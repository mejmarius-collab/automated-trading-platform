import { ALLOWED_LOT_SIZES } from '../config.js';

export function normalizeLotSize(lotSize) {
  const parsed = Number(lotSize);
  const allowed = ALLOWED_LOT_SIZES.find(size => Math.abs(size - parsed) < 0.000001);
  if (!Number.isFinite(parsed) || !allowed) throw new Error('Invalid lot size');
  return allowed;
}

export function formatLotSize(lotSize) {
  return lotSize.toFixed(2);
}

export function formatAllowedLotSizes() {
  return ALLOWED_LOT_SIZES.map(formatLotSize).join(', ');
}

export function cleanEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function requireEmail(email) {
  const normalized = cleanEmail(email);
  if (!normalized) throw new Error('Missing email');
  return normalized;
}

export function cleanContactHandle(value) {
  return String(value || '').trim();
}

export function formatContactLine(label, value) {
  const cleaned = cleanContactHandle(value);
  return `${label}: ${cleaned || 'neįvesta'}`;
}
