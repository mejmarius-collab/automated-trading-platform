import express from 'express';
import fs from 'fs';
import { supabase, EMA_CACHE_FILE } from '../config.js';
import { state, saveAgentState, emaControlReady } from '../state.js';
import { metaApiFetch } from '../services/metaapi.js';
import { cancelOrderByMagic } from '../services/metaapi.js';
import { nowVilnius } from '../utils/formatters.js';

const router = express.Router();

// ── GET /agent/master-lot ───────────────────────────────────────────────────
router.get('/agent/master-lot', (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ lot: state.masterLotSize });
});

// ── POST /cycle/state — pushed by Python cycle agent ───────────────────────
router.post('/cycle/state', express.json(), (req, res) => {
  const secret = req.body?.secret || req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'unauthorized' });
  state.cycleState = req.body?.state || null;
  res.json({ ok: true });
});

// ── POST /api/msb-close-magic — close any open position by magic ───────────
router.post('/api/msb-close-magic', express.json(), async (req, res) => {
  const secret = req.body?.secret || req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const magic = Number(req.body?.magic);
  if (!magic) return res.status(400).json({ error: 'magic required' });
  try {
    const { closeTradeByMagic } = await import('../services/metaapi.js');
    const result = await closeTradeByMagic(magic);
    if (!result) return res.status(502).json({ ok: false, error: 'Position not found or MetaAPI unavailable' });
    res.json(result);
  } catch (err) { console.error('/api/msb-close-magic error:', err); res.status(500).json({ error: err.message }); }
});

// ── GET /api/account-balance ────────────────────────────────────────────────
router.get('/api/account-balance', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const infoRes = await metaApiFetch(`/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/account-information`, { headers: { 'auth-token': process.env.METAAPI_TOKEN } });
    const info = await infoRes.json();
    if (!info || info.balance == null) return res.status(502).json({ ok: false, error: 'MetaAPI unavailable' });
    res.json({ balance: info.balance, equity: info.equity });
  } catch (err) { console.error('/api/account-balance error:', err); res.status(500).json({ error: err.message }); }
});

// ── POST /api/modify-sl ─────────────────────────────────────────────────────
router.post('/api/modify-sl', express.json(), async (req, res) => {
  const secret = req.body?.secret || req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const magic = Number(req.body?.magic), sl = Number(req.body?.sl);
  if (!magic || sl == null || isNaN(sl)) return res.status(400).json({ error: 'magic and sl required' });
  try {
    const posRes = await metaApiFetch(`/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/positions`, { headers: { 'auth-token': process.env.METAAPI_TOKEN } });
    const positions = await posRes.json();
    if (!Array.isArray(positions)) return res.status(502).json({ ok: false, error: 'MetaAPI unavailable' });
    const target = positions.find(p => p.magic === magic);
    if (!target) return res.status(404).json({ ok: false, error: `No position with magic ${magic}` });
    const { movePositionStopLoss } = await import('../services/metaapi.js');
    const result = await movePositionStopLoss(target.id, sl, target.takeProfit ?? null);
    if (result.ok) await supabase.from('trades').update({ sl }).eq('magic', magic).eq('status', 'open');
    res.json(result);
  } catch (err) { console.error('/api/modify-sl error:', err); res.status(500).json({ error: err.message }); }
});

// ── EMA cache ───────────────────────────────────────────────────────────────
router.post('/ema-update', express.json(), (req, res) => {
  const secret = req.query.secret || req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const { ema20_1h, ema50_1h, ema200_1h, ema20_4h, ema50_4h, ema200_4h, ema20_d, ema50_d, ema20_15m, ema50_15m, o15m, h15m, l15m, c15m, t } = req.body;
  if (!ema20_1h || !ema200_1h) return res.status(400).json({ error: 'Missing required EMA fields' });
  state.tvEmaCache = { ema20_1h, ema50_1h, ema200_1h, ema20_4h, ema50_4h, ema200_4h, ema20_d, ema50_d, ema20_15m, ema50_15m, o15m, h15m, l15m, c15m, t, updated_at: new Date().toISOString() };
  try { fs.writeFileSync(EMA_CACHE_FILE, JSON.stringify(state.tvEmaCache)); } catch (e) { console.warn('[EMA] Cache write failed:', e.message); }
  res.json({ ok: true });
});

