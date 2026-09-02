import { fetchWithTimeout } from '../utils/http.js';

// Never throws — a Telegram error must not crash calling routes (e.g. Stripe webhook → 500 → retries → duplicates)
export async function sendTelegram(chatId, text, options = {}) {
  try {
    const res = await fetchWithTimeout(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, ...options }),
      }
    );
    return await res.json();
  } catch (err) {
    console.error('Telegram send error:', err);
    return { ok: false, error: String(err) };
  }
}
