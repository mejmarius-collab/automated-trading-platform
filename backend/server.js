/**
 * PORTFOLIO / DEMO VERSION
 * All credentials, keys, and production URLs have been removed or replaced with env-var placeholders.
 * Set DEMO_MODE=true (default) to disable live trading execution.
 * See .env.example for all required environment variables.
 */
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import https from 'https';
import crypto from 'crypto';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ── DEMO MODE ──────────────────────────────────────────────────────────────
// Default: true — this public portfolio version always runs in demo mode.
// In demo mode all MetaAPI/CopyFactory/broker calls are blocked at runtime.
const DEMO_MODE = process.env.DEMO_MODE !== 'false';
if (DEMO_MODE) {
  console.log('[DEMO] Running in demo/portfolio mode. Live trade execution, MetaAPI, CopyFactory and background monitors are disabled.');
}

function demoGuard(req, res, next) {
  if (DEMO_MODE) return res.status(503).json({ ok: false, error: 'Demo mode — live execution disabled' });
  next();
}

// ── Clients ────────────────────────────────────────────────────────────────
// Fallback placeholder values allow the server to boot in demo mode without
// real credentials — all live calls are blocked by demoGuard anyway.
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://demo-placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'demo-service-key-placeholder'
);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_demo_placeholder');


let priceCache = null;
let priceCacheTime = 0;

const ALLOWED_LOT_SIZES = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 1.00];
const TP_CHECK_INTERVAL_MS = Math.max(5_000, Number(process.env.TP_CHECK_INTERVAL_MS || process.env.BE_CHECK_INTERVAL_MS || 15_000) || 15_000);
const DEFAULT_STATS_RESET_AT = '2026-06-27T00:00:00.000+00:00';
const STATS_RESET_AT = process.env.STATS_RESET_AT ?? DEFAULT_STATS_RESET_AT;

const SINGLE_STEP_TP_SRC_CODES = new Set([6, 7, 9, 10, 11]); // EMA slots (6), Ride (7), Trendline (9), HHHL Structure (10), HHHL LINIJA (11)
const MAX_GENERATED_TP_LEVELS = Math.max(1, Number(process.env.MAX_GENERATED_TP_LEVELS || 12) || 12);
const AGENT_STATE_FILE = new URL('./agent_state.json', import.meta.url).pathname;
function _loadAgentState() {
  try {
    if (fs.existsSync(AGENT_STATE_FILE)) return JSON.parse(fs.readFileSync(AGENT_STATE_FILE, 'utf8'));
  } catch {}
  return {};
}
function _saveAgentState() {
  try { fs.writeFileSync(AGENT_STATE_FILE, JSON.stringify({ emaAgentPaused, emaSkipUntilCross, trendlineState, trendlineHistory, _tlNextId })); } catch {}
  supabase.from('settings').upsert({ key: 'ema_control', value: { emaAgentPaused, emaSkipUntilCross } }, { onConflict: 'key' }).then(({ error }) => {
    if (error) console.error('[state] Supabase EMA control upsert failed:', error.message);
  });
  supabase.from('settings').delete().eq('key', 'trendline_state').then(() => {
    supabase.from('settings').insert({ key: 'trendline_state', value: { trendlineState, trendlineHistory, _tlNextId } }).then(({ error }) => {
      if (error) console.error('[state] Supabase trendline insert failed:', error.message);
      else console.log(`[state] Trendline state saved: ${trendlineState.length} active, ${trendlineHistory.length} history`);
    });
  });
}
async function _restoreEmaControlFromSupabase() {
  try {
    const { data: rows } = await supabase.from('settings').select('value').eq('key', 'ema_control');
    if (!rows || rows.length === 0) return;
    const row = rows[rows.length - 1];
    if (row.value.emaAgentPaused != null) emaAgentPaused = row.value.emaAgentPaused;
    if (row.value.emaSkipUntilCross !== undefined) emaSkipUntilCross = row.value.emaSkipUntilCross;
    console.log(`[state] EMA control restored from Supabase: paused=${emaAgentPaused} skip=${emaSkipUntilCross}`);
  } catch (e) {
    console.warn('[state] Could not restore EMA control from Supabase:', e.message);
  }
}
async function _restoreTrendlineFromSupabase() {
  try {
    const { data: rows, error } = await supabase.from('settings').select('value').eq('key', 'trendline_state');
    console.log(`[state] TL restore: rows=${rows?.length ?? 0} error=${error?.message ?? 'none'}`);
    if (error || !rows || rows.length === 0) return;
    const row = rows[rows.length - 1];
    console.log(`[state] TL row.value=`, JSON.stringify(row.value));
    if (Array.isArray(row.value?.trendlineState)) trendlineState = row.value.trendlineState;
    if (Array.isArray(row.value?.trendlineHistory)) trendlineHistory = row.value.trendlineHistory.slice(-30);
    if (row.value?._tlNextId != null) _tlNextId = row.value._tlNextId;
    console.log(`[state] Trendlines restored: ${trendlineState.length} active, ${trendlineHistory.length} history`);
  } catch (e) {
    console.warn('[state] Could not restore trendline state from Supabase:', e.message);
  }
}
const _savedAgentState = _loadAgentState();
let emaAgentPaused = _savedAgentState.emaAgentPaused ?? false;
let emaSkipUntilCross = _savedAgentState.emaSkipUntilCross ?? null; // "BUY" | "SELL" | null
const _emaControlReady = DEMO_MODE ? Promise.resolve() : _restoreEmaControlFromSupabase();
const _trendlineReady  = DEMO_MODE ? Promise.resolve() : _restoreTrendlineFromSupabase();
let emaClearPending = false;
let rideOpenPending = null; // "BUY" | "SELL" | null
let trendlineState = Array.isArray(_savedAgentState.trendlineState) ? _savedAgentState.trendlineState : [];
let trendlineHistory = Array.isArray(_savedAgentState.trendlineHistory) ? _savedAgentState.trendlineHistory.slice(-30) : [];
let _tlNextId = _savedAgentState._tlNextId ?? 1;
let tvTlActiveOrders = []; // [{market_magic, limit_magic, market_signal_id, limit_signal_id}]

async function _loadTlActiveOrders() {
  try {
    const { data } = await supabase.from('tl_active_orders').select('*');
    if (data && data.length) {
      tvTlActiveOrders = data.map(r => ({
        market_magic:      Number(r.market_magic),
        limit_magic:       Number(r.limit_magic),
        market_signal_id:  r.market_signal_id,
        limit_signal_id:   r.limit_signal_id,
      }));
      console.log(`[tv-tl] Loaded ${tvTlActiveOrders.length} active TL orders from Supabase`);
    }
  } catch (e) { console.warn('[tv-tl] Could not load tl_active_orders:', e.message); }
}
if (!DEMO_MODE) _loadTlActiveOrders();

// HHHL LINIJA monitor: kai market orderi užsidaro (TP/SL), atšaukia limit
if (!DEMO_MODE) setInterval(async () => {
  if (!hhhlLinijaOrders.length) return;
  const accountId = process.env.HHHL_MT5_ACCOUNT_ID;
  if (!accountId) return;
  try {
    const posRes = await metaApiFetch(
      `/users/current/accounts/${accountId}/positions`,
      { headers: { 'auth-token': process.env.METAAPI_TOKEN } }
    );
    const positions = await posRes.json();
    const openIds = new Set((Array.isArray(positions) ? positions : []).map(p => String(p.id)));
    const toRemove = [];
    for (const entry of hhhlLinijaOrders) {
      if (!openIds.has(entry.positionId)) {
        toRemove.push(entry);
        try {
          await metaApiFetch(
            `/users/current/accounts/${accountId}/trade`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'auth-token': process.env.METAAPI_TOKEN },
              body: JSON.stringify({ actionType: 'ORDER_CANCEL', orderId: entry.orderId }),
            }
          );
          console.log(`[HHHL-LINIJA] Auto-cancelled limit ${entry.orderId} (market ${entry.positionId} closed)`);
          await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID,
            `🔄 <b>HHHL LINIJA ${entry.dir}</b> — limit atšauktas (market užsidarė)`,
            { parse_mode: 'HTML' }
          );
        } catch (e) { console.error('[HHHL-LINIJA] Cancel limit error:', e.message); }
      }
    }
    if (toRemove.length) {
      const removeSet = new Set(toRemove.map(o => o.positionId));
      hhhlLinijaOrders = hhhlLinijaOrders.filter(o => !removeSet.has(o.positionId));
    }
  } catch (e) { console.error('[HHHL-LINIJA] Monitor error:', e.message); }
}, 2 * 60 * 1000);

async function _saveTlOrder(order) {
  try {
    await supabase.from('tl_active_orders').upsert({
      market_magic:     order.market_magic,
      limit_magic:      order.limit_magic,
      market_signal_id: order.market_signal_id,
      limit_signal_id:  order.limit_signal_id,
    });
  } catch (e) { console.warn('[tv-tl] Supabase save failed:', e.message); }
}

async function _deleteTlOrder(market_magic) {
  try {
    await supabase.from('tl_active_orders').delete().eq('market_magic', Number(market_magic));
  } catch (e) { console.warn('[tv-tl] Supabase delete failed:', e.message); }
}
const METAAPI_PROVISIONING_BASE = 'https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai';
const COPYFACTORY_STRATEGY_ID = process.env.COPYFACTORY_STRATEGY_ID || 'YOUR_STRATEGY_ID';
const tpMilestoneNotified = new Set();
const tpMilestoneInProgress = new Set();
let tpMonitorRunning = false;
let masterLotSize = parseFloat(process.env.DEFAULT_LOT_SIZE || '0.10');
let hhhlLinijaState = { '15MIN': { res: null, sup: null }, '60MIN': { res: null, sup: null } }; // keyed by tf
const hhhlLimitDedup  = new Map(); // `${dir}_${price}` → timestamp (ms) — HHHL LIMIT dedup
const hhhlBreakDedup  = new Map(); // `${tfKey}_${dir}`  → timestamp (ms) — HHHL LINIJA BREAK dedup
const HHHL_DEDUP_MS = 15_000;
let hhhlLinijaOrders = []; // [{positionId, orderId, dir}] — market+limit pairs for auto-cancel
const hhhlStaleTracker = new Map(); // magic → stale cycle count (for MetaAPI deal sync delay)

// ── Helpers ────────────────────────────────────────────────────────────────
function normalizeLotSize(lotSize) {
  const parsed = Number(lotSize);
  const allowed = ALLOWED_LOT_SIZES.find(size => Math.abs(size - parsed) < 0.000001);

  if (!Number.isFinite(parsed) || !allowed) {
    throw new Error('Invalid lot size');
  }

  return allowed;
}

function formatLotSize(lotSize) {
  return lotSize.toFixed(2);
}

function formatAllowedLotSizes() {
  return ALLOWED_LOT_SIZES.map(formatLotSize).join(', ');
}

function cleanEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function requireEmail(email) {
  const normalized = cleanEmail(email);

  if (!normalized) {
    throw new Error('Missing email');
  }

  return normalized;
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(String(value || ''), 'base64url').toString('utf8');
}

function getOnboardingSecret() {
  return process.env.ONBOARDING_TOKEN_SECRET || process.env.WEBHOOK_SECRET || process.env.STRIPE_SECRET_KEY;
}

function createOnboardingToken(email, plan, ttlMs = 30 * 60 * 1000) {
  const payload = {
    email: cleanEmail(email),
    plan,
    exp: Date.now() + ttlMs,
  };
  const payloadPart = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', getOnboardingSecret())
    .update(payloadPart)
    .digest('base64url');
  return `${payloadPart}.${signature}`;
}

function verifyOnboardingToken(token) {
  const [payloadPart, signature] = String(token || '').split('.');
  if (!payloadPart || !signature) throw new Error('Invalid onboarding token');

  const expectedSignature = crypto
    .createHmac('sha256', getOnboardingSecret())
    .update(payloadPart)
    .digest('base64url');

  const signatureBuffer = Buffer.from(signature);
  const expectedSignatureBuffer = Buffer.from(expectedSignature);
  if (
    signatureBuffer.length !== expectedSignatureBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedSignatureBuffer)
  ) {
    throw new Error('Invalid onboarding token signature');
  }

  const payload = JSON.parse(base64UrlDecode(payloadPart));
  if (!payload.email || !payload.plan || !payload.exp || Date.now() > payload.exp) {
    throw new Error('Onboarding token expired');
  }
  return payload;
}

function cleanContactHandle(value) {
  return String(value || '').trim();
}

function formatContactLine(label, value) {
  const cleaned = cleanContactHandle(value);
  return `${label}: ${cleaned || 'neįvesta'}`;
}

function formatSignalPrice(value) {
  const rounded = Math.round(value * 100) / 100;
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(2).replace(/\.?0+$/, '');
}

function getSignalSourceCode(signalId) {
  return parseInt(String(signalId || '')[13]) || null;
}

function getGeneratedTpLevelLimit(srcCode) {
  return SINGLE_STEP_TP_SRC_CODES.has(srcCode) ? 1 : MAX_GENERATED_TP_LEVELS;
}

function buildSplitTakeProfits(action, entry, finalTp, step = 10, maxLevels = Infinity) {
  const direction = action === 'BUY' ? 1 : -1;
  const totalDistance = direction * (finalTp - entry);
  if (!Number.isFinite(totalDistance) || totalDistance <= 0) return [];

  const distances = [];
  for (const fixed of [10]) {
    if (fixed < totalDistance) distances.push(fixed);
  }

  const base = distances.length > 0 ? distances[distances.length - 1] : 0;
  const remaining = totalDistance - base;
  const fullSteps = Math.floor(remaining / step);
  const remainderPts = remaining - fullSteps * step;
  const stepsToAdd = remainderPts > 0.000001 ? fullSteps - 1 : fullSteps;
  for (let i = 1; i <= stepsToAdd; i++) {
    const d = base + i * step;
    if (d < totalDistance) distances.push(d);
  }
  distances.push(totalDistance);

  const levelLimit = Number.isFinite(maxLevels) ? Math.max(1, Math.floor(maxLevels)) : distances.length;
  const capped = distances.slice(0, levelLimit);

  return capped.map((d, i) => ({
    label: `TP${i + 1}`,
    price: i === capped.length - 1 ? finalTp : entry + direction * d,
  }));
}

function normaliseTakeProfitLevels(tpLevels, fallbackLabel = 'TP') {
  return (tpLevels || [])
    .map((tp, index) => ({
      label: String(tp.label || (tpLevels.length > 1 ? `TP${index + 1}` : fallbackLabel)).toUpperCase(),
      price: Number(tp.price),
    }))
    .filter(tp => /^TP\d*$/.test(tp.label) && Number.isFinite(tp.price));
}

function filterMinTpGap(tpLevels, direction, minGap = 5) {
  if (tpLevels.length <= 1) return tpLevels;
  const result = [];
  for (let i = 0; i < tpLevels.length; i++) {
    const next = tpLevels[i + 1];
    if (next) {
      const gap = direction === 'SELL' ? tpLevels[i].price - next.price : next.price - tpLevels[i].price;
      if (gap < minGap) continue; // too close to next — skip current, prefer further TP
    }
    result.push(tpLevels[i]);
  }
  return result;
}

function formatTakeProfitLines(tpLevels, separator = ':') {
  return normaliseTakeProfitLevels(tpLevels)
    .map(tp => `${tp.label} ${separator} ${formatSignalPrice(tp.price)}`)
    .join('\n');
}

function parseOpenTradeResult(result) {
  const empty = { tpLevels: [], hits: new Set() };
  const raw = String(result || '').trim();
  if (!raw) return empty;

  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      return {
        tpLevels: normaliseTakeProfitLevels(parsed.tpLevels || []).filter(tp => /^TP\d+$/.test(tp.label)),
        hits: new Set((parsed.hits || []).filter(label => /^TP\d+$/.test(label))),
      };
    } catch (_) {
      return empty;
    }
  }

  return { tpLevels: [], hits: parseTpMilestoneResult(raw) };
}

function formatOpenTradeResultMeta(tpLevels, hits) {
  const cleanTpLevels = normaliseTakeProfitLevels(tpLevels).filter(tp => /^TP\d+$/.test(tp.label));
  const cleanHits = [...hits].filter(label => /^TP\d+$/.test(label));
  if (!cleanTpLevels.length) return formatTpMilestoneResult(new Set(cleanHits));
  return JSON.stringify({
    tpLevels: cleanTpLevels.map(tp => ({ label: tp.label, price: Number(tp.price.toFixed(5)) })),
    hits: cleanHits,
  });
}

function getTakeProfitLevelsForRow(row) {
  const maxLevels = getGeneratedTpLevelLimit(Number(row.src_code));
  const meta = parseOpenTradeResult(row.result);
  if (meta.tpLevels.length) return meta.tpLevels.slice(0, maxLevels);
  if (row.tp == null) return [];
  return buildSplitTakeProfits(
    row.direction,
    Number(row.entry),
    Number(row.tp),
    10,
    maxLevels
  );
}

function isMetaApiTradeSuccess(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.error || data.errorCode) return false;

  const numericCode = Number(data.numericCode);
  const stringCode = String(data.stringCode || '').toUpperCase();
  const successStringCodes = new Set([
    'DONE',
    'PLACED',
    'DONE_PARTIAL',
    'ERR_NO_ERROR',
    'TRADE_RETCODE_DONE',
    'TRADE_RETCODE_PLACED',
    'TRADE_RETCODE_DONE_PARTIAL',
  ]);

  if (stringCode) return successStringCodes.has(stringCode);
  if (Number.isFinite(numericCode)) return [0, 10008, 10009, 10010].includes(numericCode);

  return true;
}

function parseTpMilestoneResult(result) {
  const labels = String(result || '')
    .split(',')
    .map(label => label.trim())
    .filter(label => /^TP\d+$/.test(label));
  return new Set(labels);
}

function formatTpMilestoneResult(labels) {
  return [...labels].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2))).join(',');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function metaApiProvisioningFetch(path, options = {}) {
  return fetch(`${METAAPI_PROVISIONING_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'auth-token': process.env.METAAPI_TOKEN,
      ...(options.headers || {}),
    },
  });
}

async function getProvisionedAccount(accountId) {
  const res = await metaApiProvisioningFetch(`/users/current/accounts/${accountId}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MetaAPI account status error ${res.status}: ${body}`);
  }
  return res.json();
}

async function callMetaApiAccountAction(accountId, action) {
  let res = await metaApiProvisioningFetch(`/users/current/accounts/${accountId}/${action}`, { method: 'POST' });
  if ([404, 405].includes(res.status)) {
    res = await metaApiProvisioningFetch(`/users/current/accounts/${accountId}/${action}`, { method: 'PUT' });
  }
  return res;
}

async function readResponseText(res) {
  try {
    return await res.text();
  } catch (_) {
    return '';
  }
}

async function deleteCopyFactorySubscriber(subscriberId) {
  if (!subscriberId) return { ok: true, status: 0, body: '' };

  try {
    const res = await fetch(
      `https://copyfactory-api-v1.london.agiliumtrade.ai/users/current/configuration/subscribers/${subscriberId}`,
      { method: 'DELETE', headers: { 'auth-token': process.env.METAAPI_TOKEN } }
    );
    const body = await readResponseText(res);
    return { ok: res.ok || res.status === 404, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 'network', body: err.message };
  }
}

async function deleteMetaApiAccount(accountId) {
  if (!accountId) return { ok: true, undeployStatus: 0, deleteStatus: 0, body: '' };

  try {
    const undeployRes = await callMetaApiAccountAction(accountId, 'undeploy');
    const undeployBody = await readResponseText(undeployRes);

    let deleteStatus = 0;
    let deleteBody = '';
    for (let attempt = 1; attempt <= 5; attempt++) {
      const deleteRes = await metaApiProvisioningFetch(`/users/current/accounts/${accountId}`, { method: 'DELETE' });
      deleteStatus = deleteRes.status;
      deleteBody = await readResponseText(deleteRes);

      if (deleteRes.ok || deleteRes.status === 404) {
        return {
          ok: true,
          undeployStatus: undeployRes.status,
          deleteStatus,
          body: deleteBody || undeployBody,
        };
      }

      if (![400, 409, 423].includes(deleteRes.status) || attempt === 5) break;
      await delay(2_000);
    }

    return {
      ok: false,
      undeployStatus: undeployRes.status,
      deleteStatus,
      body: deleteBody || undeployBody,
    };
  } catch (err) {
    return { ok: false, undeployStatus: 'network', deleteStatus: 'network', body: err.message };
  }
}

async function cleanupProvisionedAccount(accountId) {
  if (!accountId) return;
  try {
    const copyFactoryDelete = await deleteCopyFactorySubscriber(accountId);
    if (!copyFactoryDelete.ok) console.warn('CopyFactory subscriber cleanup failed:', copyFactoryDelete.status, copyFactoryDelete.body);
  } catch (err) {
    console.warn('CopyFactory subscriber cleanup failed:', err.message);
  }
  try {
    const metaApiDelete = await deleteMetaApiAccount(accountId);
    if (!metaApiDelete.ok) console.warn('MetaAPI account cleanup failed:', metaApiDelete.deleteStatus, metaApiDelete.body);
  } catch (err) {
    console.warn('MetaAPI delete cleanup failed:', err.message);
  }
}

function buildCopyFactorySubscriberConfig(email, lotSize, brokerSymbol = null) {
  // fixedVolume = lot/2 because each signal sends two orders (main + Order A).
  // e.g. subscriber chooses 0.10 → 0.05 per order × 2 = 0.10 total.
  const perOrderLot = Math.max(0.01, Math.floor(lotSize / 2 * 100) / 100);
  const subscription = {
    strategyId: COPYFACTORY_STRATEGY_ID,
    multiplier: 1,
    tradeSizeScaling: {
      mode: 'fixedVolume',
      tradeVolume: perOrderLot,
    },
  };
  // If broker uses a different symbol name (e.g. "XAUUSD!" instead of "XAUUSD"), add mapping.
  const normalizedSymbol = brokerSymbol ? brokerSymbol.trim() : null;
  if (normalizedSymbol && normalizedSymbol.toUpperCase() !== 'XAUUSD') {
    subscription.symbolMapping = [{ from: 'XAUUSD', to: normalizedSymbol }];
  }
  return {
    name: 'Aurora ' + email,
    subscriptions: [subscription],
  };
}

async function detectGoldSymbol(accountId) {
  try {
    const res = await metaApiFetch(`/users/current/accounts/${accountId}/symbols`);
    const symbols = await res.json();
    if (!Array.isArray(symbols)) return null;
    // Collect all gold-related symbols, prefer ones with suffix (broker-specific) over plain XAUUSD
    const goldSymbols = symbols.filter(s => /^(XAU|GOLD)/i.test(s));
    if (!goldSymbols.length) return null;
    // Prefer suffixed variants (XAUUSD#, XAUUSD., XAUUSDm) over plain XAUUSD
    const suffixed = goldSymbols.filter(s => s !== 'XAUUSD' && s !== 'GOLD');
    if (suffixed.length === 1) return suffixed[0];
    // Multiple suffixed — pick by priority
    const priority = ['XAUUSD#', 'XAUUSD.', 'XAUUSDm', 'XAUUSDm.', 'XAUUSD!'];
    for (const s of priority) {
      if (goldSymbols.includes(s)) return s;
    }
    // Fallback: plain XAUUSD or first match
    return goldSymbols.includes('XAUUSD') ? 'XAUUSD' : goldSymbols[0];
  } catch (e) {
    console.warn('detectGoldSymbol failed:', e.message);
    return null;
  }
}

