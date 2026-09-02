import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import fetch from 'node-fetch';

import { DEMO_MODE, supabase, CORS_ALLOWED_ORIGINS, isOriginAllowed } from './config.js';
import { state, saveAgentState, emaControlReady, trendlineReady, loadTlActiveOrders } from './state.js';
import { sendTelegram } from './services/telegram.js';
import { startMonitors } from './services/monitors.js';
import { demoGuard } from './middleware/auth.js';

import { stripeWebhookHandler } from './routes/webhooks.js';
import demoRouter from './routes/demo.js';
import webhooksRouter from './routes/webhooks.js';
import onboardingRouter from './routes/onboarding.js';
import tradesRouter from './routes/trades.js';
import agentRouter from './routes/agent.js';
import adminRouter from './routes/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ── CORS ─────────────────────────────────────────────────────────────────────
// Only origins in CORS_ALLOWED_ORIGINS receive an Access-Control-Allow-Origin
// header. A disallowed origin still gets a response, but without that header
// the browser refuses to expose it to the page — which is the intended block.
//
// Requests carrying no Origin header (server-to-server, curl, same-origin
// navigation) pass through untouched: CORS never applied to them in the first
// place, and they are authenticated by x-webhook-secret where it matters.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.vary('Origin');

  if (isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-webhook-secret, x-telegram-bot-api-secret-token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Stripe webhook — MUST be before express.json() ───────────────────────────
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), stripeWebhookHandler);

// ── Static frontend ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../../frontend')));

// ── JSON body parser for all other routes ────────────────────────────────────
app.use(express.json());

// ── Demo write-blocker: in DEMO_MODE, all mutating requests are blocked ───────
if (DEMO_MODE) {
  app.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      if (req.path.startsWith('/api/demo/')) return next();
      return res.json({ ok: true, demo: true, message: 'Demo mode — no live operations executed' });
    }
    next();
  });
}

// ── Route mounting ────────────────────────────────────────────────────────────
if (DEMO_MODE) {
  // Mounted at /api/demo — this is the path the frontend, README and
  // docs/architecture.md all reference.
  app.use('/api/demo', demoRouter);
}

app.use(webhooksRouter);
app.use(onboardingRouter);
app.use(tradesRouter);
app.use(agentRouter);
app.use('/admin', demoGuard);
app.use(adminRouter);

// ── GET /orders/pending ───────────────────────────────────────────────────────
app.get('/orders/pending', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { metaApiFetch } = await import('./services/metaapi.js');
    const ordersRes = await metaApiFetch(`/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/orders`, { headers: { 'auth-token': process.env.METAAPI_TOKEN } });
    const orders = await ordersRes.json();
    if (!Array.isArray(orders)) { console.warn('GET /orders/pending: unexpected MetaAPI response', JSON.stringify(orders).slice(0, 200)); return res.status(502).json({ error: 'Unexpected MetaAPI response' }); }
    res.json(orders.map(o => ({ symbol: o.symbol, direction: o.type && o.type.includes('BUY') ? 'BUY' : 'SELL', entry: o.openPrice, lot: o.volume, magic: o.magic })));
  } catch (err) { console.error('GET /orders/pending error:', err); res.status(500).json({ error: 'MetaAPI unavailable' }); }
});

// ── GET /price/internal ───────────────────────────────────────────────────────
app.get('/price/internal', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const now = Date.now();
    if (state.priceCache && now - state.priceCacheTime < 10_000) return res.json(state.priceCache);
    const response = await fetch(`https://api.twelvedata.com/quote?symbol=XAU/USD&apikey=${process.env.TWELVE_DATA_API_KEY}`);
    const d = await response.json();
    const price = d.close ?? d.price ?? null;
    if (!response.ok || price == null) { if (state.priceCache) return res.json(state.priceCache); return res.status(502).json({ error: 'Price unavailable' }); }
    state.priceCache = { price, timestamp: d.datetime ?? new Date().toISOString() };
    state.priceCacheTime = now;
    res.json(state.priceCache);
  } catch (err) { if (state.priceCache) return res.json(state.priceCache); res.status(502).json({ error: 'Price unavailable' }); }
});

