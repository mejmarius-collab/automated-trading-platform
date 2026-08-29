import fs from 'fs';
import { DEMO_MODE, AGENT_STATE_FILE, EMA_CACHE_FILE } from './config.js';
import { supabase } from './config.js';
import { sendTelegram } from './services/telegram.js';

// ── Persisted agent state ──────────────────────────────────────────────────
function _loadAgentState() {
  try {
    if (fs.existsSync(AGENT_STATE_FILE)) return JSON.parse(fs.readFileSync(AGENT_STATE_FILE, 'utf8'));
  } catch {}
  return {};
}

const _saved = _loadAgentState();

// ── Shared mutable state ───────────────────────────────────────────────────
// All route handlers import this object and mutate its properties.
export const state = {
  // Price cache
  priceCache: null,
  priceCacheTime: 0,

  // EMA agent control
  emaAgentPaused:    _saved.emaAgentPaused    ?? false,
  emaSkipUntilCross: _saved.emaSkipUntilCross ?? null,
  emaClearPending:   false,
  rideOpenPending:   null,

  // Trendline state
  trendlineState:   Array.isArray(_saved.trendlineState)   ? _saved.trendlineState             : [],
  trendlineHistory: Array.isArray(_saved.trendlineHistory) ? _saved.trendlineHistory.slice(-30) : [],
  _tlNextId:        _saved._tlNextId ?? 1,
  tvTlActiveOrders: [],

  // HHHL state
  hhhlLinijaState: { '15MIN': { res: null, sup: null }, '60MIN': { res: null, sup: null } },
  hhhlLimitDedup:  new Map(),
  hhhlBreakDedup:  new Map(),
  hhhlLinijaOrders: [],
  hhhlStaleTracker: new Map(),

  // Master lot
  masterLotSize: parseFloat(process.env.DEFAULT_LOT_SIZE || '0.10'),

  // Cycle agent state
  cycleState: null,

  // EMA cache (restored from disk)
  tvEmaCache: (() => {
    try {
      if (fs.existsSync(EMA_CACHE_FILE)) {
        const data = JSON.parse(fs.readFileSync(EMA_CACHE_FILE, 'utf8'));
        console.log('[EMA] Restored cache from disk:', data.updated_at);
        return data;
      }
    } catch (e) { console.warn('[EMA] Could not restore cache from disk:', e.message); }
    return {};
  })(),

  // TP milestone monitor
  tpMilestoneNotified: new Set(),
  tpMilestoneInProgress: new Set(),
  tpMonitorRunning: false,
};

// ── State persistence ──────────────────────────────────────────────────────
export function saveAgentState() {
  try {
    fs.writeFileSync(AGENT_STATE_FILE, JSON.stringify({
      emaAgentPaused: state.emaAgentPaused,
      emaSkipUntilCross: state.emaSkipUntilCross,
      trendlineState: state.trendlineState,
      trendlineHistory: state.trendlineHistory,
      _tlNextId: state._tlNextId,
    }));
  } catch {}
  supabase.from('settings').upsert({ key: 'ema_control', value: { emaAgentPaused: state.emaAgentPaused, emaSkipUntilCross: state.emaSkipUntilCross } }, { onConflict: 'key' }).then(({ error }) => {
    if (error) console.error('[state] Supabase EMA control upsert failed:', error.message);
  });
  supabase.from('settings').delete().eq('key', 'trendline_state').then(() => {
    supabase.from('settings').insert({ key: 'trendline_state', value: { trendlineState: state.trendlineState, trendlineHistory: state.trendlineHistory, _tlNextId: state._tlNextId } }).then(({ error }) => {
      if (error) console.error('[state] Supabase trendline insert failed:', error.message);
      else console.log(`[state] Trendline state saved: ${state.trendlineState.length} active, ${state.trendlineHistory.length} history`);
    });
  });
}

export async function restoreEmaControlFromSupabase() {
  try {
    const { data: rows } = await supabase.from('settings').select('value').eq('key', 'ema_control');
    if (!rows || rows.length === 0) return;
    const row = rows[rows.length - 1];
    if (row.value.emaAgentPaused != null) state.emaAgentPaused = row.value.emaAgentPaused;
    if (row.value.emaSkipUntilCross !== undefined) state.emaSkipUntilCross = row.value.emaSkipUntilCross;
    console.log(`[state] EMA control restored: paused=${state.emaAgentPaused} skip=${state.emaSkipUntilCross}`);
  } catch (e) { console.warn('[state] Could not restore EMA control from Supabase:', e.message); }
}

export async function restoreTrendlineFromSupabase() {
  try {
    const { data: rows, error } = await supabase.from('settings').select('value').eq('key', 'trendline_state');
    console.log(`[state] TL restore: rows=${rows?.length ?? 0} error=${error?.message ?? 'none'}`);
    if (error || !rows || rows.length === 0) return;
    const row = rows[rows.length - 1];
    if (Array.isArray(row.value?.trendlineState))   state.trendlineState   = row.value.trendlineState;
    if (Array.isArray(row.value?.trendlineHistory)) state.trendlineHistory = row.value.trendlineHistory.slice(-30);
    if (row.value?._tlNextId != null) state._tlNextId = row.value._tlNextId;
    console.log(`[state] Trendlines restored: ${state.trendlineState.length} active, ${state.trendlineHistory.length} history`);
  } catch (e) { console.warn('[state] Could not restore trendline state from Supabase:', e.message); }
}

export async function loadTlActiveOrders() {
  try {
    const { data } = await supabase.from('tl_active_orders').select('*');
    if (data && data.length) {
      state.tvTlActiveOrders = data.map(r => ({
        market_magic:     Number(r.market_magic),
        limit_magic:      Number(r.limit_magic),
        market_signal_id: r.market_signal_id,
        limit_signal_id:  r.limit_signal_id,
      }));
      console.log(`[tv-tl] Loaded ${state.tvTlActiveOrders.length} active TL orders from Supabase`);
    }
  } catch (e) { console.warn('[tv-tl] Could not load tl_active_orders:', e.message); }
}

export async function saveTlOrder(order) {
  try {
    await supabase.from('tl_active_orders').upsert({
      market_magic:     order.market_magic,
      limit_magic:      order.limit_magic,
      market_signal_id: order.market_signal_id,
      limit_signal_id:  order.limit_signal_id,
    });
  } catch (e) { console.warn('[tv-tl] Supabase save failed:', e.message); }
}

export async function deleteTlOrder(market_magic) {
  try {
    await supabase.from('tl_active_orders').delete().eq('market_magic', Number(market_magic));
  } catch (e) { console.warn('[tv-tl] Supabase delete failed:', e.message); }
}

// ── Promises for startup restore (resolved immediately in DEMO_MODE) ────────
export const emaControlReady    = DEMO_MODE ? Promise.resolve() : restoreEmaControlFromSupabase();
export const trendlineReady     = DEMO_MODE ? Promise.resolve() : restoreTrendlineFromSupabase();