async function putCopyFactorySubscriber(subscriberId, email, lotSize, brokerSymbol = null) {
  const res = await fetch(
    `https://copyfactory-api-v1.london.agiliumtrade.ai/users/current/configuration/subscribers/${subscriberId}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'auth-token': process.env.METAAPI_TOKEN,
      },
      body: JSON.stringify(buildCopyFactorySubscriberConfig(email, lotSize, brokerSymbol)),
    }
  );
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

function parseDuplicateCopyFactorySubscriberId(status, body) {
  if (status !== 400) return null;

  let message = '';
  try {
    message = JSON.parse(body)?.message || '';
  } catch (_) {
    message = '';
  }

  const source = `${message}\n${body}`;
  return source.match(/another subscriber id\s+([0-9a-f-]{36})\s+mapped/i)?.[1] || null;
}

async function waitForMetaApiConnection(accountId, timeoutMs = 90_000) {
  const deployRes = await callMetaApiAccountAction(accountId, 'deploy');
  if (!deployRes.ok) {
    const body = await deployRes.text();
    throw new Error(`MetaAPI deploy error ${deployRes.status}: ${body}`);
  }

  const startedAt = Date.now();
  let lastAccount = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastAccount = await getProvisionedAccount(accountId);
    const state = String(lastAccount.state || '').toUpperCase();
    const connectionStatus = String(lastAccount.connectionStatus || '').toUpperCase();
    if (state === 'DEPLOYED' && connectionStatus === 'CONNECTED') return lastAccount;
    if (state === 'FAILED' || connectionStatus === 'FAILED') {
      throw new Error(`MetaAPI account did not connect: state=${state || 'unknown'} connection=${connectionStatus || 'unknown'}`);
    }
    await delay(3_000);
  }

  const state = String(lastAccount?.state || 'unknown');
  const connectionStatus = String(lastAccount?.connectionStatus || 'unknown');
  throw new Error(`MetaAPI connection timeout: state=${state} connection=${connectionStatus}`);
}

function getPlanFromCheckoutSession(session) {
  const successUrl = session.success_url || '';
  const metadataPlan = session.metadata?.plan || '';

  try {
    const urlPlan = new URL(successUrl).searchParams.get('plan') || '';
    return metadataPlan || urlPlan;
  } catch (_) {
    const planMatch = successUrl.match(/plan=([^&]+)/);
    return metadataPlan || (planMatch ? decodeURIComponent(planMatch[1]) : '');
  }
}

// Never throws — Telegram klaida neturi versti viso route'o (pvz. Stripe webhook 500 → retry → dublikatai)
async function sendTelegram(chatId, text, options = {}) {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, ...options }),
      }
    );
    return await res.json();
  } catch (err) {
    console.error('Telegram send error:', err);
    return { ok: false, error: String(err) };
  }
}


// ── Supabase insert with retry (3 attempts, 1s delay) ────────────────────────
async function supabaseInsertWithRetry(table, data, label = '') {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { error } = await supabase.from(table).insert(data);
    if (!error) return null;
    console.error(`Supabase ${label} insert error (attempt ${attempt}/3):`, error.message || error);
    if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
    else return error;
  }
}

function genHhhlSignalId(srcCode, dir) {
  const nowMs = Date.now();
  const dirCode = dir === 'BUY' ? '1' : '2';
  const id = `${nowMs}${srcCode}${dirCode}1${String(nowMs).slice(-3)}`;
  return { signalId: id, magic: parseInt(id.slice(-9)) };
}

// ── Vilnius time helper ───────────────────────────────────────────────────
function nowVilnius() {
  // Always store timestamps in Europe/Vilnius time (UTC+3 summer, UTC+2 winter)
  const now = new Date();
  const vilnius = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Vilnius' }));
  // Reconstruct as ISO string but without timezone offset (store as-is)
  const pad = n => String(n).padStart(2, '0');
  return `${vilnius.getFullYear()}-${pad(vilnius.getMonth()+1)}-${pad(vilnius.getDate())}T${pad(vilnius.getHours())}:${pad(vilnius.getMinutes())}:${pad(vilnius.getSeconds())}.000+00:00`;
}

// ── Rate limit viešiems GET endpointams ────────────────────────────────────
// Paprastas fixed-window per-IP limiteris (be papildomų dependency).
// Railway veikia už proxy, todėl trust proxy reikalingas teisingam req.ip.
app.set('trust proxy', 1);
const rateMap = new Map();
function rateLimit(limit = 60, windowMs = 60_000) {
  return (req, res, next) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const entry = rateMap.get(ip);
    if (!entry || now - entry.start > windowMs) {
      rateMap.set(ip, { start: now, count: 1 });
      return next();
    }
    if (++entry.count > limit) return res.status(429).json({ error: 'Too many requests' });
    next();
  };
}
// Periodinis senų įrašų valymas, kad Map neaugtų neribotai
setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [ip, entry] of rateMap) {
    if (entry.start < cutoff) rateMap.delete(ip);
  }
}, 10 * 60_000);
const publicLimiter = rateLimit(60, 60_000);

// ── CORS ───────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: (origin, cb) => {
      const allowed = (process.env.CORS_ALLOWED_ORIGINS || 'https://yourdomain.com,https://www.yourdomain.com,http://localhost:3000').split(',');
      if (!origin || allowed.includes(origin)) cb(null, true);
      else cb(new Error('CORS: origin not allowed'));
    },
  })
);

// ── POST /webhook/stripe ───────────────────────────────────────────────────
// Must be registered before express.json() — Stripe requires the raw body
// for signature verification. express.raw() is applied only to this route.
app.post(
  '/webhook/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Stripe signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (DEMO_MODE) {
      console.log('[DEMO] Stripe webhook received but live provisioning skipped');
      return res.json({ received: true, demo: true });
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const email = cleanEmail(session.customer_details?.email || session.customer_email);
        const name = session.customer_details?.name || '';
        const plan = getPlanFromCheckoutSession(session);
        console.log('Stripe session metadata:', JSON.stringify(session.metadata), 'plan:', plan);
        const stripeCustomerId = session.customer || null;

        if (email) {
          const { error: dbError } = await supabase.from('clients').upsert({
            email,
            name,
            plan,
            active: true,
            stripe_customer_id: stripeCustomerId,
          }, { onConflict: 'email' });
          if (dbError) console.error('Supabase clients insert error:', dbError);
        } else {
          console.error('Stripe checkout session completed without email:', session.id);
        }

        const resumeLink = email && plan
          ? `${process.env.FRONTEND_URL || 'https://yourdomain.com'}/onboarding.html?token=${encodeURIComponent(createOnboardingToken(email, plan))}`
          : '';
        const newClientMsg =
          `🆕 Naujas klientas!\n` +
          `👤 ${name}\n` +
          `💰 Planas: ${plan}\n` +
          `📧 ${email}` +
          (resumeLink ? `\n🔁 Resume onboarding: ${resumeLink}` : '');
        await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, newClientMsg);

        if ((plan === 'Signalas' || plan === 'Automatinis') && email) {
          const { data: clientRow } = await supabase
            .from('clients')
            .select('telegram_user_id')
            .eq('email', email)
            .maybeSingle();
          if (clientRow?.telegram_user_id) {
            const welcomeMsg = plan === 'Signalas'
              ? 'Sveiki! 🎉 Ačiū už užsakymą. Netrukus būsite pridėti į VIP signalų grupę Telegram. Susisieksime greitu metu.\n\nWelcome! 🎉 Thank you for your purchase. You will be added to the VIP signals group on Telegram shortly. We\'ll be in touch soon.'
              : 'Sveiki! 🎉 Ačiū už užsakymą. Netrukus susisieksime ir padėsime prijungti sąskaitą. Kilus klausimų — rašykite į Telegram.\n\nWelcome! 🎉 Thank you for your purchase. We will be in touch shortly to help you connect your account. If you have any questions — message us on Telegram.';
            await sendTelegram(clientRow.telegram_user_id, welcomeMsg);
          }
        }
      } else if (event.type === 'customer.subscription.deleted') {
        const stripeCustomerId = event.data.object.customer;
        const { data: client } = await supabase
          .from('clients')
          .select('*')
          .eq('stripe_customer_id', stripeCustomerId)
          .maybeSingle();
        if (client) {
          let cleanupOk = true;
          if (client.metaapi_account_id) {
            const copyFactoryDelete = await deleteCopyFactorySubscriber(client.metaapi_account_id);
            console.log('CopyFactory unsubscribe (subscription deleted):', copyFactoryDelete.status, 'for', client.email);
            if (!copyFactoryDelete.ok) {
              cleanupOk = false;
              await sendTelegram(
                process.env.TELEGRAM_ADMIN_CHAT_ID,
                `❌ CopyFactory klaida atšaukiant prenumeratą ${client.email}: HTTP ${copyFactoryDelete.status}. Supabase NEATNAUJINTA.\n${String(copyFactoryDelete.body || '').slice(0, 500)}`
              );
            }

            if (cleanupOk) {
              const metaApiDelete = await deleteMetaApiAccount(client.metaapi_account_id);
              console.log('MetaAPI delete (subscription deleted):', metaApiDelete.deleteStatus, 'undeploy:', metaApiDelete.undeployStatus, 'for', client.email);
              if (!metaApiDelete.ok) {
                cleanupOk = false;
                await sendTelegram(
                  process.env.TELEGRAM_ADMIN_CHAT_ID,
                  `❌ MetaAPI klaida atšaukiant prenumeratą ${client.email}: HTTP ${metaApiDelete.deleteStatus}. Supabase NEATNAUJINTA.\n${String(metaApiDelete.body || '').slice(0, 500)}`
                );
              }
            }
          }
          if (cleanupOk) {
            const updateData = { active: false };
            if (client.metaapi_account_id) updateData.metaapi_account_id = null;
            await supabase.from('clients').update(updateData).eq('email', client.email);
            await sendTelegram(
              process.env.TELEGRAM_ADMIN_CHAT_ID,
              `❌ Prenumerata baigėsi: ${client.email}` +
              (client.metaapi_account_id ? '\nCopyFactory: istrinta\nMetaAPI: istrinta' : '')
            );
          }
        } else {
          console.warn('customer.subscription.deleted: no client found for stripe_customer_id', stripeCustomerId);
        }
      }

      res.json({ received: true });
    } catch (err) {
      console.error('POST /webhook/stripe error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ── Static files — serve frontend/ directory ──────────────────────────────
app.use(express.static(__dirname + '/../frontend'));

// ── JSON for all other routes ──────────────────────────────────────────────
app.use(express.json());

// ── Global DEMO_MODE write blocker ────────────────────────────────────────
// In demo mode, block ALL non-demo write requests at the middleware level.
// /api/demo/* and GET requests pass through. Stripe webhook is handled above
// (before express.json) and has its own DEMO_MODE early-return inside.
if (DEMO_MODE) {
  app.use((req, res, next) => {
    const writeMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
    if (writeMethods.includes(req.method) && !req.path.startsWith('/api/demo')) {
      return res.status(503).json({ error: 'Demo mode active — live operations disabled', demo: true });
    }
    next();
  });
}

// ── GET / ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'aurora-fx-gold' });
});

// ── DEMO endpoints (portfolio mode — synthetic data only) ──────────────────
// Schema matches frontend mapRawTrade() expectations exactly.
const DEMO_TRADES = [
  { id: 1, signal_id: '17220000000110101001', symbol: 'XAUUSD', direction: 'BUY',  entry: 2318.50, exit: 2328.50, tp: 2328.50, sl: 2308.50, lot: 0.10, status: 'closed', result: 'TP1', profit:  10.0, src_code: 6,  opened_at: '2026-08-01T09:15:00.000+00:00', closed_at: '2026-08-01T14:32:00.000+00:00' },
  { id: 2, signal_id: '17230000000120201002', symbol: 'XAUUSD', direction: 'SELL', entry: 2345.20, exit: 2335.20, tp: 2335.20, sl: 2355.20, lot: 0.10, status: 'closed', result: 'TP1', profit:  10.0, src_code: 6,  opened_at: '2026-08-05T11:00:00.000+00:00', closed_at: '2026-08-05T16:45:00.000+00:00' },
  { id: 3, signal_id: '17240000000130101003', symbol: 'XAUUSD', direction: 'BUY',  entry: 2301.00, exit: 2291.00, tp: 2321.00, sl: 2291.00, lot: 0.10, status: 'closed', result: 'SL',  profit: -10.0, src_code: 9,  opened_at: '2026-08-10T08:30:00.000+00:00', closed_at: '2026-08-10T10:15:00.000+00:00' },
  { id: 4, signal_id: '17250000000140201004', symbol: 'XAUUSD', direction: 'SELL', entry: 2378.90, exit: 2368.90, tp: 2368.90, sl: 2388.90, lot: 0.10, status: 'closed', result: 'TP1', profit:  10.0, src_code: 11, opened_at: '2026-08-15T13:00:00.000+00:00', closed_at: '2026-08-15T18:22:00.000+00:00' },
  { id: 5, signal_id: '17260000000150101005', symbol: 'XAUUSD', direction: 'BUY',  entry: 2330.75, exit: null,    tp: 2350.75, sl: 2320.75, lot: 0.10, status: 'open',   result: null,  profit:   null, src_code: 6,  opened_at: '2026-08-28T07:00:00.000+00:00', closed_at: null },
];

app.get('/api/demo/trades', publicLimiter, (req, res) => {
  res.json(DEMO_TRADES);
});

app.get('/api/demo/open-trades', publicLimiter, (req, res) => {
  res.json(DEMO_TRADES.filter(t => t.status === 'open'));
});

app.get('/api/demo/pnl/today', publicLimiter, (req, res) => {
  res.json({ total_profit: 10.0, trade_count: 1 });
});

app.get('/api/demo/pnl/monthly', publicLimiter, (req, res) => {
  res.json({ total_profit: 20.0, trade_count: 4, wins: 3, losses: 1, winrate: 75.0 });
});

app.get('/api/demo/checkout-session', publicLimiter, (req, res) => {
  res.json({ email: 'demo@aurora-demo.example.com', plan: 'Automatinis', demo: true });
});

app.get('/api/demo/onboarding-resume', publicLimiter, (req, res) => {
  res.json({ email: 'demo@aurora-demo.example.com', plan: 'Automatinis', demo: true });
});

app.post('/api/demo/connect-account', publicLimiter, (req, res) => {
  res.json({ ok: true, demo: true, message: 'Demo mode — no broker connection made.' });
});

app.get('/checkout-session', async (req, res) => {
  try {
    const sessionId = String(req.query.session_id || '').trim();

    if (!sessionId.startsWith('cs_')) {
      return res.status(400).json({ error: 'Missing checkout session id' });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.status !== 'complete') {
      return res.status(402).json({ error: 'Checkout session is not complete' });
    }

    const email = cleanEmail(session.customer_details?.email || session.customer_email);
    const name = session.customer_details?.name || '';
    const plan = getPlanFromCheckoutSession(session);
    const stripeCustomerId = session.customer || null;

    if (!email) {
      return res.status(400).json({ error: 'Missing checkout email' });
    }

    const { error: dbError } = await supabase.from('clients').upsert({
      email,
      name,
      plan,
      active: true,
      stripe_customer_id: stripeCustomerId,
    }, { onConflict: 'email' });
    if (dbError) throw dbError;

    res.json({ email, name, plan });
  } catch (err) {
    console.error('GET /checkout-session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /onboarding-resume - resume paid onboarding without a Stripe session URL
app.get('/onboarding-resume', async (req, res) => {
  try {
    const payload = verifyOnboardingToken(req.query.token);
    const { data: client, error } = await supabase
      .from('clients')
      .select('email, name, plan, active')
      .eq('email', payload.email)
      .maybeSingle();
    if (error) throw error;
    if (!client || !client.active) {
      return res.status(403).json({ error: 'No active subscription found' });
    }

    res.json({
      email: client.email,
      name: client.name || '',
      plan: client.plan || payload.plan,
    });
  } catch (err) {
    console.error('GET /onboarding-resume error:', err);
    res.status(401).json({ error: 'Invalid or expired onboarding link' });
  }
});

const METAAPI_REGIONS = ['london', 'new-york'];

async function metaApiFetch(path, options = {}) {
  let lastErr;
  for (const region of METAAPI_REGIONS) {
    const url = `https://mt-client-api-v1.${region}.agiliumtrade.ai${path}`;
    try {
      const res = await fetch(url, options);
      // If response is not JSON (e.g. HTML error page), try next region
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json') && !res.ok) {
        console.warn(`MetaAPI ${region} returned non-JSON (${res.status}), trying next region`);
        lastErr = new Error(`HTTP ${res.status} from ${region}`);
        continue;
      }
      return res;
    } catch (err) {
      console.warn(`MetaAPI ${region} failed (${err.code || err.message}), trying next region`);
      lastErr = err;
    }
  }
  throw lastErr;
}

// ── MetaAPI helpers ────────────────────────────────────────────────────────
async function openTrade(symbol, action, volume, takeProfit, stopLoss, magic, openPrice, orderType = 'limit', comment = null, noTp = false) {
  let actionType;
  if (orderType === 'market') {
    actionType = action === 'BUY' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL';
  } else {
    actionType = action === 'BUY' ? 'ORDER_TYPE_BUY_LIMIT' : 'ORDER_TYPE_SELL_LIMIT';
  }
  const body = { actionType, symbol, volume, magic };
  if (!noTp) body.takeProfit = takeProfit;
  if (stopLoss !== undefined && stopLoss !== null) body.stopLoss = stopLoss;
  if (orderType !== 'market' && openPrice !== undefined) body.openPrice = openPrice;
  if (comment) body.comment = comment;

  let data;
  for (let attempt = 0; attempt <= 2; attempt++) {
    const res = await metaApiFetch(
      `/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/trade`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'auth-token': process.env.METAAPI_TOKEN,
        },
        body: JSON.stringify(body),
      }
    );
    data = await res.json();
    console.log(`MetaAPI openTrade response (attempt ${attempt + 1}):`, JSON.stringify(data));
    const isTooMany = data?.error === 'TooManyRequestsError';
    const isCallable = JSON.stringify(data).includes('Failed to execute a callable');
    if (!isTooMany && !isCallable) break;
    const retryDelay = isTooMany ? 7000 : 2000;
    console.warn(`MetaAPI ${isTooMany ? 'TooManyRequests' : 'callable'} — retry in ${retryDelay/1000}s (attempt ${attempt + 1}/3)`);
    if (attempt < 2) await new Promise(r => setTimeout(r, retryDelay));
  }

  // Fallback to market order if limit was rejected due to price too close
  const limitFailed = orderType !== 'market' && data && (
    data.stringCode === 'ERR_INVALID_STOPS' ||
    data.stringCode === 'ERR_INVALID_PRICE' ||
    data.numericCode === 130 ||
    data.numericCode === 129
  );
  if (limitFailed) {
    console.log('Limit order failed, falling back to market order');
    const marketActionType = action === 'BUY' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL';
    const marketBody = { actionType: marketActionType, symbol, volume, magic };
    if (!noTp) marketBody.takeProfit = takeProfit;
    if (stopLoss !== undefined && stopLoss !== null) marketBody.stopLoss = stopLoss;
    const marketRes = await metaApiFetch(
      `/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/trade`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'auth-token': process.env.METAAPI_TOKEN,
        },
        body: JSON.stringify(marketBody),
      }
    );
    data = await marketRes.json();
    console.log('MetaAPI market fallback response:', JSON.stringify(data));
  }

  return data;
}

async function getActualOpenPrice(magic) {
  await new Promise(r => setTimeout(r, 1500));
  try {
    const res = await metaApiFetch(
      `/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/positions`,
      { headers: { 'auth-token': process.env.METAAPI_TOKEN } }
    );
    const positions = await res.json();
    if (!Array.isArray(positions)) return null;
    return positions.find(p => p.magic === magic)?.openPrice ?? null;
  } catch { return null; }
}

async function closeTradeByMagic(magic) {
  const positionsRes = await metaApiFetch(
    `/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/positions`,
    {
      headers: { 'auth-token': process.env.METAAPI_TOKEN },
    }
  );
  const positions = await positionsRes.json();
  if (!Array.isArray(positions)) {
    console.log('Positions response not array:', JSON.stringify(positions));
    return null;
  }
  const target = positions.find(p => p.magic === magic);
  if (!target) {
    console.log('No open position with magic:', magic);
    return null;
  }
  const exitPrice = target.currentPrice;
  const profit = target.profit;
  const closeRes = await metaApiFetch(
    `/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/trade`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'auth-token': process.env.METAAPI_TOKEN,
      },
      body: JSON.stringify({
        actionType: 'POSITION_CLOSE_ID',
        positionId: target.id,
      }),
    }
  );
  const data = await closeRes.json();
  console.log('MetaAPI closeTrade response:', JSON.stringify(data));
  const ok = closeRes.ok && isMetaApiTradeSuccess(data);
  if (!ok) console.error('MetaAPI closeTrade rejected:', JSON.stringify(data));
  return { ok, data, exitPrice, profit };
}

async function movePositionStopLoss(positionId, stopLoss, takeProfit = null) {
  const body = {
    actionType: 'POSITION_MODIFY',
    positionId,
    stopLoss,
  };
  if (takeProfit !== undefined && takeProfit !== null) body.takeProfit = takeProfit;

  const res = await metaApiFetch(
    `/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/trade`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'auth-token': process.env.METAAPI_TOKEN,
      },
      body: JSON.stringify(body),
    }
  );
  const data = await res.json();
  console.log('MetaAPI POSITION_MODIFY response:', JSON.stringify(data));
  return { ok: res.ok && isMetaApiTradeSuccess(data), status: res.status, data };
}



function getTradeKey(row) {
  return String(row.signal_id || row.magic);
}

function getTpMilestoneKey(row, label) {
  return `${getTradeKey(row)}:${label}`;
}

function tpMilestoneHit(row, position, tp) {
  const currentPrice = Number(position.currentPrice);
  if (!Number.isFinite(currentPrice)) return false;
  return row.direction === 'BUY'
    ? currentPrice >= tp.price
    : currentPrice <= tp.price;
}

async function monitorTakeProfitMilestones() {
  if (tpMonitorRunning) return;
  tpMonitorRunning = true;
  try {
    const { data: openRows, error } = await supabase
      .from('trades')
      .select('magic, signal_id, symbol, direction, entry, tp, result, tg_message_id, tg_chat_id, src_code')
      .eq('status', 'open');
    if (error) {
      console.error('TP monitor select error:', error);
      return;
    }
    if (!openRows || openRows.length === 0) {
      tpMilestoneNotified.clear();
      tpMilestoneInProgress.clear();
      return;
    }

    const openTradeKeys = new Set(openRows.map(getTradeKey));
    for (const key of [...tpMilestoneNotified]) {
      if (!openTradeKeys.has(key.split(':')[0])) tpMilestoneNotified.delete(key);
    }
    for (const key of [...tpMilestoneInProgress]) {
      if (!openTradeKeys.has(key.split(':')[0])) tpMilestoneInProgress.delete(key);
    }

    const headers = { 'auth-token': process.env.METAAPI_TOKEN };
    const accountId = process.env.METAAPI_MASTER_ACCOUNT_ID;
    const positions = await (await metaApiFetch(`/users/current/accounts/${accountId}/positions`, { headers })).json();
    if (!Array.isArray(positions)) return;

    const positionsByMagic = new Map(positions.map(p => [p.magic, p]));
    let needsReconcile = false;
    for (const row of openRows) {
      // HHHL trades are in MT5, not MT4 — handled by reconcileHhhlTrades
      if (Number(row.src_code) === 10 || Number(row.src_code) === 11) continue;

      const position = positionsByMagic.get(row.magic);
      if (!position) {
        // Position gone from MT4 — trigger reconciler immediately instead of waiting 10min
        needsReconcile = true;
        continue;
      }
      if (String(row.signal_id || '').endsWith('_a')) continue;

      const entry = Number(row.entry);
      const finalTp = Number(row.tp);
      if (!Number.isFinite(entry) || !Number.isFinite(finalTp)) continue;

      // Single-TP agents manage their own close notifications — skip milestone monitor entirely
      if (SINGLE_STEP_TP_SRC_CODES.has(Number(row.src_code))) continue;

      const openMeta = parseOpenTradeResult(row.result);
      const tpLevels = getTakeProfitLevelsForRow(row);
      if (tpLevels.length < 2 || tpLevels[0].label !== 'TP1') continue;

      const persistedMilestones = openMeta.hits;

      // Pre-mark any TPs that were already past the fill price — prevents instant false TP hits
      // when a market order fills at a price already beyond a TP level.
      const fillPrice = Number(position.openPrice);
      if (Number.isFinite(fillPrice)) {
        let silentlyMarked = false;
        for (const tp of tpLevels) {
          if (persistedMilestones.has(tp.label)) continue;
          const filledPast = row.direction === 'BUY' ? fillPrice >= tp.price : fillPrice <= tp.price;
          if (filledPast) {
            persistedMilestones.add(tp.label);
            tpMilestoneNotified.add(getTpMilestoneKey(row, tp.label));
            silentlyMarked = true;
          }
        }
        if (silentlyMarked) {
          await supabase.from('trades')
            .update({ result: formatOpenTradeResultMeta(openMeta.tpLevels, persistedMilestones) })
            .eq('magic', row.magic).eq('status', 'open');
        }
      }

      for (const tp of tpLevels) {
        if (!tpMilestoneHit(row, position, tp)) continue;
        const milestoneKey = getTpMilestoneKey(row, tp.label);
        if (persistedMilestones.has(tp.label)) {
          tpMilestoneNotified.add(milestoneKey);
          continue;
        }
        if (tpMilestoneNotified.has(milestoneKey) || tpMilestoneInProgress.has(milestoneKey)) continue;

        tpMilestoneInProgress.add(milestoneKey);
        try {
          const chatId = row.tg_chat_id || process.env.TELEGRAM_CHAT_ID_XAU;
          const line = `🟢 ${row.symbol || 'XAUUSD'} ${row.direction || ''} — ${tp.label} hit`.replace(/\s+/g, ' ');
          const tpIndex = tpLevels.findIndex(t => t.label === tp.label);
          const isFinalTp = tpIndex === tpLevels.length - 1;

          if (tpIndex === 0) {
            const telegramText = `${line}\nID ${row.signal_id}`;
            await sendTelegram(chatId, telegramText, row.tg_message_id ? { reply_to_message_id: row.tg_message_id } : {});
            try {
              const slResult = await movePositionStopLoss(position.id, entry, finalTp);
              console.log(`SL moved to entry ${entry} after TP1 (magic=${row.magic}):`, slResult.ok ? 'ok' : 'failed', slResult.data);
              if (slResult.ok) {
                await supabase.from('trades').update({ sl: entry }).eq('magic', row.magic).eq('status', 'open');
              }
            } catch (slErr) {
              console.error(`SL move to entry failed (magic=${row.magic}):`, slErr.message);
            }
          } else if (!isFinalTp) {
            // Intermediate TP (TP2, TP3... when not the last level)
            const telegramText = `${line}\nID ${row.signal_id}`;
            await sendTelegram(chatId, telegramText, row.tg_message_id ? { reply_to_message_id: row.tg_message_id } : {});
          }
          // Final TP: don't notify from monitor — let reconcile confirm the close and send correct message
          // (avoids sending "Final TP hit" when position actually closes at BE due to race condition)
          if (!isFinalTp) {
            persistedMilestones.add(tp.label);
            const { error: persistError } = await supabase
              .from('trades')
              .update({ result: formatOpenTradeResultMeta(openMeta.tpLevels, persistedMilestones) })
              .eq('magic', row.magic)
              .eq('status', 'open');
            if (persistError) console.error('TP milestone persist error:', persistError);
          }
          tpMilestoneNotified.add(milestoneKey);
          console.log('TP milestone notified:', row.magic, tp.label, isFinalTp ? '(final — reconcile will close)' : '');
          setTimeout(reconcileOpenTrades, 2_000);
        } catch (tpErr) {
          console.error('TP milestone monitor error:', tpErr);
        } finally {
          tpMilestoneInProgress.delete(milestoneKey);
        }
      }
    }
    if (needsReconcile) setTimeout(reconcileOpenTrades, 2_000);
  } catch (err) {
    console.error('monitorTakeProfitMilestones error:', err);
  } finally {
    tpMonitorRunning = false;
  }
}

async function cancelOrderByMagic(magic) {
  const ordersRes = await metaApiFetch(
    `/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/orders`,
    {
      headers: { 'auth-token': process.env.METAAPI_TOKEN },
    }
  );
  const orders = await ordersRes.json();
  const target = Array.isArray(orders) ? orders.find(o => o.magic === magic) : null;
  if (!target) {
    console.log('No pending order with magic:', magic);
    return null;
  }
  const cancelRes = await metaApiFetch(
    `/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/trade`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'auth-token': process.env.METAAPI_TOKEN,
      },
      body: JSON.stringify({ actionType: 'ORDER_CANCEL', orderId: target.id }),
    }
  );
  const data = await cancelRes.json();
  console.log('MetaAPI cancelOrder response:', JSON.stringify(data));
  const ok = cancelRes.ok && isMetaApiTradeSuccess(data);
  if (!ok) console.error('MetaAPI cancelOrder rejected:', JSON.stringify(data));
  return { ok, target, data };
}

async function getClosedDealByMagic(magic) {
  const endTime = new Date().toISOString();
  const startTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const dealsRes = await metaApiFetch(
    `/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/history-deals/time/${startTime}/${endTime}`,
    {
      headers: { 'auth-token': process.env.METAAPI_TOKEN },
    }
  );
  const deals = await dealsRes.json();
  const deal = Array.isArray(deals)
    ? deals.find(d => d.magic === magic && (d.type === 'DEAL_TYPE_SELL' || d.type === 'DEAL_TYPE_BUY') && d.entryType === 'DEAL_ENTRY_OUT')
    : null;
  const result = deal ? { exitPrice: deal.price, profit: deal.profit } : null;
  console.log('Deal history result:', JSON.stringify(result));
  return result;
}

