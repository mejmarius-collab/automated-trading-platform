import { fetchWithTimeout } from '../utils/http.js';
import { METAAPI_REGIONS } from '../config.js';
import { isMetaApiTradeSuccess } from '../utils/formatters.js';

export async function metaApiFetch(path, options = {}) {
  let lastErr;
  for (const region of METAAPI_REGIONS) {
    const url = `https://mt-client-api-v1.${region}.agiliumtrade.ai${path}`;
    try {
      const res = await fetchWithTimeout(url, options);
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

export async function openTrade(symbol, action, volume, takeProfit, stopLoss, magic, openPrice, orderType = 'limit', comment = null, noTp = false) {
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

  const accountId = process.env.METAAPI_MASTER_ACCOUNT_ID;
  const headers = { 'Content-Type': 'application/json', 'auth-token': process.env.METAAPI_TOKEN };

  let data;
  for (let attempt = 0; attempt <= 2; attempt++) {
    const res = await metaApiFetch(`/users/current/accounts/${accountId}/trade`, { method: 'POST', headers, body: JSON.stringify(body) });
    data = await res.json();
    console.log(`MetaAPI openTrade response (attempt ${attempt + 1}):`, JSON.stringify(data));
    const isTooMany = data?.error === 'TooManyRequestsError';
    const isCallable = JSON.stringify(data).includes('Failed to execute a callable');
    if (!isTooMany && !isCallable) break;
    const retryDelay = isTooMany ? 7000 : 2000;
    console.warn(`MetaAPI ${isTooMany ? 'TooManyRequests' : 'callable'} — retry in ${retryDelay / 1000}s`);
    if (attempt < 2) await new Promise(r => setTimeout(r, retryDelay));
  }

  const limitFailed = orderType !== 'market' && data && (
    data.stringCode === 'ERR_INVALID_STOPS' || data.stringCode === 'ERR_INVALID_PRICE' ||
    data.numericCode === 130 || data.numericCode === 129
  );
  if (limitFailed) {
    console.log('Limit order failed, falling back to market order');
    const marketActionType = action === 'BUY' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL';
    const marketBody = { actionType: marketActionType, symbol, volume, magic };
    if (!noTp) marketBody.takeProfit = takeProfit;
    if (stopLoss !== undefined && stopLoss !== null) marketBody.stopLoss = stopLoss;
    const marketRes = await metaApiFetch(`/users/current/accounts/${accountId}/trade`, { method: 'POST', headers, body: JSON.stringify(marketBody) });
    data = await marketRes.json();
    console.log('MetaAPI market fallback response:', JSON.stringify(data));
  }

  return data;
}

export async function getActualOpenPrice(magic) {
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

export async function closeTradeByMagic(magic) {
  const accountId = process.env.METAAPI_MASTER_ACCOUNT_ID;
  const headers = { 'auth-token': process.env.METAAPI_TOKEN };
  const positionsRes = await metaApiFetch(`/users/current/accounts/${accountId}/positions`, { headers });
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
    `/users/current/accounts/${accountId}/trade`,
    { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ actionType: 'POSITION_CLOSE_ID', positionId: target.id }) }
  );
  const data = await closeRes.json();
  console.log('MetaAPI closeTrade response:', JSON.stringify(data));
  const ok = closeRes.ok && isMetaApiTradeSuccess(data);
  if (!ok) console.error('MetaAPI closeTrade rejected:', JSON.stringify(data));
  return { ok, data, exitPrice, profit };
}

export async function cancelOrderByMagic(magic) {
  const accountId = process.env.METAAPI_MASTER_ACCOUNT_ID;
  const ordersRes = await metaApiFetch(`/users/current/accounts/${accountId}/orders`, { headers: { 'auth-token': process.env.METAAPI_TOKEN } });
  const orders = await ordersRes.json();
  const target = Array.isArray(orders) ? orders.find(o => o.magic === magic) : null;
  if (!target) {
    console.log('No pending order with magic:', magic);
    return null;
  }
  const cancelRes = await metaApiFetch(
    `/users/current/accounts/${accountId}/trade`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'auth-token': process.env.METAAPI_TOKEN }, body: JSON.stringify({ actionType: 'ORDER_CANCEL', orderId: target.id }) }
  );
  const data = await cancelRes.json();
  const ok = cancelRes.ok && isMetaApiTradeSuccess(data);
  return { ok, data };
}

export async function getClosedDealByMagic(magic) {
  const endTime = new Date().toISOString();
  const startTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const dealsRes = await metaApiFetch(
    `/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/history-deals/time/${startTime}/${endTime}`,
    { headers: { 'auth-token': process.env.METAAPI_TOKEN } }
  );
  const deals = await dealsRes.json();
  const deal = Array.isArray(deals)
    ? deals.find(d => d.magic === magic && (d.type === 'DEAL_TYPE_SELL' || d.type === 'DEAL_TYPE_BUY') && d.entryType === 'DEAL_ENTRY_OUT')
    : null;
  const result = deal ? { exitPrice: deal.price, profit: deal.profit } : null;
  console.log('Deal history result:', JSON.stringify(result));
  return result;
}

export async function movePositionStopLoss(positionId, stopLoss, takeProfit = null) {
  const body = { actionType: 'POSITION_MODIFY', positionId, stopLoss };
  if (takeProfit !== undefined && takeProfit !== null) body.takeProfit = takeProfit;
  const res = await metaApiFetch(
    `/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/trade`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'auth-token': process.env.METAAPI_TOKEN }, body: JSON.stringify(body) }
  );
  const data = await res.json();
  console.log('MetaAPI POSITION_MODIFY response:', JSON.stringify(data));
  return { ok: res.ok && isMetaApiTradeSuccess(data), status: res.status, data };
}