router.get('/ema-current', (req, res) => res.json(state.tvEmaCache));

// ── Agent trendline endpoints ───────────────────────────────────────────────
router.get('/agent/trendline/candle', (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!state.tvEmaCache || !state.tvEmaCache.c15m) return res.status(204).end();
  res.json({ o: state.tvEmaCache.o15m, h: state.tvEmaCache.h15m, l: state.tvEmaCache.l15m, c: state.tvEmaCache.c15m, t: state.tvEmaCache.t });
});

router.get('/agent/trendline', (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  res.json(state.trendlineState);
});

router.post('/agent/trendline/cancel', express.json(), (req, res) => {
  const secret = req.headers['x-webhook-secret'] || req.body?.secret;
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const id = req.body?.id;
  if (id != null) state.trendlineState = state.trendlineState.filter(t => t.id !== Number(id));
  else state.trendlineState = [];
  saveAgentState();
  res.json({ ok: true });
});

// ── TV trendline order tracking ─────────────────────────────────────────────
router.get('/agent/tv-tl-orders', (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  res.json(state.tvTlActiveOrders);
});

router.post('/agent/tv-tl-orders/remove', express.json(), (req, res) => {
  const secret = req.body?.secret || req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const { market_magic } = req.body || {};
  if (market_magic != null) {
    state.tvTlActiveOrders = state.tvTlActiveOrders.filter(o => o.market_magic !== Number(market_magic));
    import('../state.js').then(({ deleteTlOrder }) => deleteTlOrder(market_magic));
  }
  res.json({ ok: true });
});

// ── EMA agent control ───────────────────────────────────────────────────────
router.get('/ema/control', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  await emaControlReady;
  res.json({ paused: state.emaAgentPaused, skipUntilCross: state.emaSkipUntilCross });
});

router.post('/ema/set-control', express.json(), (req, res) => {
  const secret = req.headers['x-webhook-secret'] || req.body?.secret;
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if ('paused' in req.body) state.emaAgentPaused = req.body.paused === true;
  if ('skipUntilCross' in req.body) state.emaSkipUntilCross = req.body.skipUntilCross || null;
  saveAgentState();
  res.json({ paused: state.emaAgentPaused, skipUntilCross: state.emaSkipUntilCross });
});

router.get('/ema/rideopennow-pending', (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const pending = state.rideOpenPending;
  state.rideOpenPending = null;
  res.json(pending ? { direction: pending.direction, entry: pending.entry } : { direction: null });
});

router.get('/ema/clear-pending', (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const pending = state.emaClearPending;
  state.emaClearPending = false;
  res.json({ clear: pending });
});

router.get('/ema/active-slots', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { data: trades, error } = await supabase.from('trades')
      .select('magic, direction, entry, sl, tp, signal_id, opened_at')
      .eq('src_code', 6).eq('status', 'open').order('opened_at', { ascending: true });
    if (error) throw error;
    res.json(trades || []);
  } catch (err) { console.error('/ema/active-slots error:', err.message); res.status(500).json({ error: err.message }); }
});

router.get('/ema/active-ride', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { data: trade, error } = await supabase.from('trades')
      .select('magic, direction, entry, signal_id, opened_at')
      .eq('src_code', 7).eq('status', 'open').order('opened_at', { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    if (!trade) return res.json(null);
    res.json({ dir: trade.direction, entry: Number(trade.entry), magic: trade.magic, opened_at: trade.opened_at });
  } catch (err) { console.error('/ema/active-ride error:', err.message); res.status(500).json({ error: err.message }); }
});

router.post('/agent/cancel-pending-magic', express.json(), async (req, res) => {
  const secret = req.body?.secret || req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const magic = parseInt(req.body?.magic);
  if (!magic) return res.status(400).json({ error: 'Missing or invalid magic' });
  try {
    const result = await cancelOrderByMagic(magic);
    await supabase.from('trades').delete().eq('magic', magic).eq('status', 'open');
    res.json({ ok: result?.ok ?? false });
  } catch (err) { console.error('/agent/cancel-pending-magic error:', err.message); res.status(500).json({ error: err.message }); }
});

export default router;
