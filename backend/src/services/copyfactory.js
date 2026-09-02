import { fetchWithTimeout } from '../utils/http.js';
import { METAAPI_PROVISIONING_BASE, COPYFACTORY_STRATEGY_ID } from '../config.js';
import { delay } from '../utils/formatters.js';
import { metaApiFetch } from './metaapi.js';

async function metaApiProvisioningFetch(path, options = {}) {
  return fetchWithTimeout(`${METAAPI_PROVISIONING_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'auth-token': process.env.METAAPI_TOKEN, ...(options.headers || {}) },
  });
}

async function readResponseText(res) {
  try { return await res.text(); } catch (_) { return ''; }
}

export async function getProvisionedAccount(accountId) {
  const res = await metaApiProvisioningFetch(`/users/current/accounts/${accountId}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MetaAPI account status error ${res.status}: ${body}`);
  }
  return res.json();
}

export async function callMetaApiAccountAction(accountId, action) {
  let res = await metaApiProvisioningFetch(`/users/current/accounts/${accountId}/${action}`, { method: 'POST' });
  if ([404, 405].includes(res.status)) {
    res = await metaApiProvisioningFetch(`/users/current/accounts/${accountId}/${action}`, { method: 'PUT' });
  }
  return res;
}

export async function deleteCopyFactorySubscriber(subscriberId) {
  if (!subscriberId) return { ok: true, status: 0, body: '' };
  try {
    const res = await fetchWithTimeout(
      `https://copyfactory-api-v1.london.agiliumtrade.ai/users/current/configuration/subscribers/${subscriberId}`,
      { method: 'DELETE', headers: { 'auth-token': process.env.METAAPI_TOKEN } }
    );
    const body = await readResponseText(res);
    return { ok: res.ok || res.status === 404, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 'network', body: err.message };
  }
}

export async function deleteMetaApiAccount(accountId) {
  if (!accountId) return { ok: true, undeployStatus: 0, deleteStatus: 0, body: '' };
  try {
    const undeployRes = await callMetaApiAccountAction(accountId, 'undeploy');
    const undeployBody = await readResponseText(undeployRes);

    let deleteStatus = 0, deleteBody = '';
    for (let attempt = 1; attempt <= 5; attempt++) {
      const deleteRes = await metaApiProvisioningFetch(`/users/current/accounts/${accountId}`, { method: 'DELETE' });
      deleteStatus = deleteRes.status;
      deleteBody = await readResponseText(deleteRes);
      if (deleteRes.ok || deleteRes.status === 404) return { ok: true, undeployStatus: undeployRes.status, deleteStatus, body: deleteBody || undeployBody };
      if (![400, 409, 423].includes(deleteRes.status) || attempt === 5) break;
      await delay(2_000);
    }
    return { ok: false, undeployStatus: undeployRes.status, deleteStatus, body: deleteBody || undeployBody };
  } catch (err) {
    return { ok: false, undeployStatus: 'network', deleteStatus: 'network', body: err.message };
  }
}

export async function cleanupProvisionedAccount(accountId) {
  if (!accountId) return;
  try {
    const cfDelete = await deleteCopyFactorySubscriber(accountId);
    if (!cfDelete.ok) console.warn('CopyFactory subscriber cleanup failed:', cfDelete.status, cfDelete.body);
  } catch (err) { console.warn('CopyFactory subscriber cleanup failed:', err.message); }
  try {
    const maDelete = await deleteMetaApiAccount(accountId);
    if (!maDelete.ok) console.warn('MetaAPI account cleanup failed:', maDelete.deleteStatus, maDelete.body);
  } catch (err) { console.warn('MetaAPI delete cleanup failed:', err.message); }
}

export function buildCopyFactorySubscriberConfig(email, lotSize, brokerSymbol = null) {
  const perOrderLot = Math.max(0.01, Math.floor(lotSize / 2 * 100) / 100);
  const subscription = { strategyId: COPYFACTORY_STRATEGY_ID, multiplier: 1, tradeSizeScaling: { mode: 'fixedVolume', tradeVolume: perOrderLot } };
  const normalizedSymbol = brokerSymbol ? brokerSymbol.trim() : null;
  if (normalizedSymbol && normalizedSymbol.toUpperCase() !== 'XAUUSD') {
    subscription.symbolMapping = [{ from: 'XAUUSD', to: normalizedSymbol }];
  }
  return { name: 'Automated ' + email, subscriptions: [subscription] };
}

export async function putCopyFactorySubscriber(subscriberId, email, lotSize, brokerSymbol = null) {
  const res = await fetchWithTimeout(
    `https://copyfactory-api-v1.london.agiliumtrade.ai/users/current/configuration/subscribers/${subscriberId}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'auth-token': process.env.METAAPI_TOKEN },
      body: JSON.stringify(buildCopyFactorySubscriberConfig(email, lotSize, brokerSymbol)),
    }
  );
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

export function parseDuplicateCopyFactorySubscriberId(status, body) {
  if (status !== 400) return null;
  let message = '';
  try { message = JSON.parse(body)?.message || ''; } catch (_) { message = ''; }
  const source = `${message}\n${body}`;
  return source.match(/another subscriber id\s+([0-9a-f-]{36})\s+mapped/i)?.[1] || null;
}

export async function waitForMetaApiConnection(accountId, timeoutMs = 90_000) {
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

export async function detectGoldSymbol(accountId) {
  try {
    const res = await metaApiFetch(`/users/current/accounts/${accountId}/symbols`);
    const symbols = await res.json();
    if (!Array.isArray(symbols)) return null;
    const goldSymbols = symbols.filter(s => /^(XAU|GOLD)/i.test(s));
    if (!goldSymbols.length) return null;
    const suffixed = goldSymbols.filter(s => s !== 'XAUUSD' && s !== 'GOLD');
    if (suffixed.length === 1) return suffixed[0];
    const priority = ['XAUUSD#', 'XAUUSD.', 'XAUUSDm', 'XAUUSDm.', 'XAUUSD!'];
    for (const s of priority) { if (goldSymbols.includes(s)) return s; }
    return goldSymbols.includes('XAUUSD') ? 'XAUUSD' : goldSymbols[0];
  } catch (e) {
    console.warn('detectGoldSymbol failed:', e.message);
    return null;
  }
}
