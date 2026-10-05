import crypto from 'crypto';

/**
 * Constant-time comparison for secrets (webhook secrets, Telegram secret tokens).
 *
 * Returns false when either value is missing, empty or not a string, so an unset
 * environment variable can never match. Both values are hashed with SHA-256 first:
 * the digests always have the same length, so the comparison neither leaks the
 * secret's length nor throws, as crypto.timingSafeEqual does on unequal lengths.
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