// ── GET /stats — strategy performance dashboard ───────────────────────────────
app.get('/stats', async (req, res) => {
  try {
    const { data: closedTrades } = await supabase.from('trades').select('direction, entry, sl, tp, result, profit, exit, closed_at, src_code, lot').eq('status', 'closed').in('src_code', [6, 7]).order('closed_at', { ascending: false });
    const { data: openTrades }   = await supabase.from('trades').select('direction, entry, sl, tp, src_code, lot').eq('status', 'open').in('src_code', [6, 7]);
    const { data: hhhlStrClosed } = await supabase.from('trades').select('direction, entry, sl, tp, result, profit, exit, closed_at, src_code, tf').eq('status', 'closed').eq('src_code', 10).order('closed_at', { ascending: false });
    const { data: hhhlLinClosed } = await supabase.from('trades').select('direction, entry, sl, tp, result, profit, exit, closed_at, src_code').eq('status', 'closed').eq('src_code', 11).order('closed_at', { ascending: false });
    const allClosed = [...(closedTrades||[]), ...(hhhlStrClosed||[]), ...(hhhlLinClosed||[])];
    const wins = allClosed.filter(t => t.result?.startsWith('TP') || t.result === 'Win').length;
    const losses = allClosed.filter(t => t.result === 'SL' || t.result === 'Loss').length;
    const total = wins + losses;
    const winrate = total ? ((wins / total) * 100).toFixed(1) : '0.0';
    const totalProfit = allClosed.reduce((s, t) => s + (t.profit || 0), 0);
    res.json({ wins, losses, total, winrate: parseFloat(winrate), total_profit: parseFloat(totalProfit.toFixed(2)), open_count: (openTrades||[]).length, trades: allClosed.slice(0, 50) });
  } catch (err) { console.error('GET /stats error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Midnight auto-reset: re-enable EMA agent at 00:00 Vilnius ────────────────
setInterval(() => {
  const now = new Date();
  const vln = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Vilnius' }));
  if (vln.getHours() === 0 && vln.getMinutes() === 0) {
    if (state.emaAgentPaused) {
      state.emaAgentPaused = false;
      saveAgentState();
      console.log('Midnight auto-reset: EMA agent re-enabled');
      sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, '🔄 Midnight auto-reset: EMA agentas automatiškai įjungtas (00:00 Vilnius)');
    }
  }
}, 60_000);

// ── Startup ───────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Automated Trading Platform running on port ${PORT} [DEMO_MODE=${DEMO_MODE}]`);

  if (CORS_ALLOWED_ORIGINS.length > 0) {
    console.log(`CORS allowlist: ${CORS_ALLOWED_ORIGINS.join(', ')}`);
  } else if (DEMO_MODE) {
    console.log('CORS allowlist: unset — allowing localhost origins (demo mode only).');
  } else {
    console.warn('CORS_ALLOWED_ORIGINS is not set: all cross-origin browser requests will be refused. Set it to your frontend origin(s).');
  }

  if (DEMO_MODE) {
    console.log('[DEMO] Startup: skipping Supabase, Telegram setWebhook and all external service calls.');
    return;
  }
  await Promise.all([emaControlReady, trendlineReady]);
  await loadTlActiveOrders();

  try {
    const { data: lotSetting } = await supabase.from('settings').select('value').eq('key', 'master_lot_size').maybeSingle();
    if (lotSetting?.value) {
      const parsed = parseFloat(lotSetting.value);
      if (Number.isFinite(parsed) && parsed > 0) { state.masterLotSize = parsed; console.log(`Master lot loaded from Supabase: ${state.masterLotSize}`); }
    }
  } catch (e) { console.warn('Could not load master lot from Supabase:', e.message); }

  try {
    const webhookUrl = `${process.env.RAILWAY_SERVER_URL || 'https://yourdomain.com'}/telegram-webhook`;
    const webhookBody = { url: webhookUrl };
    if (process.env.TELEGRAM_WEBHOOK_SECRET) webhookBody.secret_token = process.env.TELEGRAM_WEBHOOK_SECRET;
    const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(webhookBody) });
    const d = await r.json();
    console.log('Telegram setWebhook:', JSON.stringify(d), 'secured:', !!process.env.TELEGRAM_WEBHOOK_SECRET);
  } catch (err) { console.error('Telegram setWebhook error:', err); }

  startMonitors();
});

export default app;
