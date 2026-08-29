import express from 'express';
import { supabase, stripe } from '../config.js';
import { demoGuard } from '../middleware/auth.js';
import { sendTelegram } from '../services/telegram.js';
import { metaApiFetch } from '../services/metaapi.js';
import {
  putCopyFactorySubscriber, parseDuplicateCopyFactorySubscriberId,
  cleanupProvisionedAccount, waitForMetaApiConnection, detectGoldSymbol,
  getProvisionedAccount,
} from '../services/copyfactory.js';
import { createOnboardingToken, verifyOnboardingToken } from '../security/tokens.js';
import { normalizeLotSize, formatLotSize, cleanEmail, requireEmail, cleanContactHandle, formatContactLine } from '../utils/validators.js';
import { METAAPI_PROVISIONING_BASE } from '../config.js';
import fetch from 'node-fetch';

const router = express.Router();

function getPlanFromCheckoutSession(session) {
  const successUrl = session.success_url || '';
  const metadataPlan = session.metadata?.plan || '';
  try {
    const urlPlan = new URL(successUrl).searchParams.get('plan') || '';
    return metadataPlan || urlPlan;
  } catch (_) {
    const planMatch = successUrl.match(/plan=([^&]+)/);
    return metadataPlan || (planMatch ? decodeURIComponent(planMatch[1]) : '');
  }
}

