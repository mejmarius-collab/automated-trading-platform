import html
import logging
import math
import os
import time
import requests
from config import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, RAILWAY_SERVER_URL, INTERNAL_SERVER_URL, WEBHOOK_SECRET, DEFAULT_LOT_SIZE

logger = logging.getLogger(__name__)
MAX_GENERATED_TP_LEVELS = 12

def _round_price(price: float) -> int:
    """>.5 rounds up, <=.5 rounds down. 4335.6→4336, 4335.5→4335."""
    return math.ceil(price - 0.5)

def _format_signal_price(price: float) -> str:
    return f"${price:,.2f}"


def _format_webhook_price(price: float) -> str:
    value = float(price)
    if value.is_integer():
        return str(int(value))
    return f"{value:.2f}".rstrip("0").rstrip(".")

def build_split_take_profits(
    action: str,
    entry: float,
    final_tp: float,
    first_tp_pts: float = 10,
) -> list[tuple[str, float]]:
    """Returns exactly 2 TP levels: [TP1 at first_tp_pts, TP2 at final_tp]."""
    direction = 1 if action == "BUY" else -1
    total_distance = direction * (final_tp - entry)
    if not math.isfinite(total_distance) or total_distance <= 0:
        return []

    if total_distance <= first_tp_pts:
        return [("TP1", float(_round_price(final_tp)))]

    tp1 = float(_round_price(entry + direction * first_tp_pts))
    tp2 = float(_round_price(final_tp))
    return [("TP1", tp1), ("TP2", tp2)]

_TELEGRAM_URL = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"


def send_telegram(text: str) -> None:
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        logger.warning("Telegram not configured — skipping notification")
        return
    try:
        resp = requests.post(
            _TELEGRAM_URL,
            json={"chat_id": TELEGRAM_CHAT_ID, "text": text, "parse_mode": "HTML"},
            timeout=10,
        )
        resp.raise_for_status()
    except Exception as exc:
        logger.error(f"Telegram send failed: {exc}")


def _format_news_context(ind: dict) -> str:
    parts = []
    events = ind.get("upcoming_events") or []
    if events:
        ev = events[0]
        h, m = divmod(ev["minutes_away"], 60)
        time_label = f"in {h}h {m}min" if h else f"in {m}min"
        parts.append(f"{ev['event']} {time_label}")
    geo = ind.get("geo_news") or []
    if geo:
        title = geo[0]["title"]
        if len(title) > 65:
            title = title[:62] + "..."
        parts.append(f'"{html.escape(title)}"')
    if not parts:
        return ""
    return "📰 " + " | ".join(parts)













def get_tradingview_emas() -> dict | None:
    """Fetch latest TradingView EMA values from Pine Script webhook. Returns None if unavailable — no fallback."""
    if not RAILWAY_SERVER_URL:
        return None
    try:
        resp = requests.get(f"{RAILWAY_SERVER_URL}/ema-current", timeout=5)
        resp.raise_for_status()
        data = resp.json()
        if not data or not data.get('ema20_1h'):
            raise ValueError("empty or missing ema20_1h")
        return data
    except Exception as exc:
        logger.warning(f"Could not fetch TV EMAs: {exc} — skipping (no TwelveData fallback)")
        return None








