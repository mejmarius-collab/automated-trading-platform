import express from 'express';
import { fetchWithTimeout } from '../utils/http.js';
import { supabase, METAAPI_PROVISIONING_BASE } from '../config.js';
import { state, saveAgentState } from '../state.js';
import { demoGuard } from '../middleware/auth.js';
import { sendTelegram } from '../services/telegram.js';
import { metaApiFetch, closeTradeByMagic, cancelOrderByMagic, getClosedDealByMagic } from '../services/metaapi.js';
import { putCopyFactorySubscriber, deleteCopyFactorySubscriber, deleteMetaApiAccount, detectGoldSymbol } from '../services/copyfactory.js';
import { cleanEmail, normalizeLotSize, formatLotSize, formatAllowedLotSizes } from '../utils/validators.js';
import { genHhhlSignalId, nowVilnius, isMetaApiTradeSuccess } from '../utils/formatters.js';

const router = express.Router();

// ── POST /admin/update-subscriber-lot ───────────────────────────────────────
router.post('/admin/update-subscriber-lot', express.json(), async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const { email: rawEmail, lot_size } = req.body;
  if (!rawEmail || lot_size == null) return res.status(400).json({ error: 'email and lot_size required' });
  const email = cleanEmail(rawEmail);
  let selectedLotSize;
  try { selectedLotSize = normalizeLotSize(lot_size); } catch { return res.status(400).json({ error: 'Invalid lot size' }); }
  const { data: client, error: dbErr } = await supabase.from('clients').select('metaapi_account_id, broker_symbol').eq('email', email).maybeSingle();
  if (dbErr || !client) return res.status(404).json({ error: 'Client not found' });
  const result = await putCopyFactorySubscriber(client.metaapi_account_id, email, selectedLotSize, client.broker_symbol);
  if (!result.ok) { console.error('update-subscriber-lot CopyFactory error:', result.body); return res.status(500).json({ error: `CopyFactory error ${result.status}`, body: result.body }); }
  const { error: updateErr } = await supabase.from('clients').update({ lot_size: formatLotSize(selectedLotSize) }).eq('email', email);
  if (updateErr) console.error('Supabase lot_size update error:', updateErr);
  const perOrder = Math.max(0.01, Math.floor(selectedLotSize / 2 * 100) / 100);
  const msg = `⚙️ Lot size atnaujintas: ${email}\n${formatLotSize(selectedLotSize)} total → ${formatLotSize(perOrder)} per orderį`;
  await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, msg);
  console.log(msg);
  res.json({ success: true, email, lot_size: formatLotSize(selectedLotSize), per_order: formatLotSize(perOrder) });
});

// ── GET /admin/client-status ─────────────────────────────────────────────────
router.get('/admin/client-status', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });
  const { data: client, error } = await supabase.from('clients').select('*').eq('email', email).single();
  if (error || !client) return res.status(404).json({ error: 'Client not found in Supabase' });
  const accountId = client.metaapi_account_id;
  const result = { supabase: client, metaapi: null, copyfactory: null, tradeAllowed: null };
  try { const r = await fetchWithTimeout(`${METAAPI_PROVISIONING_BASE}/users/current/accounts/${accountId}`, { headers: { 'auth-token': process.env.METAAPI_TOKEN } }); result.metaapi = await r.json(); } catch (e) { result.metaapi = { error: e.message }; }
  try { const r = await fetchWithTimeout(`https://copyfactory-api-v1.london.agiliumtrade.ai/users/current/configuration/subscribers/${accountId}`, { headers: { 'auth-token': process.env.METAAPI_TOKEN } }); result.copyfactory = await r.json(); } catch (e) { result.copyfactory = { error: e.message }; }
  try { const r = await metaApiFetch(`/users/current/accounts/${accountId}/account-information`, { headers: { 'auth-token': process.env.METAAPI_TOKEN } }); const ai = await r.json(); result.tradeAllowed = ai?.tradeAllowed ?? null; result.accountInfo = ai; } catch (e) { result.tradeAllowed = { error: e.message }; }
  res.json(result);
});

// ── GET /admin/subscriber-logs ───────────────────────────────────────────────
router.get('/admin/subscriber-logs', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });
  const { data: client, error } = await supabase.from('clients').select('metaapi_account_id').eq('email', email).single();
  if (error || !client) return res.status(404).json({ error: 'Client not found' });
  const accountId = client.metaapi_account_id;
  const authHeader = { 'auth-token': process.env.METAAPI_TOKEN };
  const result = {};
  try { const r = await fetchWithTimeout(`https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/${accountId}/positions`, { headers: authHeader }); result.positions = await r.json(); } catch (e) { result.positions = { error: e.message }; }
  try {
    const start = new Date(Date.now() - 4 * 3600 * 1000).toISOString(), end = new Date().toISOString();
    const r = await fetchWithTimeout(`https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/${accountId}/history-deals/time-range?startTime=${start}&endTime=${end}&limit=20`, { headers: authHeader });
    result.recentDeals = await r.json();
  } catch (e) { result.recentDeals = { error: e.message }; }
  res.json(result);
});

// ── GET /admin/copyfactory-log ───────────────────────────────────────────────
router.get('/admin/copyfactory-log', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });
  const { data: client, error } = await supabase.from('clients').select('metaapi_account_id').eq('email', email).single();
  if (error || !client) return res.status(404).json({ error: 'Client not found' });
  const accountId = client.metaapi_account_id;
  const authHeader = { 'auth-token': process.env.METAAPI_TOKEN };
  const result = { symbols: null, cfLog: null };
  try { const r = await metaApiFetch(`/users/current/accounts/${accountId}/symbols`, { headers: authHeader }); const symbols = await r.json(); result.symbols = Array.isArray(symbols) ? symbols.filter(s => /^(XAU|GOLD)/i.test(s)) : symbols; } catch (e) { result.symbols = { error: e.message }; }
  try { const r = await fetchWithTimeout(`https://copyfactory-api-v1.london.agiliumtrade.ai/users/current/subscribers/${accountId}/user-log?limit=50`, { headers: authHeader }); result.cfLog = await r.json(); } catch (e) { result.cfLog = { error: e.message }; }
  res.json(result);
});

