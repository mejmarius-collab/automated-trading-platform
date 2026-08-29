import { DEMO_MODE } from '../config.js';

export function demoGuard(req, res, next) {
  if (DEMO_MODE) return res.status(503).json({ ok: false, error: 'Demo mode — live execution disabled' });
  next();
}

// Simple fixed-window per-IP rate limiter (no external dependencies).
// Railway runs behind a proxy — app.set('trust proxy', 1) is required for req.ip to be correct.
const rateMap = new Map();

export function rateLimit(limit = 60, windowMs = 60_000) {
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

// Periodically remove stale rate-map entries to prevent unbounded memory growth
setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [ip, entry] of rateMap) {
    if (entry.start < cutoff) rateMap.delete(ip);
  }
}, 10 * 60_000);

export const publicLimiter = rateLimit(60, 60_000);
