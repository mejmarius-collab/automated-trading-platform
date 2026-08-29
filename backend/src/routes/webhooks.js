import express from 'express';
import { supabase, stripe, DEMO_MODE, HHHL_DEDUP_MS } from '../config.js';
import { state } from '../state.js';
import { demoGuard } from '../middleware/auth.js';
import { sendTelegram } from '../services/telegram.js';
import {
  openTrade, getActualOpenPrice, closeTradeByMagic, cancelOrderByMagic,
  getClosedDealByMagic, metaApiFetch,
} from '../services/metaapi.js';
import {
  formatSignalPrice, getSignalSourceCode, getGeneratedTpLevelLimit,
  buildSplitTakeProfits, filterMinTpGap, formatTakeProfitLines,
  formatOpenTradeResultMeta, isMetaApiTradeSuccess,
  genHhhlSignalId, nowVilnius,
} from '../utils/formatters.js';
import { parseWebhookEntrySignal, parseSecretTextPayload } from '../utils/parsers.js';
import { createOnboardingToken } from '../security/tokens.js';
import { deleteCopyFactorySubscriber, deleteMetaApiAccount } from '../services/copyfactory.js';
import { cleanEmail } from '../utils/validators.js';
import { MAX_GENERATED_TP_LEVELS } from '../config.js';

async function supabaseInsertWithRetry(table, data, label = '') {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { error } = await supabase.from(table).insert(data);
    if (!error) return null;
    console.error(`Supabase ${label} insert error (attempt ${attempt}/3):`, error.message || error);
    if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
    else return error;
  }
}

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

