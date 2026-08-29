import express from 'express';
import fetch from 'node-fetch';
import { supabase } from '../config.js';
import { state } from '../state.js';
import { publicLimiter } from '../middleware/auth.js';
import { metaApiFetch } from '../services/metaapi.js';
import { vilniusParts } from '../utils/formatters.js';

const router = express.Router();

// ── GET /price — XAU/USD with 10s in-memory cache ──────────────────────────
router.get('/price', publicLimiter, async (req, res) => {
  try {
    const now = Date.now();
    if (state.priceCache && now - state.priceCacheTime < 10_000) return res.json(state.priceCache);

    const response = await fetch(`https://api.twelvedata.com/quote?symbol=XAU/USD&apikey=${process.env.TWELVE_DATA_API_KEY}`);
    const d = await response.json();
    const price = d.close ?? d.price ?? null;

    if (!response.ok || price == null) {
      console.warn('TwelveData /price error:', JSON.stringify(d).slice(0, 200));
      if (state.priceCache) return res.json(state.priceCache);
      return res.status(502).json({ error: 'Price unavailable' });
    }

    state.priceCache = { price, change: d.change ?? null, change_percent: d.percent_change ?? null, timestamp: d.datetime ?? new Date().toISOString() };
    state.priceCacheTime = now;
    res.json(state.priceCache);
  } catch (err) {
    console.error('GET /price error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /trades/open ────────────────────────────────────────────────────────
router.get('/trades/open', publicLimiter, async (req, res) => {
  try {
    const { data: dbTrades } = await supabase.from('trades')
      .select('magic, symbol, direction, entry, lot, opened_at, src_code')
      .eq('status', 'open');
    const openDbTrades = dbTrades || [];
    const positionsRes = await metaApiFetch(
      `/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/positions`,
      { headers: { 'auth-token': process.env.METAAPI_TOKEN } }
    );
    const positions = await positionsRes.json();
    if (!Array.isArray(positions) || positions.length === 0) return res.json([]);
    const dbMagics = new Set(openDbTrades.map(t => t.magic));
    res.json(positions.filter(p => dbMagics.has(p.magic)).map(p => ({
      symbol: p.symbol, direction: p.type === 'POSITION_TYPE_BUY' ? 'BUY' : 'SELL',
      entry: p.openPrice, lot: p.volume, profit: p.profit, magic: p.magic, opened_at: p.time,
    })));
  } catch (err) { console.error('GET /trades/open error:', err); res.json([]); }
});

// ── GET /positions/open — all open positions (for Python agent, no Supabase filter) ──
router.get('/positions/open', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const posRes = await metaApiFetch(
      `/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/positions`,
      { headers: { 'auth-token': process.env.METAAPI_TOKEN } }
    );
    const positions = await posRes.json();
    res.json(Array.isArray(positions) ? positions : []);
  } catch (err) { console.error('GET /positions/open error:', err); res.status(500).json({ error: err.message }); }
});

// ── GET /trades/history ─────────────────────────────────────────────────────
router.get('/trades/history', publicLimiter, async (req, res) => {
  try {
    const { data, error } = await supabase.from('trades').select('*')
      .eq('status', 'closed').not('result', 'in', '("Atšauktas","Canceled")')
      .not('closed_at', 'is', null).order('closed_at', { ascending: false }).limit(10);
    if (error) throw error;
    res.json(data);
  } catch (err) { console.error('GET /trades/history error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── GET /pnl/today ──────────────────────────────────────────────────────────
router.get('/pnl/today', publicLimiter, async (req, res) => {
  try {
    const { year, month, day } = vilniusParts(new Date());
    const todayStart = `${year}-${month}-${day}T00:00:00.000+00:00`;
    const { data, error } = await supabase.from('trades').select('profit').eq('status', 'closed').gte('closed_at', todayStart);
    if (error) throw error;
    res.json({ total_profit: parseFloat(data.reduce((s, t) => s + (t.profit || 0), 0).toFixed(2)), trade_count: data.length });
  } catch (err) { console.error('GET /pnl/today error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── GET /pnl/monthly ────────────────────────────────────────────────────────
router.get('/pnl/monthly', publicLimiter, async (req, res) => {
  try {
    const now = new Date();
    const { year, month: monthNum } = vilniusParts(now);
    const monthStart = `${year}-${monthNum}-01T00:00:00.000+00:00`;
    const { data, error } = await supabase.from('trades').select('profit').eq('status', 'closed').gte('closed_at', monthStart);
    if (error) throw error;
    const month = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'Europe/Vilnius' }).format(now);
    res.json({ month, total_profit: parseFloat(data.reduce((s, t) => s + (t.profit || 0), 0).toFixed(2)), trade_count: data.length });
  } catch (err) { console.error('GET /pnl/monthly error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── GET /pnl/breakdown ──────────────────────────────────────────────────────
router.get('/pnl/breakdown', publicLimiter, async (req, res) => {
  try {
    const { data, error } = await supabase.from('trades').select('closed_at, profit').eq('status', 'closed').not('closed_at', 'is', null).order('closed_at', { ascending: false });
    if (error) throw error;
    const monthMap = {};
    data.forEach(t => {
      const key = String(t.closed_at).slice(0, 7);
      if (!monthMap[key]) {
        const monthLabel = new Date(`${key}-15T12:00:00Z`).toLocaleString('lt-LT', { month: 'long', year: 'numeric', timeZone: 'UTC' });
        monthMap[key] = { month: monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1), profit: 0 };
      }
      monthMap[key].profit += (t.profit || 0);
    });
    res.json(Object.keys(monthMap).sort((a, b) => b.localeCompare(a)).slice(0, 9).map(k => ({ month: monthMap[k].month, profit: parseFloat(monthMap[k].profit.toFixed(2)) })));
  } catch (err) { console.error('GET /pnl/breakdown error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

export default router;