// ── POST /admin/update-subscriber-symbol ────────────────────────────────────
router.post('/admin/update-subscriber-symbol', express.json(), async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const { email: rawEmail, broker_symbol } = req.body;
  if (!rawEmail) return res.status(400).json({ error: 'email required' });
  const email = cleanEmail(rawEmail);
  const { data: client, error: dbErr } = await supabase.from('clients').select('metaapi_account_id, lot_size').eq('email', email).maybeSingle();
  if (dbErr || !client) return res.status(404).json({ error: 'Client not found' });
  if (!client.lot_size) return res.status(400).json({ error: 'lot_size not set for this client' });
  let brokerSymbol = broker_symbol && broker_symbol.trim().toLowerCase() !== 'auto' ? broker_symbol.trim() : null;
  let autoDetected = false;
  if (!brokerSymbol) { const detected = await detectGoldSymbol(client.metaapi_account_id); brokerSymbol = detected || 'XAUUSD'; autoDetected = true; console.log(`Auto-detected symbol for ${email}: ${brokerSymbol}`); }
  const lotSize = parseFloat(client.lot_size);
  const result = await putCopyFactorySubscriber(client.metaapi_account_id, email, lotSize, brokerSymbol);
  if (!result.ok) { console.error('update-subscriber-symbol CopyFactory error:', result.body); return res.status(500).json({ error: `CopyFactory error ${result.status}`, body: result.body }); }
  const { error: updateErr } = await supabase.from('clients').update({ broker_symbol: brokerSymbol !== 'XAUUSD' ? brokerSymbol : null }).eq('email', email);
  if (updateErr) console.error('Supabase broker_symbol update error:', updateErr);
  const msg = `🔀 Symbol atnaujintas: ${email}\nXAUUSD → ${brokerSymbol}${autoDetected ? ' (auto-detected)' : ''}`;
  await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, msg); console.log(msg);
  res.json({ success: true, email, broker_symbol: brokerSymbol, auto_detected: autoDetected });
});

