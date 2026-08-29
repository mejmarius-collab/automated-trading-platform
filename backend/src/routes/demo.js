import express from 'express';
import { publicLimiter } from '../middleware/auth.js';

const router = express.Router();

// ── Demo trade data (portfolio mode — synthetic only) ──────────────────────
// Schema matches frontend mapRawTrade() expectations.
const DEMO_TRADES = [
  { id: 1, signal_id: '17220000000110101001', symbol: 'XAUUSD', direction: 'BUY',  entry: 2318.50, exit: 2328.50, tp: 2328.50, sl: 2308.50, lot: 0.10, status: 'closed', result: 'TP1', profit:  10.0, src_code: 6,  opened_at: '2026-08-01T09:15:00.000+00:00', closed_at: '2026-08-01T14:32:00.000+00:00' },
  { id: 2, signal_id: '17230000000120201002', symbol: 'XAUUSD', direction: 'SELL', entry: 2345.20, exit: 2335.20, tp: 2335.20, sl: 2355.20, lot: 0.10, status: 'closed', result: 'TP1', profit:  10.0, src_code: 6,  opened_at: '2026-08-05T11:00:00.000+00:00', closed_at: '2026-08-05T16:45:00.000+00:00' },
  { id: 3, signal_id: '17240000000130101003', symbol: 'XAUUSD', direction: 'BUY',  entry: 2301.00, exit: 2291.00, tp: 2321.00, sl: 2291.00, lot: 0.10, status: 'closed', result: 'SL',  profit: -10.0, src_code: 9,  opened_at: '2026-08-10T08:30:00.000+00:00', closed_at: '2026-08-10T10:15:00.000+00:00' },
  { id: 4, signal_id: '17250000000140201004', symbol: 'XAUUSD', direction: 'SELL', entry: 2378.90, exit: 2368.90, tp: 2368.90, sl: 2388.90, lot: 0.10, status: 'closed', result: 'TP1', profit:  10.0, src_code: 11, opened_at: '2026-08-15T13:00:00.000+00:00', closed_at: '2026-08-15T18:22:00.000+00:00' },
  { id: 5, signal_id: '17260000000150101005', symbol: 'XAUUSD', direction: 'BUY',  entry: 2330.75, exit: null,    tp: 2350.75, sl: 2320.75, lot: 0.10, status: 'open',   result: null,  profit:   null, src_code: 6,  opened_at: '2026-08-28T07:00:00.000+00:00', closed_at: null },
];

router.get('/trades',       publicLimiter, (req, res) => res.json(DEMO_TRADES));
router.get('/open-trades',  publicLimiter, (req, res) => res.json(DEMO_TRADES.filter(t => t.status === 'open')));
router.get('/pnl/today',    publicLimiter, (req, res) => res.json({ total_profit: 10.0, trade_count: 1 }));
router.get('/pnl/monthly',  publicLimiter, (req, res) => res.json({ total_profit: 20.0, trade_count: 4, wins: 3, losses: 1, winrate: 75.0 }));
router.get('/checkout-session',   publicLimiter, (req, res) => res.json({ email: 'demo@example.com', plan: 'Automatinis', demo: true }));
router.get('/onboarding-resume',  publicLimiter, (req, res) => res.json({ email: 'demo@example.com', plan: 'Automatinis', demo: true }));
router.post('/connect-account',   publicLimiter, (req, res) => res.json({ ok: true, demo: true, message: 'Demo mode — no broker connection made.' }));

export default router;