// ── Stripe webhook handler — must be mounted with express.raw() BEFORE express.json() ──
export async function stripeWebhookHandler(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (DEMO_MODE) {
    console.log('[DEMO] Stripe webhook received but live provisioning skipped');
    return res.json({ received: true, demo: true });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = cleanEmail(session.customer_details?.email || session.customer_email);
      const name = session.customer_details?.name || '';
      const plan = getPlanFromCheckoutSession(session);
      console.log('Stripe session metadata:', JSON.stringify(session.metadata), 'plan:', plan);
      const stripeCustomerId = session.customer || null;

      if (email) {
        const { error: dbError } = await supabase.from('clients').upsert({ email, name, plan, active: true, stripe_customer_id: stripeCustomerId }, { onConflict: 'email' });
        if (dbError) console.error('Supabase clients insert error:', dbError);
      } else {
        console.error('Stripe checkout session completed without email:', session.id);
      }

      const resumeLink = email && plan
        ? `${process.env.FRONTEND_URL || 'https://yourdomain.com'}/onboarding.html?token=${encodeURIComponent(createOnboardingToken(email, plan))}`
        : '';
      await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID,
        `🆕 Naujas klientas!\n👤 ${name}\n💰 Planas: ${plan}\n📧 ${email}` +
        (resumeLink ? `\n🔁 Resume onboarding: ${resumeLink}` : ''));

      if ((plan === 'Signalas' || plan === 'Automatinis') && email) {
        const { data: clientRow } = await supabase.from('clients').select('telegram_user_id').eq('email', email).maybeSingle();
        if (clientRow?.telegram_user_id) {
          const welcomeMsg = plan === 'Signalas'
            ? 'Sveiki! 🎉 Ačiū už užsakymą. Netrukus būsite pridėti į VIP signalų grupę Telegram. Susisieksime greitu metu.\n\nWelcome! 🎉 Thank you for your purchase. You will be added to the VIP signals group on Telegram shortly. We\'ll be in touch soon.'
            : 'Sveiki! 🎉 Ačiū už užsakymą. Netrukus susisieksime ir padėsime prijungti sąskaitą.\n\nWelcome! 🎉 Thank you for your purchase. We will be in touch shortly to help you connect your account.';
          await sendTelegram(clientRow.telegram_user_id, welcomeMsg);
        }
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const stripeCustomerId = event.data.object.customer;
      const { data: client } = await supabase.from('clients').select('*').eq('stripe_customer_id', stripeCustomerId).maybeSingle();
      if (client) {
        let cleanupOk = true;
        if (client.metaapi_account_id) {
          const cfDelete = await deleteCopyFactorySubscriber(client.metaapi_account_id);
          console.log('CopyFactory unsubscribe (subscription deleted):', cfDelete.status, 'for', client.email);
          if (!cfDelete.ok) {
            cleanupOk = false;
            await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `❌ CopyFactory klaida atšaukiant prenumeratą ${client.email}: HTTP ${cfDelete.status}. Supabase NEATNAUJINTA.\n${String(cfDelete.body || '').slice(0, 500)}`);
          }
          if (cleanupOk) {
            const maDelete = await deleteMetaApiAccount(client.metaapi_account_id);
            console.log('MetaAPI delete (subscription deleted):', maDelete.deleteStatus, 'undeploy:', maDelete.undeployStatus, 'for', client.email);
            if (!maDelete.ok) {
              cleanupOk = false;
              await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `❌ MetaAPI klaida atšaukiant prenumeratą ${client.email}: HTTP ${maDelete.deleteStatus}. Supabase NEATNAUJINTA.\n${String(maDelete.body || '').slice(0, 500)}`);
            }
          }
        }
        if (cleanupOk) {
          const updateData = { active: false };
          if (client.metaapi_account_id) updateData.metaapi_account_id = null;
          await supabase.from('clients').update(updateData).eq('email', client.email);
          await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `❌ Prenumerata baigėsi: ${client.email}` + (client.metaapi_account_id ? '\nCopyFactory: istrinta\nMetaAPI: istrinta' : ''));
        }
      } else {
        console.warn('customer.subscription.deleted: no client found for stripe_customer_id', stripeCustomerId);
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('POST /webhook/stripe error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

const router = express.Router();

// ── POST /webhook/telegram-only ─────────────────────────────────────────────
router.post('/webhook/telegram-only', express.text({ type: '*/*' }), async (req, res) => {
  const { text, bodySecret } = parseSecretTextPayload(req.body);
  if (!bodySecret || bodySecret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!text) return res.status(400).json({ error: 'Missing text' });

  const chatId = process.env.TELEGRAM_CHAT_ID_XAU;
  const tgRes = await sendTelegram(chatId, text);
  if (!tgRes.ok) {
    await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `WARN: Telegram-only signal send failed\n${JSON.stringify(tgRes).slice(0, 400)}\n\n${text.slice(0, 500)}`);
    return res.status(502).json({ ok: false, telegram: tgRes });
  }
  res.json({ ok: true, telegram_message_id: tgRes.result?.message_id || null });
});

// ── POST /webhook/fvg — signal alerts (market/limit, Supabase, VIP) ─────────
router.post('/webhook/fvg', express.text({ type: '*/*' }), async (req, res) => {
  const { text, bodySecret, silent, no_msg, comment, layer, noTp } = parseSecretTextPayload(req.body);
  if (!bodySecret || bodySecret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!text) { console.warn('/webhook/fvg missing text'); return res.status(400).json({ error: 'Missing text' }); }
  if (DEMO_MODE) return res.json({ ok: true, demo: true, message: 'Demo mode — no live trade executed' });

  res.json({ ok: true });

  (async () => {
    try {
      const idMatch = text.match(/ID\s+(\d+)/);
      const signalId = idMatch ? idMatch[1] : null;

      if (text.includes('CLOSE TRADE')) {
        if (!signalId) return;
        const { data: tradeRow } = await supabase.from('trades').select('magic, tg_message_id, tg_chat_id').eq('signal_id', signalId).eq('status', 'open').limit(1).maybeSingle();
        const magic = tradeRow?.magic ?? parseInt(signalId.slice(-9));
        if (!tradeRow) {
          console.warn('CLOSE TRADE without open DB row, signal_id:', signalId);
          await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `⚠️ CLOSE TRADE be atviro DB įrašo (ID ${signalId}) — į kanalus nepersiųsta.\n\n${text}`);
          return;
        }
        const closeResult = await closeTradeByMagic(magic);
        let tradeResult = text.includes('— TP') ? 'TP' : 'SL';
        let exitPrice = null, profit = null;
        if (/\bTP\b/i.test(text)) tradeResult = 'TP';
        let closeOrCancelOk = false;
        if (closeResult?.ok) {
          closeOrCancelOk = true;
          exitPrice = closeResult.exitPrice; profit = closeResult.profit;
          if (!profit) { const d = await getClosedDealByMagic(magic); exitPrice = d?.exitPrice || exitPrice; profit = d?.profit || null; }
        } else {
          const cancelled = await cancelOrderByMagic(magic);
          if (cancelled?.ok) { closeOrCancelOk = true; tradeResult = 'Canceled'; } else { const d = await getClosedDealByMagic(magic); if (d) { closeOrCancelOk = true; exitPrice = d.exitPrice || null; profit = d.profit ?? null; } }
        }
        if (!closeOrCancelOk) {
          await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `WARN: CLOSE TRADE not confirmed by MetaAPI\nID ${signalId}\nMagic ${magic}\n\n${text}`);
          return;
        }
        if (tradeResult === 'Canceled') {
          await supabase.from('trades').delete().eq('magic', magic).eq('status', 'open');
        } else {
          await supabase.from('trades').update({ status: 'closed', result: tradeResult, closed_at: nowVilnius(), exit: exitPrice, profit }).eq('magic', magic).eq('status', 'open');
        }
        const chatId = tradeRow.tg_chat_id || process.env.TELEGRAM_CHAT_ID_XAU;
        const options = tradeRow.tg_message_id ? { reply_to_message_id: tradeRow.tg_message_id } : {};
        const closeLine = text.split(/\n+/).map(line => line.trim()).find(Boolean) || text;
        const channelCloseText = tradeResult === 'Canceled' ? `${closeLine}\n\nCLOSE TRADE` : text;
        await sendTelegram(chatId, channelCloseText, options);

      } else {
        const entrySignal = parseWebhookEntrySignal(text);
        let tgText = text;
        let displayTpLevels = [];
        let lotLabel = '';
        if (entrySignal) {
          const { action, symbol, isLimitOrder, signalId: entrySignalId } = entrySignal;
          const magic = parseInt(entrySignalId.slice(-9));
          const srcCode = getSignalSourceCode(entrySignalId);
          const customDisplayTpLevels = entrySignal.tpLevels.length > 1 ? entrySignal.tpLevels.slice(0, MAX_GENERATED_TP_LEVELS) : [];
          const displayEntry = entrySignal.price;
          const displayTp = (customDisplayTpLevels.length ? customDisplayTpLevels : entrySignal.tpLevels).at(-1)?.price;
          const displaySl = entrySignal.sl;
          if (!Number.isFinite(displayEntry) || !Number.isFinite(displayTp)) {
            console.error('Invalid parsed entry signal:', JSON.stringify(entrySignal));
            await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `WARN: signal parse failed, invalid entry/TP\n${text}`);
            return;
          }
          const generatedDisplayTpLevels = (customDisplayTpLevels.length || noTp || entrySignal.noSplit)
            ? [] : buildSplitTakeProfits(action, displayEntry, displayTp, 10, getGeneratedTpLevelLimit(srcCode));
          displayTpLevels = customDisplayTpLevels.length
            ? customDisplayTpLevels.slice(0, 2)
            : (noTp || entrySignal.noSplit) ? [{ label: 'TP', price: displayTp }] : filterMinTpGap(generatedDisplayTpLevels, action).slice(0, 2);
          if (displayTpLevels.length === 1 && displayTpLevels[0].label === 'TP1') displayTpLevels = [{ label: 'TP', price: displayTpLevels[0].price }];
          const rawEntry = displayEntry;
          const rawTpLevels = displayTpLevels.map(tp => ({ label: tp.label, price: tp.price }));
          const rawTp = (rawTpLevels.length ? rawTpLevels : [{ price: displayTp }]).at(-1).price;
          const volume = 0.5;
          const isSplitOrder = !entrySignal.noSplit && displayTpLevels.length >= 2;
          const tradeVolume = entrySignal.noSplit ? volume : Math.round(volume / 2 * 100) / 100;
          const rawSl = displaySl;
          const tpLines = formatTakeProfitLines(displayTpLevels, ':');
          lotLabel = isSplitOrder ? `${formatSignalPrice(tradeVolume)} × 2 (${formatSignalPrice(volume)} total)` : formatSignalPrice(tradeVolume);
          tgText = noTp
            ? [`🔔 ${symbol} ${action} ${formatSignalPrice(displayEntry)}`, `LOT ${lotLabel}`, `ID ${entrySignalId}`].join('\n')
            : [`${symbol} ${action}${isLimitOrder ? ' LIMIT' : ''} ${formatSignalPrice(displayEntry)}`, tpLines, `SL ${displaySl !== null ? formatSignalPrice(displaySl) : 'OPEN'}`, `LOT ${lotLabel}`, `ID ${entrySignalId}`, comment ? `\n💬 ${comment}` : null].filter(Boolean).join('\n');
          const bufferedSl = rawSl ? (action === 'BUY' ? rawSl - 0.4 : rawSl + 0.4) : null;
          let tradeOpenData = null;
          let tradeOpened = false;
          try {
            tradeOpenData = await openTrade(symbol, action, tradeVolume, rawTp, bufferedSl, magic, isLimitOrder ? rawEntry : null, isLimitOrder ? 'limit' : 'market', null, noTp);
            tradeOpened = isMetaApiTradeSuccess(tradeOpenData);
            if (!tradeOpened) console.error('openTrade rejected:', JSON.stringify(tradeOpenData));
          } catch (tradeErr) { console.error('openTrade error (MetaAPI down?):', tradeErr.message); }

          if (tradeOpened && !entrySignal.noSplit && displayTpLevels.length >= 2) {
            const tp1Price = displayTpLevels[0].price;
            const magicA = (magic + 1) % 2147483647;
            try {
              const orderAData = await openTrade(symbol, action, tradeVolume, tp1Price, bufferedSl, magicA, isLimitOrder ? rawEntry : null, isLimitOrder ? 'limit' : 'market');
              const orderAOpened = isMetaApiTradeSuccess(orderAData);
              if (orderAOpened) {
                console.log(`Order A placed: ${symbol} ${action} TP1=${tp1Price} magic=${magicA}`);
                if (!silent) {
                  const actualEntryA = await getActualOpenPrice(magicA);
                  const insertErrorA = await supabaseInsertWithRetry('trades', {
                    symbol, direction: action, entry: actualEntryA ?? rawEntry, sl: rawSl,
                    tp: tp1Price, lot: tradeVolume, magic: magicA,
                    signal_id: entrySignalId + '_a', src_code: srcCode, status: 'open', opened_at: nowVilnius(),
                  }, `Order A ${entrySignalId}`);
                  if (insertErrorA) await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `WARN: Supabase Order A insert failed after 3 retries\n${symbol} ${action}\nID ${entrySignalId}\n${insertErrorA.message || JSON.stringify(insertErrorA).slice(0, 200)}`);
                }
              } else { console.error('Order A placement failed:', JSON.stringify(orderAData)); }
            } catch (e) { console.error('Order A (TP1) placement failed:', e.message); }
          }

          if (silent) {
            if (!tradeOpened) console.warn(`[silent] MT4 order failed: ${symbol} ${action}`);
          } else {
            if (tradeOpened) {
              const actualEntry = await getActualOpenPrice(magic);
              const insertData = { symbol, direction: action, entry: actualEntry ?? rawEntry, sl: rawSl, tp: noTp ? null : rawTp, lot: tradeVolume, magic, signal_id: entrySignalId, src_code: srcCode, status: 'open', opened_at: nowVilnius() };
              if (!noTp && rawTpLevels.length) insertData.result = formatOpenTradeResultMeta(rawTpLevels, new Set());
              const insertError = await supabaseInsertWithRetry('trades', insertData, `${srcCode} ${entrySignalId}`);
              if (insertError) await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `WARN: Supabase trade insert failed after 3 retries\n${symbol} ${action} ${formatSignalPrice(rawEntry)}\nID ${entrySignalId}\n${insertError.message || JSON.stringify(insertError).slice(0, 300)}`);
            } else if (process.env.TELEGRAM_ADMIN_CHAT_ID) {
              const responseText = tradeOpenData ? JSON.stringify(tradeOpenData).slice(0, 500) : 'no response';
              await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `WARN: MetaAPI order was not stored as open\n${symbol} ${action} ${formatSignalPrice(rawEntry)}\nID ${entrySignalId}\nResponse: ${responseText}`);
            }
          }
        }
        if (!silent && !no_msg) {
          const chatId = process.env.TELEGRAM_CHAT_ID_XAU;
          let tgRes = { ok: false, result: null };
          if (!layer) {
            console.log('Signal sending to chat:', chatId, 'text:', tgText.slice(0, 50));
            tgRes = await sendTelegram(chatId, tgText);
            console.log('Signal sendTelegram result:', JSON.stringify(tgRes));
            if (!tgRes.ok) await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `WARN: VIP Telegram signal send failed\nID ${signalId || 'n/a'}\n${JSON.stringify(tgRes).slice(0, 400)}`);
          }
          if (!layer && tgRes.ok && entrySignal && tgRes.result?.message_id) {
            await supabase.from('trades').update({ tg_message_id: tgRes.result.message_id, tg_chat_id: chatId }).eq('signal_id', signalId);
          }
        }
      }
    } catch (err) { console.error('POST /webhook/fvg error:', err); }
  })();
});

