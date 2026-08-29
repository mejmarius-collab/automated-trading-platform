import { normaliseTakeProfitLevels } from './formatters.js';

export function parseWebhookEntrySignal(text) {
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

export function parseSecretTextPayload(raw) {
  let text, bodySecret, silent = false, no_msg = false, comment = null, layer = false, noTp = false;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        text = parsed.text; bodySecret = parsed.secret; silent = parsed.silent === true;
        no_msg = parsed.no_msg === true; comment = parsed.comment || null;
        layer = parsed.layer === true; noTp = parsed.no_tp === true;
      } catch { text = trimmed; }
    } else { text = trimmed; }
  } else if (raw && typeof raw === 'object') {
    text = raw.text; bodySecret = raw.secret; silent = raw.silent === true;
    no_msg = raw.no_msg === true; comment = raw.comment || null;
    layer = raw.layer === true; noTp = raw.no_tp === true;
  }
  return { text, bodySecret, silent, no_msg, comment, layer, noTp };
}
