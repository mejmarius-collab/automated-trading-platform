import fetch from 'node-fetch';

// Deliberately imports nothing from config.js: config.js needs this module to
// give the Supabase and Stripe clients a bounded fetch, so importing back would
// be circular.
export const HTTP_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.HTTP_TIMEOUT_MS || 15_000) || 15_000
);

/**
 * fetch with a hard deadline.
 *
 * Every outbound call in this codebase goes through here. Without a deadline a
 * hung upstream (DNS that never resolves, a TCP connect that never completes)
 * holds the Express request open indefinitely: the client waits forever and the
 * socket is never released. It also silently disabled the region failover in
 * services/metaapi.js — that loop only advances when a request *fails*, so a
 * hang in the first region meant the second was never tried.
 *
 * A caller-supplied signal is honoured as-is rather than being replaced, so
 * callers that manage their own cancellation keep working.
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  if (options.signal) return fetch(url, options);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      let host = String(url);
      try { host = new URL(String(url)).host; } catch { /* keep the raw value */ }
      const timeoutErr = new Error(`Request to ${host} timed out after ${timeoutMs}ms`);
      timeoutErr.code = 'ETIMEDOUT';
      timeoutErr.cause = err;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
