import { MAX_GENERATED_TP_LEVELS, SINGLE_STEP_TP_SRC_CODES } from '../config.js';

export function formatSignalPrice(value) {
  const rounded = Math.round(value * 100) / 100;
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(2).replace(/\.?0+$/, '');
}

export function getSignalSourceCode(signalId) {
  return parseInt(String(signalId || '')[13]) || null;
}

export function getGeneratedTpLevelLimit(srcCode) {
  return SINGLE_STEP_TP_SRC_CODES.has(srcCode) ? 1 : MAX_GENERATED_TP_LEVELS;
}

export function buildSplitTakeProfits(action, entry, finalTp, step = 10, maxLevels = Infinity) {
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

export function normaliseTakeProfitLevels(tpLevels, fallbackLabel = 'TP') {
  return (tpLevels || [])
    .map((tp, index) => ({
      label: String(tp.label || (tpLevels.length > 1 ? `TP${index + 1}` : fallbackLabel)).toUpperCase(),
      price: Number(tp.price),
    }))
    .filter(tp => /^TP\d*$/.test(tp.label) && Number.isFinite(tp.price));
}

export function filterMinTpGap(tpLevels, direction, minGap = 5) {
  if (tpLevels.length <= 1) return tpLevels;
  const result = [];
  for (let i = 0; i < tpLevels.length; i++) {
    const next = tpLevels[i + 1];
    if (next) {
      const gap = direction === 'SELL' ? tpLevels[i].price - next.price : next.price - tpLevels[i].price;
      if (gap < minGap) continue;
    }
    result.push(tpLevels[i]);
  }
  return result;
}

export function formatTakeProfitLines(tpLevels, separator = ':') {
  return normaliseTakeProfitLevels(tpLevels)
    .map(tp => `${tp.label} ${separator} ${formatSignalPrice(tp.price)}`)
    .join('\n');
}

export function parseOpenTradeResult(result) {
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

export function formatOpenTradeResultMeta(tpLevels, hits) {
  const cleanTpLevels = normaliseTakeProfitLevels(tpLevels).filter(tp => /^TP\d+$/.test(tp.label));
  const cleanHits = [...hits].filter(label => /^TP\d+$/.test(label));
  if (!cleanTpLevels.length) return formatTpMilestoneResult(new Set(cleanHits));
  return JSON.stringify({
    tpLevels: cleanTpLevels.map(tp => ({ label: tp.label, price: Number(tp.price.toFixed(5)) })),
    hits: cleanHits,
  });
}

export function getTakeProfitLevelsForRow(row) {
  const maxLevels = getGeneratedTpLevelLimit(Number(row.src_code));
  const meta = parseOpenTradeResult(row.result);
  if (meta.tpLevels.length) return meta.tpLevels.slice(0, maxLevels);
  if (row.tp == null) return [];
  return buildSplitTakeProfits(row.direction, Number(row.entry), Number(row.tp), 10, maxLevels);
}

export function parseTpMilestoneResult(result) {
  const labels = String(result || '')
    .split(',')
    .map(label => label.trim())
    .filter(label => /^TP\d+$/.test(label));
  return new Set(labels);
}

export function formatTpMilestoneResult(labels) {
  return [...labels].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2))).join(',');
}

export function isMetaApiTradeSuccess(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.error || data.errorCode) return false;
  const numericCode = Number(data.numericCode);
  const stringCode = String(data.stringCode || '').toUpperCase();
  const successStringCodes = new Set([
    'DONE', 'PLACED', 'DONE_PARTIAL', 'ERR_NO_ERROR',
    'TRADE_RETCODE_DONE', 'TRADE_RETCODE_PLACED', 'TRADE_RETCODE_DONE_PARTIAL',
  ]);
  if (stringCode) return successStringCodes.has(stringCode);
  if (Number.isFinite(numericCode)) return [0, 10008, 10009, 10010].includes(numericCode);
  return true;
}

export function genHhhlSignalId(srcCode, dir) {
  const nowMs = Date.now();
  const dirCode = dir === 'BUY' ? '1' : '2';
  const id = `${nowMs}${srcCode}${dirCode}1${String(nowMs).slice(-3)}`;
  return { signalId: id, magic: parseInt(id.slice(-9)) };
}

export function nowVilnius() {
  const now = new Date();
  const vilnius = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Vilnius' }));
  const pad = n => String(n).padStart(2, '0');
  return `${vilnius.getFullYear()}-${pad(vilnius.getMonth() + 1)}-${pad(vilnius.getDate())}T${pad(vilnius.getHours())}:${pad(vilnius.getMinutes())}:${pad(vilnius.getSeconds())}.000+00:00`;
}

export function vilniusParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Vilnius',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  return {
    year: parts.find(p => p.type === 'year').value,
    month: parts.find(p => p.type === 'month').value,
    day: parts.find(p => p.type === 'day').value,
  };
}

export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