// ── POST /telegram-webhook — Telegram bot commands ───────────────────────────
router.post('/telegram-webhook', demoGuard, express.json(), async (req, res) => {
  try {
    if (process.env.TELEGRAM_WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== process.env.TELEGRAM_WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false });
    }
    const message = req.body?.message;
    if (!message) return res.json({ ok: true });

    const fromId     = String(message.from?.id || '');
    const fromChatId = String(message.chat?.id);
    const text       = (message.text || '').trim();
    const isAdmin    = fromChatId === String(process.env.TELEGRAM_ADMIN_CHAT_ID);

    // /help — any user
    if (/^\/help/i.test(text)) {
      const adminSection = isAdmin ? '\n\n🔧 Admin komandos:\n\n👥 Klientai:\n/clients — visi klientai\n/status <email> — kliento informacija\n/activate <email> — aktyvuoti klientą\n/deactivate <email> — deaktyvuoti klientą\n/deleteclient <email> — ištrinti klientą (CopyFactory + MetaAPI + Supabase)\n/setlot <email> <lot> — pakeisti kliento lot dydį (0.01–1.00)\n/setmasterlot <lot> — pakeisti master lot dydį\n/updateallsubs — atnaujinti visų subscriber\'ių CopyFactory konfigūraciją\n\n📊 Pozicijos:\n/balance — sąskaitų balansai, floating ir dienos pelnas\n/close <id> — uždaryti poziciją\n/modtp <magic> <tp> — pakeisti TP\n/cancelc <id> — atšaukti pending limit orderį\n/closeall — atšaukti visus pending orderius\n/closepositions — uždaryti visas atviras pozicijas\n/syncpositions — sinchronizuoti MetaAPI pozicijas į Supabase\n\n📡 Signalai:\n/signal BUY|SELL <kaina> [TP1: x\\nTP2: x\\nSL: x] — rankinis signalas\n\n📈 EMA agentas:\n/ema stop|start|skip|status — EMA agentas\n/clearema — išvalyti EMA state\n/rideopennow BUY|SELL <price> — rankinis ride\n/cancelc <id> — atšaukti pending orderį\n/modtp <magic> <tp> — modifikuoti TP' : '';
      await sendTelegram(fromChatId, '🤖 Automated Trading Platform Bot\n\nKomandos / Commands:\n/stop — sustabdyti kopijavimą / pause copying\n/start — aktyvuoti kopijavimą / resume copying\n/help — ši žinutė / this message\n\n💰 Jūsų lėšos visada saugiai laikomos jūsų pačių brokerio sąskaitoje.\nYour funds are always safely held in your own broker account.' + adminSection);
      return res.json({ ok: true });
    }

    // /stop — any user
    if (/^\/stop/i.test(text)) {
      const { data: client } = await supabase.from('clients').select('*').eq('telegram_user_id', fromId).maybeSingle();
      if (!client) { await sendTelegram(fromChatId, '❌ Klientas nerastas / Client not found\n\nJūsų Telegram ID nepriregistruotas sistemoje.\nYour Telegram ID is not registered.'); return res.json({ ok: true }); }
      if (!client.metaapi_account_id) { await sendTelegram(fromChatId, 'ℹ️ Automatinis kopijavimas šiai paskyrai neprijungtas / Automated copying is not connected for this account.'); return res.json({ ok: true }); }
      const cfDelete = await deleteCopyFactorySubscriber(client.metaapi_account_id);
      console.log('CopyFactory unsubscribe status:', cfDelete.status, 'for', client.email);
      if (!cfDelete.ok) {
        await sendTelegram(fromChatId, '⚠️ Nepavyko sustabdyti kopijavimo / Could not pause copying\n\nBandykite dar kartą po kelių minučių.\nPlease try again in a few minutes.');
        await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `❌ /stop klaida: ${client.email} CopyFactory HTTP ${cfDelete.status}. Supabase NEATNAUJINTA.\n${String(cfDelete.body || '').slice(0, 500)}`);
        return res.json({ ok: true });
      }
      await supabase.from('clients').update({ active: false }).eq('email', client.email);
      await sendTelegram(fromChatId, '✅ Kopijavimas sustabdytas / Copying paused\n\nEsami atviri sandoriai liks atviri kol pasieks TP/SL.\nOpen trades will remain open until they hit TP/SL.\n\nNorėdami vėl aktyvuoti — rašykite /start\nTo resume — send /start');
      await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `⏸️ Klientas sustabdė kopijavimą: ${client.email}`);
      return res.json({ ok: true });
    }

    // /start — any user
    if (/^\/start/i.test(text)) {
      const { data: client } = await supabase.from('clients').select('*').eq('telegram_user_id', fromId).maybeSingle();
      if (!client) { await sendTelegram(fromChatId, '❌ Klientas nerastas / Client not found\n\nJūsų Telegram ID nepriregistruotas sistemoje.\nYour Telegram ID is not registered.'); return res.json({ ok: true }); }
      const lotSize = parseFloat(client.lot_size) || 0.01;
      if (!client.metaapi_account_id) { await sendTelegram(fromChatId, '⚠️ Sąskaita dar neprijungta / Account is not connected\n\nPirmiausia prijunkite savo MT4/MT5 sąskaitą per onboarding puslapį.\nPlease connect your MT4/MT5 account first.'); await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `❌ /start klaida: ${client.email} neturi MetaAPI ID.`); return res.json({ ok: true }); }
      const subResult = await putCopyFactorySubscriber(client.metaapi_account_id, client.email, lotSize);
      console.log('CopyFactory resubscribe status:', subResult.status, 'for', client.email);
      if (!subResult.ok) {
        await sendTelegram(fromChatId, '⚠️ Nepavyko aktyvuoti kopijavimo / Could not activate copying\n\nBandykite dar kartą po kelių minučių.\nPlease try again in a few minutes.');
        await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `❌ /start klaida: ${client.email} CopyFactory HTTP ${subResult.status}. Supabase NEATNAUJINTA.\n${String(subResult.body || '').slice(0, 500)}`);
        return res.json({ ok: true });
      }
      await supabase.from('clients').update({ active: true }).eq('email', client.email);
      await sendTelegram(fromChatId, '✅ Kopijavimas aktyvuotas / Copying activated\n\nNauji sandoriai bus automatiškai kopijuojami į Jūsų sąskaitą.\nNew trades will be automatically copied to your account.');
      await sendTelegram(process.env.TELEGRAM_ADMIN_CHAT_ID, `▶️ Klientas aktyvavo kopijavimą: ${client.email}`);
      return res.json({ ok: true });
    }

    // Admin-only commands from here
    if (!isAdmin) return res.json({ ok: true });

    // /syncpositions
    if (/^\/syncpositions$/i.test(text)) {
      try {
        const posRes = await metaApiFetch(`/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/positions`, { headers: { 'auth-token': process.env.METAAPI_TOKEN } });
        const positions = await posRes.json();
        if (!Array.isArray(positions)) { await sendTelegram(fromChatId, '⚠️ MetaAPI neatsakė teisingai.'); return res.json({ ok: true }); }
        if (positions.length === 0) { await sendTelegram(fromChatId, 'ℹ️ Nėra atvirų pozicijų MT4.'); return res.json({ ok: true }); }
        const { data: existing } = await supabase.from('trades').select('magic').eq('status', 'open');
        const existingMagics = new Set((existing || []).map(t => t.magic));
        let synced = 0, skipped = 0;
        for (const p of positions) {
          if (existingMagics.has(p.magic)) { skipped++; continue; }
          const direction = p.type === 'POSITION_TYPE_BUY' ? 'BUY' : 'SELL';
          const openedAt = p.time ? new Date(p.time).toISOString() : new Date().toISOString();
          const { error } = await supabase.from('trades').insert({ symbol: p.symbol?.replace('/', '') || 'XAUUSD', direction, entry: p.openPrice, sl: p.stopLoss || null, tp: p.takeProfit || null, lot: p.volume, magic: p.magic, signal_id: `manual_${p.id || p.magic}`, src_code: 0, status: 'open', opened_at: openedAt });
          if (error) console.error('syncpositions insert error:', error); else synced++;
        }
        await sendTelegram(fromChatId, `✅ <b>Sync atliktas</b>\n\nĮrašyta: <b>${synced}</b> naujų pozicijų\nPraleista (jau yra): <b>${skipped}</b>\nViso MT4: <b>${positions.length}</b>`);
      } catch (err) { console.error('/syncpositions error:', err); await sendTelegram(fromChatId, `⚠️ Klaida: ${err.message}`); }
      return res.json({ ok: true });
    }

    // /cyclestatus
    if (/^\/cyclestatus$/i.test(text)) {
      if (!state.cycleState) { await sendTelegram(fromChatId, 'ℹ️ Cycle state dar negautas (agentas dar nepaleidęs ciklo).'); return res.json({ ok: true }); }
      const s = state.cycleState;
      const inWindow = s.in_timer_window ? '✅ AKTYVUS' : '⏳ Laukiama';
      const confirmed = s.confirmed_signal_date ? `✅ ${s.confirmed_signal_date}` : 'Nėra';
      const watchSent = s.watch_alert_sent ? 'Taip' : 'Ne';
      const emoji = s.last_pivot_type === 'Low' ? '🔻' : '🔺';
      await sendTelegram(fromChatId, `🔄 <b>Cycle Status</b>\n\n${emoji} Paskutinis: <b>${s.last_pivot_type}</b> ${s.last_pivot_date} @ $${s.last_pivot_price}\nLaukiamas: <b>${s.next_expected}</b>\nPraėjo: <b>${s.days_ago}d</b> | Avg ciklas: <b>${s.avg_cycle}d</b>\nTimer langas: ${inWindow}\nWatch alert išsiųstas: ${watchSent}\nPatvirtinimas: ${confirmed}`);
      return res.json({ ok: true });
    }

    // /clients
    if (/^\/clients$/i.test(text)) {
      const { data: clients } = await supabase.from('clients').select('email, plan, active, lot_size').order('email', { ascending: true });
      if (!clients || clients.length === 0) { await sendTelegram(fromChatId, '📭 Nėra klientų.'); return res.json({ ok: true }); }
      const lines = clients.map(c => `${c.active ? '🟢' : '🔴'} ${c.email}\n   Planas: ${c.plan || '—'} · Lot: ${c.lot_size || '—'}`);
      await sendTelegram(fromChatId, `👥 Klientai (${clients.length}):\n\n` + lines.join('\n\n'));
      return res.json({ ok: true });
    }

    // /status hhhl
    if (/^\/status\s+hhhl$/i.test(text)) {
      const fmtTF = (label, s) => {
        const r = s?.res ? `📉 <b>RES</b> P1: ${s.res.p1} → P2: ${s.res.p2} ⏱ ${(s.res.updated_at||'').slice(11,16)} UTC` : '📉 RES: nėra';
        const sp = s?.sup ? `📈 <b>SUP</b> P1: ${s.sup.p1} → P2: ${s.sup.p2} ⏱ ${(s.sup.updated_at||'').slice(11,16)} UTC` : '📈 SUP: nėra';
        return `<b>[${label}]</b>\n${r}\n${sp}`;
      };
      await sendTelegram(fromChatId, `📊 <b>HHHL LINIJA statusas</b>\n\n${fmtTF('15MIN', state.hhhlLinijaState['15MIN'])}\n\n${fmtTF('1H', state.hhhlLinijaState['60MIN'])}`, { parse_mode: 'HTML' });
      return res.json({ ok: true });
    }

    // /status <email>
    const statusMatch = text.match(/^\/status\s+(\S+)/i);
    if (statusMatch) {
      const email = cleanEmail(statusMatch[1]);
      const { data: client } = await supabase.from('clients').select('*').eq('email', email).maybeSingle();
      if (!client) { await sendTelegram(fromChatId, `❌ Klientas nerastas: ${email}`); return res.json({ ok: true }); }
      await sendTelegram(fromChatId, `👤 ${client.email}\nPlanas: ${client.plan || '—'}\nAktyvus: ${client.active ? '✅ Taip' : '❌ Ne'}\nLot dydis: ${client.lot_size || '—'}\nMetaAPI ID: ${client.metaapi_account_id || '—'}\nTelegram ID: ${client.telegram_user_id || '—'}\nStripe customer: ${client.stripe_customer_id || '—'}`);
      return res.json({ ok: true });
    }

    // /deactivate <email>
    const deactivateMatch = text.match(/^\/deactivate\s+(\S+)/i);
    if (deactivateMatch) {
      const email = cleanEmail(deactivateMatch[1]);
      const { data: client } = await supabase.from('clients').select('*').eq('email', email).maybeSingle();
      if (!client) { await sendTelegram(fromChatId, `❌ Klientas nerastas: ${email}`); return res.json({ ok: true }); }
      if (client.metaapi_account_id) {
        const cfDelete = await deleteCopyFactorySubscriber(client.metaapi_account_id);
        console.log('CopyFactory deactivate status:', cfDelete.status, 'for', client.email);
        if (!cfDelete.ok) { await sendTelegram(fromChatId, `❌ CopyFactory klaida deaktyvuojant ${email}: HTTP ${cfDelete.status}. Supabase NEATNAUJINTA.\n${String(cfDelete.body || '').slice(0, 500)}`); return res.json({ ok: true }); }
      }
      await supabase.from('clients').update({ active: false }).eq('email', email);
      await sendTelegram(fromChatId, `⏸️ Klientas deaktyvuotas: ${email}`);
      return res.json({ ok: true });
    }

    // /deleteclient <email>
    const deleteClientMatch = text.match(/^\/deleteclient\s+(\S+)/i);
    if (deleteClientMatch) {
      const email = cleanEmail(deleteClientMatch[1]);
      const { data: client } = await supabase.from('clients').select('*').eq('email', email).maybeSingle();
      if (!client) { await sendTelegram(fromChatId, `Klientas nerastas: ${email}`); return res.json({ ok: true }); }
      let externalDeleteMsg = 'CopyFactory/MetaAPI: nebuvo MetaAPI ID, todėl išorinės sistemos netrintos';
      if (client.metaapi_account_id) {
        const cfDelete = await deleteCopyFactorySubscriber(client.metaapi_account_id);
        if (!cfDelete.ok) { await sendTelegram(fromChatId, `CopyFactory klaida trinant ${email}: HTTP ${cfDelete.status}. Supabase NEISTRINTA.\n${String(cfDelete.body || '').slice(0, 500)}`); return res.json({ ok: true }); }
        const maDelete = await deleteMetaApiAccount(client.metaapi_account_id);
        if (!maDelete.ok) { await sendTelegram(fromChatId, `MetaAPI klaida trinant ${email}: HTTP ${maDelete.deleteStatus}. Supabase NEISTRINTA.\n${String(maDelete.body || '').slice(0, 500)}`); return res.json({ ok: true }); }
        externalDeleteMsg = 'CopyFactory: istrinta\nMetaAPI: istrinta';
      }
      const { error: deleteError } = await supabase.from('clients').delete().eq('email', email);
      if (deleteError) { console.error('Supabase deleteclient error:', deleteError); await sendTelegram(fromChatId, `Supabase klaida trinant ${email}: ${deleteError.message}`); return res.json({ ok: true }); }
      await sendTelegram(fromChatId, `Klientas istrintas: ${email}\n${externalDeleteMsg}`);
      return res.json({ ok: true });
    }

    // /activate <email>
    const activateMatch = text.match(/^\/activate\s+(\S+)/i);
    if (activateMatch) {
      const email = cleanEmail(activateMatch[1]);
      const { data: client } = await supabase.from('clients').select('*').eq('email', email).maybeSingle();
      if (!client) { await sendTelegram(fromChatId, `❌ Klientas nerastas: ${email}`); return res.json({ ok: true }); }
      if (!client.metaapi_account_id) { await sendTelegram(fromChatId, `❌ Klientas neturi MetaAPI ID, todėl aktyvuoti CopyFactory nepavyks: ${email}`); return res.json({ ok: true }); }
      const lotSize = parseFloat(client.lot_size) || 0.01;
      const subResult = await putCopyFactorySubscriber(client.metaapi_account_id, client.email, lotSize);
      if (!subResult.ok) { await sendTelegram(fromChatId, `❌ CopyFactory klaida aktyvuojant ${email}: HTTP ${subResult.status}. Supabase NEATNAUJINTA.\n${String(subResult.body || '').slice(0, 500)}`); return res.json({ ok: true }); }
      await supabase.from('clients').update({ active: true }).eq('email', email);
      await sendTelegram(fromChatId, `▶️ Klientas aktyvuotas: ${email}`);
      return res.json({ ok: true });
    }

    // /setlot <email> <lot>
    const setlotMatch = text.match(/^\/setlot\s+(\S+)\s+(\S+)/i);
    if (setlotMatch) {
      const email = cleanEmail(setlotMatch[1]);
      let lotSize;
      try { lotSize = normalizeLotSize(setlotMatch[2]); } catch { await sendTelegram(fromChatId, `❌ Netinkamas lot dydis. Leistinos reikšmės: ${formatAllowedLotSizes()}`); return res.json({ ok: true }); }
      const { data: client } = await supabase.from('clients').select('*').eq('email', email).maybeSingle();
      if (!client) { await sendTelegram(fromChatId, `❌ Klientas nerastas: ${email}`); return res.json({ ok: true }); }
      if (!client.metaapi_account_id) { await sendTelegram(fromChatId, `❌ Klientas neturi MetaAPI ID: ${email}`); return res.json({ ok: true }); }
      if (!client.active) {
        await supabase.from('clients').update({ lot_size: formatLotSize(lotSize) }).eq('email', email);
        await sendTelegram(fromChatId, `✅ Lot dydis pakeistas Supabase: ${email} → ${formatLotSize(lotSize)}\nKlientas neaktyvus — CopyFactory neperkurta. Naujas lot bus pritaikytas per /start.`);
        return res.json({ ok: true });
      }
      const subResult = await putCopyFactorySubscriber(client.metaapi_account_id, client.email, lotSize);
      if (!subResult.ok) { await sendTelegram(fromChatId, `❌ CopyFactory klaida keičiant lot dydį ${email}: HTTP ${subResult.status}. Supabase NEATNAUJINTA.\n${String(subResult.body || '').slice(0, 500)}`); return res.json({ ok: true }); }
      await supabase.from('clients').update({ lot_size: formatLotSize(lotSize) }).eq('email', email);
      await sendTelegram(fromChatId, `✅ Lot dydis pakeistas: ${email} → ${formatLotSize(lotSize)}`);
      return res.json({ ok: true });
    }

    // /setmasterlot <lot>
    const setMasterLotMatch = text.match(/^\/setmasterlot\s+(\S+)/i);
    if (setMasterLotMatch) {
      let newLot;
      try { newLot = normalizeLotSize(setMasterLotMatch[1]); } catch { await sendTelegram(fromChatId, `❌ Netinkamas lot dydis. Leistinos reikšmės: ${formatAllowedLotSizes()}`); return res.json({ ok: true }); }
      state.masterLotSize = newLot;
      await supabase.from('settings').upsert({ key: 'master_lot_size', value: String(newLot) }, { onConflict: 'key' });
      await sendTelegram(fromChatId, `✅ Master lot pakeistas: <b>${formatLotSize(newLot)}</b>\nNauji automatiniai signalai naudos šį lot dydį.`);
      return res.json({ ok: true });
    }

    // /updateallsubs
    if (/^\/updateallsubs$/i.test(text)) {
      const { data: activeClients } = await supabase.from('clients').select('email, metaapi_account_id, lot_size').eq('active', true).not('metaapi_account_id', 'is', null);
      if (!activeClients?.length) { await sendTelegram(fromChatId, 'Nėra aktyvių subscriber\'ių.'); return res.json({ ok: true }); }
      let ok = 0, fail = 0;
      await Promise.all(activeClients.map(async c => {
        const subLot = parseFloat(c.lot_size) || 0.01;
        const result = await putCopyFactorySubscriber(c.metaapi_account_id, c.email, subLot);
        if (result.ok) ok++; else { fail++; console.warn(`/updateallsubs failed for ${c.email}: ${result.status}`); }
      }));
      await sendTelegram(fromChatId, `✅ Subscriber\'iai atnaujinti: <b>${ok}</b> sėkmingai, <b>${fail}</b> klaida.`);
      return res.json({ ok: true });
    }

    // /closeall
    if (/^\/closeall/i.test(text)) {
      const ordersRes = await metaApiFetch(`/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/orders`, { headers: { 'auth-token': process.env.METAAPI_TOKEN } });
      const orders = await ordersRes.json();
      if (!Array.isArray(orders) || orders.length === 0) { await sendTelegram(fromChatId, '📭 Nėra aktyvių pending orderių.'); return res.json({ ok: true }); }
      let cancelled = 0;
      for (const order of orders) {
        try {
          const cancelRes = await metaApiFetch(`/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/trade`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'auth-token': process.env.METAAPI_TOKEN }, body: JSON.stringify({ actionType: 'ORDER_CANCEL', orderId: order.id }) });
          const cancelData = await cancelRes.json();
          if (!cancelRes.ok || !isMetaApiTradeSuccess(cancelData)) { console.error('closeall cancel rejected:', JSON.stringify(cancelData)); continue; }
          await supabase.from('trades').delete().eq('magic', order.magic).eq('status', 'open');
          cancelled++;
        } catch (err) { console.error('closeall cancel error:', err); }
      }
      await sendTelegram(fromChatId, `✅ Atšaukta ${cancelled} iš ${orders.length} pending orderių.`);
      return res.json({ ok: true });
    }

    // /hhhlbreak BUY|SELL [price]
    if (/^\/hhhlbreak\s+(BUY|SELL)/i.test(text)) {
      const match = text.match(/^\/hhhlbreak\s+(BUY|SELL)(?:\s+([\d.]+))?/i);
      const dir = match[1].toUpperCase();
      const accountId = process.env.HHHL_MT5_ACCOUNT_ID;
      if (!accountId) { await sendTelegram(fromChatId, '❌ HHHL_MT5_ACCOUNT_ID not set'); return res.json({ ok: true }); }
      let marketP = match[2] ? parseFloat(match[2]) : null;
      if (!marketP) {
        try {
          const priceRes = await metaApiFetch(`/users/current/accounts/${accountId}/symbols/XAUUSD/current-price`, { headers: { 'auth-token': process.env.METAAPI_TOKEN } });
          const priceData = await priceRes.json();
          marketP = dir === 'BUY' ? priceData?.ask : priceData?.bid;
          if (!marketP) throw new Error('no price');
        } catch { await sendTelegram(fromChatId, '❌ Nepavyko gauti kainos — nurodyk rankiniu: /hhhlbreak BUY 4610.50'); return res.json({ ok: true }); }
      }
      const tpPt = 10, slPt = 10, mul = dir === 'BUY' ? 1 : -1;
      const limP = dir === 'BUY' ? +(marketP - 1).toFixed(2) : +(marketP + 1).toFixed(2);
      const comment = `HHHL_LIN_${dir}`;
      const placeManual = async (actionType, entryP) => {
        const tp = +(entryP + mul * tpPt).toFixed(2), sl = +(entryP - mul * slPt).toFixed(2);
        const { signalId: manSigId, magic: manMagic } = genHhhlSignalId(11, dir);
        const body = { actionType, symbol: 'XAUUSD', volume: 0.01, takeProfit: tp, stopLoss: sl, magic: manMagic, comment };
        if (actionType.includes('LIMIT')) body.openPrice = entryP;
        try {
          const r = await metaApiFetch(`/users/current/accounts/${accountId}/trade`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'auth-token': process.env.METAAPI_TOKEN }, body: JSON.stringify(body) });
          const d = await r.json();
          const ok = !!(d?.orderId || d?.positionId || !d?.error);
          const posId = d?.positionId ? String(d.positionId) : (d?.orderId ? String(d.orderId) : null);
          if (ok) supabase.from('trades').insert({ signal_id: manSigId, magic: manMagic, direction: dir, entry: entryP, sl, tp, src_code: 11, status: 'open', symbol: 'XAUUSD', opened_at: nowVilnius(), position_id: posId }).then(({ error }) => { if (error) console.error('[HHHL manual] Supabase insert error:', error.message); });
          return { ok, tp, sl, positionId: d?.positionId ? String(d.positionId) : null, orderId: d?.orderId ? String(d.orderId) : null };
        } catch { return { ok: false, tp: +(entryP + mul * tpPt).toFixed(2), sl: +(entryP - mul * slPt).toFixed(2), positionId: null, orderId: null }; }
      };
      const mType = dir === 'BUY' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL', lType = dir === 'BUY' ? 'ORDER_TYPE_BUY_LIMIT' : 'ORDER_TYPE_SELL_LIMIT';
      const emoji = dir === 'BUY' ? '🟢' : '🔴';
      const mR = await placeManual(mType, marketP);
      await new Promise(r => setTimeout(r, 200));
      const lR = await placeManual(lType, limP);
      if (mR.positionId && lR.orderId) state.hhhlLinijaOrders.push({ positionId: mR.positionId, orderId: lR.orderId, dir });
      await sendTelegram(fromChatId, `${emoji} <b>HHHL LINIJA MANUAL — ${dir}</b>\n\n${mR.ok?'✅':'❌'} Market @ <b>${marketP}</b>  SL: ${mR.sl} | TP: ${mR.tp}\n${lR.ok?'✅':'❌'} Limit @ <b>${limP}</b>  SL: ${lR.sl} | TP: ${lR.tp}`, { parse_mode: 'HTML' });
      return res.json({ ok: true });
    }

    // /hhhlstr BUY|SELL <price>
    if (/^\/hhhlstr\s+(BUY|SELL)/i.test(text)) {
      const match = text.match(/^\/hhhlstr\s+(BUY|SELL)\s+([\d.]+)/i);
      if (!match) { await sendTelegram(fromChatId, '❌ Formatas: /hhhlstr BUY 4462.50'); return res.json({ ok: true }); }
      const dir = match[1].toUpperCase(), limitP = parseFloat(match[2]);
      if (!limitP) { await sendTelegram(fromChatId, '❌ Netinkama kaina'); return res.json({ ok: true }); }
      const accountId = process.env.HHHL_MT5_ACCOUNT_ID;
      if (!accountId) { await sendTelegram(fromChatId, '❌ HHHL_MT5_ACCOUNT_ID nenustatytas'); return res.json({ ok: true }); }
      const tpPt = 9, slPt = 30, mul = dir === 'BUY' ? 1 : -1;
      const tp = +(limitP + mul * tpPt).toFixed(2), sl = +(limitP - mul * slPt).toFixed(2);
      const emoji = dir === 'BUY' ? '🟢' : '🔴';
      const { signalId: strSigId, magic: strMagic } = genHhhlSignalId(10, dir);
      let strOk = false, strPosId = null;
      try {
        const actionType = dir === 'BUY' ? 'ORDER_TYPE_BUY_LIMIT' : 'ORDER_TYPE_SELL_LIMIT';
        const r = await metaApiFetch(`/users/current/accounts/${accountId}/trade`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'auth-token': process.env.METAAPI_TOKEN }, body: JSON.stringify({ actionType, symbol: 'XAUUSD', volume: 0.01, openPrice: limitP, takeProfit: tp, stopLoss: sl, magic: strMagic, comment: `HHHL_STR_${dir}` }) });
        const d = await r.json(); console.log('[HHHL-STR manual] MetaAPI:', JSON.stringify(d));
        strOk = !!(d?.orderId || d?.positionId || !d?.error);
        strPosId = d?.positionId ? String(d.positionId) : (d?.orderId ? String(d.orderId) : null);
      } catch (err) { console.error('[HHHL-STR manual] error:', err.message); }
      if (strOk) supabase.from('trades').insert({ signal_id: strSigId, magic: strMagic, direction: dir, entry: limitP, sl, tp, src_code: 10, status: 'open', symbol: 'XAUUSD', opened_at: nowVilnius(), position_id: strPosId, tf: '5MIN' }).then(({ error }) => { if (error) console.error('[HHHL-STR manual] Supabase error:', error.message); });
      await sendTelegram(fromChatId, `${emoji} <b>HHHL Structure MANUAL — ${dir}</b>\n\n${strOk?'✅':'❌'} Limit @ <b>${limitP}</b>\nTP: ${tp} (+${tpPt}pt)\nSL: ${sl} (-${slPt}pt)`, { parse_mode: 'HTML' });
      return res.json({ ok: true });
    }

    // /closepositions
    if (/^\/closepositions$/i.test(text)) {
      const posRes = await metaApiFetch(`/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/positions`, { headers: { 'auth-token': process.env.METAAPI_TOKEN } });
      const positions = await posRes.json();
      if (!Array.isArray(positions) || positions.length === 0) { await sendTelegram(fromChatId, '📭 Nėra atvirų pozicijų.'); return res.json({ ok: true }); }
      let closed = 0;
      for (const pos of positions) {
        try {
          const closeRes = await metaApiFetch(`/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/trade`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'auth-token': process.env.METAAPI_TOKEN }, body: JSON.stringify({ actionType: 'POSITION_CLOSE_ID', positionId: pos.id }) });
          const closeData = await closeRes.json();
          if (!closeRes.ok || !isMetaApiTradeSuccess(closeData)) { console.error('closepositions rejected:', JSON.stringify(closeData)); continue; }
          await supabase.from('trades').update({ status: 'closed', result: 'Manual', closed_at: nowVilnius() }).eq('magic', pos.magic).eq('status', 'open');
          closed++;
        } catch (err) { console.error('closepositions error:', err); }
      }
      await sendTelegram(fromChatId, `✅ Uždarytos ${closed} iš ${positions.length} pozicijų.`);
      return res.json({ ok: true });
    }

    // /balance
    if (/^\/balance$/i.test(text)) {
      const { data: clients } = await supabase.from('clients').select('email, metaapi_account_id').eq('active', true).not('metaapi_account_id', 'is', null);
      const accounts = (clients || []).map(c => ({ name: c.email, id: c.metaapi_account_id }));
      if (!accounts.length) { await sendTelegram(fromChatId, '💰 Nėra aktyvių sąskaitų.'); return res.json({ ok: true }); }
      const authHeader = { 'auth-token': process.env.METAAPI_TOKEN };
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const lines = [];
      for (const acc of accounts) {
        try {
          const [infoRes, dealsRes] = await Promise.all([
            metaApiFetch(`/users/current/accounts/${acc.id}/account-information`, { headers: authHeader }),
            metaApiFetch(`/users/current/accounts/${acc.id}/history-deals/time/${todayStart.toISOString()}/${new Date().toISOString()}`, { headers: authHeader }),
          ]);
          const info = await infoRes.json(), deals = await dealsRes.json();
          if (!infoRes.ok || info.error || info.message) { lines.push(`${acc.name}: MetaAPI klaida — ${info.message || info.error || infoRes.status}`); continue; }
          const floating = (info.equity ?? 0) - (info.balance ?? 0);
          const todayProfit = Array.isArray(deals) ? deals.filter(d => d.entryType === 'DEAL_ENTRY_OUT').reduce((s, d) => s + (d.profit || 0), 0) : 0;
          const fmt = (v) => `${v >= 0 ? '+' : ''}$${v.toFixed(2)}`;
          lines.push(`${acc.name}\nBalance: $${Number(info.balance ?? 0).toFixed(2)}\nFloating: ${fmt(floating)}\nŠiandien: ${fmt(todayProfit)}`);
        } catch (e) { lines.push(`${acc.name}: klaida — ${e.message}`); }
      }
      await sendTelegram(fromChatId, '💰 Sąskaitų balansai\n\n' + lines.join('\n\n'));
      return res.json({ ok: true });
    }

    // /signal
    if (/^\/signal\b/i.test(text)) {
      const body = text.replace(/^\/signal\s*/i, '').trim();
      const firstLine = body.split('\n')[0].trim();
      const entryMatch = firstLine.match(/^(?:XAUUSD\s+)?(BUY|SELL)(?:\s+LIMIT)?\s+([\d.]+)/i);
      if (!entryMatch) { await sendTelegram(fromChatId, '⚠️ Formatas:\n/signal BUY 4150\nTP1: 4160\nTP2: 4175\nSL: 4140'); return res.json({ ok: true }); }
      const direction = entryMatch[1].toUpperCase(), entry = parseFloat(entryMatch[2]);
      const isLimit = /\bLIMIT\b/i.test(body);
      const tpMatches = [...body.matchAll(/TP\d*\s*[:\s]\s*([\d.]+)/gi)];
      const tps = tpMatches.map(m => Math.round(parseFloat(m[1])));
      const slMatch = body.match(/SL\s*[:\s]\s*([\d.]+)/i);
      const sl = slMatch ? Math.ceil(parseFloat(slMatch[1])) : null;
      const lotMatch = body.match(/LOT\s*[:\s]\s*([\d.]+)/i);
      const lot = lotMatch ? parseFloat(lotMatch[1]) : state.masterLotSize;
      if (!tps.length || !sl) { await sendTelegram(fromChatId, '⚠️ Trūksta TP arba SL.'); return res.json({ ok: true }); }
      const commentLines = body.split('\n').slice(1).filter(l => l.trim() && !/^TP\d*\s*[:\s]/i.test(l.trim()) && !/^SL[\s:]/i.test(l.trim()) && !/^LOT[\s:]/i.test(l.trim()));
      const comment = commentLines.join('\n').trim() || null;
      const nowMs = Date.now(), dirCode = direction === 'BUY' ? '1' : '2';
      const signalId = `${nowMs}9${dirCode}${String(nowMs).slice(-4)}`;
      const lines = [`XAUUSD ${direction}${isLimit ? ' LIMIT' : ''} ${Math.round(entry)}`];
      tps.forEach((tp, i) => lines.push(tps.length === 1 ? `TP ${tp}` : `TP${i + 1} ${tp}`));
      lines.push(`SL ${sl}`, `LOT ${lot}`, `ID ${signalId}`);
      const webhookText = lines.join('\n');
      const payload = JSON.stringify({ text: webhookText, secret: process.env.WEBHOOK_SECRET, ...(comment ? { comment } : {}) });
      const port = process.env.PORT || 3000;
      const req2 = (await import('http')).default.request({ hostname: 'localhost', port, path: '/webhook/fvg', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, () => {});
      req2.on('error', (e) => console.error('/signal internal webhook error:', e));
      req2.write(payload); req2.end();
      await sendTelegram(fromChatId, `✅ Signalas priimtas:\n<pre>${webhookText}</pre>`, { parse_mode: 'HTML' });
      return res.json({ ok: true });
    }

    // /ema stop|start|skip|status
    const emaCtrlMatch = text.match(/^\/ema\s+(stop|start|skip|status)(?:\s+(buy|sell))?$/i);
    if (emaCtrlMatch) {
      const cmd = emaCtrlMatch[1].toLowerCase(), dir = (emaCtrlMatch[2] || '').toUpperCase();
      if (cmd === 'stop') {
        state.emaAgentPaused = true; saveAgentState();
        await sendTelegram(fromChatId, '⏸ EMA agentas <b>SUSTABDYTAS</b>. Paleisk su /ema start.', { parse_mode: 'HTML' });
      } else if (cmd === 'start') {
        state.emaAgentPaused = false; state.emaSkipUntilCross = null; saveAgentState();
        await sendTelegram(fromChatId, '▶️ EMA agentas <b>PALEISTAS</b>. Laukia signalų.', { parse_mode: 'HTML' });
      } else if (cmd === 'skip') {
        if (!dir || !['BUY', 'SELL'].includes(dir)) { await sendTelegram(fromChatId, '❌ Nurodyk kryptį: /ema skip buy arba /ema skip sell'); }
        else {
          const waitFor = dir === 'BUY' ? 'SELL' : 'BUY';
          state.emaSkipUntilCross = waitFor; saveAgentState();
          await sendTelegram(fromChatId, `⏭ EMA praleis <b>${dir}</b> signalus, laukia <b>${waitFor}</b> kryžiavimosi.`, { parse_mode: 'HTML' });
        }
      } else if (cmd === 'status') {
        const skipTxt = state.emaSkipUntilCross ? `Laukia <b>${state.emaSkipUntilCross}</b> kryžiavimosi` : '—';
        const e = state.tvEmaCache;
        let emaLines = '';
        if (e && e.c15m) {
          const e20_15 = parseFloat(e.ema20_15m), e50_15 = parseFloat(e.ema50_15m);
          const e20_1h = parseFloat(e.ema20_1h), e50_1h = parseFloat(e.ema50_1h);
          const close = parseFloat(e.c15m);
          const bias15 = e20_15 > e50_15 ? '📈 BULL' : '📉 BEAR';
          const bias1h = e20_1h > e50_1h ? '📈 BULL' : '📉 BEAR';
          const aligned = (e20_15 > e50_15 && close > e20_1h && close > e50_1h) ? '🟢 BUY laukimas' : (e20_15 < e50_15 && close < e20_1h && close < e50_1h) ? '🔴 SELL laukimas' : '🟡 Nesutampa — signalo nėra';
          const updAt = e.updated_at ? e.updated_at.slice(11, 16) + ' UTC' : '—';
          emaLines = `\n💰 Close: <b>${close.toFixed(2)}</b>\n15M: EMA20 <b>${e20_15.toFixed(2)}</b> | EMA50 <b>${e50_15.toFixed(2)}</b> → ${bias15}\n1H:  EMA20 <b>${e20_1h.toFixed(2)}</b> | EMA50 <b>${e50_1h.toFixed(2)}</b> → ${bias1h}\n\n${aligned}\n⏱ Duomenys: ${updAt}`;
        } else { emaLines = '\n⚠️ EMA duomenų dar nėra (Pine Script neprisijungęs?)'; }
        await sendTelegram(fromChatId, `📊 <b>EMA Agentas</b>\nSustabdytas: <b>${state.emaAgentPaused ? 'TAIP ⏸' : 'NE ▶️'}</b>\nSkip: <b>${skipTxt}</b>${emaLines}`, { parse_mode: 'HTML' });
      }
      return res.json({ ok: true });
    }

    // /clearema
    if (/^\/clearema$/i.test(text)) {
      state.emaClearPending = true;
      await sendTelegram(fromChatId, '🗑 EMA state išvalymas užklaustas — agentas išvalys tp1/tp3/ride per artimiausią ciklą (iki 15 min).', { parse_mode: 'HTML' });
      return res.json({ ok: true });
    }

    // /rideopennow BUY|SELL <price>
    const rideOpenMatch = text.match(/^\/rideopennow\s+(buy|sell)\s+([\d.]+)$/i);
    if (rideOpenMatch) {
      const dir = rideOpenMatch[1].toUpperCase(), entry = parseFloat(rideOpenMatch[2]);
      if (!entry || entry < 1000 || entry > 10000) { await sendTelegram(fromChatId, '❌ Neteisinga kaina. Naudok: /rideopennow SELL 4380'); return res.json({ ok: true }); }
      state.rideOpenPending = { direction: dir, entry };
      setTimeout(() => { state.rideOpenPending = null; }, 5 * 60 * 1000);
      await sendTelegram(fromChatId, `🏇 Ride ${dir} @ ${entry} užklaustas — agentas atidarys per 30s.`);
      return res.json({ ok: true });
    }

    // /cancelc <signal_id>
    const cancelcMatch = text.match(/^\/cancelc\s+(\S+)/i);
    if (cancelcMatch) {
      const signalId = cancelcMatch[1];
      const { data: tradeRow, error: lookupError } = await supabase.from('trades').select('magic, tg_message_id, tg_chat_id').eq('signal_id', signalId).eq('status', 'open').limit(1).maybeSingle();
      if (lookupError) console.error('Supabase cancelc lookup error:', lookupError);
      const magic = tradeRow?.magic ?? parseInt(signalId.slice(-9));
      const cancelled = await cancelOrderByMagic(magic);
      if (!cancelled?.ok) { await sendTelegram(fromChatId, `❌ Cancel nepavyko — orderis nerastas arba MetaAPI klaida\nID ${signalId}\nMagic ${magic}`); return res.json({ ok: true }); }
      await supabase.from('trades').delete().eq('magic', magic).eq('status', 'open');
      const magicA = (magic + 1) % 2147483647;
      try { const cancelA = await cancelOrderByMagic(magicA); if (cancelA?.ok) await supabase.from('trades').delete().eq('magic', magicA).eq('status', 'open'); } catch (e) { console.error('cancelc Order A attempt failed:', e.message); }
      const channelChatId = tradeRow?.tg_chat_id || process.env.TELEGRAM_CHAT_ID_XAU;
      const channelOptions = tradeRow?.tg_message_id ? { reply_to_message_id: tradeRow.tg_message_id } : {};
      await sendTelegram(channelChatId, `ORDER CANCELED\nID ${signalId}`, channelOptions);
      await sendTelegram(fromChatId, `✅ ORDER CANCELED\nID ${signalId}`);
      return res.json({ ok: true });
    }

    // /modtp <magic> <new_tp>
    const modTpMatch = text.match(/^\/modtp\s+(\d+)\s+([\d.]+)/i);
    if (modTpMatch) {
      const magic = parseInt(modTpMatch[1]), newTp = parseFloat(modTpMatch[2]);
      try {
        const posRes = await metaApiFetch(`/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/positions`, { headers: { 'auth-token': process.env.METAAPI_TOKEN } });
        const positions = await posRes.json();
        const pos = Array.isArray(positions) ? positions.find(p => p.magic === magic) : null;
        if (!pos) { await sendTelegram(fromChatId, `ERR: Pozicija su magic ${magic} nerasta.`); return res.json({ ok: true }); }
        const modRes = await metaApiFetch(`/users/current/accounts/${process.env.METAAPI_MASTER_ACCOUNT_ID}/trade`, { method: 'POST', headers: { 'auth-token': process.env.METAAPI_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ actionType: 'POSITION_MODIFY', positionId: pos.id, takeProfit: newTp }) });
        const modData = await modRes.json();
        const ok = modData?.numericCode === 10009 || modData?.numericCode === 0 || modData?.stringCode === 'TRADE_RETCODE_DONE' || modData?.stringCode === 'ERR_NO_ERROR';
        if (ok) await supabase.from('trades').update({ tp: newTp }).eq('magic', magic).eq('status', 'open');
        await sendTelegram(fromChatId, ok ? `✅ TP pakeistas → ${newTp} | Magic ${magic}` : `ERR: TP keitimas nepavyko\n${JSON.stringify(modData).slice(0, 200)}`);
      } catch (e) { await sendTelegram(fromChatId, `ERR: ${e.message}`); }
      return res.json({ ok: true });
    }

    // /close <signal_id>
    const closeMatch = text.match(/^\/close\s+(\S+)/i);
    if (!closeMatch) return res.json({ ok: true });
    const signalId = closeMatch[1];
    const { data: tradeRow, error: lookupError } = await supabase.from('trades').select('magic, tg_message_id, tg_chat_id, src_code').eq('signal_id', signalId).eq('status', 'open').limit(1).maybeSingle();
    if (lookupError) console.error('Supabase manual close lookup error:', lookupError);
    const magic = tradeRow?.magic ?? parseInt(signalId.slice(-9));
    let exitPrice = null, profit = null;
    const closeResult = await closeTradeByMagic(magic);
    let cancelResult = null;
    if (closeResult?.ok) {
      exitPrice = closeResult.exitPrice; profit = closeResult.profit;
      if (!profit) { const dealResult = await getClosedDealByMagic(magic); exitPrice = dealResult?.exitPrice || exitPrice; profit = dealResult?.profit || null; }
    } else {
      cancelResult = await cancelOrderByMagic(magic);
      if (!cancelResult?.ok) { const dealResult = await getClosedDealByMagic(magic); exitPrice = dealResult?.exitPrice || null; profit = dealResult?.profit || null; }
    }
    if (closeResult?.ok || profit != null) {
      const { error: updateError } = await supabase.from('trades').update({ status: 'closed', result: profit > 0 ? 'Win' : 'Loss', closed_at: nowVilnius(), exit: exitPrice, profit }).eq('magic', magic).eq('status', 'open');
      if (updateError) console.error('Supabase manual close error:', updateError);
    } else if (cancelResult?.ok) {
      const { error: deleteError } = await supabase.from('trades').delete().eq('magic', magic).eq('status', 'open');
      if (deleteError) console.error('Supabase manual close delete error:', deleteError);
    } else {
      await sendTelegram(fromChatId, `ERR: Close/cancel not confirmed by MetaAPI\nID ${signalId}\nMagic ${magic}`);
      return res.json({ ok: false, error: 'Close/cancel not confirmed' });
    }
    const magicA = (magic + 1) % 2147483647;
    try {
      const closeA = await closeTradeByMagic(magicA);
      if (!closeA?.ok) await cancelOrderByMagic(magicA);
      const exitA = closeA?.exitPrice ?? null, profitA = closeA?.profit ?? null;
      await supabase.from('trades').update({ status: 'closed', result: profitA != null ? (profitA > 0 ? 'Win' : 'Loss') : 'Manual', closed_at: nowVilnius(), exit: exitA, profit: profitA }).eq('magic', magicA).eq('status', 'open');
    } catch (e) { console.error('Order A close attempt failed:', e.message); }
    const reply = profit != null ? `✅ Trade closed manually\nID ${signalId}\nExit: ${exitPrice ?? '—'}\nProfit: ${profit}` : `✅ Close signal sent\nID ${signalId}`;
    await sendTelegram(fromChatId, reply);
    const channelMsg = `✅ CLOSE TRADE — Manual\nID ${signalId}\nExit: ${exitPrice ?? '—'}\nProfit: ${profit ?? '—'}`;
    const channelOptions = tradeRow?.tg_message_id ? { reply_to_message_id: tradeRow.tg_message_id } : {};
    const channelChatId = tradeRow?.tg_chat_id || process.env.TELEGRAM_CHAT_ID_XAU;
    await sendTelegram(channelChatId, channelMsg, channelOptions);
    res.json({ ok: true });

  } catch (err) { console.error('POST /telegram-webhook error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

export default router;