def get_open_positions() -> list | None:
    """Returns list of open positions, or None if unavailable."""
    if not RAILWAY_SERVER_URL or not WEBHOOK_SECRET:
        return None
    try:
        resp = requests.get(
            f"{RAILWAY_SERVER_URL}/positions/open",
            headers={"x-webhook-secret": WEBHOOK_SECRET},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        return data if isinstance(data, list) else None
    except Exception as exc:
        logger.warning(f"Could not fetch open positions: {exc}")
        return None






def get_pending_orders() -> list | None:
    """Returns list of pending limit orders, or None if unavailable."""
    if not RAILWAY_SERVER_URL or not WEBHOOK_SECRET:
        return None
    try:
        resp = requests.get(
            f"{RAILWAY_SERVER_URL}/orders/pending",
            headers={"x-webhook-secret": WEBHOOK_SECRET},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        return data if isinstance(data, list) else None
    except Exception as exc:
        logger.warning(f"Could not fetch pending orders: {exc}")
        return None


def _get_master_lot() -> float:
    if not RAILWAY_SERVER_URL or not WEBHOOK_SECRET:
        return DEFAULT_LOT_SIZE
    try:
        resp = requests.get(
            f"{RAILWAY_SERVER_URL}/agent/master-lot",
            headers={"x-webhook-secret": WEBHOOK_SECRET},
            timeout=5,
        )
        resp.raise_for_status()
        lot = float(resp.json().get("lot", DEFAULT_LOT_SIZE))
        return lot if lot > 0 else DEFAULT_LOT_SIZE
    except Exception as exc:
        logger.warning(f"Could not fetch master lot, using default: {exc}")
        return DEFAULT_LOT_SIZE


def get_master_lot() -> float:
    """Public wrapper around _get_master_lot for use by strategy modules."""
    return _get_master_lot()


def get_account_balance() -> float | None:
    """Fetch current MT4 account balance from MetaAPI via server."""
    if not RAILWAY_SERVER_URL or not WEBHOOK_SECRET:
        return None
    try:
        resp = requests.get(
            f"{RAILWAY_SERVER_URL}/api/account-balance",
            headers={"x-webhook-secret": WEBHOOK_SECRET},
            timeout=10,
        )
        resp.raise_for_status()
        bal = float(resp.json().get("balance", 0))
        return bal if bal > 0 else None
    except Exception as exc:
        logger.warning(f"get_account_balance failed: {exc}")
        return None


def calc_lot(sl_pts: float, risk_pct: float = 0.02) -> float:
    """Dynamic lot size: risk_pct% of account balance with sl_pts stop loss.
    XAUUSD: 1 lot = 100oz, 1pt = $100/lot. Falls back to master lot on failure."""
    if sl_pts <= 0:
        return _get_master_lot()
    balance = get_account_balance()
    if not balance:
        logger.warning("calc_lot: balance unavailable — using master lot")
        return _get_master_lot()
    risk_usd = balance * risk_pct
    lot = risk_usd / (sl_pts * 100)
    return max(0.01, math.floor(lot * 100) / 100)


def get_ema_active_ride() -> dict | None:
    """Fetch active EMA ride position from Supabase (used to restore state after restart).
    Retries up to 3 times with 15s delay to handle Railway simultaneous restart."""
    if not RAILWAY_SERVER_URL or not WEBHOOK_SECRET:
        return None
    for attempt in range(3):
        try:
            resp = requests.get(
                f"{RAILWAY_SERVER_URL}/ema/active-ride",
                headers={"x-webhook-secret": WEBHOOK_SECRET},
                timeout=10,
            )
            resp.raise_for_status()
            data = resp.json()
            return data if data else None
        except Exception as exc:
            if attempt < 2:
                logger.warning(f"Could not fetch EMA active ride (attempt {attempt+1}/3): {exc} — retrying in 15s")
                time.sleep(15)
            else:
                logger.warning(f"Could not fetch EMA active ride after 3 attempts: {exc}")
    return None


def get_ema_control() -> dict:
    """Returns EMA agent control state: {paused, skipUntilCross}."""
    if not RAILWAY_SERVER_URL or not WEBHOOK_SECRET:
        return {"paused": False, "skipUntilCross": None}
    try:
        resp = requests.get(
            f"{RAILWAY_SERVER_URL}/ema/control",
            headers={"x-webhook-secret": WEBHOOK_SECRET},
            timeout=5,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception:
        return {"paused": False, "skipUntilCross": None}


def clear_ema_skip() -> None:
    """Clear skipUntilCross after the awaited cross fires."""
    if not RAILWAY_SERVER_URL or not WEBHOOK_SECRET:
        return
    try:
        requests.post(
            f"{RAILWAY_SERVER_URL}/ema/set-control",
            json={"skipUntilCross": None, "secret": WEBHOOK_SECRET},
            timeout=5,
        )
    except Exception as exc:
        logger.warning(f"clear_ema_skip failed: {exc}")


def get_ema_clear_pending() -> bool:
    """Returns True if /clearema was requested — clears the flag server-side."""
    if not RAILWAY_SERVER_URL or not WEBHOOK_SECRET:
        return False
    try:
        resp = requests.get(
            f"{RAILWAY_SERVER_URL}/ema/clear-pending",
            headers={"x-webhook-secret": WEBHOOK_SECRET},
            timeout=5,
        )
        resp.raise_for_status()
        return resp.json().get("clear", False)
    except Exception as exc:
        logger.warning(f"get_ema_clear_pending failed: {exc}")
        return False


def get_rideopennow_pending() -> tuple[str, float] | None:
    """Returns (direction, entry) if /rideopennow was requested, else None."""
    if not RAILWAY_SERVER_URL or not WEBHOOK_SECRET:
        return None
    try:
        resp = requests.get(
            f"{RAILWAY_SERVER_URL}/ema/rideopennow-pending",
            headers={"x-webhook-secret": WEBHOOK_SECRET},
            timeout=5,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("direction") and data.get("entry"):
            return data["direction"], float(data["entry"])
        return None
    except Exception as exc:
        logger.warning(f"get_rideopennow_pending failed: {exc}")
        return None


def get_ema_active_slots() -> list[dict]:
    """Fetch active EMA tp1/tp3 positions from Supabase (src_code=6, used to restore state after restart).
    Retries up to 3 times with 15s delay to handle Railway simultaneous restart."""
    if not RAILWAY_SERVER_URL or not WEBHOOK_SECRET:
        return []
    for attempt in range(3):
        try:
            resp = requests.get(
                f"{RAILWAY_SERVER_URL}/ema/active-slots",
                headers={"x-webhook-secret": WEBHOOK_SECRET},
                timeout=10,
            )
            resp.raise_for_status()
            return resp.json() or []
        except Exception as exc:
            if attempt < 2:
                logger.warning(f"Could not fetch EMA active slots (attempt {attempt+1}/3): {exc} — retrying in 15s")
                time.sleep(15)
            else:
                logger.warning(f"Could not fetch EMA active slots after 3 attempts: {exc}")
    return []


def call_ride_webhook(direction: str, entry: float, src_code: int, lot_fraction: float = 1.0) -> tuple[bool, int | None]:
    """Place market order with no TP/SL for EMA ride position. Returns (ok, magic).
    lot_fraction: multiply master lot by this factor (e.g. 0.5 for half lot)."""
    if not RAILWAY_SERVER_URL or not WEBHOOK_SECRET:
        logger.warning("RAILWAY_SERVER_URL or WEBHOOK_SECRET not set — skipping ride order")
        return False, None

    direction_code = "1" if direction == "BUY" else "2"
    now_ms = int(time.time() * 1000)
    signal_id = f"{now_ms}{int(src_code)}{direction_code}{str(now_ms)[-4:]}"
    magic = int(signal_id[-9:])

    entry_rounded = _round_price(entry)
    lot = _get_master_lot()
    if lot_fraction != 1.0:
        lot = max(0.01, math.floor(lot * lot_fraction * 100) / 100)
    # Unreachable dummy TP — no_tp:true suppresses it on MetaAPI,
    # but Supabase stores it; ±9999 keeps milestone monitor from firing false alerts.
    dummy_tp = entry_rounded + 9999 if direction == "BUY" else max(1, entry_rounded - 9999)

    lines = [
        f"XAUUSD {direction} {entry_rounded}",
        f"TP {dummy_tp}",
        "SL 0",  # 0 is falsy → bufferedSl=null → no SL in MT5
        f"LOT {lot}",
        f"ID {signal_id}",
        "NOSPLIT",
    ]
    payload = {"text": "\n".join(lines), "secret": WEBHOOK_SECRET, "no_tp": True, "no_msg": True}

    try:
        resp = requests.post(f"{RAILWAY_SERVER_URL}/webhook/fvg", json=payload, timeout=10)
        resp.raise_for_status()
        logger.info(f"Ride order: {direction} @ {entry_rounded} | magic={magic} | ID {signal_id}")
        return True, magic
    except Exception as exc:
        logger.error(f"Ride webhook failed: {exc}")
        return False, None


def close_trade_by_magic(magic: int) -> dict | None:
    """Close open MT5 position by magic number. Returns {ok, exitPrice} or None."""
    if not RAILWAY_SERVER_URL or not WEBHOOK_SECRET:
        return None
    try:
        resp = requests.post(
            f"{RAILWAY_SERVER_URL}/api/msb-close-magic",
            json={"magic": magic, "secret": WEBHOOK_SECRET},
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as exc:
        logger.warning(f"close_trade_by_magic({magic}) failed: {exc}")
        return None



def cancel_pending_magic(magic: int) -> bool:
    """Cancel any pending limit order by magic number."""
    if not RAILWAY_SERVER_URL or not WEBHOOK_SECRET:
        return False
    try:
        resp = requests.post(
            f"{RAILWAY_SERVER_URL}/agent/cancel-pending-magic",
            json={"magic": magic, "secret": WEBHOOK_SECRET},
            timeout=10,
        )
        resp.raise_for_status()
        ok = resp.json().get("ok", False)
        logger.info(f"cancel_pending_magic({magic}): ok={ok}")
        return ok
    except Exception as exc:
        logger.warning(f"cancel_pending_magic({magic}) failed: {exc}")
        return False




_ZONE_TYPE_LABELS = {
    "equal_highs":  "Equal Highs",
    "equal_lows":   "Equal Lows",
    "swing_high":   "Swing High",
    "swing_low":    "Swing Low",
    "round_number": "Round Number",
    "PDH":          "Prev Day High",
    "PDL":          "Prev Day Low",
}


def format_liq_signal(signal: dict, zones: dict, current_price: float,
                      tp1_price: float | None = None, tp2_price: float | None = None) -> str:
    """Format liquidity sweep setup for Telegram."""
    decision  = signal["decision"]
    arrow     = "↗" if decision == "BUY" else "↘"
    conf      = signal.get("confidence", "?")
    entry     = signal["entry"]
    sl        = signal["sl"]
    tp        = signal.get("tp_price_display") or signal.get("tp")
    zone      = signal.get("zone_price")
    zone_type = _ZONE_TYPE_LABELS.get(signal.get("zone_type", ""), signal.get("zone_type", "Zone"))
    sl_dist   = abs(entry - sl)
    reasoning = html.escape(signal.get("reasoning") or "")
    sweep_dir = "dips below lows" if decision == "BUY" else "spikes above highs"

    if tp1_price and tp2_price:
        tp1_dist = abs(tp1_price - entry)
        tp2_dist = abs(tp2_price - entry)
        rr2 = f"1:{tp2_dist/sl_dist:.1f}" if sl_dist > 0 else "?"
        tp_line = (
            f"🎯 TP1: <b>{_format_signal_price(tp1_price)}</b> (1:1)"
            f" | TP2: <b>{_format_signal_price(tp2_price)}</b> ({rr2})"
        )
    else:
        tp_dist = abs(tp - entry) if tp else 0
        rr = f"1:{tp_dist/sl_dist:.1f}" if sl_dist > 0 else "?"
        tp_line = f"🎯 TP: <b>{_format_signal_price(tp)}</b> | RR: <b>{rr}</b>"

    lines = [
        f"🎯 <b>LIQ Sweep — {decision} XAUUSD</b> {arrow}",
        f"Zone: <b>{_format_signal_price(zone)}</b> ({zone_type})" if zone else None,
        f"Kaina: <b>{_format_signal_price(current_price)}</b> → tikimasi, kad {sweep_dir}",
        f"Entry LIMIT: <b>{_format_signal_price(entry)}</b>",
        tp_line,
        f"🛑 SL: <b>{_format_signal_price(sl)}</b> ({sl_dist:.0f}pt) | Confidence: <b>{conf}%</b>",
        f"💡 {reasoning}" if reasoning else None,
    ]
    return "\n".join(l for l in lines if l is not None)


def format_liq_low_confidence(signal: dict, current_price: float, threshold: int) -> str:
    """Format low-confidence skip notification for Liq agent."""
    decision  = signal.get("decision", "N/A")
    conf      = signal.get("confidence", "?")
    zone      = signal.get("zone_price")
    zone_type = _ZONE_TYPE_LABELS.get(signal.get("zone_type", ""), signal.get("zone_type", "Zone"))
    lines = [
        "⚠️ <b>Liq agentas — žemas confidence</b>",
        f"Kaina: <b>{_format_signal_price(current_price)}</b>",
        f"Signalas: <b>{decision}</b> | Zone: {_format_signal_price(zone)} ({zone_type})" if zone else f"Signalas: <b>{decision}</b>",
        f"Confidence: <b>{conf}%</b> (min {threshold}%) — praleista",
    ]
    return "\n".join(lines)

# ─── end Liq helpers ───────────────────────────────────────────────────────────

def call_fvg_webhook(signal: dict, silent: bool = False, no_msg: bool = False, startup_confirm: bool = False, tp_override: float | None = None, lot_fraction: float = 1.0, tp_levels_override: list | None = None, use_dynamic_lot: bool = False) -> bool:
    """Send BUY/SELL signal to /webhook/fvg. If startup_confirm=True: server holds for /yes confirmation.
    tp_override: use a single fixed TP instead of build_split_take_profits.
    lot_fraction: multiply master lot by this factor (e.g. 0.5 for half lot).
    tp_levels_override: explicit list of (label, price) TP levels — bypasses build_split_take_profits and tp_override.
    """
    if not RAILWAY_SERVER_URL or not WEBHOOK_SECRET:
        logger.warning("RAILWAY_SERVER_URL or WEBHOOK_SECRET not set — skipping MT4 execution")
        return False

    decision = signal['decision']
    if decision not in ('BUY', 'SELL'):
        return False

    src_code = signal.get('src_code')
    if src_code is not None:
        direction_code = "1" if decision == "BUY" else "2"
        now_ms = int(time.time() * 1000)
        signal_id = f"{now_ms}{int(src_code)}{direction_code}{str(now_ms)[-4:]}"
    else:
        signal_id = str(int(time.time()))
    entry = _round_price(signal['entry'])
    sl = _round_price(signal['sl'])
    if use_dynamic_lot and signal.get('sl') and signal.get('entry'):
        sl_pts = abs(float(signal['entry']) - float(signal['sl']))
        lot = calc_lot(sl_pts)
    else:
        lot = _get_master_lot()
    if lot_fraction != 1.0:
        lot = max(0.01, math.floor(lot * lot_fraction * 100) / 100)
    order_type = str(signal.get('order_type') or 'limit').lower()
    limit_text = " LIMIT" if order_type != "market" else ""
    if tp_levels_override is not None:
        tp_levels = tp_levels_override
    elif tp_override is not None:
        tp_levels = [("TP", float(_round_price(tp_override)))]
    else:
        tp_levels = build_split_take_profits(decision, signal['entry'], signal['tp'])
        if not tp_levels:
            tp_levels = [("TP1", signal['tp'])]

    lines = [f"XAUUSD {decision}{limit_text} {entry}"]
    for label, price in tp_levels:
        effective_label = "TP" if len(tp_levels) == 1 else label
        lines.append(f"{effective_label} {_format_webhook_price(price)}")
    lines.extend([
        f"SL {sl}",
        f"LOT {lot}",
        f"ID {signal_id}",
    ])
    # When tp_levels_override or tp_override is set, agent controls split — tell server not to split further.
    if tp_levels_override is not None or tp_override is not None:
        lines.append("NOSPLIT")
    text = "\n".join(lines)

    payload = {"text": text, "secret": WEBHOOK_SECRET}
    if silent:
        payload["silent"] = True
    if no_msg:
        payload["no_msg"] = True
    if startup_confirm:
        payload["startup_confirm"] = True

    try:
        resp = requests.post(
            f"{RAILWAY_SERVER_URL}/webhook/fvg",
            json=payload,
            timeout=10,
        )
        resp.raise_for_status()
        logger.info(f"MT4 order sent: {decision} XAUUSD @ {entry} | ID {signal_id} | silent={silent}")
        return True
    except Exception as exc:
        logger.error(f"MT4 webhook call failed: {exc}")
        return False