// ── Open trades reconcile ──────────────────────────────────────────────────
// Agentų trade'ai neturi išorinio CLOSE TRADE šaltinio — TP/SL vykdo tik MT4.
// Kas 10 min tikrinam: jei atviro DB trade'o magic nebėra nei pozicijose, nei
// pending orderiuose, ieškom uždarymo deal'o istorijoje ir uždarom DB eilutę
// + siunčiam close žinutę į kanalus.
// TODO TradeSync migracija: pakeisti tik metaApiFetch callus, logika lieka.
async function reconcileOpenTrades() {
  try {
    const { data: openRows } = await supabase
      .from('trades')
      .select('magic, signal_id, symbol, direction, entry, tp, result, tg_message_id, tg_chat_id, src_code')
      .eq('status', 'open');
    if (!openRows || openRows.length === 0) return;

    const headers = { 'auth-token': process.env.METAAPI_TOKEN };
    const accountId = process.env.METAAPI_MASTER_ACCOUNT_ID;

    const positions = await (await metaApiFetch(`/users/current/accounts/${accountId}/positions`, { headers })).json();
    if (!Array.isArray(positions)) return; // MetaAPI neprieinamas — bandysim kitą ciklą
    const orders = await (await metaApiFetch(`/users/current/accounts/${accountId}/orders`, { headers })).json();
    if (!Array.isArray(orders)) return;

    const liveMagics = new Set([...positions.map(p => Number(p.magic)), ...orders.map(o => Number(o.magic))]);
    const stale = openRows.filter(r => !liveMagics.has(Number(r.magic)));
    if (stale.length === 0) return;

    const endTime = new Date().toISOString();
    const startTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const deals = await (await metaApiFetch(
      `/users/current/accounts/${accountId}/history-deals/time/${startTime}/${endTime}`,
      { headers }
    )).json();
    if (!Array.isArray(deals)) return;

    for (const row of stale) {
      if (!row.magic || Number(row.magic) === 0) {
        await supabase.from('trades').update({ status: 'closed', result: 'Manual', closed_at: nowVilnius() }).eq('signal_id', row.signal_id).eq('status', 'open');
        console.log('Reconcile: auto-closed magic=0 row, signal_id:', row.signal_id);
        continue;
      }
      const outDeals = deals.filter(d =>
        Number(d.magic) === Number(row.magic) &&
        (d.type === 'DEAL_TYPE_SELL' || d.type === 'DEAL_TYPE_BUY') &&
        d.entryType === 'DEAL_ENTRY_OUT'
      );
      if (outDeals.length === 0) continue; // atšauktas/pasenęs orderis arba deal'as senesnis nei 48h — paliekam

      const profit = outDeals.reduce((s, d) => s + (d.profit || 0), 0);
      const exitPrice = outDeals[outDeals.length - 1].price ?? null;
      const atTpLevel = row.tp && exitPrice && Math.abs(exitPrice - row.tp) <= 5;
      let result = profit > 0 && !atTpLevel ? 'Manual'
        : profit > 0 ? 'TP'
        : 'SL';
      const { error: updError } = await supabase
        .from('trades')
        .update({ status: 'closed', result, closed_at: nowVilnius(), exit: exitPrice, profit })
        .eq('magic', row.magic)
        .eq('status', 'open');
      if (updError) { console.error('Reconcile update error:', updError); continue; }

      // Skip notification for secondary Order A trades (_a) — TP1 hit is notified by milestone monitor
      if (String(row.signal_id || '').endsWith('_a')) {
        console.log('Reconciled closed Order A trade (silent):', row.magic, result, 'profit:', profit);
        continue;
      }

      // Skip notification if final TP was already sent by milestone monitor
      const reconMeta = parseOpenTradeResult(row.result);
      const reconTpLevels = getTakeProfitLevelsForRow(row);
      const finalTpLabel = reconTpLevels.length > 1 ? reconTpLevels[reconTpLevels.length - 1].label : null;
      const finalTpAlreadyNotified = finalTpLabel && reconMeta.hits.has(finalTpLabel);
      if (finalTpAlreadyNotified) {
        console.log('Reconciled closed trade (notification already sent):', row.magic, result, 'profit:', profit);
        continue;
      }

      const chatId = row.tg_chat_id || process.env.TELEGRAM_CHAT_ID_XAU;
      const profitStr = profit != null ? ` | P&L: ${profit > 0 ? '+' : ''}$${profit.toFixed(2)}` : '';
      const exitStr = exitPrice ? ` @ $${Number(exitPrice).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
      // Detect BE close: TP1 was already hit (SL moved to entry), position closed near entry price
      const tp1WasHit = reconMeta.hits.has('TP1');
      const closedNearEntry = exitPrice && row.entry && Math.abs(Number(exitPrice) - Number(row.entry)) <= 3;
      const isBeClose = result === 'SL' && tp1WasHit && closedNearEntry;
      let tgText;
      if (isBeClose) {
        tgText = `🔄 BE hit. Trade closed at entry.\nID ${row.signal_id}`;
      } else if (result === 'Manual') {
        tgText = `🔒 Trade manually closed${exitStr}${profitStr}\nID ${row.signal_id}`;
      } else if (result === 'TP') {
        tgText = `✅ Final TP hit. TRADE CLOSED\nID ${row.signal_id}`;
      } else {
        tgText = `🔴 SL hit.\nID ${row.signal_id}`;
      }
      await sendTelegram(chatId, tgText, row.tg_message_id ? { reply_to_message_id: row.tg_message_id } : {});
      console.log(`Reconciled: magic=${row.magic} signal_id=${row.signal_id} ${row.direction || ''} entry=${row.entry || ''} result=${result} profit=${profit?.toFixed(2)}`);
    }
  } catch (err) {
    console.error('reconcileOpenTrades error:', err);
  }
}
async function reconcileHhhlTrades() {
  try {
    const { data: openRows } = await supabase
      .from('trades')
      .select('magic, signal_id, direction, entry, tp, position_id')
      .eq('status', 'open')
      .in('src_code', [10, 11]);
    if (!openRows || openRows.length === 0) return;

    const accountId = process.env.HHHL_MT5_ACCOUNT_ID;
    if (!accountId) return;
    const headers = { 'auth-token': process.env.METAAPI_TOKEN };

    const positions = await (await metaApiFetch(`/users/current/accounts/${accountId}/positions`, { headers })).json();
    if (!Array.isArray(positions)) return;
    const orders = await (await metaApiFetch(`/users/current/accounts/${accountId}/orders`, { headers })).json();
    if (!Array.isArray(orders)) return;

    const liveMagics = new Set([...positions.map(p => Number(p.magic)), ...orders.map(o => Number(o.magic))]);
    const stale = openRows.filter(r => !liveMagics.has(Number(r.magic)));
    console.log(`[HHHL reconcile] openRows=${openRows.length} positions=${positions.length} orders=${orders.length} stale=${stale.length} liveMagics=[${[...liveMagics].join(',')}]`);
    if (stale.length === 0) return;

    const endTime = new Date().toISOString();
    const startTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const dealsRaw = await (await metaApiFetch(
      `/users/current/accounts/${accountId}/history-deals/time/${startTime}/${endTime}`,
      { headers }
    )).json();
    const deals = Array.isArray(dealsRaw) ? dealsRaw : [];
    console.log(`[HHHL reconcile] deals=${deals.length} dealsRawIsArray=${Array.isArray(dealsRaw)} stalemagics=[${stale.map(r=>r.magic).join(',')}]`);
    if (deals.length > 0) console.log(`[HHHL reconcile] sample deal:`, JSON.stringify(deals[0]));

    for (const row of stale) {
      if (!row.magic || Number(row.magic) === 0) {
        await supabase.from('trades').update({ status: 'closed', result: 'Cancelled', closed_at: nowVilnius() }).eq('signal_id', row.signal_id).eq('status', 'open');
        console.log(`[HHHL reconcile] Skipped magic=0 row, signal_id=${row.signal_id}`);
        continue;
      }
      const outDeals = deals.filter(d =>
        (Number(d.magic) === Number(row.magic) || (row.position_id && d.positionId === String(row.position_id))) &&
        (d.type === 'DEAL_TYPE_SELL' || d.type === 'DEAL_TYPE_BUY') &&
        d.entryType === 'DEAL_ENTRY_OUT'
      );
      console.log(`[HHHL reconcile] magic=${row.magic} posId=${row.position_id} outDeals=${outDeals.length}`);
      if (outDeals.length === 0) {
        // No closing deal — could be MetaAPI sync delay or truly cancelled pending limit.
        // Wait 1 extra cycle (2min) before marking Cancelled, so MT5 deals have time to sync.
        const staleCycles = (hhhlStaleTracker.get(Number(row.magic)) || 0) + 1;
        hhhlStaleTracker.set(Number(row.magic), staleCycles);
        if (staleCycles < 2) {
          console.log(`[HHHL reconcile] No deal yet for magic=${row.magic} (cycle ${staleCycles}) — retry next cycle`);
          continue;
        }
        hhhlStaleTracker.delete(Number(row.magic));
        await supabase.from('trades').update({ status: 'closed', result: 'Cancelled', closed_at: nowVilnius() }).eq('magic', row.magic).eq('status', 'open');
        console.log(`[HHHL reconcile] Cancelled (no deal after 2 cycles): magic=${row.magic}`);
        continue;
      }
      hhhlStaleTracker.delete(Number(row.magic));
      const profit = outDeals.reduce((s, d) => s + (d.profit || 0), 0);
      const exitPrice = outDeals[outDeals.length - 1].price ?? null;
      const atTp = row.tp && exitPrice && Math.abs(exitPrice - row.tp) <= 3;
      const nearEntry = row.entry && exitPrice && Math.abs(exitPrice - Number(row.entry)) <= 2;
      const result = nearEntry && profit === 0 ? 'BE' : profit > 0 && !atTp ? 'Manual' : profit > 0 ? 'TP' : 'SL';
      await supabase.from('trades').update({ status: 'closed', result, closed_at: nowVilnius(), exit: exitPrice, profit }).eq('magic', row.magic).eq('status', 'open');
      console.log(`[HHHL reconcile] magic=${row.magic} ${row.direction} result=${result} profit=${profit?.toFixed(2)}`);
    }
  } catch (err) {
    console.error('[HHHL reconcile] error:', err);
  }
}

if (!DEMO_MODE) {
  setInterval(monitorTakeProfitMilestones, TP_CHECK_INTERVAL_MS);
  setTimeout(monitorTakeProfitMilestones, 5_000);
  setInterval(reconcileOpenTrades, 2 * 60 * 1000);
  setInterval(reconcileHhhlTrades, 2 * 60 * 1000);
  setTimeout(reconcileOpenTrades, 10_000);
  setTimeout(reconcileHhhlTrades, 15_000);
}

function parseWebhookEntrySignal(text) {
  const normalized = String(text || '').replace(/\\n/g, '\n').trim();
  const lines = normalized.split(/\n+/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return null;

  const header = lines[0].match(/^(GOLD|XAUUSD|BTCUSD|ETHUSD|XRPUSD)\s+(BUY|SELL)(?:\s+LIMIT)?\s+([0-9][0-9,]*(?:\.\d+)?)/i);
  if (!header) return null;

  const idLine = lines.find(line => /^ID\s+\d+/i.test(line));
  const idMatch = idLine?.match(/^ID\s+(\d+)/i);
  if (!idMatch) return null;

  const tpLevels = [];
  for (const line of lines) {
    const tpMatch = line.match(/^TP(?:(\d+)\b)?\s*[:\-]?\s*([0-9][0-9,]*(?:\.\d+)?)/i);
    if (!tpMatch) continue;
    tpLevels.push({
      label: tpMatch[1] ? `TP${tpMatch[1]}` : (tpLevels.length ? `TP${tpLevels.length + 1}` : 'TP'),
      price: Number(tpMatch[2].replace(/,/g, '')),
    });
  }
  if (!tpLevels.length) return null;

  const slLine = lines.find(line => /^SL\b/i.test(line));
  const slMatch = slLine?.match(/[0-9][0-9,]*(?:\.\d+)?/);
  const lotLine = lines.find(line => /^LOT\s+/i.test(line));
  const lotMatch = lotLine?.match(/^LOT\s+([0-9]+(?:\.\d+)?)/i);

  const action = header[2].toUpperCase();
  const entryPrice = Number(header[3].replace(/,/g, ''));
  const tpDirection = action === 'BUY' ? 1 : -1;
  const cleanTpLevels = normaliseTakeProfitLevels(tpLevels)
    .filter(tp => tpDirection * (tp.price - entryPrice) > 0);
  if (!cleanTpLevels.length) return null;

  return {
    rawSymbol: header[1].toUpperCase(),
    symbol: header[1].toUpperCase() === 'GOLD' ? 'XAUUSD' : header[1].toUpperCase(),
    action,
    isLimitOrder: /\b(BUY|SELL)\s+LIMIT\b/i.test(lines[0]),
    noSplit: lines.some(l => l.trim().toUpperCase() === 'NOSPLIT'),
    price: entryPrice,
    tpLevels: cleanTpLevels.length > 1
      ? cleanTpLevels.map((tp, index) => ({ label: `TP${index + 1}`, price: tp.price }))
      : cleanTpLevels,
    sl: slMatch ? Number(slMatch[0].replace(/,/g, '')) : null,
    lot: lotMatch ? Number(lotMatch[1]) : null,
    signalId: idMatch[1],
  };
}

function parseSecretTextPayload(raw) {
  let text;
  let bodySecret;
  let silent = false;
  let no_msg = false;
  let comment = null;
  let layer = false;
  let noTp = false;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      try { const parsed = JSON.parse(trimmed); text = parsed.text; bodySecret = parsed.secret; silent = parsed.silent === true; no_msg = parsed.no_msg === true; comment = parsed.comment || null; layer = parsed.layer === true; noTp = parsed.no_tp === true; } catch { text = trimmed; }
    } else { text = trimmed; }
  } else if (raw && typeof raw === 'object') {
    text = raw.text;
    bodySecret = raw.secret;
    silent = raw.silent === true;
    no_msg = raw.no_msg === true;
    comment = raw.comment || null;
    layer = raw.layer === true;
    noTp = raw.no_tp === true;
  }
  return { text, bodySecret, silent, no_msg, comment, layer, noTp };
}

// POST /webhook/telegram-only - forward formatted signals to Telegram only
app.post('/webhook/telegram-only', express.text({ type: '*/*' }), async (req, res) => {
  const { text, bodySecret } = parseSecretTextPayload(req.body);
  if (!bodySecret || bodySecret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!text) return res.status(400).json({ error: 'Missing text' });

  const chatId = process.env.TELEGRAM_CHAT_ID_XAU;
  const tgRes = await sendTelegram(chatId, text);
  if (!tgRes.ok) {
    await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `WARN: Telegram-only signal send failed\n${JSON.stringify(tgRes).slice(0, 400)}\n\n${text.slice(0, 500)}`);
    return res.status(502).json({ ok: false, telegram: tgRes });
  }
  res.json({ ok: true, telegram_message_id: tgRes.result?.message_id || null });
});

// POST /webhook/fvg - signal alerts (market/limit, Supabase, VIP)
app.post('/webhook/fvg', express.text({ type: '*/*' }), async (req, res) => {
  const { text, bodySecret, silent, no_msg, comment, layer, noTp } = parseSecretTextPayload(req.body);
  if (!bodySecret || bodySecret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!text) { console.warn('/webhook/fvg missing text'); return res.status(400).json({ error: 'Missing text' }); }
  if (DEMO_MODE) return res.json({ ok: true, demo: true, message: 'Demo mode — no live trade executed' });

  res.json({ ok: true });

  (async () => {
    try {
      const idMatch = text.match(/ID\s+(\d+)/);
      const signalId = idMatch ? idMatch[1] : null;

      if (text.includes('CLOSE TRADE')) {
        if (!signalId) return;
        const { data: tradeRow } = await supabase.from('trades').select('magic, tg_message_id, tg_chat_id').eq('signal_id', signalId).eq('status', 'open').limit(1).maybeSingle();
        const magic = tradeRow?.magic ?? parseInt(signalId.slice(-9));
        if (!tradeRow) {
          // DB įrašo nėra (entry insert nepavyko / jau uždaryta / dublikuotas close alertas) —
          // pranešam adminui, kad close žinutė nedingtų tyliai
          console.warn('CLOSE TRADE without open DB row, signal_id:', signalId);
          await sendTelegram(
            process.env.TELEGRAM_ADMIN_CHAT_ID,
            `⚠️ CLOSE TRADE be atviro DB įrašo (ID ${signalId}) — į kanalus nepersiųsta.\nGalimos priežastys: dublikuotas alertas, jau uždarytas, arba entry insert buvo nepavykęs.\n\n${text}`
          );
          return;
        }
        const closeResult = await closeTradeByMagic(magic);
        let tradeResult = text.includes('— TP') ? 'TP' : 'SL';
        let exitPrice = null, profit = null;
        if (/\bTP\b/i.test(text)) tradeResult = 'TP';
        let closeOrCancelOk = false;
        if (closeResult?.ok) {
          closeOrCancelOk = true;
          exitPrice = closeResult.exitPrice; profit = closeResult.profit;
          if (!profit) { const d = await getClosedDealByMagic(magic); exitPrice = d?.exitPrice || exitPrice; profit = d?.profit || null; }
        } else {
          const cancelled = await cancelOrderByMagic(magic);
          if (cancelled?.ok) { closeOrCancelOk = true; tradeResult = 'Canceled'; } else { const d = await getClosedDealByMagic(magic); if (d) { closeOrCancelOk = true; exitPrice = d.exitPrice || null; profit = d.profit ?? null; } }
        }
        if (!closeOrCancelOk) {
          await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `WARN: CLOSE TRADE not confirmed by MetaAPI\nID ${signalId}\nMagic ${magic}\n\n${text}`);
          return;
        }
        if (tradeResult === 'Canceled') {
          // Atšaukti pending orderiai nesaugomi — įrašas trinamas iš DB
          await supabase.from('trades').delete().eq('magic', magic).eq('status', 'open');
        } else {
          await supabase.from('trades').update({ status: 'closed', result: tradeResult, closed_at: nowVilnius(), exit: exitPrice, profit }).eq('magic', magic).eq('status', 'open');
        }
        const chatId = tradeRow.tg_chat_id || process.env.TELEGRAM_CHAT_ID_XAU;
        const options = tradeRow.tg_message_id ? { reply_to_message_id: tradeRow.tg_message_id } : {};
        const closeLine = text.split(/\n+/).map(line => line.trim()).find(Boolean) || text;
        const channelCloseText = tradeResult === 'Canceled'
          ? `${closeLine}\n\nCLOSE TRADE`
          : text;
        await sendTelegram(chatId, channelCloseText, options);

      } else {
        // SL variants: "SL - OPEN 4163.4" (price), "SL 4163.4" (price), "SL OPEN" / "SL - OPEN" (no price -> no hard SL on MT4)
        const entrySignal = parseWebhookEntrySignal(text);
        let tgText = text;
        // Declared at outer scope so they're accessible in the if(!silent) block below
        let displayTpLevels = [];
        let lotLabel = '';
        if (entrySignal) {
          const { action, symbol, isLimitOrder, signalId: entrySignalId } = entrySignal;
          const magic = parseInt(entrySignalId.slice(-9));
          const srcCode = getSignalSourceCode(entrySignalId);
          const customDisplayTpLevels = entrySignal.tpLevels.length > 1
            ? entrySignal.tpLevels.slice(0, MAX_GENERATED_TP_LEVELS)
            : [];
          const displayEntry = entrySignal.price;
          const displayTp = (customDisplayTpLevels.length ? customDisplayTpLevels : entrySignal.tpLevels).at(-1)?.price;
          const displaySl = entrySignal.sl;
          if (!Number.isFinite(displayEntry) || !Number.isFinite(displayTp)) {
            console.error('Invalid parsed entry signal:', JSON.stringify(entrySignal));
            await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `WARN: signal parse failed, invalid entry/TP\n${text}`);
            return;
          }
          // NOSPLIT signals (EMA, ride): single TP display only
          const generatedDisplayTpLevels = (customDisplayTpLevels.length || noTp || entrySignal.noSplit)
            ? []
            : buildSplitTakeProfits(action, displayEntry, displayTp, 10, getGeneratedTpLevelLimit(srcCode));
          displayTpLevels = customDisplayTpLevels.length
            ? customDisplayTpLevels.slice(0, 2)
            : (noTp || entrySignal.noSplit)
              ? [{ label: 'TP', price: displayTp }]
              : filterMinTpGap(generatedDisplayTpLevels, action).slice(0, 2);
          if (displayTpLevels.length === 1 && displayTpLevels[0].label === 'TP1') {
            displayTpLevels = [{ label: 'TP', price: displayTpLevels[0].price }];
          }
          const rawEntry = displayEntry;
          const rawTpLevels = displayTpLevels.map(tp => ({ label: tp.label, price: tp.price }));
          const rawTp = (rawTpLevels.length ? rawTpLevels : [{ price: displayTp }]).at(-1).price;
          const volume = 0.5;
          // Split: when signal has multiple TPs (Order A → TP1, main → final TP)
          const isSplitOrder = !entrySignal.noSplit && displayTpLevels.length >= 2;
          // NOSPLIT: full lot (no Order A pairing)
          const tradeVolume = entrySignal.noSplit
            ? volume
            : Math.round(volume / 2 * 100) / 100;
          const rawSl = displaySl;
          const tpLines = formatTakeProfitLines(displayTpLevels, ':');
          lotLabel = isSplitOrder
            ? `${formatSignalPrice(tradeVolume)} × 2 (${formatSignalPrice(volume)} total)`
            : formatSignalPrice(tradeVolume);
          tgText = noTp
            ? [
                `🔔 ${symbol} ${action} ${formatSignalPrice(displayEntry)}`,
                `LOT ${lotLabel}`,
                `ID ${entrySignalId}`,
              ].join('\n')
            : [
                `${symbol} ${action}${isLimitOrder ? ' LIMIT' : ''} ${formatSignalPrice(displayEntry)}`,
                tpLines,
                `SL ${displaySl !== null ? formatSignalPrice(displaySl) : 'OPEN'}`,
                `LOT ${lotLabel}`,
                `ID ${entrySignalId}`,
                comment ? `\n💬 ${comment}` : null,
              ].filter(Boolean).join('\n');
          const bufferedSl = rawSl
            ? (action === 'BUY' ? rawSl - 0.4 : rawSl + 0.4)
            : null;
          let tradeOpenData = null;
          let tradeOpened = false;
          try {
            tradeOpenData = await openTrade(symbol, action, tradeVolume, rawTp, bufferedSl, magic, isLimitOrder ? rawEntry : null, isLimitOrder ? 'limit' : 'market', null, noTp);
            tradeOpened = isMetaApiTradeSuccess(tradeOpenData);
            if (!tradeOpened) console.error('openTrade rejected:', JSON.stringify(tradeOpenData));
          } catch (tradeErr) {
            console.error('openTrade error (MetaAPI down?):', tradeErr.message);
          }
          // Order A: half lot to TP1 (10pt) — closes at first split level
          if (tradeOpened && !entrySignal.noSplit && displayTpLevels.length >= 2) {
            const tp1Price = displayTpLevels[0].price;
            const magicA = (magic + 1) % 2147483647;
            try {
              const orderAData = await openTrade(symbol, action, tradeVolume, tp1Price, bufferedSl, magicA, isLimitOrder ? rawEntry : null, isLimitOrder ? 'limit' : 'market');
              const orderAOpened = isMetaApiTradeSuccess(orderAData);
              if (orderAOpened) {
                console.log(`Order A placed: ${symbol} ${action} TP1=${tp1Price} magic=${magicA}`);
                if (!silent) {
                  const actualEntryA = await getActualOpenPrice(magicA);
                  const insertErrorA = await supabaseInsertWithRetry('trades', {
                    symbol, direction: action, entry: actualEntryA ?? rawEntry, sl: rawSl,
                    tp: tp1Price, lot: tradeVolume, magic: magicA,
                    signal_id: entrySignalId + '_a', src_code: srcCode,
                    status: 'open', opened_at: nowVilnius(),
                  }, `Order A ${entrySignalId}`);
                  if (insertErrorA) await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `WARN: Supabase Order A insert failed after 3 retries\n${symbol} ${action}\nID ${entrySignalId}\n${insertErrorA.message || JSON.stringify(insertErrorA).slice(0, 200)}`);
                }
              } else {
                console.error('Order A placement failed:', JSON.stringify(orderAData));
              }
            } catch (e) {
              console.error('Order A (TP1) placement failed:', e.message);
            }
          }
          if (silent) {
            if (!tradeOpened) console.warn(`[silent] MT4 order failed: ${symbol} ${action}`);
          } else {
            if (tradeOpened) {
              const actualEntry = await getActualOpenPrice(magic);
              const insertData = { symbol, direction: action, entry: actualEntry ?? rawEntry, sl: rawSl, tp: noTp ? null : rawTp, lot: tradeVolume, magic, signal_id: entrySignalId, src_code: srcCode, status: 'open', opened_at: nowVilnius() };
              if (!noTp && rawTpLevels.length) insertData.result = formatOpenTradeResultMeta(rawTpLevels, new Set());
              const insertError = await supabaseInsertWithRetry('trades', insertData, `${srcCode} ${entrySignalId}`);
              if (insertError) {
                await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `WARN: Supabase trade insert failed after 3 retries\n${symbol} ${action} ${formatSignalPrice(rawEntry)}\nID ${entrySignalId}\n${insertError.message || JSON.stringify(insertError).slice(0, 300)}`);
              }
            } else if (process.env.TELEGRAM_ADMIN_CHAT_ID) {
              const responseText = tradeOpenData ? JSON.stringify(tradeOpenData).slice(0, 500) : 'no response';
              await sendTelegram(
                process.env.TELEGRAM_ADMIN_CHAT_ID,
                `WARN: MetaAPI order was not stored as open\n${symbol} ${action} ${formatSignalPrice(rawEntry)}\nID ${entrySignalId}\nResponse: ${responseText}`
              );
            }
          }
        }
        if (!silent && !no_msg) {
          const chatId = process.env.TELEGRAM_CHAT_ID_XAU;
          let tgRes = { ok: false, result: null };
          if (!layer) {
            console.log('Signal sending to chat:', chatId, 'text:', tgText.slice(0, 50));
            tgRes = await sendTelegram(chatId, tgText);
            console.log('Signal sendTelegram result:', JSON.stringify(tgRes));
            if (!tgRes.ok) {
              await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `WARN: VIP Telegram signal send failed\nID ${signalId || 'n/a'}\n${JSON.stringify(tgRes).slice(0, 400)}`);
            }
          }
          if (!layer && tgRes.ok && entrySignal && tgRes.result?.message_id) {
            await supabase.from('trades').update({ tg_message_id: tgRes.result.message_id, tg_chat_id: chatId }).eq('signal_id', signalId);
          }
        }
      }
    } catch (err) { console.error('POST /webhook/fvg error:', err); }
  })();
});

// GET /price - XAU/USD with 10 s in-memory cache
app.get('/price', publicLimiter, async (req, res) => {
  try {
    const now = Date.now();
    if (priceCache && now - priceCacheTime < 10_000) {
      return res.json(priceCache);
    }

    const response = await fetch(
      `https://api.twelvedata.com/quote?symbol=XAU/USD&apikey=${process.env.TWELVE_DATA_API_KEY}`
    );
    const d = await response.json();
    const price = d.close ?? d.price ?? null;

    // Klaidos (rate limit, API error) necache'inam — graziname sena cache jei turim
    if (!response.ok || price == null) {
      console.warn('TwelveData /price error:', JSON.stringify(d).slice(0, 200));
      if (priceCache) return res.json(priceCache);
      return res.status(502).json({ error: 'Price unavailable' });
    }

    priceCache = {
      price,
      change: d.change ?? null,
      change_percent: d.percent_change ?? null,
      timestamp: d.datetime ?? new Date().toISOString(),
    };
    priceCacheTime = now;

    res.json(priceCache);
  } catch (err) {
    console.error('GET /price error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /trades/open ───────────────────────────────────────────────────────
app.get('/trades/open', publicLimiter, async (req, res) => {
  try {
    const { data: dbTrades } = await supabase
      .from('trades')
      .select('magic, symbol, direction, entry, lot, opened_at, src_code')
      .eq('status', 'open');

    const openDbTrades = dbTrades || [];

    const positionsRes = await metaApiFetch(
      `/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/positions`,
      {
        headers: { 'auth-token': process.env.METAAPI_TOKEN },
      }
    );
    const positions = await positionsRes.json();
    if (!Array.isArray(positions) || positions.length === 0) {
      return res.json([]);
    }

    // Only show positions whose magic exists in Supabase
    const dbMagics = new Set(openDbTrades.map(t => t.magic));

    const mapped = positions
      .filter(p => dbMagics.has(p.magic))
      .map(p => ({
        symbol:    p.symbol,
        direction: p.type === 'POSITION_TYPE_BUY' ? 'BUY' : 'SELL',
        entry:     p.openPrice,
        lot:       p.volume,
        profit:    p.profit,
        magic:     p.magic,
        opened_at: p.time,
      }));
    res.json(mapped);
  } catch (err) {
    console.error('GET /trades/open error:', err);
    res.json([]);
  }
});

// ── GET /positions/open — all open positions (no Supabase filter, for python agent) ──
app.get('/positions/open', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const positionsRes = await metaApiFetch(
      `/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/positions`,
      { headers: { 'auth-token': process.env.METAAPI_TOKEN } }
    );
    const positions = await positionsRes.json();
    if (!Array.isArray(positions)) {
      console.warn('GET /positions/open: unexpected MetaAPI response', JSON.stringify(positions).slice(0, 200));
      return res.status(502).json({ error: 'Unexpected MetaAPI response' });
    }
    res.json(positions.map(p => ({
      symbol:    p.symbol,
      direction: p.type === 'POSITION_TYPE_BUY' ? 'BUY' : 'SELL',
      entry:     p.openPrice,
      lot:       p.volume,
      profit:    p.profit,
      magic:     p.magic,
      openTime:  p.time,
      sl:        p.stopLoss ?? null,
      tp:        p.takeProfit ?? null,
    })));
  } catch (err) {
    console.error('GET /positions/open error:', err);
    res.status(500).json({ error: 'MetaAPI unavailable' });
  }
});

// ── GET /orders/pending — all pending limit orders (for python agent) ──────
app.get('/orders/pending', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const ordersRes = await metaApiFetch(
      `/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/orders`,
      { headers: { 'auth-token': process.env.METAAPI_TOKEN } }
    );
    const orders = await ordersRes.json();
    if (!Array.isArray(orders)) {
      console.warn('GET /orders/pending: unexpected MetaAPI response', JSON.stringify(orders).slice(0, 200));
      return res.status(502).json({ error: 'Unexpected MetaAPI response' });
    }
    res.json(orders.map(o => ({
      symbol:    o.symbol,
      direction: o.type && o.type.includes('BUY') ? 'BUY' : 'SELL',
      entry:     o.openPrice,
      lot:       o.volume,
      magic:     o.magic,
    })));
  } catch (err) {
    // 500 (not []) so the agent treats "unknown" differently from "none pending"
    console.error('GET /orders/pending error:', err);
    res.status(500).json({ error: 'MetaAPI unavailable' });
  }
});


// ── GET /price/internal — cached XAU/USD price for internal agents ────────────
app.get('/price/internal', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const now = Date.now();
    if (priceCache && now - priceCacheTime < 10_000) return res.json(priceCache);
    const response = await fetch(`https://api.twelvedata.com/quote?symbol=XAU/USD&apikey=${process.env.TWELVE_DATA_API_KEY}`);
    const d = await response.json();
    const price = d.close ?? d.price ?? null;
    if (!response.ok || price == null) {
      if (priceCache) return res.json(priceCache);
      return res.status(502).json({ error: 'Price unavailable' });
    }
    priceCache = { price, timestamp: d.datetime ?? new Date().toISOString() };
    priceCacheTime = now;
    res.json(priceCache);
  } catch (err) {
    if (priceCache) return res.json(priceCache);
    res.status(502).json({ error: 'Price unavailable' });
  }
});

// ── GET /agent/master-lot — python agent fetches current master lot size ─────────────
app.get('/agent/master-lot', (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ lot: masterLotSize });
});


