import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// ── DEMO MODE ──────────────────────────────────────────────────────────────
// Default: true — this public portfolio version always runs in demo mode.
// In demo mode all MetaAPI/CopyFactory/broker calls are blocked at runtime.
export const DEMO_MODE = process.env.DEMO_MODE !== 'false';

// ── Proxy trust ────────────────────────────────────────────────────────────
// req.ip has exactly one consumer: the per-IP rate limiter in middleware/auth.js.
// Getting this setting wrong breaks that limiter in one of two directions:
//
//   too low  — behind Railway's proxy req.ip is the proxy, so every visitor
//              shares a single bucket and the limiter becomes a global cap.
//   too high — with no real proxy in front, X-Forwarded-For is attacker
//              controlled, so the limiter can be bypassed at will.
//
// Hence: explicit, and overridable. TRUST_PROXY accepts a hop count (1),
// true/false, or anything Express understands ('loopback', a CIDR, a list).
//
// Default follows how this app is actually deployed: DEMO_MODE=true is the
// local/portfolio case with no proxy, DEMO_MODE=false is the Railway
// deployment, which always fronts the app with exactly one proxy hop.
function parseTrustProxy(raw, demoMode) {
  if (raw === undefined || String(raw).trim() === '') return demoMode ? false : 1;
  const value = String(raw).trim();
  if (value === '0' || value.toLowerCase() === 'false') return false;
  if (value.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY, DEMO_MODE);

// ── CORS ───────────────────────────────────────────────────────────────────
// Comma-separated allowlist of browser origins permitted to read responses:
//   CORS_ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
//
// CORS is a browser-only mechanism. Server-to-server callers (the Python
// agents, Stripe webhooks) send no Origin header, are never subject to it, and
// authenticate with x-webhook-secret instead — so tightening this does not
// affect them.
export const CORS_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * An origin is allowed when it is listed in CORS_ALLOWED_ORIGINS.
 *
 * With no allowlist configured we fall back to localhost only, and only in
 * DEMO_MODE, so `npm install && node server.js` works with no .env file. In
 * production (DEMO_MODE=false) an unset allowlist means no cross-origin access
 * at all — failing closed rather than silently allowing everything.
 */
export function isOriginAllowed(origin) {
  if (!origin) return false;
  const normalized = String(origin).replace(/\/+$/, '');
  if (CORS_ALLOWED_ORIGINS.includes(normalized)) return true;
  if (CORS_ALLOWED_ORIGINS.length === 0 && DEMO_MODE) return LOCALHOST_ORIGIN.test(normalized);
  return false;
}

// ── Clients ────────────────────────────────────────────────────────────────
// Fallback placeholder values allow the server to boot in demo mode without
// real credentials — all live calls are blocked by demoGuard anyway.
export const supabase = createClient(
  process.env.SUPABASE_URL || 'https://demo-placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'demo-service-key-placeholder'
);

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_demo_placeholder');

// ── Constants ──────────────────────────────────────────────────────────────
export const ALLOWED_LOT_SIZES = [
  0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.10,
  0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 1.00,
];

export const TP_CHECK_INTERVAL_MS = Math.max(
  5_000,
  Number(process.env.TP_CHECK_INTERVAL_MS || process.env.BE_CHECK_INTERVAL_MS || 15_000) || 15_000
);

export const STATS_RESET_AT = process.env.STATS_RESET_AT ?? '2026-06-27T00:00:00.000+00:00';

// src_code values whose agents manage their own TP notifications
export const SINGLE_STEP_TP_SRC_CODES = new Set([6, 7, 9, 10, 11]);

export const MAX_GENERATED_TP_LEVELS = Math.max(
  1,
  Number(process.env.MAX_GENERATED_TP_LEVELS || 12) || 12
);

export const AGENT_STATE_FILE = new URL('../agent_state.json', import.meta.url).pathname;
export const EMA_CACHE_FILE = '/tmp/tv_ema_cache.json';

export const METAAPI_PROVISIONING_BASE = 'https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai';
export const METAAPI_REGIONS = ['london', 'new-york'];
export const COPYFACTORY_STRATEGY_ID = process.env.COPYFACTORY_STRATEGY_ID || 'YOUR_STRATEGY_ID';
export const HHHL_DEDUP_MS = 15_000;