// ── GET /checkout-session ───────────────────────────────────────────────────
router.get('/checkout-session', async (req, res) => {
  try {
    const sessionId = String(req.query.session_id || '').trim();
    if (!sessionId.startsWith('cs_')) return res.status(400).json({ error: 'Missing checkout session id' });

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.status !== 'complete') return res.status(402).json({ error: 'Checkout session is not complete' });

    const email = cleanEmail(session.customer_details?.email || session.customer_email);
    const name = session.customer_details?.name || '';
    const plan = getPlanFromCheckoutSession(session);
    const stripeCustomerId = session.customer || null;
    if (!email) return res.status(400).json({ error: 'Missing checkout email' });

    const { error: dbError } = await supabase.from('clients').upsert({ email, name, plan, active: true, stripe_customer_id: stripeCustomerId }, { onConflict: 'email' });
    if (dbError) throw dbError;
    res.json({ email, name, plan });
  } catch (err) { console.error('GET /checkout-session error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── GET /onboarding-resume ──────────────────────────────────────────────────
router.get('/onboarding-resume', async (req, res) => {
  try {
    const payload = verifyOnboardingToken(req.query.token);
    const { data: client, error } = await supabase.from('clients').select('email, name, plan, active').eq('email', payload.email).maybeSingle();
    if (error) throw error;
    if (!client || !client.active) return res.status(403).json({ error: 'No active subscription found' });
    res.json({ email: client.email, name: client.name || '', plan: client.plan || payload.plan });
  } catch (err) { console.error('GET /onboarding-resume error:', err); res.status(401).json({ error: 'Invalid or expired onboarding link' }); }
});

// ── POST /save-telegram-id ──────────────────────────────────────────────────
router.post('/save-telegram-id', demoGuard, express.json(), async (req, res) => {
  const secret = req.headers['x-webhook-secret'] || req.body?.secret;
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { email: rawEmail, telegram_user_id, telegram_username, discord_username } = req.body;
    const email = requireEmail(rawEmail);
    const telegramId = cleanContactHandle(telegram_user_id);
    const telegramUsername = cleanContactHandle(telegram_username);
    const discordUsername = cleanContactHandle(discord_username);
    if (!telegramId && !telegramUsername && !discordUsername) return res.status(400).json({ ok: false, error: 'Missing contact details' });

    const { data: client } = await supabase.from('clients').select('active, telegram_user_id').eq('email', email).maybeSingle();
    if (!client || !client.active) return res.status(403).json({ ok: false, error: 'No active subscription found for this email' });

    if (telegramId && client.telegram_user_id && client.telegram_user_id !== telegramId) {
      await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `⚠️ Telegram ID PAKEISTAS klientui ${email}: ${client.telegram_user_id} → ${telegramId}. Jei klientas to neprašė — patikrink!`);
    }
    if (telegramId) {
      const { error: dbError } = await supabase.from('clients').update({ telegram_user_id: telegramId }).eq('email', email);
      if (dbError) throw dbError;
    }

    await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID,
      `✅ Klientas užpildė Signalas kontaktus\n📧 ${email}\n💬 ${formatContactLine('Telegram ID', telegramId)}\n👤 ${formatContactLine('Telegram username', telegramUsername)}\n🎮 ${formatContactLine('Discord username', discordUsername)}`);
    if (telegramId) {
      await sendTelegram(telegramId, 'Sveiki! 🎉 Ačiū už užsakymą. Netrukus būsite pridėti į VIP signalų grupę. Susisieksime greitu metu.\n\nWelcome! 🎉 Thank you for your purchase. You will be added to the VIP signals group shortly. We\'ll be in touch soon.');
    }
    res.json({ ok: true });
  } catch (err) { console.error('POST /save-telegram-id error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── POST /connect-account ───────────────────────────────────────────────────
router.post('/connect-account', demoGuard, express.json(), async (req, res) => {
  let accountIdToCleanup = null;
  try {
    const { email: rawEmail, server, login, password, platform, lot_size, broker_symbol: brokerSymbol, telegram_user_id, telegram_username, discord_username, token } = req.body || {};
    const email = requireEmail(rawEmail);

    // Validate onboarding token
    let tokenPayload;
    try { tokenPayload = verifyOnboardingToken(token); } catch (e) { return res.status(401).json({ success: false, error: 'Invalid or expired onboarding link. Please start over.' }); }
    if (tokenPayload.email !== email) return res.status(401).json({ success: false, error: 'Token email mismatch.' });

    const { data: client } = await supabase.from('clients').select('*').eq('email', email).maybeSingle();
    if (!client || !client.active) return res.status(403).json({ success: false, error: 'No active subscription found for this email.' });

    const selectedLotSize = normalizeLotSize(lot_size);
    const telegramId = cleanContactHandle(telegram_user_id);
    const telegramUsername = cleanContactHandle(telegram_username);
    const discordUsername = cleanContactHandle(discord_username);

    if (!server || !login || !password || !platform) return res.status(400).json({ success: false, error: 'Missing required fields: server, login, password, platform.' });

    const accountPayload = {
      login: String(login),
      password: String(password),
      name: email,
      server: String(server),
      platform: String(platform).toLowerCase() === 'mt5' ? 'mt5' : 'mt4',
      magic: 0,
    };
    const createRes = await fetch(`${METAAPI_PROVISIONING_BASE}/users/current/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'auth-token': process.env.METAAPI_TOKEN },
      body: JSON.stringify(accountPayload),
    });
    if (!createRes.ok) {
      const body = await createRes.text();
      throw new Error(`MetaAPI account creation error ${createRes.status}: ${body}`);
    }
    const account = await createRes.json();
    accountIdToCleanup = account.id;

    const connectedAccount = await waitForMetaApiConnection(account.id);
    const accInfoRes = await metaApiFetch(`/users/current/accounts/${account.id}/account-information`, { headers: { 'auth-token': process.env.METAAPI_TOKEN } });
    let accInfo = null;
    try { accInfo = await accInfoRes.json(); } catch (_) {}

    if (accInfo && (accInfo.tradeAllowed === false || accInfo.investorMode === true)) {
      await cleanupProvisionedAccount(account.id);
      accountIdToCleanup = null;
      return res.status(400).json({ success: false, error: 'Investor (read-only) password detected. Please use your master password to connect.' });
    }

    let effectiveBrokerSymbol = brokerSymbol;
    if (!effectiveBrokerSymbol) {
      const detected = await detectGoldSymbol(account.id);
      if (detected && detected !== 'XAUUSD') { effectiveBrokerSymbol = detected; console.log(`Auto-detected gold symbol for ${email}: ${detected}`); }
    }

    let copyFactorySubscriberId = account.id;
    let reusedCopyFactorySubscriberId = null;
    const subscribeResult = await putCopyFactorySubscriber(account.id, email, selectedLotSize, effectiveBrokerSymbol);

    if (!subscribeResult.ok) {
      const duplicateSubscriberId = parseDuplicateCopyFactorySubscriberId(subscribeResult.status, subscribeResult.body);
      if (!duplicateSubscriberId) {
        console.error('CopyFactory subscribe error:', subscribeResult.body);
        await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `❌ CopyFactory subscribe KLAIDA: ${email} (account ${account.id}) HTTP ${subscribeResult.status}. Klientui sėkmės žinutė neišsiųsta.`);
        throw new Error(`CopyFactory subscribe error ${subscribeResult.status}: ${subscribeResult.body}`);
      }
      const reuseResult = await putCopyFactorySubscriber(duplicateSubscriberId, email, selectedLotSize, brokerSymbol);
      if (!reuseResult.ok) {
        console.error('CopyFactory existing subscriber update error:', reuseResult.body);
        await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `❌ CopyFactory existing subscriber KLAIDA: ${email} HTTP ${reuseResult.status}.`);
        throw new Error(`CopyFactory existing subscriber update error ${reuseResult.status}: ${reuseResult.body}`);
      }
      copyFactorySubscriberId = duplicateSubscriberId;
      reusedCopyFactorySubscriberId = duplicateSubscriberId;
      await cleanupProvisionedAccount(account.id);
      accountIdToCleanup = null;
    }

    const upsertData = { email, metaapi_account_id: copyFactorySubscriberId, lot_size: formatLotSize(selectedLotSize) };
    if (effectiveBrokerSymbol) upsertData.broker_symbol = effectiveBrokerSymbol;
    if (telegramId) upsertData.telegram_user_id = telegramId;
    const { error: dbError } = await supabase.from('clients').upsert(upsertData, { onConflict: 'email' });
    if (dbError) throw dbError;
    accountIdToCleanup = null;

    await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID,
      `🔗 Sąskaita prijungta!\n📧 ${email}\n🏦 Serveris: ${server}\n📊 Platforma: ${platform}\n📈 Lot dydis: ${formatLotSize(selectedLotSize)}\n💬 ${formatContactLine('Telegram ID', telegramId)}\n${effectiveBrokerSymbol && effectiveBrokerSymbol.toUpperCase() !== 'XAUUSD' ? `🔀 Symbol: XAUUSD → ${effectiveBrokerSymbol}\n` : '✅ Symbol: XAUUSD\n'}${reusedCopyFactorySubscriberId ? `♻️ Existing subscriber reused: ${reusedCopyFactorySubscriberId}\n` : ''}✅ Kopijavimas aktyvus`);
    if (telegramId) {
      await sendTelegram(telegramId, 'Sveiki! 🎉 Jūsų sąskaita sėkmingai prijungta. Kopijavimas aktyvuotas.\n\nKomandos:\n▶️ /start — pradėti kopijavimą\n⏹ /stop — sustabdyti kopijavimą\n❓ /help — pagalba\n\nIškilo problemų? Rašykite: t.me/yourtelegram\n\nWelcome! 🎉 Your account has been successfully connected. Copying is now active.\n\nHaving issues? Contact us: t.me/yourtelegram');
    }
    res.json({ success: true, account_id: copyFactorySubscriberId, lot_size: formatLotSize(selectedLotSize) });
  } catch (err) {
    console.error('POST /connect-account error:', err);
    if (accountIdToCleanup) await cleanupProvisionedAccount(accountIdToCleanup);
    await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `❌ Sąskaitos prijungimas nepavyko\n📧 ${cleanEmail(req.body?.email)}\n⚠️ Klaida: ${String(err.message || err).slice(0, 900)}`);
    const msg = err.message || '';
    let userError;
    if (msg.includes('connection timeout') || (msg.includes('state=DEPLOYED') && msg.includes('DISCONNECTED'))) {
      userError = 'Nepavyko prisijungti prie brokerio serverio. Patikrinkite serverio pavadinimą, sąskaitos numerį ir slaptažodį. / Could not connect to broker server — please check your server name, account number and password.';
    } else if (msg.includes('account did not connect') || msg.includes('FAILED')) {
      userError = 'Prisijungimas nepavyko. Patikrinkite sąskaitos duomenis ir bandykite dar kartą. / Connection failed — please check your account details and try again.';
    } else {
      userError = 'Klaida jungiantis prie sąskaitos. Susisiekite su mumis per Telegram. / Error connecting account — please contact us on Telegram.';
    }
    res.json({ success: false, error: userError });
  }
});

export default router;