// ── Cycle agent state (pushed by python cycle agent) ──────────────────────────────────
let cycleState = null;

app.post('/cycle/state', express.json(), (req, res) => {
  const secret = req.body?.secret || req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'unauthorized' });
  cycleState = req.body?.state || null;
  res.json({ ok: true });
});

// ── POST /api/msb-close-magic — close any open position by magic number ───────
app.post('/api/msb-close-magic', express.json(), async (req, res) => {
  const secret = req.body?.secret || req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const magic = Number(req.body?.magic);
  if (!magic) return res.status(400).json({ error: 'magic required' });
  try {
    const result = await closeTradeByMagic(magic);
    if (!result) return res.status(502).json({ ok: false, error: 'Position not found or MetaAPI unavailable' });
    res.json(result);
  } catch (err) {
    console.error('/api/msb-close-magic error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/account-balance — fetch MT4 account balance from MetaAPI ────────
app.get('/api/account-balance', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const infoRes = await metaApiFetch(
      `/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/account-information`,
      { headers: { 'auth-token': process.env.METAAPI_TOKEN } }
    );
    const info = await infoRes.json();
    if (!info || info.balance == null) return res.status(502).json({ ok: false, error: 'MetaAPI unavailable' });
    res.json({ balance: info.balance, equity: info.equity });
  } catch (err) {
    console.error('/api/account-balance error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/modify-sl — move SL on any open position by magic ──────────────
app.post('/api/modify-sl', express.json(), async (req, res) => {
  const secret = req.body?.secret || req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const magic = Number(req.body?.magic);
  const sl = Number(req.body?.sl);
  if (!magic || sl == null || isNaN(sl)) return res.status(400).json({ error: 'magic and sl required' });
  try {
    const posRes = await metaApiFetch(
      `/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/positions`,
      { headers: { 'auth-token': process.env.METAAPI_TOKEN } }
    );
    const positions = await posRes.json();
    if (!Array.isArray(positions)) return res.status(502).json({ ok: false, error: 'MetaAPI unavailable' });
    const target = positions.find(p => p.magic === magic);
    if (!target) return res.status(404).json({ ok: false, error: `No position with magic ${magic}` });
    const result = await movePositionStopLoss(target.id, sl, target.takeProfit ?? null);
    if (result.ok) {
      await supabase.from('trades').update({ sl }).eq('magic', magic).eq('status', 'open');
    }
    res.json(result);
  } catch (err) {
    console.error('/api/modify-sl error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── TradingView EMA cache ──────────────────────────────────────────────────────
const EMA_CACHE_FILE = '/tmp/tv_ema_cache.json';

let tvEmaCache = (() => {
  try {
    if (fs.existsSync(EMA_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(EMA_CACHE_FILE, 'utf8'));
      console.log('[EMA] Restored cache from disk:', data.updated_at);
      return data;
    }
  } catch (e) {
    console.warn('[EMA] Could not restore cache from disk:', e.message);
  }
  return {};
})();

app.post('/ema-update', express.json(), (req, res) => {
  const secret = req.query.secret || req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const { ema20_1h, ema50_1h, ema200_1h, ema20_4h, ema50_4h, ema200_4h, ema20_d, ema50_d, ema20_15m, ema50_15m, o15m, h15m, l15m, c15m, t } = req.body;
  if (!ema20_1h || !ema200_1h) return res.status(400).json({ error: 'Missing required EMA fields' });
  tvEmaCache = { ema20_1h, ema50_1h, ema200_1h, ema20_4h, ema50_4h, ema200_4h, ema20_d, ema50_d, ema20_15m, ema50_15m, o15m, h15m, l15m, c15m, t, updated_at: new Date().toISOString() };
  try { fs.writeFileSync(EMA_CACHE_FILE, JSON.stringify(tvEmaCache)); } catch (e) { console.warn('[EMA] Cache write failed:', e.message); }
  res.json({ ok: true });
});

app.get('/ema-current', (req, res) => {
  res.json(tvEmaCache);
});

app.get('/agent/trendline/candle', (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!tvEmaCache || !tvEmaCache.c15m) return res.status(204).end();
  res.json({ o: tvEmaCache.o15m, h: tvEmaCache.h15m, l: tvEmaCache.l15m, c: tvEmaCache.c15m, t: tvEmaCache.t });
});

app.get('/agent/trendline', (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  res.json(trendlineState);
});

app.post('/agent/trendline/cancel', (req, res) => {
  const secret = req.headers['x-webhook-secret'] || req.body?.secret;
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const id = req.body?.id;
  if (id != null) {
    trendlineState = trendlineState.filter(t => t.id !== Number(id));
  } else {
    trendlineState = [];
  }
  _saveAgentState();
  res.json({ ok: true });
});

// ── HHHL Structure — TV alert → MetaAPI MT5 limit order ──────────────────────
app.post('/webhook/hhhl', express.json(), async (req, res) => {
  const secret = req.body?.secret;
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (DEMO_MODE) return res.json({ ok: true, demo: true, message: 'Demo mode — no live trade executed' });

  const { dir, price, pivot_time, sl_pt, tp_pt, tf } = req.body;
  if (!dir || !price) return res.status(400).json({ error: 'Missing fields' });

  const accountId = process.env.HHHL_MT5_ACCOUNT_ID;
  if (!accountId) {
    console.error('[HHHL] HHHL_MT5_ACCOUNT_ID not set');
    return res.status(500).json({ error: 'MT5 account not configured' });
  }

  const p     = +price;
  const tpPt  = +(tp_pt  || 9);
  const slPt  = +(sl_pt  || 30);
  const mul   = dir === 'BUY' ? 1 : -1;
  const tp    = +(p + mul * tpPt).toFixed(2);
  const sl    = +(p - mul * slPt).toFixed(2);
  const emoji = dir === 'BUY' ? '🟢' : '🔴';
  const tfLabel = tf ? ` [${tf}]` : '';
  const comment = tf ? `${tf}_${dir}` : `HHHL_${dir}`;

  // Dedup: ignore same pivot price+dir within 15s (TV retry protection)
  const limitDedupKey = `${dir}_${p.toFixed(2)}`;
  const limitLastTs   = hhhlLimitDedup.get(limitDedupKey);
  if (limitLastTs && Date.now() - limitLastTs < HHHL_DEDUP_MS) {
    console.log(`[HHHL] Duplicate ignored: ${limitDedupKey}`);
    return res.json({ ok: true, duplicate: true });
  }
  hhhlLimitDedup.set(limitDedupKey, Date.now());

  const { signalId: hhhlSigId, magic: hhhlMagic } = genHhhlSignalId(10, dir);

  // Place limit order via MetaAPI
  let orderOk = false;
  let hhhlPositionId = null;
  try {
    const actionType = dir === 'BUY' ? 'ORDER_TYPE_BUY_LIMIT' : 'ORDER_TYPE_SELL_LIMIT';
    const tradeRes = await metaApiFetch(
      `/users/current/accounts/${accountId}/trade`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'auth-token': process.env.METAAPI_TOKEN },
        body: JSON.stringify({ actionType, symbol: 'XAUUSD', volume: 0.01, openPrice: p, takeProfit: tp, stopLoss: sl, magic: hhhlMagic, comment }),
      }
    );
    const tradeData = await tradeRes.json();
    console.log(`[HHHL] MetaAPI response:`, JSON.stringify(tradeData));
    orderOk = tradeData?.orderId || tradeData?.positionId || (!tradeData?.error);
    hhhlPositionId = tradeData?.positionId ? String(tradeData.positionId) : (tradeData?.orderId ? String(tradeData.orderId) : null);
  } catch (err) {
    console.error('[HHHL] MetaAPI error:', err.message);
  }

  if (orderOk) {
    supabase.from('trades').insert({
      signal_id: hhhlSigId, magic: hhhlMagic, direction: dir,
      entry: p, sl, tp, src_code: 10, status: 'open',
      symbol: 'XAUUSD', opened_at: nowVilnius(), position_id: hhhlPositionId, tf: tf || null,
    }).then(({ error }) => { if (error) console.error('[HHHL] Supabase insert error:', error.message); });
  }

  await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID,
    `${emoji} <b>HHHL ${dir} LIMIT${tfLabel}</b> ${orderOk ? '✅' : '❌'}\n\n` +
    `Entry: <b>${p}</b>\n` +
    `TP: <b>${tp}</b> (+${tpPt}pt)\n` +
    `SL: <b>${sl}</b> (-${slPt}pt)\n` +
    `📍 Pivot: ${pivot_time || '—'}`,
    { parse_mode: 'HTML' }
  );

  console.log(`[HHHL] ${dir} LIMIT @ ${p} TP=${tp} SL=${sl} | ok=${orderOk} magic=${hhhlMagic}`);
  res.json({ ok: orderOk });
});

// ── HHHL LINIJA — trendline break / state ────────────────────────────────────
app.post('/webhook/hhhl-break', express.json(), async (req, res) => {
  const secret = req.body?.secret;
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (DEMO_MODE) return res.json({ ok: true, demo: true, message: 'Demo mode — no live trade executed' });

  const { type, dir, price, tp_pt, sl_pt, tf, order_type, limit_price } = req.body;

  // STATE alert — new TL formed, update state
  if (type === 'STATE') {
    const now = new Date().toISOString();
    const tfKey = tf || '15MIN';
    if (!hhhlLinijaState[tfKey]) hhhlLinijaState[tfKey] = { res: null, sup: null };
    if (dir === 'RES') {
      hhhlLinijaState[tfKey].res = { p1: +req.body.p1, p2: +req.body.p2, tf: tfKey, updated_at: now };
      console.log(`[HHHL-LINIJA] RES state [${tfKey}]: P1=${req.body.p1} P2=${req.body.p2}`);
    } else if (dir === 'SUP') {
      hhhlLinijaState[tfKey].sup = { p1: +req.body.p1, p2: +req.body.p2, tf: tfKey, updated_at: now };
      console.log(`[HHHL-LINIJA] SUP state [${tfKey}]: P1=${req.body.p1} P2=${req.body.p2}`);
    }
    return res.json({ ok: true });
  }

  // BREAK alert — place MARKET + LIMIT (same logic as TL break)
  if (type !== 'BREAK' || !dir || !price) return res.status(400).json({ error: 'Missing fields' });

  // Dedup: ignore same TF+dir break within 15s (TV retry protection)
  const breakDedupKey = `${tf || '15MIN'}_${dir}`;
  const breakLastTs   = hhhlBreakDedup.get(breakDedupKey);
  if (breakLastTs && Date.now() - breakLastTs < HHHL_DEDUP_MS) {
    console.log(`[HHHL-LINIJA] Duplicate break ignored: ${breakDedupKey}`);
    return res.json({ ok: true, duplicate: true });
  }
  hhhlBreakDedup.set(breakDedupKey, Date.now());

  const accountId = process.env.HHHL_MT5_ACCOUNT_ID;
  if (!accountId) {
    console.error('[HHHL-LINIJA] HHHL_MT5_ACCOUNT_ID not set');
    return res.status(500).json({ error: 'MT5 account not configured' });
  }

  const p     = +price;
  const limP  = limit_price ? +limit_price : dir === 'BUY' ? +(p - 1).toFixed(2) : +(p + 1).toFixed(2);
  const tpPt  = +(tp_pt || 10);
  const slPt  = +(sl_pt || 10);
  const mul   = dir === 'BUY' ? 1 : -1;
  const gap   = Math.abs(p - limP);
  const emoji = dir === 'BUY' ? '🟢' : '🔴';
  const tfLabel = tf ? ` [${tf}]` : '';
  const comment = `HHHL_LIN_${dir}`;
  const ts = new Date().toLocaleTimeString('lt-LT', { timeZone: 'Europe/Vilnius', hour: '2-digit', minute: '2-digit' });

  // Clear TL from state after break
  const tfKey = tf || '15MIN';
  if (!hhhlLinijaState[tfKey]) hhhlLinijaState[tfKey] = { res: null, sup: null };
  if (dir === 'BUY') hhhlLinijaState[tfKey].res = null;
  else               hhhlLinijaState[tfKey].sup = null;

  const placeOne = async (actionType, entryP) => {
    const tp = +(entryP + mul * tpPt).toFixed(2);
    const sl = +(entryP - mul * slPt).toFixed(2);
    const { signalId, magic } = genHhhlSignalId(11, dir);
    const body = { actionType, symbol: 'XAUUSD', volume: 0.01, takeProfit: tp, stopLoss: sl, magic, comment };
    if (actionType.includes('LIMIT')) body.openPrice = entryP;
    try {
      const r = await metaApiFetch(
        `/users/current/accounts/${accountId}/trade`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'auth-token': process.env.METAAPI_TOKEN }, body: JSON.stringify(body) }
      );
      const d = await r.json();
      console.log(`[HHHL-LINIJA] MetaAPI ${actionType}:`, JSON.stringify(d));
      const ok = !!(d?.orderId || d?.positionId || !d?.error);
      const posId = d?.positionId ? String(d.positionId) : (d?.orderId ? String(d.orderId) : null);
      if (ok) {
        supabase.from('trades').insert({
          signal_id: signalId, magic, direction: dir,
          entry: entryP, sl, tp, src_code: 11, status: 'open',
          symbol: 'XAUUSD', opened_at: nowVilnius(), position_id: posId,
        }).then(({ error }) => { if (error) console.error('[HHHL-LINIJA] Supabase insert error:', error.message); });
      }
      return { ok, tp, sl, positionId: d?.positionId ? String(d.positionId) : null, orderId: d?.orderId ? String(d.orderId) : null };
    } catch (err) {
      console.error('[HHHL-LINIJA] MetaAPI error:', err.message);
      return { ok: false, tp, sl, positionId: null, orderId: null };
    }
  };

  const mType = dir === 'BUY' ? 'ORDER_TYPE_BUY'      : 'ORDER_TYPE_SELL';
  const lType = dir === 'BUY' ? 'ORDER_TYPE_BUY_LIMIT' : 'ORDER_TYPE_SELL_LIMIT';

  if (gap > MAX_GAP_TV) {
    await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID,
      `📐 <b>HHHL LINIJA${tfLabel} — ignoruojamas</b>\n[${ts}] ${dir} | Market: ${p} | TL: ${limP} | Gap: ${gap.toFixed(1)}pt\n⚠️ Gap > ${MAX_GAP_TV}pt — TL šlaitas per status.`,
      { parse_mode: 'HTML' }
    );
    return res.json({ ok: false, reason: 'gap_too_large' });
  }

  if (gap > BIG_GAP_TV) {
    const r1 = await placeOne(lType, limP);
    await new Promise(r => setTimeout(r, 200));
    const r2 = await placeOne(lType, limP);
    await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID,
      `${emoji} <b>HHHL LINIJA${tfLabel} — ${dir} ⚠️ BIG GAP</b>\n[${ts}] Market: ${p} | TL: ${limP} | Gap: ${gap.toFixed(1)}pt (>${BIG_GAP_TV}pt)\n\n${r1.ok?'✅':'❌'} Limit 1 ${dir} @ <b>${limP}</b>  SL: ${r1.sl} | TP: ${r1.tp}\n${r2.ok?'✅':'❌'} Limit 2 ${dir} @ <b>${limP}</b>  SL: ${r2.sl} | TP: ${r2.tp}`,
      { parse_mode: 'HTML' }
    );
  } else {
    const mR = await placeOne(mType, p);
    await new Promise(r => setTimeout(r, 200));
    const lR = await placeOne(lType, limP);
    if (mR.positionId && lR.orderId) {
      hhhlLinijaOrders.push({ positionId: mR.positionId, orderId: lR.orderId, dir });
    }
    await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID,
      `${emoji} <b>HHHL LINIJA${tfLabel} — ${dir}</b>\n[${ts}] Gap: ${gap.toFixed(1)}pt\n\n${mR.ok?'✅':'❌'} Market ${dir} @ <b>${p}</b>\n   SL: ${mR.sl} | TP: ${mR.tp}\n\n${lR.ok?'✅':'❌'} Limit ${dir} @ <b>${limP}</b> (retest)\n   SL: ${lR.sl} | TP: ${lR.tp}`,
      { parse_mode: 'HTML' }
    );
  }

  res.json({ ok: true });
});


// ── TV Trendline Break — webhook from TradingView Pine Script ─────────────────
const BIG_GAP_TV   = 20.0;
const MAX_GAP_TV   = 50.0;
const MIN_BREAK_TV = 0.5;

async function calcLotForTl() {
  return 0.5;
}

async function _postFvgInternal(text) {
  const payload = JSON.stringify({ text, secret: process.env.WEBHOOK_SECRET });
  const port = process.env.PORT || 3000;
  const http = (await import('http')).default;
  return new Promise((resolve) => {
    const r = http.request(
      { hostname: 'localhost', port, path: '/webhook/fvg', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => { res.resume(); resolve(true); }
    );
    r.on('error', (e) => { console.error('_postFvgInternal error:', e); resolve(false); });
    r.write(payload); r.end();
  });
}

app.post('/webhook/tv-tl', express.json(), async (req, res) => {
  const { secret, direction, entry, tl_value, sl_pt, tp_pt } = req.body || {};
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (DEMO_MODE) return res.json({ ok: true, demo: true, message: 'Demo mode — no live trade executed' });
  const dir = (direction || '').toUpperCase();
  const marketEntry = parseFloat(entry);
  const tlVal       = parseFloat(tl_value);
  const slPt        = parseFloat(sl_pt);
  const tpPt        = parseFloat(tp_pt);
  if (!['BUY','SELL'].includes(dir) || isNaN(marketEntry) || isNaN(tlVal) || isNaN(slPt) || isNaN(tpPt)) {
    return res.status(400).json({ error: 'Invalid fields. Required: direction (BUY/SELL), entry, tl_value, sl_pt, tp_pt' });
  }
  res.json({ ok: true });

  (async () => {
    try {
      const gap = Math.abs(marketEntry - tlVal);
      const ts  = new Date().toLocaleTimeString('lt-LT', { timeZone: 'Europe/Vilnius', hour: '2-digit', minute: '2-digit' });

      if (gap > MAX_GAP_TV) {
        console.log(`[tv-tl] Gap ${gap.toFixed(1)}pt > MAX_GAP_TV — ignored`);
        await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID,
          `📐 <b>TV TL Break — ignoruojamas</b>\n[${ts}] Entry: ${marketEntry} | TL: ${tlVal.toFixed(2)} | Gap: ${gap.toFixed(1)}pt\n⚠️ Gap > ${MAX_GAP_TV}pt — TL šlaitas per status.`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      const lot      = await calcLotForTl(slPt);
      const nowMs    = Date.now();
      const dirCode  = dir === 'BUY' ? '1' : '2';
      const mSid     = `${nowMs}9${dirCode}1${String(nowMs).slice(-3)}`;
      const lSid     = `${nowMs}9${dirCode}2${String(nowMs).slice(-3)}`;
      const mMagic   = parseInt(mSid.slice(-9));
      const lMagic   = parseInt(lSid.slice(-9));

      if (gap > BIG_GAP_TV) {
        // Tik 2x limit į retest
        const limitEntry = dir === 'BUY' ? +(tlVal + 1).toFixed(2) : +(tlVal - 1).toFixed(2);
        const limitSl    = dir === 'BUY' ? +(limitEntry - slPt).toFixed(2) : +(limitEntry + slPt).toFixed(2);
        const limitTp    = dir === 'BUY' ? +(limitEntry + tpPt).toFixed(2) : +(limitEntry - tpPt).toFixed(2);
        const lSid2      = `${nowMs + 1}9${dirCode}2${String(nowMs + 1).slice(-3)}`;
        const ok1 = await _postFvgInternal(`XAUUSD ${dir} LIMIT ${limitEntry}\nTP ${limitTp}\nSL ${limitSl}\nLOT ${lot}\nID ${lSid}\nNOSPLIT`);
        await new Promise(r => setTimeout(r, 200));
        const ok2 = await _postFvgInternal(`XAUUSD ${dir} LIMIT ${limitEntry}\nTP ${limitTp}\nSL ${limitSl}\nLOT ${lot}\nID ${lSid2}\nNOSPLIT`);
        await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID,
          `📐 <b>TV TL Break — ${dir} XAUUSD</b>\n[${ts}] Entry: ${marketEntry} | TL: ${tlVal.toFixed(2)} | Gap: ${gap.toFixed(1)}pt ⚠️ (>${BIG_GAP_TV}pt — tik retest)\n\n${ok1?'✅':'❌'} Limit 1 ${dir} @ <b>${limitEntry}</b>  SL: ${limitSl} | TP: ${limitTp}\n${ok2?'✅':'❌'} Limit 2 ${dir} @ <b>${limitEntry}</b>  SL: ${limitSl} | TP: ${limitTp}`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      // Normalus gap — Market + Limit
      const limitEntry = dir === 'BUY' ? +(tlVal + 1).toFixed(2) : +(tlVal - 1).toFixed(2);
      const mSl  = dir === 'BUY' ? +(marketEntry - slPt).toFixed(2) : +(marketEntry + slPt).toFixed(2);
      const mTp  = dir === 'BUY' ? +(marketEntry + tpPt).toFixed(2) : +(marketEntry - tpPt).toFixed(2);
      const lSl  = dir === 'BUY' ? +(limitEntry  - slPt).toFixed(2) : +(limitEntry  + slPt).toFixed(2);
      const lTp  = dir === 'BUY' ? +(limitEntry  + tpPt).toFixed(2) : +(limitEntry  - tpPt).toFixed(2);

      const okM = await _postFvgInternal(`XAUUSD ${dir} ${marketEntry}\nTP ${mTp}\nSL ${mSl}\nLOT ${lot}\nID ${mSid}\nNOSPLIT`);
      await new Promise(r => setTimeout(r, 200));
      const okL = await _postFvgInternal(`XAUUSD ${dir} LIMIT ${limitEntry}\nTP ${lTp}\nSL ${lSl}\nLOT ${lot}\nID ${lSid}\nNOSPLIT`);

      if (okM && okL) {
        const tlOrder = { market_magic: mMagic, limit_magic: lMagic, market_signal_id: mSid, limit_signal_id: lSid };
        tvTlActiveOrders.push(tlOrder);
        _saveTlOrder(tlOrder);
      }

      await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID,
        `📐 <b>TV TL Break — ${dir} XAUUSD</b>\n[${ts}] Entry: ${marketEntry} | TL: ${tlVal.toFixed(2)} | Gap: ${gap.toFixed(1)}pt\n\n${okM?'✅':'❌'} Market ${dir} @ <b>${marketEntry}</b>\n   SL: ${mSl} | TP: ${mTp}\n\n${okL?'✅':'❌'} Limit ${dir} @ <b>${limitEntry}</b> (retest)\n   SL: ${lSl} | TP: ${lTp}`,
        { parse_mode: 'HTML' }
      );
    } catch (e) { console.error('/webhook/tv-tl error:', e); }
  })();
});

app.get('/agent/tv-tl-orders', (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  res.json(tvTlActiveOrders);
});

app.post('/agent/tv-tl-orders/remove', express.json(), (req, res) => {
  const secret = req.body?.secret || req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const { market_magic } = req.body || {};
  if (market_magic != null) {
    tvTlActiveOrders = tvTlActiveOrders.filter(o => o.market_magic !== Number(market_magic));
    _deleteTlOrder(market_magic);
  }
  res.json({ ok: true });
});

app.get('/ema/control', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  await _emaControlReady;
  res.json({ paused: emaAgentPaused, skipUntilCross: emaSkipUntilCross });
});

app.post('/ema/set-control', (req, res) => {
  const secret = req.headers['x-webhook-secret'] || req.body?.secret;
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if ('paused' in req.body) emaAgentPaused = req.body.paused === true;
  if ('skipUntilCross' in req.body) emaSkipUntilCross = req.body.skipUntilCross || null;
  _saveAgentState();
  res.json({ paused: emaAgentPaused, skipUntilCross: emaSkipUntilCross });
});

// ── GET /ema/rideopennow-pending — manual ride open command ──────────────────
app.get('/ema/rideopennow-pending', (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const pending = rideOpenPending;
  rideOpenPending = null;
  res.json(pending ? { direction: pending.direction, entry: pending.entry } : { direction: null });
});

app.get('/ema/clear-pending', (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const pending = emaClearPending;
  emaClearPending = false;
  res.json({ clear: pending });
});

// ── GET /ema/active-slots — restore EMA tp1/tp3 state after restart ─────────
app.get('/ema/active-slots', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { data: trades, error } = await supabase
      .from('trades')
      .select('magic, direction, entry, sl, tp, signal_id, opened_at')
      .eq('src_code', 6)
      .eq('status', 'open')
      .order('opened_at', { ascending: true });
    if (error) throw error;
    res.json(trades || []);
  } catch (err) {
    console.error('/ema/active-slots error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /ema/active-ride — restore EMA ride state after restart ──────────────
app.get('/ema/active-ride', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { data: trade, error } = await supabase
      .from('trades')
      .select('magic, direction, entry, signal_id, opened_at')
      .eq('src_code', 7)
      .eq('status', 'open')
      .order('opened_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!trade) return res.json(null);
    res.json({ dir: trade.direction, entry: Number(trade.entry), magic: trade.magic, opened_at: trade.opened_at });
  } catch (err) {
    console.error('/ema/active-ride error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /agent/cancel-pending-magic — cancel pending limit order by magic ────
app.post('/agent/cancel-pending-magic', express.json(), async (req, res) => {
  const secret = req.body?.secret || req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const magic = parseInt(req.body?.magic);
  if (!magic) return res.status(400).json({ error: 'Missing or invalid magic' });
  try {
    const result = await cancelOrderByMagic(magic);
    await supabase.from('trades').delete().eq('magic', magic).eq('status', 'open');
    res.json({ ok: result?.ok ?? false });
  } catch (err) {
    console.error('/agent/cancel-pending-magic error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── GET /trades/history ────────────────────────────────────────────────────
app.get('/trades/history', publicLimiter, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('trades')
      .select('*')
      .eq('status', 'closed')
      .not('result', 'in', '("Atšauktas","Canceled")')
      .not('closed_at', 'is', null)
      .order('closed_at', { ascending: false })
      .limit(10);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('GET /trades/history error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Vilnius date-parts helper ─────────────────────────────────────────────
// Reliably extracts {year, month, day} in Europe/Vilnius time using
// Intl.DateTimeFormat.formatToParts — avoids the fragile
// new Date(toLocaleString(...)) anti-pattern.
function vilniusParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Vilnius',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  return {
    year:  parts.find(p => p.type === 'year').value,
    month: parts.find(p => p.type === 'month').value,
    day:   parts.find(p => p.type === 'day').value,
  };
}

// ── GET /pnl/today ────────────────────────────────────────────────────────
app.get('/pnl/today', publicLimiter, async (req, res) => {
  try {
    const now = new Date();
    const { year, month, day } = vilniusParts(now);
    const todayStart = `${year}-${month}-${day}T00:00:00.000+00:00`;

    const { data, error } = await supabase
      .from('trades')
      .select('profit')
      .eq('status', 'closed')
      .gte('closed_at', todayStart);
    if (error) throw error;

    const total_profit = data.reduce((s, t) => s + (t.profit || 0), 0);
    const trade_count = data.length;

    res.json({
      total_profit: parseFloat(total_profit.toFixed(2)),
      trade_count,
    });
  } catch (err) {
    console.error('GET /pnl/today error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /pnl/monthly ───────────────────────────────────────────────────────
// Filters by current calendar month in Vilnius time (matches nowVilnius() storage format).
// Uses closed_at so profit is attributed to the month a trade settled, consistent with /pnl/today.
app.get('/pnl/monthly', publicLimiter, async (req, res) => {
  try {
    const now = new Date();
    // vilniusParts() reliably extracts Vilnius year/month without the fragile
    // new Date(toLocaleString(...)) pattern that breaks at month boundaries.
    const { year, month: monthNum } = vilniusParts(now);
    const monthStart = `${year}-${monthNum}-01T00:00:00.000+00:00`;

    const { data, error } = await supabase
      .from('trades')
      .select('profit')
      .eq('status', 'closed')
      .gte('closed_at', monthStart);
    if (error) throw error;

    const total_profit = data.reduce((s, t) => s + (t.profit || 0), 0);
    const trade_count = data.length;
    const month = new Intl.DateTimeFormat('en-US', {
      month: 'long', year: 'numeric', timeZone: 'Europe/Vilnius',
    }).format(now);

    res.json({
      month,
      total_profit: parseFloat(total_profit.toFixed(2)),
      trade_count,
    });
  } catch (err) {
    console.error('GET /pnl/monthly error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/pnl/breakdown', publicLimiter, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('trades')
      .select('closed_at, profit')
      .eq('status', 'closed')
      .not('closed_at', 'is', null)
      .order('closed_at', { ascending: false });
    if (error) throw error;

    const monthMap = {};
    data.forEach(t => {
      // closed_at saugomas kaip Vilniaus laikas su +00:00 — metus/mėnesį imam tiesiai iš
      // stringo, kad rezultatas nepriklausytų nuo serverio timezone
      const key = String(t.closed_at).slice(0, 7); // "YYYY-MM"
      if (!monthMap[key]) {
        const monthLabel = new Date(`${key}-15T12:00:00Z`).toLocaleString('lt-LT', {
          month: 'long', year: 'numeric', timeZone: 'UTC',
        });
        const capitalizedMonth = monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1);
        monthMap[key] = { month: capitalizedMonth, profit: 0 };
      }
      monthMap[key].profit += (t.profit || 0);
    });

    const breakdown = Object.keys(monthMap)
      .sort((a, b) => b.localeCompare(a))
      .slice(0, 9)
      .map(k => ({
        month: monthMap[k].month,
        profit: parseFloat(monthMap[k].profit.toFixed(2)),
      }));

    res.json(breakdown);
  } catch (err) {
    console.error('GET /pnl/breakdown error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /save-telegram-id — save Telegram user ID for Signalas clients ────
app.post('/save-telegram-id', demoGuard, async (req, res) => {
  const secret = req.headers['x-webhook-secret'] || req.body?.secret;
  if (!secret || secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const {
      email: rawEmail,
      telegram_user_id,
      telegram_username,
      discord_username,
    } = req.body;
    const email = requireEmail(rawEmail);
    const telegramId = cleanContactHandle(telegram_user_id);
    const telegramUsername = cleanContactHandle(telegram_username);
    const discordUsername = cleanContactHandle(discord_username);
    if (!telegramId && !telegramUsername && !discordUsername) {
      return res.status(400).json({ ok: false, error: 'Missing contact details' });
    }

    // Apsauga: ID galima prirašyti tik aktyviam klientui; ID pakeitimas — pranešamas adminui,
    // nes per /stop ir /start šis ID valdo kliento kopijavimą
    const { data: client } = await supabase
      .from('clients')
      .select('active, telegram_user_id')
      .eq('email', email)
      .maybeSingle();
    if (!client || !client.active) {
      return res.status(403).json({ ok: false, error: 'No active subscription found for this email' });
    }
    if (telegramId && client.telegram_user_id && client.telegram_user_id !== telegramId) {
      await sendTelegram(
        process.env.TELEGRAM_ADMIN_CHAT_ID,
        `⚠️ Telegram ID PAKEISTAS klientui ${email}: ${client.telegram_user_id} → ${telegramId}. Jei klientas to neprašė — patikrink!`
      );
    }

    if (telegramId) {
      const { error: dbError } = await supabase
        .from('clients')
        .update({ telegram_user_id: telegramId })
        .eq('email', email);
      if (dbError) throw dbError;
    }

    const adminContactMsg =
      `✅ Klientas užpildė Signalas kontaktus\n` +
      `📧 ${email}\n` +
      `💬 ${formatContactLine('Telegram ID', telegramId)}\n` +
      `👤 ${formatContactLine('Telegram username', telegramUsername)}\n` +
      `🎮 ${formatContactLine('Discord username', discordUsername)}`;
    await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, adminContactMsg);

    if (telegramId) {
      await sendTelegram(
        telegramId,
        'Sveiki! 🎉 Ačiū už užsakymą. Netrukus būsite pridėti į VIP signalų grupę. Susisieksime greitu metu.\n\nWelcome! 🎉 Thank you for your purchase. You will be added to the VIP signals group shortly. We\'ll be in touch soon.'
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('POST /save-telegram-id error:', err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ── POST /connect-account — provision MetaAPI MT account ──────────────────
app.post('/connect-account', async (req, res) => {
  // Require signed onboarding token to prevent unauthenticated provisioning
  let tokenPayload;
  try {
    tokenPayload = verifyOnboardingToken(req.body.token || req.query.token);
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or missing onboarding token' });
  }
  if (DEMO_MODE) {
    return res.status(503).json({ success: false, error: 'Demo mode — broker connections are disabled', demo: true });
  }
  let accountIdToCleanup = null;
  try {
    const {
      email: rawEmail,
      lot_size,
      login,
      password,
      server,
      platform,
      telegram_user_id,
      telegram_username,
      discord_username,
      broker_symbol,
    } = req.body;
    const email = requireEmail(rawEmail);
    if (tokenPayload.email !== email) {
      return res.status(403).json({ error: 'Token email mismatch' });
    }
    const selectedLotSize = normalizeLotSize(lot_size);
    const brokerSymbol = typeof broker_symbol === 'string' && broker_symbol.trim() ? broker_symbol.trim() : null;
    const telegramId = cleanContactHandle(telegram_user_id);
    const telegramUsername = cleanContactHandle(telegram_username);
    const discordUsername = cleanContactHandle(discord_username);

    const { data: existingClient } = await supabase
      .from('clients')
      .select('active')
      .eq('email', email)
      .maybeSingle();
    if (!existingClient || !existingClient.active) {
      return res.status(403).json({ success: false, error: 'No active subscription found for this email' });
    }

    const provisionRes = await metaApiProvisioningFetch(
      '/users/current/accounts',
      {
        method: 'POST',
        body: JSON.stringify({
          login,
          password,
          name: 'Aurora ' + email,
          server,
          platform,
          copyFactoryRoles: ['SUBSCRIBER'],
          magic: 123456,
          application: 'MetaApi',
          type: 'cloud',
        }),
      }
    );

    if (!provisionRes.ok) {
      const errBody = await provisionRes.text();
      throw new Error(`MetaAPI error ${provisionRes.status}: ${errBody}`);
    }

    const account = await provisionRes.json();
    if (!account?.id) throw new Error('MetaAPI did not return account id');
    accountIdToCleanup = account.id;
    await waitForMetaApiConnection(account.id);

    // Reject investor (read-only) passwords — CopyFactory cannot place orders without write access.
    // Retry a few times: tradeAllowed/investorMode may be null immediately after connection.
    let accInfo = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 3000));
      try {
        const accInfoRes = await metaApiFetch(
          `/users/current/accounts/${account.id}/account-information`,
          { headers: { 'auth-token': process.env.METAAPI_TOKEN } }
        );
        accInfo = await accInfoRes.json();
        if (accInfo && (accInfo.tradeAllowed === false || accInfo.investorMode === true)) break;
        if (accInfo && accInfo.tradeAllowed === true) break; // confirmed master password
      } catch (_) {}
    }
    if (accInfo && (accInfo.tradeAllowed === false || accInfo.investorMode === true)) {
      await cleanupProvisionedAccount(account.id);
      accountIdToCleanup = null;
      return res.status(400).json({
        success: false,
        error: 'Investor (read-only) password detected. Please use your master password to connect.',
      });
    }

    // Auto-detect gold symbol if client didn't specify one
    let effectiveBrokerSymbol = brokerSymbol;
    if (!effectiveBrokerSymbol) {
      const detected = await detectGoldSymbol(account.id);
      if (detected && detected !== 'XAUUSD') {
        effectiveBrokerSymbol = detected;
        console.log(`Auto-detected gold symbol for ${email}: ${detected}`);
      }
    }

    let copyFactorySubscriberId = account.id;
    let reusedCopyFactorySubscriberId = null;
    const subscribeResult = await putCopyFactorySubscriber(account.id, email, selectedLotSize, effectiveBrokerSymbol);

    if (!subscribeResult.ok) {
      const duplicateSubscriberId = parseDuplicateCopyFactorySubscriberId(subscribeResult.status, subscribeResult.body);

      if (!duplicateSubscriberId) {
        console.error('CopyFactory subscribe error:', subscribeResult.body);
        await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `❌ CopyFactory subscribe KLAIDA: ${email} (account ${account.id}) HTTP ${subscribeResult.status}. Klientui sėkmės žinutė neišsiųsta.`);
        throw new Error(`CopyFactory subscribe error ${subscribeResult.status}: ${subscribeResult.body}`);
      }

      console.warn('CopyFactory duplicate subscriber, reusing existing subscriber:', duplicateSubscriberId, 'for', email);
      const reuseResult = await putCopyFactorySubscriber(duplicateSubscriberId, email, selectedLotSize, brokerSymbol);
      if (!reuseResult.ok) {
        console.error('CopyFactory existing subscriber update error:', reuseResult.body);
        await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `❌ CopyFactory existing subscriber KLAIDA: ${email} (subscriber ${duplicateSubscriberId}) HTTP ${reuseResult.status}. Klientui sėkmės žinutė neišsiųsta.`);
        throw new Error(`CopyFactory existing subscriber update error ${reuseResult.status}: ${reuseResult.body}`);
      }

      copyFactorySubscriberId = duplicateSubscriberId;
      reusedCopyFactorySubscriberId = duplicateSubscriberId;
      await cleanupProvisionedAccount(account.id);
      accountIdToCleanup = null;
      await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `♻️ CopyFactory subscriber jau buvo sukurtas, todėl panaudotas esamas ID: ${email} → ${duplicateSubscriberId}`);
    } else {
      console.log('Subscribed to strategy:', account.id);
    }

    console.log('Saving to Supabase:', email, copyFactorySubscriberId);
    const upsertData = { email, metaapi_account_id: copyFactorySubscriberId, lot_size: formatLotSize(selectedLotSize) };
    if (effectiveBrokerSymbol) upsertData.broker_symbol = effectiveBrokerSymbol;
    if (telegramId) upsertData.telegram_user_id = telegramId;
    const { error: dbError } = await supabase
      .from('clients')
      .upsert(upsertData, { onConflict: 'email' });
    if (dbError) throw dbError;
    accountIdToCleanup = null;

    console.log('Account connected successfully:', email, login);
    const adminConnectMsg =
      `🔗 Sąskaita prijungta!\n` +
      `📧 ${email}\n` +
      `🏦 Serveris: ${server}\n` +
      `📊 Platforma: ${platform}\n` +
      `📈 Lot dydis: ${formatLotSize(selectedLotSize)}\n` +
      `💬 ${formatContactLine('Telegram ID', telegramId)}\n` +
      `👤 ${formatContactLine('Telegram username', telegramUsername)}\n` +
      `🎮 ${formatContactLine('Discord username', discordUsername)}\n` +
      (effectiveBrokerSymbol && effectiveBrokerSymbol.toUpperCase() !== 'XAUUSD'
        ? `🔀 Symbol: XAUUSD → ${effectiveBrokerSymbol}${effectiveBrokerSymbol !== brokerSymbol ? ' (auto-detected)' : ''}\n`
        : `✅ Symbol: XAUUSD\n`) +
      (reusedCopyFactorySubscriberId ? `♻️ Existing subscriber reused: ${reusedCopyFactorySubscriberId}\n` : '') +
      `✅ Kopijavimas aktyvus`;
    await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, adminConnectMsg);
    if (telegramId) {
      await sendTelegram(
        telegramId,
        'Sveiki! 🎉 Jūsų sąskaita sėkmingai prijungta. Kopijavimas aktyvuotas.\n\nKomandos:\n▶️ /start — pradėti kopijavimą\n⏹ /stop — sustabdyti kopijavimą\n❓ /help — pagalba\n\nIškilo problemų? Rašykite: t.me/yourtelegram\n\nWelcome! 🎉 Your account has been successfully connected. Copying is now active.\n\nCommands:\n▶️ /start — resume copying\n⏹ /stop — pause copying\n❓ /help — help\n\nHaving issues? Contact us: t.me/yourtelegram'
      );
    }
    res.json({ success: true, account_id: copyFactorySubscriberId, lot_size: formatLotSize(selectedLotSize) });
  } catch (err) {
    console.error('POST /connect-account error:', err);
    if (accountIdToCleanup) await cleanupProvisionedAccount(accountIdToCleanup);
    await sendTelegram(
      process.env.TELEGRAM_ADMIN_CHAT_ID,
      `❌ Sąskaitos prijungimas nepavyko\n` +
      `📧 ${cleanEmail(req.body?.email)}\n` +
      `🏦 Serveris: ${req.body?.server || 'neįvesta'}\n` +
      `📊 Platforma: ${req.body?.platform || 'neįvesta'}\n` +
      `🔢 Login: ${req.body?.login || 'neįvesta'}\n` +
      `⚠️ Klaida: ${String(err.message || err).slice(0, 900)}`
    );
    const msg = err.message || '';
    let userError;
    if (msg.includes('connection timeout') || (msg.includes('state=DEPLOYED') && msg.includes('DISCONNECTED'))) {
      userError = 'Nepavyko prisijungti prie brokerio serverio. Patikrinkite serverio pavadinimą, sąskaitos numerį ir slaptažodį. / Could not connect to broker server — please check your server name, account number and password.';
    } else if (msg.includes('account did not connect') || msg.includes('FAILED')) {
      userError = 'Prisijungimas nepavyko. Patikrinkite sąskaitos duomenis ir bandykite dar kartą. / Connection failed — please check your account details and try again.';
    } else if (msg.includes('deploy error 404') || msg.includes('NotFoundError')) {
      userError = 'Sąskaita nerasta. Susisiekite su mumis per Telegram. / Account not found — please contact us on Telegram.';
    } else if (msg.includes('No active subscription')) {
      userError = 'Nerasta aktyvi prenumerata šiam el. paštui. Susisiekite su mumis. / No active subscription found for this email.';
    } else if (msg.includes('Invalid lot size')) {
      userError = 'Netinkamas lot dydis. / Invalid lot size.';
    } else {
      userError = 'Klaida jungiantis prie sąskaitos. Susisiekite su mumis per Telegram. / Error connecting account — please contact us on Telegram.';
    }
    res.json({ success: false, error: userError });
  }
});

// ── /admin/* — all admin routes blocked in demo mode ─────────────────────
app.use('/admin', demoGuard);

// ── POST /admin/update-subscriber-lot — update existing subscriber lot size ──
app.post('/admin/update-subscriber-lot', express.json(), async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const { email: rawEmail, lot_size } = req.body;
  if (!rawEmail || lot_size == null) return res.status(400).json({ error: 'email and lot_size required' });

  const email = cleanEmail(rawEmail);
  let selectedLotSize;
  try { selectedLotSize = normalizeLotSize(lot_size); } catch { return res.status(400).json({ error: 'Invalid lot size' }); }

  const { data: client, error: dbErr } = await supabase
    .from('clients')
    .select('metaapi_account_id, broker_symbol')
    .eq('email', email)
    .maybeSingle();
  if (dbErr || !client) return res.status(404).json({ error: 'Client not found' });

  const result = await putCopyFactorySubscriber(client.metaapi_account_id, email, selectedLotSize, client.broker_symbol);
  if (!result.ok) {
    console.error('update-subscriber-lot CopyFactory error:', result.body);
    return res.status(500).json({ error: `CopyFactory error ${result.status}`, body: result.body });
  }

  const { error: updateErr } = await supabase.from('clients').update({ lot_size: formatLotSize(selectedLotSize) }).eq('email', email);
  if (updateErr) console.error('Supabase lot_size update error:', updateErr);

  const perOrder = Math.max(0.01, Math.floor(selectedLotSize / 2 * 100) / 100);
  const msg = `⚙️ Lot size atnaujintas: ${email}\n${formatLotSize(selectedLotSize)} total → ${formatLotSize(perOrder)} per orderį`;
  await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, msg);
  console.log(msg);

  res.json({ success: true, email, lot_size: formatLotSize(selectedLotSize), per_order: formatLotSize(perOrder) });
});

// ── GET /admin/client-status — diagnose client MetaAPI + CopyFactory state ──
app.get('/admin/client-status', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });

  const { data: client, error } = await supabase.from('clients').select('*').eq('email', email).single();
  if (error || !client) return res.status(404).json({ error: 'Client not found in Supabase' });

  const accountId = client.metaapi_account_id;
  const result = { supabase: client, metaapi: null, copyfactory: null, tradeAllowed: null };

  try {
    const maRes = await fetch(`${METAAPI_PROVISIONING_BASE}/users/current/accounts/${accountId}`,
      { headers: { 'auth-token': process.env.METAAPI_TOKEN } });
    result.metaapi = await maRes.json();
  } catch (e) { result.metaapi = { error: e.message }; }

  try {
    const cfRes = await fetch(`https://copyfactory-api-v1.london.agiliumtrade.ai/users/current/configuration/subscribers/${accountId}`,
      { headers: { 'auth-token': process.env.METAAPI_TOKEN } });
    result.copyfactory = await cfRes.json();
  } catch (e) { result.copyfactory = { error: e.message }; }

  try {
    const aiRes = await metaApiFetch(`/users/current/accounts/${accountId}/account-information`,
      { headers: { 'auth-token': process.env.METAAPI_TOKEN } });
    const ai = await aiRes.json();
    result.tradeAllowed = ai?.tradeAllowed ?? null;
    result.accountInfo = ai;
  } catch (e) { result.tradeAllowed = { error: e.message }; }

  res.json(result);
});

// ── GET /admin/subscriber-logs — CopyFactory subscriber trading logs ──
app.get('/admin/subscriber-logs', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });

  const { data: client, error } = await supabase.from('clients').select('metaapi_account_id').eq('email', email).single();
  if (error || !client) return res.status(404).json({ error: 'Client not found' });

  const accountId = client.metaapi_account_id;
  const authHeader = { 'auth-token': process.env.METAAPI_TOKEN };
  const result = {};
  try {
    const r = await fetch(`https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/${accountId}/positions`, { headers: authHeader });
    result.positions = await r.json();
  } catch (e) { result.positions = { error: e.message }; }
  try {
    const start = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
    const end = new Date().toISOString();
    const r = await fetch(`https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/${accountId}/history-deals/time-range?startTime=${start}&endTime=${end}&limit=20`, { headers: authHeader });
    result.recentDeals = await r.json();
  } catch (e) { result.recentDeals = { error: e.message }; }
  res.json(result);
});

// ── GET /admin/copyfactory-log — CopyFactory subscriber user log (errors/warnings) ──
app.get('/admin/copyfactory-log', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });

  const { data: client, error } = await supabase.from('clients').select('metaapi_account_id').eq('email', email).single();
  if (error || !client) return res.status(404).json({ error: 'Client not found' });

  const accountId = client.metaapi_account_id;
  const authHeader = { 'auth-token': process.env.METAAPI_TOKEN };
  const result = { symbols: null, cfLog: null };

  try {
    const r = await metaApiFetch(`/users/current/accounts/${accountId}/symbols`, { headers: authHeader });
    const symbols = await r.json();
    result.symbols = Array.isArray(symbols) ? symbols.filter(s => /^(XAU|GOLD)/i.test(s)) : symbols;
  } catch (e) { result.symbols = { error: e.message }; }

  try {
    const r = await fetch(`https://copyfactory-api-v1.london.agiliumtrade.ai/users/current/subscribers/${accountId}/user-log?limit=50`, { headers: authHeader });
    result.cfLog = await r.json();
  } catch (e) { result.cfLog = { error: e.message }; }

  res.json(result);
});

// ── POST /admin/update-subscriber-symbol — fix symbol mapping for existing client ──
// broker_symbol: explicit symbol string, or omit/pass "auto" to auto-detect via MetaAPI
app.post('/admin/update-subscriber-symbol', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const { email: rawEmail, broker_symbol } = req.body;
  if (!rawEmail) return res.status(400).json({ error: 'email required' });

  const email = cleanEmail(rawEmail);

  const { data: client, error: dbErr } = await supabase
    .from('clients')
    .select('metaapi_account_id, lot_size')
    .eq('email', email)
    .maybeSingle();

  if (dbErr || !client) return res.status(404).json({ error: 'Client not found' });
  if (!client.lot_size) return res.status(400).json({ error: 'lot_size not set for this client' });

  // Auto-detect if broker_symbol not provided or explicitly "auto"
  let brokerSymbol = broker_symbol && broker_symbol.trim().toLowerCase() !== 'auto' ? broker_symbol.trim() : null;
  let autoDetected = false;
  if (!brokerSymbol) {
    const detected = await detectGoldSymbol(client.metaapi_account_id);
    brokerSymbol = detected || 'XAUUSD';
    autoDetected = true;
    console.log(`Auto-detected symbol for ${email}: ${brokerSymbol}`);
  }

  const lotSize = parseFloat(client.lot_size);
  const result = await putCopyFactorySubscriber(client.metaapi_account_id, email, lotSize, brokerSymbol);

  if (!result.ok) {
    console.error('update-subscriber-symbol CopyFactory error:', result.body);
    return res.status(500).json({ error: `CopyFactory error ${result.status}`, body: result.body });
  }

  const { error: updateErr } = await supabase
    .from('clients')
    .update({ broker_symbol: brokerSymbol !== 'XAUUSD' ? brokerSymbol : null })
    .eq('email', email);

  if (updateErr) console.error('Supabase broker_symbol update error:', updateErr);

  const msg = `🔀 Symbol atnaujintas: ${email}\nXAUUSD → ${brokerSymbol}${autoDetected ? ' (auto-detected)' : ''}`;
  await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, msg);
  console.log(msg);

  res.json({ success: true, email, broker_symbol: brokerSymbol, auto_detected: autoDetected });
});

// ── POST /telegram-webhook — Telegram bot commands ────────────────────────
app.post('/telegram-webhook', demoGuard, async (req, res) => {
  try {
    // Apsauga: jei nustatytas secret, priimam tik uzklausas su teisingu Telegram header'iu.
    // Uzkerta kelia suklastotoms komandoms (pvz. /closeall, /setlot) is bet kur.
    if (process.env.TELEGRAM_WEBHOOK_SECRET &&
        req.headers['x-telegram-bot-api-secret-token'] !== process.env.TELEGRAM_WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false });
    }
    const message = req.body?.message;
    if (!message) return res.json({ ok: true });

    const fromId     = String(message.from?.id || '');
    const fromChatId = String(message.chat?.id);
    const text       = (message.text || '').trim();

    // /help — any user
    if (/^\/help/i.test(text)) {
      const isAdmin = fromChatId === String(process.env.TELEGRAM_ADMIN_CHAT_ID);
      const adminSection = isAdmin
        ? '\n\n🔧 Admin komandos:\n\n👥 Klientai:\n/clients — visi klientai\n/status <email> — kliento informacija\n/activate <email> — aktyvuoti klientą\n/deactivate <email> — deaktyvuoti klientą\n/deleteclient <email> — ištrinti klientą (CopyFactory + MetaAPI + Supabase)\n/setlot <email> <lot> — pakeisti kliento lot dydį (0.01–1.00)\n/setmasterlot <lot> — pakeisti master lot dydį\n/updateallsubs — atnaujinti visų subscriber\'ių CopyFactory konfigūraciją\n\n📊 Pozicijos:\n/balance — sąskaitų balansai, floating ir dienos pelnas\n/close <id> — uždaryti poziciją\n/modtp <magic> <tp> — pakeisti TP\n/cancelc <id> — atšaukti pending limit orderį\n/closeall — atšaukti visus pending orderius\n/closepositions — uždaryti visas atviras pozicijas\n/syncpositions — sinchronizuoti MetaAPI pozicijas į Supabase\n\n📡 Signalai:\n/signal BUY|SELL <kaina> [TP1: x\\nTP2: x\\nSL: x] — rankinis signalas\n\n🤖 Agentai:\n/ema stop|start — sustabdyti/paleisti EMA agentą\n\n📈 EMA agentas (15M ciklai):\n/ema stop — sustabdyti EMA agentą\n/ema start — paleisti EMA agentą (išvalo skip)\n/ema skip buy|sell — praleisti BUY arba SELL signalus iki kito kryžiavimosi\n/ema status — EMA agento būsena\n/clearema — išvalyti EMA state (tp1/tp2/tp3/ride) po rankinio uždarymo\n\n📐 Trendline agentas (TV webhook):\nBrėžk TL TradingView → Pine Script siunčia webhook → Market+Limit auto'
        : '';
      await sendTelegram(fromChatId,
        '🤖 Aurora FX Gold Bot\n\nKomandos / Commands:\n/stop — sustabdyti kopijavimą / pause copying\n/start — aktyvuoti kopijavimą / resume copying\n/help — ši žinutė / this message\n\n💰 Jūsų lėšos visada saugiai laikomos jūsų pačių brokerio sąskaitoje.\nYour funds are always safely held in your own broker account.' + adminSection
      );
      return res.json({ ok: true });
    }

    // /stop — any user
    if (/^\/stop/i.test(text)) {
      const { data: client } = await supabase
        .from('clients').select('*').eq('telegram_user_id', fromId).maybeSingle();
      if (!client) {
        await sendTelegram(fromChatId,
          '❌ Klientas nerastas / Client not found\n\nJūsų Telegram ID nepriregistruotas sistemoje. Susisiekite su administratoriumi.\nYour Telegram ID is not registered. Please contact the administrator.'
        );
        return res.json({ ok: true });
      }
      if (!client.metaapi_account_id) {
        await sendTelegram(fromChatId,
          'ℹ️ Automatinis kopijavimas šiai paskyrai neprijungtas / Automated copying is not connected for this account.'
        );
        return res.json({ ok: true });
      }
      const copyFactoryDelete = await deleteCopyFactorySubscriber(client.metaapi_account_id);
      console.log('CopyFactory unsubscribe status:', copyFactoryDelete.status, 'for', client.email);
      if (!copyFactoryDelete.ok) {
        // NESAKOM klientui, kad sustabdyta, jei realiai nepavyko — kitaip toliau prekiaujama jo pinigais
        await sendTelegram(fromChatId,
          '⚠️ Nepavyko sustabdyti kopijavimo / Could not pause copying\n\nBandykite dar kartą po kelių minučių arba susisiekite su administratoriumi.\nPlease try again in a few minutes or contact the administrator.'
        );
        await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `❌ /stop klaida: ${client.email} CopyFactory HTTP ${copyFactoryDelete.status}. Supabase NEATNAUJINTA — klientas VIS DAR aktyvus.\n${String(copyFactoryDelete.body || '').slice(0, 500)}`);
        return res.json({ ok: true });
      }
      await supabase.from('clients').update({ active: false }).eq('email', client.email);
      await sendTelegram(fromChatId,
        '✅ Kopijavimas sustabdytas / Copying paused\n\nEsami atviri sandoriai liks atviri kol pasieks TP/SL.\nOpen trades will remain open until they hit TP/SL.\n\nNorėdami vėl aktyvuoti — rašykite /start\nTo resume — send /start'
      );
      await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `⏸️ Klientas sustabdė kopijavimą: ${client.email}`);
      return res.json({ ok: true });
    }

    // /start — any user
    if (/^\/start/i.test(text)) {
      const { data: client } = await supabase
        .from('clients').select('*').eq('telegram_user_id', fromId).maybeSingle();
      if (!client) {
        await sendTelegram(fromChatId,
          '❌ Klientas nerastas / Client not found\n\nJūsų Telegram ID nepriregistruotas sistemoje. Susisiekite su administratoriumi.\nYour Telegram ID is not registered. Please contact the administrator.'
        );
        return res.json({ ok: true });
      }
      const lotSize = parseFloat(client.lot_size) || 0.01;
      if (!client.metaapi_account_id) {
        await sendTelegram(fromChatId,
          '⚠️ Sąskaita dar neprijungta / Account is not connected\n\nPirmiausia prijunkite savo MT4/MT5 sąskaitą per onboarding puslapį.\nPlease connect your MT4/MT5 account first.'
        );
        await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `❌ /start klaida: ${client.email} neturi MetaAPI ID.`);
        return res.json({ ok: true });
      }
      const subResult = await putCopyFactorySubscriber(client.metaapi_account_id, client.email, lotSize);
      console.log('CopyFactory resubscribe status:', subResult.status, 'for', client.email);
      if (!subResult.ok) {
        await sendTelegram(fromChatId,
          '⚠️ Nepavyko aktyvuoti kopijavimo / Could not activate copying\n\nBandykite dar kartą po kelių minučių arba susisiekite su administratoriumi.\nPlease try again in a few minutes or contact the administrator.'
        );
        await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `❌ /start klaida: ${client.email} CopyFactory HTTP ${subResult.status}. Supabase NEATNAUJINTA — klientas NEAKTYVUS.\n${String(subResult.body || '').slice(0, 500)}`);
        return res.json({ ok: true });
      }
      await supabase.from('clients').update({ active: true }).eq('email', client.email);
      await sendTelegram(fromChatId,
        '✅ Kopijavimas aktyvuotas / Copying activated\n\nNauji sandoriai bus automatiškai kopijuojami į Jūsų sąskaitą.\nNew trades will be automatically copied to your account.'
      );
      await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `▶️ Klientas aktyvavo kopijavimą: ${client.email}`);
      return res.json({ ok: true });
    }

    // /close — admin only
    if (fromChatId !== String(process.env.TELEGRAM_ADMIN_CHAT_ID)) {
      return res.json({ ok: true });
    }

    // /syncpositions — sync all open MetaAPI positions into Supabase (manual trades)
    if (/^\/syncpositions$/i.test(text)) {
      try {
        const posRes = await metaApiFetch(
          `/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/positions`,
          { headers: { 'auth-token': process.env.METAAPI_TOKEN } }
        );
        const positions = await posRes.json();
        if (!Array.isArray(positions)) {
          await sendTelegram(fromChatId, '⚠️ MetaAPI neatsakė teisingai.');
          return res.json({ ok: true });
        }
        if (positions.length === 0) {
          await sendTelegram(fromChatId, 'ℹ️ Nėra atvirų pozicijų MT4.');
          return res.json({ ok: true });
        }
        // Get existing open trades from Supabase by magic
        const { data: existing } = await supabase
          .from('trades')
          .select('magic')
          .eq('status', 'open');
        const existingMagics = new Set((existing || []).map(t => t.magic));

        let synced = 0;
        let skipped = 0;
        for (const p of positions) {
          if (existingMagics.has(p.magic)) { skipped++; continue; }
          const direction = p.type === 'POSITION_TYPE_BUY' ? 'BUY' : 'SELL';
          const openedAt = p.time ? new Date(p.time).toISOString() : new Date().toISOString();
          const { error } = await supabase.from('trades').insert({
            symbol:     p.symbol?.replace('/', '') || 'XAUUSD',
            direction,
            entry:      p.openPrice,
            sl:         p.stopLoss || null,
            tp:         p.takeProfit || null,
            lot:        p.volume,
            magic:      p.magic,
            signal_id:  `manual_${p.id || p.magic}`,
            src_code:   0,
            status:     'open',
            opened_at:  openedAt,
          });
          if (error) {
            console.error('syncpositions insert error:', error);
          } else {
            synced++;
          }
        }
        await sendTelegram(fromChatId,
          `✅ <b>Sync atliktas</b>\n\n` +
          `Įrašyta: <b>${synced}</b> naujų pozicijų\n` +
          `Praleista (jau yra): <b>${skipped}</b>\n` +
          `Viso MT4: <b>${positions.length}</b>`
        );
      } catch (err) {
        console.error('/syncpositions error:', err);
        await sendTelegram(fromChatId, `⚠️ Klaida: ${err.message}`);
      }
      return res.json({ ok: true });
    }

    // /cyclestatus — show current cycle agent state
    if (/^\/cyclestatus$/i.test(text)) {
      if (!cycleState) {
        await sendTelegram(fromChatId, 'ℹ️ Cycle state dar negautas (agentas dar nepaleidęs ciklo).');
        return res.json({ ok: true });
      }
      const s = cycleState;
      const inWindow = s.in_timer_window ? '✅ AKTYVUS' : '⏳ Laukiama';
      const confirmed = s.confirmed_signal_date ? `✅ ${s.confirmed_signal_date}` : 'Nėra';
      const watchSent = s.watch_alert_sent ? 'Taip' : 'Ne';
      const emoji = s.last_pivot_type === 'Low' ? '🔻' : '🔺';
      await sendTelegram(fromChatId,
        `🔄 <b>Cycle Status</b>\n\n` +
        `${emoji} Paskutinis: <b>${s.last_pivot_type}</b> ${s.last_pivot_date} @ $${s.last_pivot_price}\n` +
        `Laukiamas: <b>${s.next_expected}</b>\n` +
        `Praėjo: <b>${s.days_ago}d</b> | Avg ciklas: <b>${s.avg_cycle}d</b>\n` +
        `Timer langas: ${inWindow}\n` +
        `Watch alert išsiųstas: ${watchSent}\n` +
        `Patvirtinimas: ${confirmed}`
      );
      return res.json({ ok: true });
    }

    // /clients — list all clients
    if (/^\/clients$/i.test(text)) {
      const { data: clients } = await supabase
        .from('clients')
        .select('email, plan, active, lot_size')
        .order('email', { ascending: true });
      if (!clients || clients.length === 0) {
        await sendTelegram(fromChatId, '📭 Nėra klientų.');
        return res.json({ ok: true });
      }
      const lines = clients.map(c =>
        `${c.active ? '🟢' : '🔴'} ${c.email}\n   Planas: ${c.plan || '—'} · Lot: ${c.lot_size || '—'}`
      );
      await sendTelegram(fromChatId, `👥 Klientai (${clients.length}):\n\n` + lines.join('\n\n'));
      return res.json({ ok: true });
    }

    // /status hhhl — HHHL LINIJA trendline state (15min + 1H) — must be before /status <email>
    if (/^\/status\s+hhhl$/i.test(text)) {
      const fmtTF = (label, s) => {
        const r = s?.res ? `📉 <b>RES</b> P1: ${s.res.p1} → P2: ${s.res.p2} ⏱ ${(s.res.updated_at||'').slice(11,16)} UTC` : '📉 RES: nėra';
        const sp = s?.sup ? `📈 <b>SUP</b> P1: ${s.sup.p1} → P2: ${s.sup.p2} ⏱ ${(s.sup.updated_at||'').slice(11,16)} UTC` : '📈 SUP: nėra';
        return `<b>[${label}]</b>\n${r}\n${sp}`;
      };
      await sendTelegram(fromChatId,
        `📊 <b>HHHL LINIJA statusas</b>\n\n` +
        fmtTF('15MIN', hhhlLinijaState['15MIN']) + '\n\n' +
        fmtTF('1H', hhhlLinijaState['60MIN']),
        { parse_mode: 'HTML' }
      );
      return res.json({ ok: true });
    }

    // /status <email>
    const statusMatch = text.match(/^\/status\s+(\S+)/i);
    if (statusMatch) {
      const email = cleanEmail(statusMatch[1]);
      const { data: client } = await supabase
        .from('clients').select('*').eq('email', email).maybeSingle();
      if (!client) {
        await sendTelegram(fromChatId, `❌ Klientas nerastas: ${email}`);
        return res.json({ ok: true });
      }
      const msg =
        `👤 ${client.email}\n` +
        `Planas: ${client.plan || '—'}\n` +
        `Aktyvus: ${client.active ? '✅ Taip' : '❌ Ne'}\n` +
        `Lot dydis: ${client.lot_size || '—'}\n` +
        `MetaAPI ID: ${client.metaapi_account_id || '—'}\n` +
        `Telegram ID: ${client.telegram_user_id || '—'}\n` +
        `Stripe customer: ${client.stripe_customer_id || '—'}`;
      await sendTelegram(fromChatId, msg);
      return res.json({ ok: true });
    }

    // /deactivate <email>
    const deactivateMatch = text.match(/^\/deactivate\s+(\S+)/i);
    if (deactivateMatch) {
      const email = cleanEmail(deactivateMatch[1]);
      const { data: client } = await supabase
        .from('clients').select('*').eq('email', email).maybeSingle();
      if (!client) {
        await sendTelegram(fromChatId, `❌ Klientas nerastas: ${email}`);
        return res.json({ ok: true });
      }
      if (client.metaapi_account_id) {
        const copyFactoryDelete = await deleteCopyFactorySubscriber(client.metaapi_account_id);
        console.log('CopyFactory deactivate status:', copyFactoryDelete.status, 'for', client.email);
        if (!copyFactoryDelete.ok) {
          await sendTelegram(fromChatId, `❌ CopyFactory klaida deaktyvuojant ${email}: HTTP ${copyFactoryDelete.status}. Supabase NEATNAUJINTA.\n${String(copyFactoryDelete.body || '').slice(0, 500)}`);
          return res.json({ ok: true });
        }
      }
      await supabase.from('clients').update({ active: false }).eq('email', email);
      await sendTelegram(fromChatId, `⏸️ Klientas deaktyvuotas: ${email}`);
      return res.json({ ok: true });
    }

    // /deleteclient <email>
    const deleteClientMatch = text.match(/^\/deleteclient\s+(\S+)/i);
    if (deleteClientMatch) {
      const email = cleanEmail(deleteClientMatch[1]);
      const { data: client } = await supabase
        .from('clients').select('*').eq('email', email).maybeSingle();
      if (!client) {
        await sendTelegram(fromChatId, `Klientas nerastas: ${email}`);
        return res.json({ ok: true });
      }

      let externalDeleteMsg = 'CopyFactory/MetaAPI: nebuvo MetaAPI ID, todėl išorinės sistemos netrintos';
      if (client.metaapi_account_id) {
        const copyFactoryDelete = await deleteCopyFactorySubscriber(client.metaapi_account_id);
        console.log('CopyFactory deleteclient status:', copyFactoryDelete.status, 'for', client.email);
        if (!copyFactoryDelete.ok) {
          await sendTelegram(fromChatId, `CopyFactory klaida trinant ${email}: HTTP ${copyFactoryDelete.status}. Supabase NEISTRINTA.\n${String(copyFactoryDelete.body || '').slice(0, 500)}`);
          return res.json({ ok: true });
        }

        const metaApiDelete = await deleteMetaApiAccount(client.metaapi_account_id);
        console.log('MetaAPI deleteclient status:', metaApiDelete.deleteStatus, 'undeploy:', metaApiDelete.undeployStatus, 'for', client.email);
        if (!metaApiDelete.ok) {
          await sendTelegram(fromChatId, `MetaAPI klaida trinant ${email}: HTTP ${metaApiDelete.deleteStatus}. Supabase NEISTRINTA.\n${String(metaApiDelete.body || '').slice(0, 500)}`);
          return res.json({ ok: true });
        }
        externalDeleteMsg = 'CopyFactory: istrinta\nMetaAPI: istrinta';
      }

      const { error: deleteError } = await supabase
        .from('clients')
        .delete()
        .eq('email', email);
      if (deleteError) {
        console.error('Supabase deleteclient error:', deleteError);
        await sendTelegram(fromChatId, `Supabase klaida trinant ${email}: ${deleteError.message}`);
        return res.json({ ok: true });
      }

      await sendTelegram(fromChatId, `Klientas istrintas: ${email}\n${externalDeleteMsg}`);
      return res.json({ ok: true });
    }

    // /activate <email>
    const activateMatch = text.match(/^\/activate\s+(\S+)/i);
    if (activateMatch) {
      const email = cleanEmail(activateMatch[1]);
      const { data: client } = await supabase
        .from('clients').select('*').eq('email', email).maybeSingle();
      if (!client) {
        await sendTelegram(fromChatId, `❌ Klientas nerastas: ${email}`);
        return res.json({ ok: true });
      }
      if (!client.metaapi_account_id) {
        await sendTelegram(fromChatId, `❌ Klientas neturi MetaAPI ID, todėl aktyvuoti CopyFactory nepavyks: ${email}`);
        return res.json({ ok: true });
      }
      const lotSize = parseFloat(client.lot_size) || 0.01;
      const subResult = await putCopyFactorySubscriber(client.metaapi_account_id, client.email, lotSize);
      console.log('CopyFactory activate status:', subResult.status, 'for', client.email);
      if (!subResult.ok) {
        await sendTelegram(fromChatId, `❌ CopyFactory klaida aktyvuojant ${email}: HTTP ${subResult.status}. Supabase NEATNAUJINTA.\n${String(subResult.body || '').slice(0, 500)}`);
        return res.json({ ok: true });
      }
      await supabase.from('clients').update({ active: true }).eq('email', email);
      await sendTelegram(fromChatId, `▶️ Klientas aktyvuotas: ${email}`);
      return res.json({ ok: true });
    }

    // /setlot <email> <lot> — update CopyFactory fixedVolume and clients.lot_size
    const setlotMatch = text.match(/^\/setlot\s+(\S+)\s+(\S+)/i);
    if (setlotMatch) {
      const email = cleanEmail(setlotMatch[1]);
      let lotSize;
      try {
        lotSize = normalizeLotSize(setlotMatch[2]);
      } catch {
        await sendTelegram(fromChatId, `❌ Netinkamas lot dydis. Leistinos reikšmės: ${formatAllowedLotSizes()}`);
        return res.json({ ok: true });
      }
      const { data: client } = await supabase
        .from('clients').select('*').eq('email', email).maybeSingle();
      if (!client) {
        await sendTelegram(fromChatId, `❌ Klientas nerastas: ${email}`);
        return res.json({ ok: true });
      }
      if (!client.metaapi_account_id) {
        await sendTelegram(fromChatId, `❌ Klientas neturi MetaAPI ID, todėl lot dydis nepakeistas CopyFactory ir Supabase: ${email}`);
        return res.json({ ok: true });
      }
      if (!client.active) {
        await supabase.from('clients').update({ lot_size: formatLotSize(lotSize) }).eq('email', email);
        await sendTelegram(fromChatId, `✅ Lot dydis pakeistas Supabase: ${email} → ${formatLotSize(lotSize)}\nKlientas neaktyvus, todėl CopyFactory neperkurta. Naujas lot bus pritaikytas per /start arba /activate.`);
        return res.json({ ok: true });
      }
      const subResult = await putCopyFactorySubscriber(client.metaapi_account_id, client.email, lotSize);
      if (!subResult.ok) {
        await sendTelegram(fromChatId, `❌ CopyFactory klaida keičiant lot dydį ${email}: HTTP ${subResult.status}. Supabase NEATNAUJINTA.\n${String(subResult.body || '').slice(0, 500)}`);
        return res.json({ ok: true });
      }
      await supabase.from('clients').update({ lot_size: formatLotSize(lotSize) }).eq('email', email);
      await sendTelegram(fromChatId, `✅ Lot dydis pakeistas: ${email} → ${formatLotSize(lotSize)}`);
      return res.json({ ok: true });
    }

    // /setmasterlot <lot> — change master account lot size for automated signals
    const setMasterLotMatch = text.match(/^\/setmasterlot\s+(\S+)/i);
    if (setMasterLotMatch) {
      let newLot;
      try {
        newLot = normalizeLotSize(setMasterLotMatch[1]);
      } catch {
        await sendTelegram(fromChatId, `❌ Netinkamas lot dydis. Leistinos reikšmės: ${formatAllowedLotSizes()}`);
        return res.json({ ok: true });
      }
      masterLotSize = newLot;
      await supabase.from('settings').upsert({ key: 'master_lot_size', value: String(newLot) }, { onConflict: 'key' });
      await sendTelegram(fromChatId, `✅ Master lot pakeistas: <b>${formatLotSize(newLot)}</b>\nNauji automatiniai signalai naudos šį lot dydį.`);
      return res.json({ ok: true });
    }

    // /updateallsubs — re-push CopyFactory config for all active subscribers
    if (/^\/updateallsubs$/i.test(text)) {
      const { data: activeClients } = await supabase
        .from('clients')
        .select('email, metaapi_account_id, lot_size')
        .eq('active', true)
        .not('metaapi_account_id', 'is', null);
      if (!activeClients?.length) {
        await sendTelegram(fromChatId, 'Nėra aktyvių subscriber\'ių.');
        return res.json({ ok: true });
      }
      let ok = 0, fail = 0;
      await Promise.all(activeClients.map(async c => {
        const subLot = parseFloat(c.lot_size) || 0.01;
        const result = await putCopyFactorySubscriber(c.metaapi_account_id, c.email, subLot);
        if (result.ok) ok++;
        else { fail++; console.warn(`/updateallsubs failed for ${c.email}: ${result.status}`); }
      }));
      await sendTelegram(fromChatId, `✅ Subscriber\'iai atnaujinti: <b>${ok}</b> sėkmingai, <b>${fail}</b> klaida.`);
      return res.json({ ok: true });
    }

    // /closeall — cancel all pending limit orders
    if (/^\/closeall/i.test(text)) {
      const ordersRes = await metaApiFetch(
        `/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/orders`,
        { headers: { 'auth-token': process.env.METAAPI_TOKEN } }
      );
      const orders = await ordersRes.json();
      if (!Array.isArray(orders) || orders.length === 0) {
        await sendTelegram(fromChatId, '📭 Nėra aktyvių pending orderių.');
        return res.json({ ok: true });
      }
      let cancelled = 0;
      for (const order of orders) {
        try {
          const cancelRes = await metaApiFetch(
            `/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/trade`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'auth-token': process.env.METAAPI_TOKEN },
              body: JSON.stringify({ actionType: 'ORDER_CANCEL', orderId: order.id }),
            }
          );
          const cancelData = await cancelRes.json();
          if (!cancelRes.ok || !isMetaApiTradeSuccess(cancelData)) {
            console.error('closeall cancel rejected:', JSON.stringify(cancelData));
            continue;
          }
          // Atšaukti pending orderiai nesaugomi — įrašas trinamas iš DB
          await supabase.from('trades')
            .delete()
            .eq('magic', order.magic)
            .eq('status', 'open');
          cancelled++;
        } catch (err) {
          console.error('closeall cancel error:', err);
        }
      }
      await sendTelegram(fromChatId, `✅ Atšaukta ${cancelled} iš ${orders.length} pending orderių.`);
      return res.json({ ok: true });
    }

    // /hhhlbreak BUY|SELL [price] — rankiniu būdu paleisti HHHL LINIJA orderį (MARKET + LIMIT)
    if (/^\/hhhlbreak\s+(BUY|SELL)/i.test(text)) {
      const match = text.match(/^\/hhhlbreak\s+(BUY|SELL)(?:\s+([\d.]+))?/i);
      const dir = match[1].toUpperCase();
      const accountId = process.env.HHHL_MT5_ACCOUNT_ID;
      if (!accountId) {
        await sendTelegram(fromChatId, '❌ HHHL_MT5_ACCOUNT_ID not set');
        return res.json({ ok: true });
      }
      // Get current price
      let marketP = match[2] ? parseFloat(match[2]) : null;
      if (!marketP) {
        try {
          const priceRes = await metaApiFetch(
            `/users/current/accounts/${accountId}/symbols/XAUUSD/current-price`,
            { headers: { 'auth-token': process.env.METAAPI_TOKEN } }
          );
          const priceData = await priceRes.json();
          marketP = dir === 'BUY' ? priceData?.ask : priceData?.bid;
          if (!marketP) throw new Error('no price');
        } catch { await sendTelegram(fromChatId, '❌ Nepavyko gauti kainos — nurodyk rankiniu: /hhhlbreak BUY 4610.50'); return res.json({ ok: true }); }
      }
      const tpPt = 10, slPt = 10, mul = dir === 'BUY' ? 1 : -1;
      const limP = dir === 'BUY' ? +(marketP - 1).toFixed(2) : +(marketP + 1).toFixed(2);
      const comment = `HHHL_LIN_${dir}`;
      const placeManual = async (actionType, entryP) => {
        const tp = +(entryP + mul * tpPt).toFixed(2);
        const sl = +(entryP - mul * slPt).toFixed(2);
        const { signalId: manSigId, magic: manMagic } = genHhhlSignalId(11, dir);
        const body = { actionType, symbol: 'XAUUSD', volume: 0.01, takeProfit: tp, stopLoss: sl, magic: manMagic, comment };
        if (actionType.includes('LIMIT')) body.openPrice = entryP;
        try {
          const r = await metaApiFetch(`/users/current/accounts/${accountId}/trade`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'auth-token': process.env.METAAPI_TOKEN }, body: JSON.stringify(body)
          });
          const d = await r.json();
          const ok = !!(d?.orderId || d?.positionId || !d?.error);
          const posId = d?.positionId ? String(d.positionId) : (d?.orderId ? String(d.orderId) : null);
          if (ok) {
            supabase.from('trades').insert({
              signal_id: manSigId, magic: manMagic, direction: dir,
              entry: entryP, sl, tp, src_code: 11, status: 'open',
              symbol: 'XAUUSD', opened_at: nowVilnius(), position_id: posId,
            }).then(({ error }) => { if (error) console.error('[HHHL manual] Supabase insert error:', error.message); });
          }
          return { ok, tp, sl, positionId: d?.positionId ? String(d.positionId) : null, orderId: d?.orderId ? String(d.orderId) : null };
        } catch { return { ok: false, tp, sl, positionId: null, orderId: null }; }
      };
      const mType = dir === 'BUY' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL';
      const lType = dir === 'BUY' ? 'ORDER_TYPE_BUY_LIMIT' : 'ORDER_TYPE_SELL_LIMIT';
      const emoji = dir === 'BUY' ? '🟢' : '🔴';
      const mR = await placeManual(mType, marketP);
      await new Promise(r => setTimeout(r, 200));
      const lR = await placeManual(lType, limP);
      if (mR.positionId && lR.orderId) hhhlLinijaOrders.push({ positionId: mR.positionId, orderId: lR.orderId, dir });
      await sendTelegram(fromChatId,
        `${emoji} <b>HHHL LINIJA MANUAL — ${dir}</b>\n\n${mR.ok?'✅':'❌'} Market @ <b>${marketP}</b>  SL: ${mR.sl} | TP: ${mR.tp}\n${lR.ok?'✅':'❌'} Limit @ <b>${limP}</b>  SL: ${lR.sl} | TP: ${lR.tp}`,
        { parse_mode: 'HTML' }
      );
      return res.json({ ok: true });
    }

    // /hhhlstr BUY|SELL <price> — rankiniu būdu paleisti HHHL Structure LIMIT orderį
    if (/^\/hhhlstr\s+(BUY|SELL)/i.test(text)) {
      const match = text.match(/^\/hhhlstr\s+(BUY|SELL)\s+([\d.]+)/i);
      if (!match) {
        await sendTelegram(fromChatId, '❌ Formatas: /hhhlstr BUY 4462.50');
        return res.json({ ok: true });
      }
      const dir = match[1].toUpperCase();
      const limitP = parseFloat(match[2]);
      if (!limitP) { await sendTelegram(fromChatId, '❌ Netinkama kaina'); return res.json({ ok: true }); }
      const accountId = process.env.HHHL_MT5_ACCOUNT_ID;
      if (!accountId) { await sendTelegram(fromChatId, '❌ HHHL_MT5_ACCOUNT_ID nenustatytas'); return res.json({ ok: true }); }
      const tpPt = 9, slPt = 30, mul = dir === 'BUY' ? 1 : -1;
      const tp = +(limitP + mul * tpPt).toFixed(2);
      const sl = +(limitP - mul * slPt).toFixed(2);
      const emoji = dir === 'BUY' ? '🟢' : '🔴';
      const { signalId: strSigId, magic: strMagic } = genHhhlSignalId(10, dir);
      let strOk = false, strPosId = null;
      try {
        const actionType = dir === 'BUY' ? 'ORDER_TYPE_BUY_LIMIT' : 'ORDER_TYPE_SELL_LIMIT';
        const r = await metaApiFetch(`/users/current/accounts/${accountId}/trade`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'auth-token': process.env.METAAPI_TOKEN },
          body: JSON.stringify({ actionType, symbol: 'XAUUSD', volume: 0.01, openPrice: limitP, takeProfit: tp, stopLoss: sl, magic: strMagic, comment: `HHHL_STR_${dir}` }),
        });
        const d = await r.json();
        console.log(`[HHHL-STR manual] MetaAPI:`, JSON.stringify(d));
        strOk = !!(d?.orderId || d?.positionId || !d?.error);
        strPosId = d?.positionId ? String(d.positionId) : (d?.orderId ? String(d.orderId) : null);
      } catch (err) { console.error('[HHHL-STR manual] error:', err.message); }
      if (strOk) {
        supabase.from('trades').insert({
          signal_id: strSigId, magic: strMagic, direction: dir,
          entry: limitP, sl, tp, src_code: 10, status: 'open',
          symbol: 'XAUUSD', opened_at: nowVilnius(), position_id: strPosId, tf: '5MIN',
        }).then(({ error }) => { if (error) console.error('[HHHL-STR manual] Supabase error:', error.message); });
      }
      await sendTelegram(fromChatId,
        `${emoji} <b>HHHL Structure MANUAL — ${dir}</b>\n\n${strOk?'✅':'❌'} Limit @ <b>${limitP}</b>\nTP: ${tp} (+${tpPt}pt)\nSL: ${sl} (-${slPt}pt)`,
        { parse_mode: 'HTML' }
      );
      return res.json({ ok: true });
    }

    // /closepositions — close all open positions
    if (/^\/closepositions$/i.test(text)) {
      const posRes = await metaApiFetch(
        `/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/positions`,
        { headers: { 'auth-token': process.env.METAAPI_TOKEN } }
      );
      const positions = await posRes.json();
      if (!Array.isArray(positions) || positions.length === 0) {
        await sendTelegram(fromChatId, '📭 Nėra atvirų pozicijų.');
        return res.json({ ok: true });
      }
      let closed = 0;
      for (const pos of positions) {
        try {
          const closeRes = await metaApiFetch(
            `/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/trade`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'auth-token': process.env.METAAPI_TOKEN },
              body: JSON.stringify({ actionType: 'POSITION_CLOSE_ID', positionId: pos.id }),
            }
          );
          const closeData = await closeRes.json();
          if (!closeRes.ok || !isMetaApiTradeSuccess(closeData)) {
            console.error('closepositions rejected:', JSON.stringify(closeData));
            continue;
          }
          await supabase.from('trades')
            .update({ status: 'closed', result: 'Manual', closed_at: nowVilnius() })
            .eq('magic', pos.magic)
            .eq('status', 'open');
          closed++;
        } catch (err) {
          console.error('closepositions error:', err);
        }
      }
      await sendTelegram(fromChatId, `✅ Uždarytos ${closed} iš ${positions.length} pozicijų.`);
      return res.json({ ok: true });
    }

    // /balance — show account balances for all subscriber accounts
    if (/^\/balance$/i.test(text)) {
      const { data: clients } = await supabase.from('clients').select('email, metaapi_account_id').eq('active', true).not('metaapi_account_id', 'is', null);
      const accounts = (clients || []).map(c => ({ name: c.email, id: c.metaapi_account_id }));
      if (!accounts.length) {
        await sendTelegram(fromChatId, '💰 Nėra aktyvių sąskaitų.');
        return res.json({ ok: true });
      }
      const authHeader = { 'auth-token': process.env.METAAPI_TOKEN };
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const lines = [];
      for (const acc of accounts) {
        try {
          const [infoRes, dealsRes] = await Promise.all([
            metaApiFetch(`/users/current/accounts/${acc.id}/account-information`, { headers: authHeader }),
            metaApiFetch(`/users/current/accounts/${acc.id}/history-deals/time/${todayStart.toISOString()}/${new Date().toISOString()}`, { headers: authHeader }),
          ]);
          const info = await infoRes.json();
          const deals = await dealsRes.json();
          if (!infoRes.ok || info.error || info.message) {
            console.error(`/balance ${acc.name} account-information error (${infoRes.status}):`, JSON.stringify(info));
            lines.push(`${acc.name}: MetaAPI klaida — ${info.message || info.error || infoRes.status}`);
            continue;
          }
          const floating = (info.equity ?? 0) - (info.balance ?? 0);
          const todayProfit = Array.isArray(deals)
            ? deals.filter(d => d.entryType === 'DEAL_ENTRY_OUT').reduce((s, d) => s + (d.profit || 0), 0)
            : 0;
          const fmt = (v) => `${v >= 0 ? '+' : ''}$${v.toFixed(2)}`;
          lines.push(
            `${acc.name}\n` +
            `Balance: $${Number(info.balance ?? 0).toFixed(2)}\n` +
            `Floating: ${fmt(floating)}\n` +
            `Šiandien: ${fmt(todayProfit)}`
          );
        } catch (e) {
          lines.push(`${acc.name}: klaida — ${e.message}`);
        }
      }
      await sendTelegram(fromChatId, '💰 Sąskaitų balansai\n\n' + lines.join('\n\n'));
      return res.json({ ok: true });
    }

    // /signal — manual signal: /signal BUY 4150\nTP1: 4160\nTP2: 4170\nSL: 4140
    if (/^\/signal\b/i.test(text)) {
      const body = text.replace(/^\/signal\s*/i, '').trim();
      const firstLine = body.split('\n')[0].trim();
      const entryMatch = firstLine.match(/^(?:XAUUSD\s+)?(BUY|SELL)(?:\s+LIMIT)?\s+([\d.]+)/i);
      if (!entryMatch) {
        await sendTelegram(fromChatId, '⚠️ Formatas:\n/signal BUY 4150\nTP1: 4160\nTP2: 4175\nSL: 4140');
        return res.json({ ok: true });
      }
      const direction = entryMatch[1].toUpperCase();
      const entry = parseFloat(entryMatch[2]);
      const isLimit = /\bLIMIT\b/i.test(body);
      const tpMatches = [...body.matchAll(/TP\d*\s*[:\s]\s*([\d.]+)/gi)];
      const tps = tpMatches.map(m => Math.round(parseFloat(m[1])));
      const slMatch = body.match(/SL\s*[:\s]\s*([\d.]+)/i);
      const sl = slMatch ? Math.ceil(parseFloat(slMatch[1])) : null;
      const lotMatch = body.match(/LOT\s*[:\s]\s*([\d.]+)/i);
      const lot = lotMatch ? parseFloat(lotMatch[1]) : masterLotSize;
      if (!tps.length || !sl) {
        await sendTelegram(fromChatId, '⚠️ Trūksta TP arba SL.');
        return res.json({ ok: true });
      }
      const commentLines = body.split('\n').slice(1).filter(line => {
        const l = line.trim();
        return l && !/^TP\d*\s*[:\s]/i.test(l) && !/^SL[\s:]/i.test(l) && !/^LOT[\s:]/i.test(l);
      });
      const comment = commentLines.join('\n').trim() || null;
      const nowMs = Date.now();
      const dirCode = direction === 'BUY' ? '1' : '2';
      const signalId = `${nowMs}9${dirCode}${String(nowMs).slice(-4)}`;
      const orderTypeLabel = isLimit ? ' LIMIT' : '';
      const lines = [`XAUUSD ${direction}${orderTypeLabel} ${Math.round(entry)}`];
      tps.forEach((tp, i) => lines.push(tps.length === 1 ? `TP ${tp}` : `TP${i + 1} ${tp}`));
      lines.push(`SL ${sl}`, `LOT ${lot}`, `ID ${signalId}`);
      const webhookText = lines.join('\n');
      const payload = JSON.stringify({ text: webhookText, secret: process.env.WEBHOOK_SECRET, ...(comment ? { comment } : {}) });
      const port = process.env.PORT || 3000;
      const req2 = (await import('http')).default.request(
        { hostname: 'localhost', port, path: '/webhook/fvg', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
        () => {}
      );
      req2.on('error', (e) => console.error('/signal internal webhook error:', e));
      req2.write(payload);
      req2.end();
      await sendTelegram(fromChatId, `✅ Signalas priimtas:\n<pre>${webhookText}</pre>`, { parse_mode: 'HTML' });
      return res.json({ ok: true });
    }

    // /ema stop|start|skip|status — EMA agent control
    const emaCtrlMatch = text.match(/^\/ema\s+(stop|start|skip|status)(?:\s+(buy|sell))?$/i);
    if (emaCtrlMatch) {
      const cmd = emaCtrlMatch[1].toLowerCase();
      const dir = (emaCtrlMatch[2] || '').toUpperCase();
      if (cmd === 'stop') {
        emaAgentPaused = true;
        _saveAgentState();
        await sendTelegram(fromChatId, '⏸ EMA agentas <b>SUSTABDYTAS</b>. Paleisk su /ema start.', { parse_mode: 'HTML' });
      } else if (cmd === 'start') {
        emaAgentPaused = false;
        emaSkipUntilCross = null;
        _saveAgentState();
        await sendTelegram(fromChatId, '▶️ EMA agentas <b>PALEISTAS</b>. Laukia signalų.', { parse_mode: 'HTML' });
      } else if (cmd === 'skip') {
        if (!dir || !['BUY', 'SELL'].includes(dir)) {
          await sendTelegram(fromChatId, '❌ Nurodyk kryptį kurią praleisti: /ema skip buy arba /ema skip sell');
        } else {
          const waitFor = dir === 'BUY' ? 'SELL' : 'BUY';
          emaSkipUntilCross = waitFor;
          _saveAgentState();
          await sendTelegram(fromChatId, `⏭ EMA praleis <b>${dir}</b> signalus, laukia <b>${waitFor}</b> kryžiavimosi.`, { parse_mode: 'HTML' });
        }
      } else if (cmd === 'status') {
        const skipTxt = emaSkipUntilCross ? `Laukia <b>${emaSkipUntilCross}</b> kryžiavimosi` : '—';
        const e = tvEmaCache;
        let emaLines = '';
        if (e && e.c15m) {
          const e20_15 = parseFloat(e.ema20_15m), e50_15 = parseFloat(e.ema50_15m);
          const e20_1h = parseFloat(e.ema20_1h),  e50_1h  = parseFloat(e.ema50_1h);
          const close  = parseFloat(e.c15m);
          const bias15 = e20_15 > e50_15 ? '📈 BULL' : '📉 BEAR';
          const bias1h = e20_1h > e50_1h ? '📈 BULL' : '📉 BEAR';
          const aligned = (e20_15 > e50_15 && close > e20_1h && close > e50_1h)
            ? '🟢 BUY laukimas'
            : (e20_15 < e50_15 && close < e20_1h && close < e50_1h)
            ? '🔴 SELL laukimas'
            : '🟡 Nesutampa — signalo nėra';
          const updAt = e.updated_at ? e.updated_at.slice(11, 16) + ' UTC' : '—';
          emaLines =
            `\n💰 Close: <b>${close.toFixed(2)}</b>\n` +
            `15M: EMA20 <b>${e20_15.toFixed(2)}</b> | EMA50 <b>${e50_15.toFixed(2)}</b> → ${bias15}\n` +
            `1H:  EMA20 <b>${e20_1h.toFixed(2)}</b> | EMA50 <b>${e50_1h.toFixed(2)}</b> → ${bias1h}\n` +
            `\n${aligned}\n` +
            `⏱ Duomenys: ${updAt}`;
        } else {
          emaLines = '\n⚠️ EMA duomenų dar nėra (Pine Script neprisijungęs?)';
        }
        await sendTelegram(fromChatId,
          `📊 <b>EMA Agentas</b>\n` +
          `Sustabdytas: <b>${emaAgentPaused ? 'TAIP ⏸' : 'NE ▶️'}</b>\n` +
          `Skip: <b>${skipTxt}</b>` +
          emaLines,
          { parse_mode: 'HTML' }
        );
      }
      return res.json({ ok: true });
    }

    // /clearema — clear EMA agent state (tp1/tp3/ride) — use after manually closing positions
    if (/^\/clearema$/i.test(text)) {
      emaClearPending = true;
      await sendTelegram(fromChatId, '🗑 EMA state išvalymas užklaustas — agentas išvalys tp1/tp3/ride per artimiausią ciklą (iki 15 min).', { parse_mode: 'HTML' });
      return res.json({ ok: true });
    }


    // /rideopennow BUY|SELL <price> — manually open EMA ride position at given price
    const rideOpenMatch = text.match(/^\/rideopennow\s+(buy|sell)\s+([\d.]+)$/i);
    if (rideOpenMatch) {
      const dir = rideOpenMatch[1].toUpperCase();
      const entry = parseFloat(rideOpenMatch[2]);
      if (!entry || entry < 1000 || entry > 10000) {
        await sendTelegram(fromChatId, '❌ Neteisinga kaina. Naudok: /rideopennow SELL 4380');
        return res.json({ ok: true });
      }
      rideOpenPending = { direction: dir, entry };
      setTimeout(() => { rideOpenPending = null; }, 5 * 60 * 1000);
      await sendTelegram(fromChatId, `🏇 Ride ${dir} @ ${entry} užklaustas — agentas atidarys per 30s.`);
      return res.json({ ok: true });
    }

    // /cancelc <signal_id> — cancel pending limit order, send "ORDER CANCELED" reply
    const cancelcMatch = text.match(/^\/cancelc\s+(\S+)/i);
    if (cancelcMatch) {
      const signalId = cancelcMatch[1];
      const { data: tradeRow, error: lookupError } = await supabase
        .from('trades')
        .select('magic, tg_message_id, tg_chat_id')
        .eq('signal_id', signalId)
        .eq('status', 'open')
        .limit(1)
        .maybeSingle();
      if (lookupError) console.error('Supabase cancelc lookup error:', lookupError);

      const magic = tradeRow?.magic ?? parseInt(signalId.slice(-9));
      const cancelled = await cancelOrderByMagic(magic);

      if (!cancelled?.ok) {
        await sendTelegram(fromChatId, `❌ Cancel nepavyko — orderis nerastas arba MetaAPI klaida\nID ${signalId}\nMagic ${magic}`);
        return res.json({ ok: true });
      }

      await supabase.from('trades').delete().eq('magic', magic).eq('status', 'open');

      // Also cancel Order A (TP1 split order, magic+1) if it exists
      const magicA = (magic + 1) % 2147483647;
      try {
        const cancelA = await cancelOrderByMagic(magicA);
        if (cancelA?.ok) {
          await supabase.from('trades').delete().eq('magic', magicA).eq('status', 'open');
        }
      } catch (e) {
        console.error('cancelc Order A attempt failed:', e.message);
      }

      const channelChatId = tradeRow?.tg_chat_id || process.env.TELEGRAM_CHAT_ID_XAU;
      const channelOptions = tradeRow?.tg_message_id ? { reply_to_message_id: tradeRow.tg_message_id } : {};
      await sendTelegram(channelChatId, `ORDER CANCELED\nID ${signalId}`, channelOptions);
      await sendTelegram(fromChatId, `✅ ORDER CANCELED\nID ${signalId}`);
      return res.json({ ok: true });
    }

    // /modtp <magic> <new_tp> — modify take profit of open position
    const modTpMatch = text.match(/^\/modtp\s+(\d+)\s+([\d.]+)/i);
    if (modTpMatch) {
      const magic = parseInt(modTpMatch[1]);
      const newTp = parseFloat(modTpMatch[2]);
      try {
        // Find position by magic number
        const posRes = await metaApiFetch(
          `/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/positions`,
          { headers: { 'auth-token': process.env.METAAPI_TOKEN } }
        );
        const positions = await posRes.json();
        const pos = Array.isArray(positions) ? positions.find(p => p.magic === magic) : null;
        if (!pos) {
          await sendTelegram(fromChatId, `ERR: Pozicija su magic ${magic} nerasta. Patikrink magic MT4 Trade tab.`);
          return res.json({ ok: true });
        }
        const modRes = await metaApiFetch(
          `/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/trade`,
          {
            method: 'POST',
            headers: { 'auth-token': process.env.METAAPI_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ actionType: 'POSITION_MODIFY', positionId: pos.id, takeProfit: newTp }),
          }
        );
        const modData = await modRes.json();
        const ok = modData?.numericCode === 10009 || modData?.numericCode === 0
          || modData?.stringCode === 'TRADE_RETCODE_DONE' || modData?.stringCode === 'ERR_NO_ERROR';
        if (ok) {
          await supabase.from('trades').update({ tp: newTp }).eq('magic', magic).eq('status', 'open');
        }
        await sendTelegram(fromChatId, ok
          ? `✅ TP pakeistas → ${newTp} | Magic ${magic}`
          : `ERR: TP keitimas nepavyko\n${JSON.stringify(modData).slice(0, 200)}`);
      } catch (e) {
        await sendTelegram(fromChatId, `ERR: ${e.message}`);
      }
      return res.json({ ok: true });
    }

    const closeMatch = text.match(/^\/close\s+(\S+)/i);
    if (!closeMatch) return res.json({ ok: true });

    const signalId = closeMatch[1];

    // Look up trade by exact signal_id string, not by sliced magic
    const { data: tradeRow, error: lookupError } = await supabase
      .from('trades')
      .select('magic, tg_message_id, tg_chat_id, src_code')
      .eq('signal_id', signalId)
      .eq('status', 'open')
      .limit(1)
      .maybeSingle();
    if (lookupError) console.error('Supabase manual close lookup error:', lookupError);

    // Fallback: if signal_id column doesn't exist yet, use sliced magic
    const magic = tradeRow?.magic ?? parseInt(signalId.slice(-9));

    let exitPrice = null;
    let profit = null;

    const closeResult = await closeTradeByMagic(magic);
    let cancelResult = null;
    if (closeResult?.ok) {
      exitPrice = closeResult.exitPrice;
      profit = closeResult.profit;
      if (!profit) {
        const dealResult = await getClosedDealByMagic(magic);
        exitPrice = dealResult?.exitPrice || exitPrice;
        profit = dealResult?.profit || null;
      }
    } else {
      cancelResult = await cancelOrderByMagic(magic);
      if (!cancelResult?.ok) {
        const dealResult = await getClosedDealByMagic(magic);
        exitPrice = dealResult?.exitPrice || null;
        profit = dealResult?.profit || null;
      }
    }

    if (closeResult?.ok || profit != null) {
      // Reali pozicija uždaryta — saugom rezultatą
      const { error: updateError } = await supabase
        .from('trades')
        .update({
          status: 'closed',
          result: profit > 0 ? 'Win' : 'Loss',
          closed_at: nowVilnius(),
          exit: exitPrice,
          profit,
        })
        .eq('magic', magic)
        .eq('status', 'open');
      if (updateError) console.error('Supabase manual close error:', updateError);
    } else if (cancelResult?.ok) {
      // Atšauktas pending orderis nesaugomas — įrašas trinamas iš DB
      const { error: deleteError } = await supabase
        .from('trades')
        .delete()
        .eq('magic', magic)
        .eq('status', 'open');
      if (deleteError) console.error('Supabase manual close delete error:', deleteError);
    } else {
      await sendTelegram(fromChatId, `ERR: Close/cancel not confirmed by MetaAPI\nID ${signalId}\nMagic ${magic}`);
      return res.json({ ok: false, error: 'Close/cancel not confirmed' });
    }

    // Also close Order A (magic+1) if it exists
    const magicA = (magic + 1) % 2147483647;
    try {
      const closeA = await closeTradeByMagic(magicA);
      if (!closeA?.ok) await cancelOrderByMagic(magicA);
      const exitA = closeA?.exitPrice ?? null;
      const profitA = closeA?.profit ?? null;
      const resultA = profitA != null ? (profitA > 0 ? 'Win' : 'Loss') : 'Manual';
      await supabase.from('trades').update({
        status: 'closed',
        result: resultA,
        closed_at: nowVilnius(),
        exit: exitA,
        profit: profitA,
      }).eq('magic', magicA).eq('status', 'open');
    } catch (e) {
      console.error('Order A close attempt failed:', e.message);
    }

    const reply = profit != null
      ? `✅ Trade closed manually\nID ${signalId}\nExit: ${exitPrice ?? '—'}\nProfit: ${profit}`
      : `✅ Close signal sent\nID ${signalId}`;
    await sendTelegram(fromChatId, reply);

    const channelMsg = `✅ CLOSE TRADE — Manual\nID ${signalId}\nExit: ${exitPrice ?? '—'}\nProfit: ${profit ?? '—'}`;
    const channelOptions = tradeRow?.tg_message_id ? { reply_to_message_id: tradeRow.tg_message_id } : {};
    const channelChatId = tradeRow?.tg_chat_id || process.env.TELEGRAM_CHAT_ID_XAU;
    await sendTelegram(channelChatId, channelMsg, channelOptions);

    res.json({ ok: true });
  } catch (err) {
    console.error('POST /telegram-webhook error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ── GET /stats — strategy performance dashboard ───────────────────────────
app.get('/stats', async (req, res) => {
  try {
    const { data: closedTrades, error: closedErr } = await supabase
      .from('trades')
      .select('direction, entry, sl, tp, result, profit, exit, closed_at, src_code, lot')
      .eq('status', 'closed')
      .in('src_code', [6, 7])
      .order('closed_at', { ascending: false });
    if (closedErr) throw closedErr;

    const { data: openTrades, error: openErr } = await supabase
      .from('trades')
      .select('direction, entry, sl, tp, src_code, lot')
      .eq('status', 'open')
      .in('src_code', [6, 7]);
    if (openErr) throw openErr;

    // TL agent trades (src_code=9)
    const { data: tlClosed, error: tlClosedErr } = await supabase
      .from('trades')
      .select('direction, entry, sl, tp, result, profit, exit, closed_at, src_code')
      .eq('status', 'closed')
      .eq('src_code', 9)
      .order('closed_at', { ascending: false });
    if (tlClosedErr) throw tlClosedErr;

    const { data: tlOpen, error: tlOpenErr } = await supabase
      .from('trades')
      .select('direction, entry, sl, tp, src_code')
      .eq('status', 'open')
      .eq('src_code', 9);
    if (tlOpenErr) throw tlOpenErr;

    // RD (RedBlue) trades (src_code=8)
    const { data: rdClosed, error: rdClosedErr } = await supabase
      .from('trades')
      .select('direction, entry, sl, tp, result, profit, exit, closed_at, src_code')
      .eq('status', 'closed')
      .eq('src_code', 8)
      .order('closed_at', { ascending: false });
    if (rdClosedErr) throw rdClosedErr;

    const { data: rdOpen, error: rdOpenErr } = await supabase
      .from('trades')
      .select('direction, entry, sl, tp, src_code')
      .eq('status', 'open')
      .eq('src_code', 8);
    if (rdOpenErr) throw rdOpenErr;

    // HHHL Structure trades (src_code=10)
    const { data: hhhlStrClosed, error: hhhlStrClosedErr } = await supabase
      .from('trades')
      .select('direction, entry, sl, tp, result, profit, exit, closed_at, src_code, tf')
      .eq('status', 'closed')
      .eq('src_code', 10)
      .order('closed_at', { ascending: false });
    if (hhhlStrClosedErr) throw hhhlStrClosedErr;
    const { data: hhhlStrOpen, error: hhhlStrOpenErr } = await supabase
      .from('trades').select('direction, entry, sl, tp, tf').eq('status', 'open').eq('src_code', 10);
    if (hhhlStrOpenErr) throw hhhlStrOpenErr;

    // HHHL LINIJA trades (src_code=11)
    const { data: hhhlLinClosed, error: hhhlLinClosedErr } = await supabase
      .from('trades')
      .select('direction, entry, sl, tp, result, profit, exit, closed_at, src_code')
      .eq('status', 'closed')
      .eq('src_code', 11)
      .order('closed_at', { ascending: false });
    if (hhhlLinClosedErr) throw hhhlLinClosedErr;
    const { data: hhhlLinOpen, error: hhhlLinOpenErr } = await supabase
      .from('trades').select('direction, entry, sl, tp').eq('status', 'open').eq('src_code', 11);
    if (hhhlLinOpenErr) throw hhhlLinOpenErr;

    function getSlot(t, allTrades) {
      if (Number(t.src_code) === 7) return 'ride';
      const entry = Number(t.entry), sl = Number(t.sl), tp = Number(t.tp);
      if (!tp || !entry) return 'unknown';
      const risk = Math.abs(entry - sl);
      if (risk > 0) {
        const ratio = Math.abs(tp - entry) / risk;
        if (Math.abs(ratio - 1.0) < 0.3) return '1:1';
        if (Math.abs(ratio - 2.0) < 0.3) return '1:2';
        if (Math.abs(ratio - 3.0) < 0.5) return '1:3';
      }
      // SL was moved to entry (risk=0) — infer risk from sibling trades in same signal batch
      if (allTrades && allTrades.length > 0) {
        const siblings = allTrades.filter(s =>
          s !== t &&
          Number(s.src_code) === 6 &&
          s.direction === t.direction &&
          Math.abs(Number(s.entry) - entry) < 5 &&
          Math.abs(Number(s.sl) - Number(s.entry)) > 1
        );
        if (siblings.length > 0) {
          const inferredRisk = Math.min(...siblings.map(s => Math.abs(Number(s.sl) - Number(s.entry))));
          if (inferredRisk > 0) {
            const ratio = Math.abs(tp - entry) / inferredRisk;
            if (Math.abs(ratio - 1.0) < 0.3) return '1:1';
            if (Math.abs(ratio - 2.0) < 0.3) return '1:2';
            if (Math.abs(ratio - 3.0) < 0.5) return '1:3';
          }
        }
      }
      return 'unknown';
    }

    function calcStats(trades) {
      const wins   = trades.filter(t => t.result === 'TP' || t.result === 'Win' || (t.result === 'Manual' && (t.profit || 0) > 0));
      const losses = trades.filter(t => t.result === 'SL' || t.result === 'Loss' || (t.result === 'Manual' && (t.profit || 0) <= 0));
      const bes    = trades.filter(t => t.result === 'BE');
      const totalPnl  = trades.reduce((s, t) => s + (t.profit || 0), 0);
      const grossWin  = wins.reduce((s, t) => s + (t.profit || 0), 0);
      const grossLoss = losses.reduce((s, t) => s + (t.profit || 0), 0);
      const wr = (wins.length + losses.length) > 0
        ? (wins.length / (wins.length + losses.length)) * 100
        : 0;
      const pf = grossLoss !== 0 ? grossWin / Math.abs(grossLoss) : (grossWin > 0 ? Infinity : 0);
      return {
        total: trades.length, wins: wins.length, losses: losses.length, bes: bes.length,
        wr, totalPnl, pf,
        avgWin:  wins.length   ? grossWin  / wins.length   : 0,
        avgLoss: losses.length ? grossLoss / losses.length : 0,
      };
    }

    const slots = ['1:1', '1:2', '1:3', 'ride'];
    const bySlot = {};
    for (const s of slots) bySlot[s] = [];
    const allEmaPool = [...(closedTrades || []), ...(openTrades || [])];
    for (const t of (closedTrades || [])) {
      const s = getSlot(t, allEmaPool);
      if (bySlot[s]) bySlot[s].push(t);
    }
    const allEma = (closedTrades || []);
    const openBySlot = {};
    for (const s of slots) openBySlot[s] = 0;
    for (const t of (openTrades || [])) {
      const s = getSlot(t, allEmaPool);
      if (openBySlot[s] !== undefined) openBySlot[s]++;
    }

    function fmt(n)      { return isFinite(n) ? n.toFixed(2) : '∞'; }
    function fmtPct(n)   { return isFinite(n) ? n.toFixed(1) + '%' : '—'; }
    function pnlColor(n) { return n >= 0 ? '#4ade80' : '#f87171'; }
    function wrColor(n)  { return n >= 55 ? '#4ade80' : n >= 45 ? '#facc15' : '#f87171'; }
    function pfColor(n)  { return n >= 1.5 ? '#4ade80' : n >= 1 ? '#facc15' : '#f87171'; }
    function esc(v)      { return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function closeTime(t){ const v = String(t.closed_at||''); return v.slice(0,10)+' '+v.slice(11,16); }
    function resultColor(r){ return (r==='TP'||r==='Win') ? '#4ade80' : r==='BE' ? '#facc15' : '#f87171'; }

    function slotCard(label, s, open) {
      const st = calcStats(bySlot[s]);
      const openBadge = open > 0 ? `<span style="background:#1d4ed8;color:#bfdbfe;border-radius:8px;padding:1px 8px;font-size:.75rem;margin-left:8px;">+${open} open</span>` : '';
      return `
      <div class="card">
        <div class="card-title">${label}${openBadge}</div>
        <table class="stat-table">
          <tr><td>Trades</td><td>${st.total}</td></tr>
          <tr><td>W / L / BE</td><td>${st.wins} / ${st.losses} / ${st.bes}</td></tr>
          <tr><td>Win rate</td><td style="color:${wrColor(st.wr)};font-weight:700;">${fmtPct(st.wr)}</td></tr>
          <tr><td>Total PnL</td><td style="color:${pnlColor(st.totalPnl)};font-weight:700;">$${fmt(st.totalPnl)}</td></tr>
          <tr><td>Profit factor</td><td style="color:${pfColor(st.pf)};font-weight:700;">${fmt(st.pf)}</td></tr>
          <tr><td>Avg win</td><td style="color:#4ade80;">$${fmt(st.avgWin)}</td></tr>
          <tr><td>Avg loss</td><td style="color:#f87171;">$${fmt(st.avgLoss)}</td></tr>
        </table>
      </div>`;
    }

    const totalSt = calcStats(allEma);
    const totalOpen = (openTrades || []).length;

    // TL stats
    const tlSt = calcStats(tlClosed || []);
    const tlOpenCount = (tlOpen || []).length;
    const tlRecentTrades = (tlClosed || []).slice(0, 30);

    // RD stats
    const rdSt = calcStats(rdClosed || []);
    const rdOpenCount = (rdOpen || []).length;
    const rdRecentTrades = (rdClosed || []).slice(0, 30);

    // HHHL stats — split by TF
    const hhhlStr5mClosed  = (hhhlStrClosed || []).filter(t => !t.tf || t.tf === '5MIN');
    const hhhlStr15mClosed = (hhhlStrClosed || []).filter(t => t.tf === '15MIN');
    const hhhlStr5mSt = calcStats(hhhlStr5mClosed);
    const hhhlStr15mSt = calcStats(hhhlStr15mClosed);
    const hhhlStrOpenCount    = (hhhlStrOpen || []).length;
    const hhhlStr5mOpenCount  = (hhhlStrOpen || []).filter(t => !t.tf || t.tf === '5MIN').length;
    const hhhlStr15mOpenCount = (hhhlStrOpen || []).filter(t => t.tf === '15MIN').length;
    const hhhlStr5mRecent  = hhhlStr5mClosed.slice(0, 30);
    const hhhlStr15mRecent = hhhlStr15mClosed.slice(0, 30);
    const hhhlLinSt = calcStats(hhhlLinClosed || []);
    const hhhlLinOpenCount = (hhhlLinOpen || []).length;
    const hhhlLinRecent = (hhhlLinClosed || []).slice(0, 30);

    // Combined stats (all agents)
    const allClosed = [...(closedTrades || []), ...(tlClosed || []), ...(hhhlStrClosed || []), ...(hhhlLinClosed || [])];
    const allOpenCount = (openTrades || []).length + (tlOpen || []).length + hhhlStrOpenCount + hhhlLinOpenCount;
    const allSt = calcStats(allClosed);

    const recentTrades = (closedTrades || []).slice(0, 60);
    function tradesTableHtml() {
      if (!recentTrades.length) return '<div class="empty">Nėra uždarytų EMA trejdų.</div>';
      return `
      <div class="table-wrap">
        <table class="trade-table">
          <thead><tr>
            <th>Data</th><th>Dir</th><th>Entry</th><th>Exit</th>
            <th>Result</th><th>PnL</th>
          </tr></thead>
          <tbody>
            ${recentTrades.map(t => {
              return `<tr>
                <td>${esc(closeTime(t))}</td>
                <td>${esc(t.direction||'—')}</td>
                <td>${Number.isFinite(Number(t.entry)) ? formatSignalPrice(Number(t.entry)) : '—'}</td>
                <td>${Number.isFinite(Number(t.exit))  ? formatSignalPrice(Number(t.exit))  : '—'}</td>
                <td style="color:${resultColor(t.result)};font-weight:700;">${esc(t.result||'—')}</td>
                <td style="color:${pnlColor(t.profit||0)};font-weight:700;">$${fmt(t.profit||0)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>EMA Stats</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0f172a;color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:28px 20px;min-height:100vh;}
    h1{font-size:1.4rem;font-weight:800;margin-bottom:4px;}
    .sub{color:#64748b;font-size:.85rem;margin-bottom:24px;}
    .cards{display:flex;flex-wrap:wrap;gap:14px;margin-bottom:28px;}
    .card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:18px 20px;min-width:200px;flex:1;}
    .card.highlight{border-color:#6366f1;background:#1e1b4b;}
    .card-title{font-size:1rem;font-weight:700;color:#e2e8f0;margin-bottom:12px;}
    .stat-table{width:100%;border-collapse:collapse;font-size:.85rem;}
    .stat-table td{padding:3px 0;color:#94a3b8;}
    .stat-table td:last-child{text-align:right;color:#f1f5f9;font-weight:600;}
    .section-title{font-size:1rem;font-weight:700;margin:0 0 12px;color:#e2e8f0;}
    .empty{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:16px;color:#64748b;font-size:.9rem;}
    .table-wrap{overflow-x:auto;}
    .trade-table{width:100%;border-collapse:collapse;min-width:580px;font-size:.83rem;}
    .trade-table th{color:#64748b;font-weight:700;padding:9px 10px;text-align:left;background:#0f172a;position:sticky;top:0;}
    .trade-table td{color:#e2e8f0;padding:8px 10px;border-top:1px solid #1e293b;}
    .trade-table tr:hover td{background:#1e293b;}
    @media(max-width:600px){body{padding:18px 12px}.cards{gap:10px}}
  </style>
</head>
<body>
  <h1>Strategijų Stats</h1>
  <p class="sub">Visi agentai · ${allOpenCount > 0 ? `<b style="color:#4ade80">${allOpenCount} pozicija atidaryta</b>` : 'Nėra atvirų pozicijų'}</p>

  <div class="cards" style="margin-bottom:36px;">
    <div class="card" style="border-color:#6366f1;background:#1e1b4b;flex:1;">
      <div class="card-title" style="color:#a5b4fc;">Bendra — visi agentai</div>
      <table class="stat-table">
        <tr><td>Trades</td><td>${allSt.total}</td></tr>
        <tr><td>W / L / BE</td><td>${allSt.wins} / ${allSt.losses} / ${allSt.bes}</td></tr>
        <tr><td>Win rate</td><td style="color:${wrColor(allSt.wr)};font-weight:700;font-size:1.1rem;">${fmtPct(allSt.wr)}</td></tr>
        <tr><td>Total PnL</td><td style="color:${pnlColor(allSt.totalPnl)};font-weight:700;font-size:1.1rem;">$${fmt(allSt.totalPnl)}</td></tr>
        <tr><td>Profit factor</td><td style="color:${pfColor(allSt.pf)};font-weight:700;">${fmt(allSt.pf)}</td></tr>
        <tr><td>Avg win</td><td style="color:#4ade80;">$${fmt(allSt.avgWin)}</td></tr>
        <tr><td>Avg loss</td><td style="color:#f87171;">$${fmt(allSt.avgLoss)}</td></tr>
      </table>
    </div>
    <div class="card" style="min-width:140px;max-width:200px;">
      <div class="card-title">📈 EMA <span style="font-size:0.7rem;color:#64748b;font-weight:400;">(mt4)</span></div>
      <table class="stat-table">
        <tr><td>Trades</td><td>${totalSt.total}</td></tr>
        <tr><td>Win rate</td><td style="color:${wrColor(totalSt.wr)};font-weight:700;">${fmtPct(totalSt.wr)}</td></tr>
        <tr><td>PnL</td><td style="color:${pnlColor(totalSt.totalPnl)};font-weight:700;">$${fmt(totalSt.totalPnl)}</td></tr>
        <tr><td>PF</td><td style="color:${pfColor(totalSt.pf)};font-weight:700;">${fmt(totalSt.pf)}</td></tr>
      </table>
    </div>
    <div class="card" style="min-width:140px;max-width:200px;">
      <div class="card-title">📐 TL <span style="font-size:0.7rem;color:#64748b;font-weight:400;">(mt4)</span></div>
      <table class="stat-table">
        <tr><td>Trades</td><td>${tlSt.total}</td></tr>
        <tr><td>Win rate</td><td style="color:${wrColor(tlSt.wr)};font-weight:700;">${fmtPct(tlSt.wr)}</td></tr>
        <tr><td>PnL</td><td style="color:${pnlColor(tlSt.totalPnl)};font-weight:700;">$${fmt(tlSt.totalPnl)}</td></tr>
        <tr><td>PF</td><td style="color:${pfColor(tlSt.pf)};font-weight:700;">${fmt(tlSt.pf)}</td></tr>
      </table>
    </div>
    <div class="card" style="min-width:140px;max-width:200px;">
      <div class="card-title">🔵 RedBlue <span style="font-size:0.7rem;color:#64748b;font-weight:400;">(mt4)</span></div>
      <table class="stat-table">
        <tr><td>Trades</td><td>${rdSt.total}</td></tr>
        <tr><td>Win rate</td><td style="color:${wrColor(rdSt.wr)};font-weight:700;">${fmtPct(rdSt.wr)}</td></tr>
        <tr><td>PnL</td><td style="color:${pnlColor(rdSt.totalPnl)};font-weight:700;">$${fmt(rdSt.totalPnl)}</td></tr>
        <tr><td>PF</td><td style="color:${pfColor(rdSt.pf)};font-weight:700;">${fmt(rdSt.pf)}</td></tr>
      </table>
    </div>
    <div class="card" style="min-width:140px;max-width:200px;">
      <div class="card-title">📌 HHHL Str 5M <span style="font-size:0.7rem;color:#64748b;font-weight:400;">(mt5)</span></div>
      <table class="stat-table">
        <tr><td>Trades</td><td>${hhhlStr5mSt.total}</td></tr>
        <tr><td>Win rate</td><td style="color:${wrColor(hhhlStr5mSt.wr)};font-weight:700;">${fmtPct(hhhlStr5mSt.wr)}</td></tr>
        <tr><td>PnL</td><td style="color:${pnlColor(hhhlStr5mSt.totalPnl)};font-weight:700;">$${fmt(hhhlStr5mSt.totalPnl)}</td></tr>
        <tr><td>PF</td><td style="color:${pfColor(hhhlStr5mSt.pf)};font-weight:700;">${fmt(hhhlStr5mSt.pf)}</td></tr>
      </table>
    </div>
    <div class="card" style="min-width:140px;max-width:200px;">
      <div class="card-title">📌 HHHL Str 15M <span style="font-size:0.7rem;color:#64748b;font-weight:400;">(mt5)</span></div>
      <table class="stat-table">
        <tr><td>Trades</td><td>${hhhlStr15mSt.total}</td></tr>
        <tr><td>Win rate</td><td style="color:${wrColor(hhhlStr15mSt.wr)};font-weight:700;">${fmtPct(hhhlStr15mSt.wr)}</td></tr>
        <tr><td>PnL</td><td style="color:${pnlColor(hhhlStr15mSt.totalPnl)};font-weight:700;">$${fmt(hhhlStr15mSt.totalPnl)}</td></tr>
        <tr><td>PF</td><td style="color:${pfColor(hhhlStr15mSt.pf)};font-weight:700;">${fmt(hhhlStr15mSt.pf)}</td></tr>
      </table>
    </div>
    <div class="card" style="min-width:140px;max-width:200px;">
      <div class="card-title">📐 HHHL Lin <span style="font-size:0.7rem;color:#64748b;font-weight:400;">(mt5)</span></div>
      <table class="stat-table">
        <tr><td>Trades</td><td>${hhhlLinSt.total}</td></tr>
        <tr><td>Win rate</td><td style="color:${wrColor(hhhlLinSt.wr)};font-weight:700;">${fmtPct(hhhlLinSt.wr)}</td></tr>
        <tr><td>PnL</td><td style="color:${pnlColor(hhhlLinSt.totalPnl)};font-weight:700;">$${fmt(hhhlLinSt.totalPnl)}</td></tr>
        <tr><td>PF</td><td style="color:${pfColor(hhhlLinSt.pf)};font-weight:700;">${fmt(hhhlLinSt.pf)}</td></tr>
      </table>
    </div>
  </div>

  <hr style="border:none;border-top:1px solid #334155;margin:0 0 32px"/>

  <h1>📈 EMA Strategy — Stats</h1>
  <p class="sub">src_code 6 · ${totalOpen > 0 ? `<b style="color:#4ade80">${totalOpen} pozicija atidaryta</b>` : 'Nėra atvirų pozicijų'}</p>

  <div class="cards">
    <div class="card highlight">
      <div class="card-title">EMA Strategy</div>
      <table class="stat-table">
        <tr><td>Trades</td><td>${totalSt.total}</td></tr>
        <tr><td>W / L / BE</td><td>${totalSt.wins} / ${totalSt.losses} / ${totalSt.bes}</td></tr>
        <tr><td>Win rate</td><td style="color:${wrColor(totalSt.wr)};font-weight:700;">${fmtPct(totalSt.wr)}</td></tr>
        <tr><td>Total PnL</td><td style="color:${pnlColor(totalSt.totalPnl)};font-weight:700;">$${fmt(totalSt.totalPnl)}</td></tr>
        <tr><td>Profit factor</td><td style="color:${pfColor(totalSt.pf)};font-weight:700;">${fmt(totalSt.pf)}</td></tr>
        <tr><td>Avg win</td><td style="color:#4ade80;">$${fmt(totalSt.avgWin)}</td></tr>
        <tr><td>Avg loss</td><td style="color:#f87171;">$${fmt(totalSt.avgLoss)}</td></tr>
      </table>
    </div>
  </div>

  <p class="section-title">Paskutiniai 60 EMA trejdų</p>
  ${tradesTableHtml()}

  <hr style="border:none;border-top:1px solid #334155;margin:36px 0"/>

  <h1 style="margin-bottom:4px;">📐 TL Agent — Trendline Stats</h1>
  <p class="sub">src_code=9 · Manualiai nustatyti trendline'ai · ${tlOpenCount > 0 ? `<b style="color:#4ade80">${tlOpenCount} pozicija atidaryta</b>` : 'Nėra atvirų pozicijų'}</p>

  <div class="cards">
    <div class="card highlight">
      <div class="card-title">Visi TL</div>
      <table class="stat-table">
        <tr><td>Trades</td><td>${tlSt.total}</td></tr>
        <tr><td>W / L / BE</td><td>${tlSt.wins} / ${tlSt.losses} / ${tlSt.bes}</td></tr>
        <tr><td>Win rate</td><td style="color:${wrColor(tlSt.wr)};font-weight:700;">${fmtPct(tlSt.wr)}</td></tr>
        <tr><td>Total PnL</td><td style="color:${pnlColor(tlSt.totalPnl)};font-weight:700;">$${fmt(tlSt.totalPnl)}</td></tr>
        <tr><td>Profit factor</td><td style="color:${pfColor(tlSt.pf)};font-weight:700;">${fmt(tlSt.pf)}</td></tr>
        <tr><td>Avg win</td><td style="color:#4ade80;">$${fmt(tlSt.avgWin)}</td></tr>
        <tr><td>Avg loss</td><td style="color:#f87171;">$${fmt(tlSt.avgLoss)}</td></tr>
      </table>
    </div>
  </div>

  <p class="section-title" style="margin-top:16px;">Paskutiniai 30 TL trejdų</p>
  ${tlRecentTrades.length ? `
  <div class="table-wrap">
    <table class="trade-table">
      <thead><tr><th>Data</th><th>Dir</th><th>Entry</th><th>Exit</th><th>Result</th><th>PnL</th></tr></thead>
      <tbody>
        ${tlRecentTrades.map(t => `<tr>
          <td>${esc(closeTime(t))}</td>
          <td>${esc(t.direction||'—')}</td>
          <td>${Number.isFinite(Number(t.entry)) ? formatSignalPrice(Number(t.entry)) : '—'}</td>
          <td>${Number.isFinite(Number(t.exit))  ? formatSignalPrice(Number(t.exit))  : '—'}</td>
          <td style="color:${resultColor(t.result)};font-weight:700;">${esc(t.result||'—')}</td>
          <td style="color:${pnlColor(t.profit||0)};font-weight:700;">$${fmt(t.profit||0)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>` : '<div class="empty">Nėra uždarytų TL trejdų.</div>'}

  <hr style="border:none;border-top:1px solid #334155;margin:36px 0"/>

  <h1 style="margin-bottom:4px;">🔵 RD — RedBlue Stats</h1>
  <p class="sub">src_code=8 · EMA20 × SMA200 band breakout · ${rdOpenCount > 0 ? `<b style="color:#4ade80">${rdOpenCount} pozicija atidaryta</b>` : 'Nėra atvirų pozicijų'}</p>

  <div class="cards">
    <div class="card highlight">
      <div class="card-title">Visi RD</div>
      <table class="stat-table">
        <tr><td>Trades</td><td>${rdSt.total}</td></tr>
        <tr><td>W / L / BE</td><td>${rdSt.wins} / ${rdSt.losses} / ${rdSt.bes}</td></tr>
        <tr><td>Win rate</td><td style="color:${wrColor(rdSt.wr)};font-weight:700;">${fmtPct(rdSt.wr)}</td></tr>
        <tr><td>Total PnL</td><td style="color:${pnlColor(rdSt.totalPnl)};font-weight:700;">$${fmt(rdSt.totalPnl)}</td></tr>
        <tr><td>Profit factor</td><td style="color:${pfColor(rdSt.pf)};font-weight:700;">${fmt(rdSt.pf)}</td></tr>
        <tr><td>Avg win</td><td style="color:#4ade80;">$${fmt(rdSt.avgWin)}</td></tr>
        <tr><td>Avg loss</td><td style="color:#f87171;">$${fmt(rdSt.avgLoss)}</td></tr>
      </table>
    </div>
  </div>

  <p class="section-title" style="margin-top:16px;">Paskutiniai 30 RD trejdų</p>
  ${rdRecentTrades.length ? `
  <div class="table-wrap">
    <table class="trade-table">
      <thead><tr><th>Data</th><th>Dir</th><th>Entry</th><th>Exit</th><th>Result</th><th>PnL</th></tr></thead>
      <tbody>
        ${rdRecentTrades.map(t => `<tr>
          <td>${esc(closeTime(t))}</td>
          <td>${esc(t.direction||'—')}</td>
          <td>${Number.isFinite(Number(t.entry)) ? formatSignalPrice(Number(t.entry)) : '—'}</td>
          <td>${Number.isFinite(Number(t.exit))  ? formatSignalPrice(Number(t.exit))  : '—'}</td>
          <td style="color:${resultColor(t.result)};font-weight:700;">${esc(t.result||'—')}</td>
          <td style="color:${pnlColor(t.profit||0)};font-weight:700;">$${fmt(t.profit||0)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>` : '<div class="empty">Nėra uždarytų RD trejdų.</div>'}

  <hr style="border:none;border-top:1px solid #334155;margin:32px 0 24px"/>

  <h2 style="margin-bottom:4px;font-size:1rem;color:#94a3b8;">Aktyvios trendline'ų (${trendlineState.length})</h2>
  ${(() => {
    const fmt2 = d => new Date(d).toLocaleString('lt-LT', { timeZone: 'Europe/Vilnius', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    if (trendlineState.length === 0) return '<div class="empty">Nėra aktyvių trendline\'ų.</div>';
    return `<div class="cards">${trendlineState.map(tl => {
      const dirLabel = tl.direction === 'down' ? '⬇ DOWNTREND → BUY' : '⬆ UPTREND → SELL';
      return `<div class="card" style="min-width:180px;max-width:260px;border-color:#f59e0b;background:#1c1a0a;">
      <div class="card-title" style="color:#fbbf24;">TL #${tl.id} <span style="color:#4ade80;font-size:0.75rem;">● AKTYVI</span></div>
      <table class="stat-table">
        <tr><td>Kryptis</td><td style="color:#fbbf24;">${dirLabel}</td></tr>
        <tr><td>Anchor 1</td><td><b>${tl.p1}</b> @ ${fmt2(tl.t1)}</td></tr>
        <tr><td>Anchor 2</td><td><b>${tl.p2}</b> @ ${fmt2(tl.t2)}</td></tr>
        <tr><td>SL / TP</td><td>${tl.slPt}pt / ${tl.tpPt}pt</td></tr>
      </table>
    </div>`;
    }).join('')}</div>`;
  })()}

  <h2 style="margin-top:20px;margin-bottom:4px;font-size:1rem;color:#64748b;">Atšauktos (${trendlineHistory.length})</h2>
  ${(() => {
    const fmt2 = d => new Date(d).toLocaleString('lt-LT', { timeZone: 'Europe/Vilnius', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    if (trendlineHistory.length === 0) return '<div class="empty" style="color:#475569;">Nėra atšauktų trendline\'ų.</div>';
    return `<div class="cards">${[...trendlineHistory].reverse().map(tl => {
      const dirLabel = tl.direction === 'down' ? '⬇ DOWN → BUY' : '⬆ UP → SELL';
      return `<div class="card" style="min-width:180px;max-width:260px;border-color:#334155;opacity:0.7;">
      <div class="card-title" style="color:#64748b;">TL #${tl.id} <span style="color:#f87171;font-size:0.75rem;">✕ ATŠAUKTA</span></div>
      <table class="stat-table">
        <tr><td>Kryptis</td><td>${dirLabel}</td></tr>
        <tr><td>Anchor 1</td><td>${tl.p1} @ ${fmt2(tl.t1)}</td></tr>
        <tr><td>Anchor 2</td><td>${tl.p2} @ ${fmt2(tl.t2)}</td></tr>
        <tr><td>SL / TP</td><td>${tl.slPt}pt / ${tl.tpPt}pt</td></tr>
        <tr><td>Atšaukta</td><td style="color:#64748b;">${fmt2(tl.cancelledAt||'')}</td></tr>
      </table>
    </div>`;
    }).join('')}</div>`;
  })()}

  <hr style="border:none;border-top:1px solid #334155;margin:36px 0"/>

  <h1 style="margin-bottom:4px;">📌 HHHL Structure 5MIN — Stats</h1>
  <p class="sub">src_code=10 · tf=5MIN · MT5 limit orderiai · ${hhhlStr5mOpenCount > 0 ? `<b style="color:#4ade80">${hhhlStr5mOpenCount} pozicija atidaryta</b>` : 'Nėra atvirų pozicijų'}</p>

  <div class="cards">
    <div class="card highlight">
      <div class="card-title">HHHL Structure 5MIN</div>
      <table class="stat-table">
        <tr><td>Trades</td><td>${hhhlStr5mSt.total}</td></tr>
        <tr><td>W / L / BE</td><td>${hhhlStr5mSt.wins} / ${hhhlStr5mSt.losses} / ${hhhlStr5mSt.bes}</td></tr>
        <tr><td>Win rate</td><td style="color:${wrColor(hhhlStr5mSt.wr)};font-weight:700;">${fmtPct(hhhlStr5mSt.wr)}</td></tr>
        <tr><td>Total PnL</td><td style="color:${pnlColor(hhhlStr5mSt.totalPnl)};font-weight:700;">$${fmt(hhhlStr5mSt.totalPnl)}</td></tr>
        <tr><td>Profit factor</td><td style="color:${pfColor(hhhlStr5mSt.pf)};font-weight:700;">${fmt(hhhlStr5mSt.pf)}</td></tr>
        <tr><td>Avg win</td><td style="color:#4ade80;">$${fmt(hhhlStr5mSt.avgWin)}</td></tr>
        <tr><td>Avg loss</td><td style="color:#f87171;">$${fmt(hhhlStr5mSt.avgLoss)}</td></tr>
      </table>
    </div>
  </div>

  <p class="section-title" style="margin-top:16px;">Paskutiniai 30 HHHL Structure 5MIN trejdų</p>
  ${hhhlStr5mRecent.length ? `
  <div class="table-wrap">
    <table class="trade-table">
      <thead><tr><th>Data</th><th>Dir</th><th>Entry</th><th>Exit</th><th>Result</th><th>PnL</th></tr></thead>
      <tbody>
        ${hhhlStr5mRecent.map(t => `<tr>
          <td>${esc(closeTime(t))}</td>
          <td>${esc(t.direction||'—')}</td>
          <td>${Number.isFinite(Number(t.entry)) ? formatSignalPrice(Number(t.entry)) : '—'}</td>
          <td>${Number.isFinite(Number(t.exit))  ? formatSignalPrice(Number(t.exit))  : '—'}</td>
          <td style="color:${resultColor(t.result)};font-weight:700;">${esc(t.result||'—')}</td>
          <td style="color:${pnlColor(t.profit||0)};font-weight:700;">$${fmt(t.profit||0)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>` : '<div class="empty">Nėra uždarytų HHHL Structure 5MIN trejdų.</div>'}

  <hr style="border:none;border-top:1px solid #334155;margin:36px 0"/>

  <h1 style="margin-bottom:4px;">📌 HHHL Structure 15MIN — Stats</h1>
  <p class="sub">src_code=10 · tf=15MIN · MT5 limit orderiai · ${hhhlStr15mOpenCount > 0 ? `<b style="color:#4ade80">${hhhlStr15mOpenCount} pozicija atidaryta</b>` : 'Nėra atvirų pozicijų'}</p>

  <div class="cards">
    <div class="card highlight">
      <div class="card-title">HHHL Structure 15MIN</div>
      <table class="stat-table">
        <tr><td>Trades</td><td>${hhhlStr15mSt.total}</td></tr>
        <tr><td>W / L / BE</td><td>${hhhlStr15mSt.wins} / ${hhhlStr15mSt.losses} / ${hhhlStr15mSt.bes}</td></tr>
        <tr><td>Win rate</td><td style="color:${wrColor(hhhlStr15mSt.wr)};font-weight:700;">${fmtPct(hhhlStr15mSt.wr)}</td></tr>
        <tr><td>Total PnL</td><td style="color:${pnlColor(hhhlStr15mSt.totalPnl)};font-weight:700;">$${fmt(hhhlStr15mSt.totalPnl)}</td></tr>
        <tr><td>Profit factor</td><td style="color:${pfColor(hhhlStr15mSt.pf)};font-weight:700;">${fmt(hhhlStr15mSt.pf)}</td></tr>
        <tr><td>Avg win</td><td style="color:#4ade80;">$${fmt(hhhlStr15mSt.avgWin)}</td></tr>
        <tr><td>Avg loss</td><td style="color:#f87171;">$${fmt(hhhlStr15mSt.avgLoss)}</td></tr>
      </table>
    </div>
  </div>

  <p class="section-title" style="margin-top:16px;">Paskutiniai 30 HHHL Structure 15MIN trejdų</p>
  ${hhhlStr15mRecent.length ? `
  <div class="table-wrap">
    <table class="trade-table">
      <thead><tr><th>Data</th><th>Dir</th><th>Entry</th><th>Exit</th><th>Result</th><th>PnL</th></tr></thead>
      <tbody>
        ${hhhlStr15mRecent.map(t => `<tr>
          <td>${esc(closeTime(t))}</td>
          <td>${esc(t.direction||'—')}</td>
          <td>${Number.isFinite(Number(t.entry)) ? formatSignalPrice(Number(t.entry)) : '—'}</td>
          <td>${Number.isFinite(Number(t.exit))  ? formatSignalPrice(Number(t.exit))  : '—'}</td>
          <td style="color:${resultColor(t.result)};font-weight:700;">${esc(t.result||'—')}</td>
          <td style="color:${pnlColor(t.profit||0)};font-weight:700;">$${fmt(t.profit||0)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>` : '<div class="empty">Nėra uždarytų HHHL Structure 15MIN trejdų.</div>'}

  <hr style="border:none;border-top:1px solid #334155;margin:36px 0"/>

  <h1 style="margin-bottom:4px;">📐 HHHL LINIJA — Stats</h1>
  <p class="sub">src_code=11 · MT5 market+limit orderiai (TL break) · ${hhhlLinOpenCount > 0 ? `<b style="color:#4ade80">${hhhlLinOpenCount} pozicija atidaryta</b>` : 'Nėra atvirų pozicijų'}</p>

  <div class="cards">
    <div class="card highlight">
      <div class="card-title">HHHL LINIJA</div>
      <table class="stat-table">
        <tr><td>Trades</td><td>${hhhlLinSt.total}</td></tr>
        <tr><td>W / L / BE</td><td>${hhhlLinSt.wins} / ${hhhlLinSt.losses} / ${hhhlLinSt.bes}</td></tr>
        <tr><td>Win rate</td><td style="color:${wrColor(hhhlLinSt.wr)};font-weight:700;">${fmtPct(hhhlLinSt.wr)}</td></tr>
        <tr><td>Total PnL</td><td style="color:${pnlColor(hhhlLinSt.totalPnl)};font-weight:700;">$${fmt(hhhlLinSt.totalPnl)}</td></tr>
        <tr><td>Profit factor</td><td style="color:${pfColor(hhhlLinSt.pf)};font-weight:700;">${fmt(hhhlLinSt.pf)}</td></tr>
        <tr><td>Avg win</td><td style="color:#4ade80;">$${fmt(hhhlLinSt.avgWin)}</td></tr>
        <tr><td>Avg loss</td><td style="color:#f87171;">$${fmt(hhhlLinSt.avgLoss)}</td></tr>
      </table>
    </div>
  </div>

  <p class="section-title" style="margin-top:16px;">Paskutiniai 30 HHHL LINIJA trejdų</p>
  ${hhhlLinRecent.length ? `
  <div class="table-wrap">
    <table class="trade-table">
      <thead><tr><th>Data</th><th>Dir</th><th>Entry</th><th>Exit</th><th>Result</th><th>PnL</th></tr></thead>
      <tbody>
        ${hhhlLinRecent.map(t => `<tr>
          <td>${esc(closeTime(t))}</td>
          <td>${esc(t.direction||'—')}</td>
          <td>${Number.isFinite(Number(t.entry)) ? formatSignalPrice(Number(t.entry)) : '—'}</td>
          <td>${Number.isFinite(Number(t.exit))  ? formatSignalPrice(Number(t.exit))  : '—'}</td>
          <td style="color:${resultColor(t.result)};font-weight:700;">${esc(t.result||'—')}</td>
          <td style="color:${pnlColor(t.profit||0)};font-weight:700;">$${fmt(t.profit||0)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>` : '<div class="empty">Nėra uždarytų HHHL LINIJA trejdų.</div>'}

  <hr style="border:none;border-top:1px solid #334155;margin:36px 0"/>

  <h2 style="margin-bottom:8px;font-size:1rem;color:#94a3b8;">HHHL LINIJA — aktyvi trendline state</h2>
  <div class="cards">
    ${['15MIN', '60MIN'].map(tfKey => {
      const tfLabel = tfKey === '60MIN' ? '1H' : tfKey;
      const s = hhhlLinijaState[tfKey] || { res: null, sup: null };
      const fmtT = t => t ? new Date(t).toLocaleString('lt-LT', { timeZone: 'Europe/Vilnius', hour: '2-digit', minute: '2-digit' }) : '—';
      const resRow = s.res
        ? `<tr><td>RES</td><td style="color:#f87171;">P1: ${s.res.p1} → P2: ${s.res.p2} <span style="color:#4ade80;font-size:0.7rem;">● aktyvi</span> ${fmtT(s.res.updated_at)}</td></tr>`
        : `<tr><td>RES</td><td style="color:#475569;">nėra aktyvios</td></tr>`;
      const supRow = s.sup
        ? `<tr><td>SUP</td><td style="color:#4ade80;">P1: ${s.sup.p1} → P2: ${s.sup.p2} <span style="color:#4ade80;font-size:0.7rem;">● aktyvi</span> ${fmtT(s.sup.updated_at)}</td></tr>`
        : `<tr><td>SUP</td><td style="color:#475569;">nėra aktyvios</td></tr>`;
      return `<div class="card" style="min-width:200px;max-width:300px;border-color:#38bdf8;background:#0a161c;">
      <div class="card-title" style="color:#7dd3fc;">HHHL LINIJA ${tfLabel}</div>
      <table class="stat-table">
        <tr><td>Endpoint</td><td style="font-size:0.72rem;">/webhook/hhhl-break</td></tr>
        <tr><td>Orderis</td><td>Market / Limit (&lt;8pt→limit+1pt)</td></tr>
        <tr><td>TP / SL</td><td>10pt / 10pt</td></tr>
        ${resRow}
        ${supRow}
      </table>
    </div>`;
    }).join('')}
  </div>

</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error('GET /stats error:', err);
    res.status(500).send('Internal server error');
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
// Auto-reset agents at midnight Vilnius — prevents "forgot to re-enable" situation
setInterval(() => {
  const now = new Date();
  const vln = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Vilnius' }));
  if (vln.getHours() === 0 && vln.getMinutes() === 0) {
    if (emaAgentPaused) {
      emaAgentPaused = false;
      _saveAgentState();
      console.log('Midnight auto-reset: EMA agent re-enabled');
      sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, '🔄 Midnight auto-reset: EMA agentas automatiškai įjungtas (00:00 Vilnius)');
    }
  }
}, 60_000);


app.listen(PORT, async () => {
  console.log(`Aurora FX Gold running on port ${PORT} [DEMO_MODE=${DEMO_MODE}]`);
  if (DEMO_MODE) {
    console.log('[DEMO] Startup: skipping Supabase, Telegram setWebhook and all external service calls.');
    return;
  }
  try {
    const { data: lotSetting } = await supabase.from('settings').select('value').eq('key', 'master_lot_size').maybeSingle();
    if (lotSetting?.value) {
      const parsed = parseFloat(lotSetting.value);
      if (Number.isFinite(parsed) && parsed > 0) {
        masterLotSize = parsed;
        console.log(`Master lot loaded from Supabase: ${masterLotSize}`);
      }
    }
  } catch (e) {
    console.warn('Could not load master lot from Supabase:', e.message);
  }
  try {
    const webhookUrl = `${process.env.RAILWAY_SERVER_URL || 'https://yourdomain.com'}/telegram-webhook`;
    const webhookBody = { url: webhookUrl };
    // Jei nustatytas secret — Telegram pridės ji prie kiekvienos uzklausos header'yje,
    // o /telegram-webhook ji patikrins. Be env kintamojo apsauga isjungta (botas veikia kaip anksciau).
    if (process.env.TELEGRAM_WEBHOOK_SECRET) webhookBody.secret_token = process.env.TELEGRAM_WEBHOOK_SECRET;
    const r = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(webhookBody),
      }
    );
    const d = await r.json();
    console.log('Telegram setWebhook:', JSON.stringify(d), 'secured:', !!process.env.TELEGRAM_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Telegram setWebhook error:', err);
  }
});
