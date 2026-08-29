import { supabase, DEMO_MODE, TP_CHECK_INTERVAL_MS, SINGLE_STEP_TP_SRC_CODES } from '../config.js';
import { state } from '../state.js';
import { metaApiFetch } from './metaapi.js';
import { sendTelegram } from './telegram.js';
import { movePositionStopLoss } from './metaapi.js';
import {
  parseOpenTradeResult, formatOpenTradeResultMeta, getTakeProfitLevelsForRow,
  nowVilnius,
} from '../utils/formatters.js';

function getTradeKey(row)               { return String(row.signal_id || row.magic); }
function getTpMilestoneKey(row, label)  { return `${getTradeKey(row)}:${label}`; }

function tpMilestoneHit(row, position, tp) {
  const currentPrice = Number(position.currentPrice);
  if (!Number.isFinite(currentPrice)) return false;
  return row.direction === 'BUY' ? currentPrice >= tp.price : currentPrice <= tp.price;
}

export async function reconcileOpenTrades() {
  try {
    const { data: openRows } = await supabase
      .from('trades')
      .select('magic, signal_id, symbol, direction, entry, tp, result, tg_message_id, tg_chat_id, src_code')
      .eq('status', 'open');
    if (!openRows || openRows.length === 0) return;

    const headers = { 'auth-token': process.env.METAAPI_TOKEN };
    const accountId = process.env.METAAPI_MASTER_ACCOUNT_ID;
    const positions = await (await metaApiFetch(`/users/current/accounts/${accountId}/positions`, { headers })).json();
    if (!Array.isArray(positions)) return;
    const orders = await (await metaApiFetch(`/users/current/accounts/${accountId}/orders`, { headers })).json();
    if (!Array.isArray(orders)) return;

    const liveMagics = new Set([...positions.map(p => Number(p.magic)), ...orders.map(o => Number(o.magic))]);
    const stale = openRows.filter(r => !liveMagics.has(Number(r.magic)));
    if (stale.length === 0) return;

    const endTime = new Date().toISOString();
    const startTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const deals = await (await metaApiFetch(`/users/current/accounts/${accountId}/history-deals/time/${startTime}/${endTime}`, { headers })).json();
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
      if (outDeals.length === 0) continue;

      const profit = outDeals.reduce((s, d) => s + (d.profit || 0), 0);
      const exitPrice = outDeals[outDeals.length - 1].price ?? null;
      const atTpLevel = row.tp && exitPrice && Math.abs(exitPrice - row.tp) <= 5;
      let result = profit > 0 && !atTpLevel ? 'Manual' : profit > 0 ? 'TP' : 'SL';
      const { error: updError } = await supabase.from('trades')
        .update({ status: 'closed', result, closed_at: nowVilnius(), exit: exitPrice, profit })
        .eq('magic', row.magic).eq('status', 'open');
      if (updError) { console.error('Reconcile update error:', updError); continue; }

      if (String(row.signal_id || '').endsWith('_a')) {
        console.log('Reconciled closed Order A trade (silent):', row.magic, result, 'profit:', profit);
        continue;
      }

      const reconMeta = parseOpenTradeResult(row.result);
      const reconTpLevels = getTakeProfitLevelsForRow(row);
      const finalTpLabel = reconTpLevels.length > 1 ? reconTpLevels[reconTpLevels.length - 1].label : null;
      if (finalTpLabel && reconMeta.hits.has(finalTpLabel)) {
        console.log('Reconciled closed trade (notification already sent):', row.magic, result, 'profit:', profit);
        continue;
      }

      const chatId = row.tg_chat_id || process.env.TELEGRAM_CHAT_ID_XAU;
      const profitStr = profit != null ? ` | P&L: ${profit > 0 ? '+' : ''}$${profit.toFixed(2)}` : '';
      const exitStr = exitPrice ? ` @ $${Number(exitPrice).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
      const tp1WasHit = reconMeta.hits.has('TP1');
      const closedNearEntry = exitPrice && row.entry && Math.abs(Number(exitPrice) - Number(row.entry)) <= 3;
      const isBeClose = result === 'SL' && tp1WasHit && closedNearEntry;
      let tgText;
      if (isBeClose)            tgText = `🔄 BE hit. Trade closed at entry.\nID ${row.signal_id}`;
      else if (result === 'Manual') tgText = `🔒 Trade manually closed${exitStr}${profitStr}\nID ${row.signal_id}`;
      else if (result === 'TP') tgText = `✅ Final TP hit. TRADE CLOSED\nID ${row.signal_id}`;
      else                      tgText = `🔴 SL hit.\nID ${row.signal_id}`;
      await sendTelegram(chatId, tgText, row.tg_message_id ? { reply_to_message_id: row.tg_message_id } : {});
      console.log(`Reconciled: magic=${row.magic} signal_id=${row.signal_id} ${row.direction || ''} result=${result} profit=${profit?.toFixed(2)}`);
    }
  } catch (err) { console.error('reconcileOpenTrades error:', err); }
}

export async function reconcileHhhlTrades() {
  try {
    const { data: openRows } = await supabase.from('trades')
      .select('magic, signal_id, direction, entry, tp, position_id')
      .eq('status', 'open').in('src_code', [10, 11]);
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
    console.log(`[HHHL reconcile] openRows=${openRows.length} stale=${stale.length}`);
    if (stale.length === 0) return;

    const endTime = new Date().toISOString();
    const startTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const dealsRaw = await (await metaApiFetch(`/users/current/accounts/${accountId}/history-deals/time/${startTime}/${endTime}`, { headers })).json();
    const deals = Array.isArray(dealsRaw) ? dealsRaw : [];

    for (const row of stale) {
      if (!row.magic || Number(row.magic) === 0) {
        await supabase.from('trades').update({ status: 'closed', result: 'Cancelled', closed_at: nowVilnius() }).eq('signal_id', row.signal_id).eq('status', 'open');
        continue;
      }
      const outDeals = deals.filter(d =>
        (Number(d.magic) === Number(row.magic) || (row.position_id && d.positionId === String(row.position_id))) &&
        (d.type === 'DEAL_TYPE_SELL' || d.type === 'DEAL_TYPE_BUY') && d.entryType === 'DEAL_ENTRY_OUT'
      );
      if (outDeals.length === 0) {
        const staleCycles = (state.hhhlStaleTracker.get(Number(row.magic)) || 0) + 1;
        state.hhhlStaleTracker.set(Number(row.magic), staleCycles);
        if (staleCycles < 2) { console.log(`[HHHL reconcile] No deal yet for magic=${row.magic} (cycle ${staleCycles})`); continue; }
        state.hhhlStaleTracker.delete(Number(row.magic));
        await supabase.from('trades').update({ status: 'closed', result: 'Cancelled', closed_at: nowVilnius() }).eq('magic', row.magic).eq('status', 'open');
        continue;
      }
      state.hhhlStaleTracker.delete(Number(row.magic));
      const profit = outDeals.reduce((s, d) => s + (d.profit || 0), 0);
      const exitPrice = outDeals[outDeals.length - 1].price ?? null;
      const atTp = row.tp && exitPrice && Math.abs(exitPrice - row.tp) <= 3;
      const nearEntry = row.entry && exitPrice && Math.abs(exitPrice - Number(row.entry)) <= 2;
      const result = nearEntry && profit === 0 ? 'BE' : profit > 0 && !atTp ? 'Manual' : profit > 0 ? 'TP' : 'SL';
      await supabase.from('trades').update({ status: 'closed', result, closed_at: nowVilnius(), exit: exitPrice, profit }).eq('magic', row.magic).eq('status', 'open');
      console.log(`[HHHL reconcile] magic=${row.magic} ${row.direction} result=${result} profit=${profit?.toFixed(2)}`);
    }
  } catch (err) { console.error('[HHHL reconcile] error:', err); }
}

export async function monitorTakeProfitMilestones() {
  if (state.tpMonitorRunning) return;
  state.tpMonitorRunning = true;
  try {
    const { data: openRows, error } = await supabase.from('trades')
      .select('magic, signal_id, symbol, direction, entry, tp, result, tg_message_id, tg_chat_id, src_code')
      .eq('status', 'open');
    if (error) { console.error('TP monitor select error:', error); return; }
    if (!openRows || openRows.length === 0) {
      state.tpMilestoneNotified.clear(); state.tpMilestoneInProgress.clear(); return;
    }

    const openTradeKeys = new Set(openRows.map(getTradeKey));
    for (const key of [...state.tpMilestoneNotified])   { if (!openTradeKeys.has(key.split(':')[0])) state.tpMilestoneNotified.delete(key); }
    for (const key of [...state.tpMilestoneInProgress]) { if (!openTradeKeys.has(key.split(':')[0])) state.tpMilestoneInProgress.delete(key); }

    const headers = { 'auth-token': process.env.METAAPI_TOKEN };
    const accountId = process.env.METAAPI_MASTER_ACCOUNT_ID;
    const positions = await (await metaApiFetch(`/users/current/accounts/${accountId}/positions`, { headers })).json();
    if (!Array.isArray(positions)) return;

    const positionsByMagic = new Map(positions.map(p => [p.magic, p]));
    let needsReconcile = false;
    for (const row of openRows) {
      if (Number(row.src_code) === 10 || Number(row.src_code) === 11) continue;
      const position = positionsByMagic.get(row.magic);
      if (!position) { needsReconcile = true; continue; }
      if (String(row.signal_id || '').endsWith('_a')) continue;

      const entry = Number(row.entry), finalTp = Number(row.tp);
      if (!Number.isFinite(entry) || !Number.isFinite(finalTp)) continue;
      if (SINGLE_STEP_TP_SRC_CODES.has(Number(row.src_code))) continue;

      const openMeta = parseOpenTradeResult(row.result);
      const tpLevels = getTakeProfitLevelsForRow(row);
      if (tpLevels.length < 2 || tpLevels[0].label !== 'TP1') continue;

      const persistedMilestones = openMeta.hits;
      const fillPrice = Number(position.openPrice);
      if (Number.isFinite(fillPrice)) {
        let silentlyMarked = false;
        for (const tp of tpLevels) {
          if (persistedMilestones.has(tp.label)) continue;
          const filledPast = row.direction === 'BUY' ? fillPrice >= tp.price : fillPrice <= tp.price;
          if (filledPast) { persistedMilestones.add(tp.label); state.tpMilestoneNotified.add(getTpMilestoneKey(row, tp.label)); silentlyMarked = true; }
        }
        if (silentlyMarked) {
          await supabase.from('trades').update({ result: formatOpenTradeResultMeta(openMeta.tpLevels, persistedMilestones) }).eq('magic', row.magic).eq('status', 'open');
        }
      }

      for (const tp of tpLevels) {
        if (!tpMilestoneHit(row, position, tp)) continue;
        const milestoneKey = getTpMilestoneKey(row, tp.label);
        if (persistedMilestones.has(tp.label)) { state.tpMilestoneNotified.add(milestoneKey); continue; }
        if (state.tpMilestoneNotified.has(milestoneKey) || state.tpMilestoneInProgress.has(milestoneKey)) continue;

        state.tpMilestoneInProgress.add(milestoneKey);
        try {
          const chatId = row.tg_chat_id || process.env.TELEGRAM_CHAT_ID_XAU;
          const line = `🟢 ${row.symbol || 'XAUUSD'} ${row.direction || ''} — ${tp.label} hit`.replace(/\s+/g, ' ');
          const tpIndex = tpLevels.findIndex(t => t.label === tp.label);
          const isFinalTp = tpIndex === tpLevels.length - 1;

          if (tpIndex === 0) {
            await sendTelegram(chatId, `${line}\nID ${row.signal_id}`, row.tg_message_id ? { reply_to_message_id: row.tg_message_id } : {});
            try {
              const slResult = await movePositionStopLoss(position.id, entry, finalTp);
              console.log(`SL moved to entry ${entry} after TP1 (magic=${row.magic}):`, slResult.ok ? 'ok' : 'failed');
              if (slResult.ok) await supabase.from('trades').update({ sl: entry }).eq('magic', row.magic).eq('status', 'open');
            } catch (slErr) { console.error(`SL move failed (magic=${row.magic}):`, slErr.message); }
          } else if (!isFinalTp) {
            await sendTelegram(chatId, `${line}\nID ${row.signal_id}`, row.tg_message_id ? { reply_to_message_id: row.tg_message_id } : {});
          }

          if (!isFinalTp) {
            persistedMilestones.add(tp.label);
            const { error: persistError } = await supabase.from('trades')
              .update({ result: formatOpenTradeResultMeta(openMeta.tpLevels, persistedMilestones) })
              .eq('magic', row.magic).eq('status', 'open');
            if (persistError) console.error('TP milestone persist error:', persistError);
          }
          state.tpMilestoneNotified.add(milestoneKey);
          console.log('TP milestone notified:', row.magic, tp.label, isFinalTp ? '(final — reconcile will close)' : '');
          setTimeout(reconcileOpenTrades, 2_000);
        } catch (tpErr) { console.error('TP milestone monitor error:', tpErr); }
        finally { state.tpMilestoneInProgress.delete(milestoneKey); }
      }
    }
    if (needsReconcile) setTimeout(reconcileOpenTrades, 2_000);
  } catch (err) { console.error('monitorTakeProfitMilestones error:', err); }
  finally { state.tpMonitorRunning = false; }
}

// HHHL LINIJA: auto-cancel limit when paired market position closes
function startHhhlLinijaMonitor() {
  setInterval(async () => {
    if (!state.hhhlLinijaOrders.length) return;
    const accountId = process.env.HHHL_MT5_ACCOUNT_ID;
    if (!accountId) return;
    try {
      const posRes = await metaApiFetch(`/users/current/accounts/${accountId}/positions`, { headers: { 'auth-token': process.env.METAAPI_TOKEN } });
      const positions = await posRes.json();
      const openIds = new Set((Array.isArray(positions) ? positions : []).map(p => String(p.id)));
      const toRemove = [];
      for (const entry of state.hhhlLinijaOrders) {
        if (!openIds.has(entry.positionId)) {
          toRemove.push(entry);
          try {
            await metaApiFetch(`/users/current/accounts/${accountId}/trade`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'auth-token': process.env.METAAPI_TOKEN },
              body: JSON.stringify({ actionType: 'ORDER_CANCEL', orderId: entry.orderId }),
            });
            console.log(`[HHHL-LINIJA] Auto-cancelled limit ${entry.orderId} (market ${entry.positionId} closed)`);
            await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `🔄 <b>HHHL LINIJA ${entry.dir}</b> — limit atšauktas (market užsidarė)`, { parse_mode: 'HTML' });
          } catch (e) { console.error('[HHHL-LINIJA] Cancel limit error:', e.message); }
        }
      }
      if (toRemove.length) {
        const removeSet = new Set(toRemove.map(o => o.positionId));
        state.hhhlLinijaOrders = state.hhhlLinijaOrders.filter(o => !removeSet.has(o.positionId));
      }
    } catch (e) { console.error('[HHHL-LINIJA] Monitor error:', e.message); }
  }, 2 * 60 * 1000);
}

export function startMonitors() {
  setInterval(monitorTakeProfitMilestones, TP_CHECK_INTERVAL_MS);
  setTimeout(monitorTakeProfitMilestones, 5_000);
  setInterval(reconcileOpenTrades, 2 * 60 * 1000);
  setInterval(reconcileHhhlTrades, 2 * 60 * 1000);
  setTimeout(reconcileOpenTrades, 10_000);
  setTimeout(reconcileHhhlTrades, 15_000);
  startHhhlLinijaMonitor();
}