// ── POST /webhook/hhhl — HHHL Structure TV alert → MetaAPI MT5 limit order ──
router.post('/webhook/hhhl', express.json(), async (req, res) => {
  const secret = req.body?.secret;
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (DEMO_MODE) return res.json({ ok: true, demo: true, message: 'Demo mode — no live trade executed' });

  const { dir, price, pivot_time, sl_pt, tp_pt, tf } = req.body;
  if (!dir || !price) return res.status(400).json({ error: 'Missing fields' });

  const accountId = process.env.HHHL_MT5_ACCOUNT_ID;
  if (!accountId) { console.error('[HHHL] HHHL_MT5_ACCOUNT_ID not set'); return res.status(500).json({ error: 'MT5 account not configured' }); }

  const p = +price, tpPt = +(tp_pt || 9), slPt = +(sl_pt || 30), mul = dir === 'BUY' ? 1 : -1;
  const tp = +(p + mul * tpPt).toFixed(2), sl = +(p - mul * slPt).toFixed(2);
  const emoji = dir === 'BUY' ? '🟢' : '🔴';
  const tfLabel = tf ? ` [${tf}]` : '';
  const comment = tf ? `${tf}_${dir}` : `HHHL_${dir}`;

  const limitDedupKey = `${dir}_${p.toFixed(2)}`;
  const limitLastTs = state.hhhlLimitDedup.get(limitDedupKey);
  if (limitLastTs && Date.now() - limitLastTs < HHHL_DEDUP_MS) { console.log(`[HHHL] Duplicate ignored: ${limitDedupKey}`); return res.json({ ok: true, duplicate: true }); }
  state.hhhlLimitDedup.set(limitDedupKey, Date.now());

  const { signalId: hhhlSigId, magic: hhhlMagic } = genHhhlSignalId(10, dir);
  let orderOk = false;
  let hhhlPositionId = null;
  try {
    const tradeRes = await metaApiFetch(`/users/current/accounts/${accountId}/trade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'auth-token': process.env.METAAPI_TOKEN },
      body: JSON.stringify({ actionType: dir === 'BUY' ? 'ORDER_TYPE_BUY_LIMIT' : 'ORDER_TYPE_SELL_LIMIT', symbol: 'XAUUSD', volume: 0.01, openPrice: p, takeProfit: tp, stopLoss: sl, magic: hhhlMagic, comment }),
    });
    const tradeData = await tradeRes.json();
    console.log('[HHHL] MetaAPI response:', JSON.stringify(tradeData));
    orderOk = tradeData?.orderId || tradeData?.positionId || (!tradeData?.error);
    hhhlPositionId = tradeData?.positionId ? String(tradeData.positionId) : (tradeData?.orderId ? String(tradeData.orderId) : null);
  } catch (err) { console.error('[HHHL] MetaAPI error:', err.message); }

  if (orderOk) {
    supabase.from('trades').insert({ signal_id: hhhlSigId, magic: hhhlMagic, direction: dir, entry: p, sl, tp, src_code: 10, status: 'open', symbol: 'XAUUSD', opened_at: nowVilnius(), position_id: hhhlPositionId, tf: tf || null })
      .then(({ error }) => { if (error) console.error('[HHHL] Supabase insert error:', error.message); });
  }

  await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID,
    `${emoji} <b>HHHL ${dir} LIMIT${tfLabel}</b> ${orderOk ? '✅' : '❌'}\n\nEntry: <b>${p}</b>\nTP: <b>${tp}</b> (+${tpPt}pt)\nSL: <b>${sl}</b> (-${slPt}pt)\n📍 Pivot: ${pivot_time || '—'}`,
    { parse_mode: 'HTML' });

  console.log(`[HHHL] ${dir} LIMIT @ ${p} TP=${tp} SL=${sl} | ok=${orderOk} magic=${hhhlMagic}`);
  res.json({ ok: orderOk });
});

// ── POST /webhook/hhhl-break — HHHL LINIJA trendline break / state ──────────
const BIG_GAP_TV = 20.0;
const MAX_GAP_TV = 50.0;

router.post('/webhook/hhhl-break', express.json(), async (req, res) => {
  const secret = req.body?.secret;
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (DEMO_MODE) return res.json({ ok: true, demo: true, message: 'Demo mode — no live trade executed' });

  const { type, dir, price, tp_pt, sl_pt, tf, limit_price } = req.body;

  if (type === 'STATE') {
    const now = new Date().toISOString();
    const tfKey = tf || '15MIN';
    if (!state.hhhlLinijaState[tfKey]) state.hhhlLinijaState[tfKey] = { res: null, sup: null };
    if (dir === 'RES') { state.hhhlLinijaState[tfKey].res = { p1: +req.body.p1, p2: +req.body.p2, tf: tfKey, updated_at: now }; console.log(`[HHHL-LINIJA] RES state [${tfKey}]: P1=${req.body.p1} P2=${req.body.p2}`); }
    else if (dir === 'SUP') { state.hhhlLinijaState[tfKey].sup = { p1: +req.body.p1, p2: +req.body.p2, tf: tfKey, updated_at: now }; console.log(`[HHHL-LINIJA] SUP state [${tfKey}]: P1=${req.body.p1} P2=${req.body.p2}`); }
    return res.json({ ok: true });
  }

  if (type !== 'BREAK' || !dir || !price) return res.status(400).json({ error: 'Missing fields' });

  const breakDedupKey = `${tf || '15MIN'}_${dir}`;
  const breakLastTs = state.hhhlBreakDedup.get(breakDedupKey);
  if (breakLastTs && Date.now() - breakLastTs < HHHL_DEDUP_MS) { console.log(`[HHHL-LINIJA] Duplicate break ignored: ${breakDedupKey}`); return res.json({ ok: true, duplicate: true }); }
  state.hhhlBreakDedup.set(breakDedupKey, Date.now());

  const accountId = process.env.HHHL_MT5_ACCOUNT_ID;
  if (!accountId) { console.error('[HHHL-LINIJA] HHHL_MT5_ACCOUNT_ID not set'); return res.status(500).json({ error: 'MT5 account not configured' }); }

  const p = +price, limP = limit_price ? +limit_price : dir === 'BUY' ? +(p - 1).toFixed(2) : +(p + 1).toFixed(2);
  const tpPt = +(tp_pt || 10), slPt = +(sl_pt || 10), mul = dir === 'BUY' ? 1 : -1;
  const gap = Math.abs(p - limP);
  const emoji = dir === 'BUY' ? '🟢' : '🔴';
  const tfLabel = tf ? ` [${tf}]` : '';
  const ts = new Date().toLocaleTimeString('lt-LT', { timeZone: 'Europe/Vilnius', hour: '2-digit', minute: '2-digit' });
  const tfKey = tf || '15MIN';
  if (!state.hhhlLinijaState[tfKey]) state.hhhlLinijaState[tfKey] = { res: null, sup: null };
  if (dir === 'BUY') state.hhhlLinijaState[tfKey].res = null; else state.hhhlLinijaState[tfKey].sup = null;

  const placeOne = async (actionType, entryP) => {
    const tp = +(entryP + mul * tpPt).toFixed(2);
    const sl = +(entryP - mul * slPt).toFixed(2);
    const { signalId, magic } = genHhhlSignalId(11, dir);
    const body = { actionType, symbol: 'XAUUSD', volume: 0.01, takeProfit: tp, stopLoss: sl, magic, comment: `HHHL_LIN_${dir}` };
    if (actionType.includes('LIMIT')) body.openPrice = entryP;
    try {
      const r = await metaApiFetch(`/users/current/accounts/${accountId}/trade`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'auth-token': process.env.METAAPI_TOKEN }, body: JSON.stringify(body) });
      const d = await r.json();
      console.log(`[HHHL-LINIJA] MetaAPI ${actionType}:`, JSON.stringify(d));
      const ok = !!(d?.orderId || d?.positionId || !d?.error);
      const posId = d?.positionId ? String(d.positionId) : (d?.orderId ? String(d.orderId) : null);
      if (ok) supabase.from('trades').insert({ signal_id: signalId, magic, direction: dir, entry: entryP, sl, tp, src_code: 11, status: 'open', symbol: 'XAUUSD', opened_at: nowVilnius(), position_id: posId }).then(({ error }) => { if (error) console.error('[HHHL-LINIJA] Supabase insert error:', error.message); });
      return { ok, tp, sl, positionId: d?.positionId ? String(d.positionId) : null, orderId: d?.orderId ? String(d.orderId) : null };
    } catch (err) { console.error('[HHHL-LINIJA] MetaAPI error:', err.message); return { ok: false, tp, sl, positionId: null, orderId: null }; }
  };

  const mType = dir === 'BUY' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL';
  const lType = dir === 'BUY' ? 'ORDER_TYPE_BUY_LIMIT' : 'ORDER_TYPE_SELL_LIMIT';

  if (gap > MAX_GAP_TV) {
    await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `📐 <b>HHHL LINIJA${tfLabel} — ignoruojamas</b>\n[${ts}] ${dir} | Market: ${p} | TL: ${limP} | Gap: ${gap.toFixed(1)}pt\n⚠️ Gap > ${MAX_GAP_TV}pt — TL šlaitas per status.`, { parse_mode: 'HTML' });
    return res.json({ ok: false, reason: 'gap_too_large' });
  }

  if (gap > BIG_GAP_TV) {
    const r1 = await placeOne(lType, limP);
    await new Promise(r => setTimeout(r, 200));
    const r2 = await placeOne(lType, limP);
    await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `${emoji} <b>HHHL LINIJA${tfLabel} — ${dir} ⚠️ BIG GAP</b>\n[${ts}] Market: ${p} | TL: ${limP} | Gap: ${gap.toFixed(1)}pt (>${BIG_GAP_TV}pt)\n\n${r1.ok?'✅':'❌'} Limit 1 ${dir} @ <b>${limP}</b>  SL: ${r1.sl} | TP: ${r1.tp}\n${r2.ok?'✅':'❌'} Limit 2 ${dir} @ <b>${limP}</b>  SL: ${r2.sl} | TP: ${r2.tp}`, { parse_mode: 'HTML' });
  } else {
    const mR = await placeOne(mType, p);
    await new Promise(r => setTimeout(r, 200));
    const lR = await placeOne(lType, limP);
    if (mR.positionId && lR.orderId) state.hhhlLinijaOrders.push({ positionId: mR.positionId, orderId: lR.orderId, dir });
    await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `${emoji} <b>HHHL LINIJA${tfLabel} — ${dir}</b>\n[${ts}] Gap: ${gap.toFixed(1)}pt\n\n${mR.ok?'✅':'❌'} Market ${dir} @ <b>${p}</b>\n   SL: ${mR.sl} | TP: ${mR.tp}\n\n${lR.ok?'✅':'❌'} Limit ${dir} @ <b>${limP}</b> (retest)\n   SL: ${lR.sl} | TP: ${lR.tp}`, { parse_mode: 'HTML' });
  }
  res.json({ ok: true });
});

// ── POST /webhook/tv-tl — TradingView trendline break ───────────────────────
async function _postFvgInternal(text) {
  const payload = JSON.stringify({ text, secret: process.env.WEBHOOK_SECRET });
  const port = process.env.PORT || 3000;
  const http = (await import('http')).default;
  return new Promise((resolve) => {
    const r = http.request(
      { hostname: 'localhost', port, path: '/webhook/fvg', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => { res.resume(); resolve(true); }
    );
    r.on('error', (e) => { console.error('_postFvgInternal error:', e); resolve(false); });
    r.write(payload); r.end();
  });
}

router.post('/webhook/tv-tl', express.json(), async (req, res) => {
  const { secret, direction, entry, tl_value, sl_pt, tp_pt } = req.body || {};
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (DEMO_MODE) return res.json({ ok: true, demo: true, message: 'Demo mode — no live trade executed' });
  const dir = (direction || '').toUpperCase();
  const marketEntry = parseFloat(entry), tlVal = parseFloat(tl_value), slPt = parseFloat(sl_pt), tpPt = parseFloat(tp_pt);
  if (!['BUY','SELL'].includes(dir) || isNaN(marketEntry) || isNaN(tlVal) || isNaN(slPt) || isNaN(tpPt)) return res.status(400).json({ error: 'Invalid fields. Required: direction (BUY/SELL), entry, tl_value, sl_pt, tp_pt' });
  res.json({ ok: true });

  (async () => {
    try {
      const gap = Math.abs(marketEntry - tlVal);
      const ts  = new Date().toLocaleTimeString('lt-LT', { timeZone: 'Europe/Vilnius', hour: '2-digit', minute: '2-digit' });
      if (gap > MAX_GAP_TV) {
        console.log(`[tv-tl] Gap ${gap.toFixed(1)}pt > MAX_GAP_TV — ignored`);
        await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `📐 <b>TV TL Break — ignoruojamas</b>\n[${ts}] Entry: ${marketEntry} | TL: ${tlVal.toFixed(2)} | Gap: ${gap.toFixed(1)}pt\n⚠️ Gap > ${MAX_GAP_TV}pt — TL šlaitas per status.`, { parse_mode: 'HTML' });
        return;
      }
      const lot = 0.5;
      const nowMs = Date.now(), dirCode = dir === 'BUY' ? '1' : '2';
      const mSid = `${nowMs}9${dirCode}1${String(nowMs).slice(-3)}`;
      const lSid = `${nowMs}9${dirCode}2${String(nowMs).slice(-3)}`;
      const mMagic = parseInt(mSid.slice(-9)), lMagic = parseInt(lSid.slice(-9));

      if (gap > BIG_GAP_TV) {
        const limitEntry = dir === 'BUY' ? +(tlVal + 1).toFixed(2) : +(tlVal - 1).toFixed(2);
        const limitSl = dir === 'BUY' ? +(limitEntry - slPt).toFixed(2) : +(limitEntry + slPt).toFixed(2);
        const limitTp = dir === 'BUY' ? +(limitEntry + tpPt).toFixed(2) : +(limitEntry - tpPt).toFixed(2);
        const lSid2 = `${nowMs + 1}9${dirCode}2${String(nowMs + 1).slice(-3)}`;
        const ok1 = await _postFvgInternal(`XAUUSD ${dir} LIMIT ${limitEntry}\nTP ${limitTp}\nSL ${limitSl}\nLOT ${lot}\nID ${lSid}\nNOSPLIT`);
        await new Promise(r => setTimeout(r, 200));
        const ok2 = await _postFvgInternal(`XAUUSD ${dir} LIMIT ${limitEntry}\nTP ${limitTp}\nSL ${limitSl}\nLOT ${lot}\nID ${lSid2}\nNOSPLIT`);
        await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `📐 <b>TV TL Break — ${dir} XAUUSD</b>\n[${ts}] Entry: ${marketEntry} | TL: ${tlVal.toFixed(2)} | Gap: ${gap.toFixed(1)}pt ⚠️ (>${BIG_GAP_TV}pt — tik retest)\n\n${ok1?'✅':'❌'} Limit 1 ${dir} @ <b>${limitEntry}</b>  SL: ${limitSl} | TP: ${limitTp}\n${ok2?'✅':'❌'} Limit 2 ${dir} @ <b>${limitEntry}</b>  SL: ${limitSl} | TP: ${limitTp}`, { parse_mode: 'HTML' });
        return;
      }

      const limitEntry = dir === 'BUY' ? +(tlVal + 1).toFixed(2) : +(tlVal - 1).toFixed(2);
      const mSl = dir === 'BUY' ? +(marketEntry - slPt).toFixed(2) : +(marketEntry + slPt).toFixed(2);
      const mTp = dir === 'BUY' ? +(marketEntry + tpPt).toFixed(2) : +(marketEntry - tpPt).toFixed(2);
      const lSl = dir === 'BUY' ? +(limitEntry - slPt).toFixed(2) : +(limitEntry + slPt).toFixed(2);
      const lTp = dir === 'BUY' ? +(limitEntry + tpPt).toFixed(2) : +(limitEntry - tpPt).toFixed(2);
      const okM = await _postFvgInternal(`XAUUSD ${dir} ${marketEntry}\nTP ${mTp}\nSL ${mSl}\nLOT ${lot}\nID ${mSid}\nNOSPLIT`);
      await new Promise(r => setTimeout(r, 200));
      const okL = await _postFvgInternal(`XAUUSD ${dir} LIMIT ${limitEntry}\nTP ${lTp}\nSL ${lSl}\nLOT ${lot}\nID ${lSid}\nNOSPLIT`);

      if (okM && okL) {
        const tlOrder = { market_magic: mMagic, limit_magic: lMagic, market_signal_id: mSid, limit_signal_id: lSid };
        state.tvTlActiveOrders.push(tlOrder);
        import('../state.js').then(({ saveTlOrder }) => saveTlOrder(tlOrder));
      }
      await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `📐 <b>TV TL Break — ${dir} XAUUSD</b>\n[${ts}] Entry: ${marketEntry} | TL: ${tlVal.toFixed(2)} | Gap: ${gap.toFixed(1)}pt\n\n${okM?'✅':'❌'} Market ${dir} @ <b>${marketEntry}</b>\n   SL: ${mSl} | TP: ${mTp}\n\n${okL?'✅':'❌'} Limit ${dir} @ <b>${limitEntry}</b> (retest)\n   SL: ${lSl} | TP: ${lTp}`, { parse_mode: 'HTML' });
    } catch (e) { console.error('/webhook/tv-tl error:', e); }
  })();
});

export default router;
