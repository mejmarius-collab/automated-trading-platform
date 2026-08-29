"""
EMA 20/50 Strategy Agent — 15M entries with 1H confluence. Single 1:1 order.

Signal logic (algorithmic, no Claude):
  SHORT: 15M EMA20 < EMA50
         AND close < 1H EMA20 AND close < 1H EMA50
         AND candle wick touched EMA20 (high >= ema20_15m)
         AND candle closed below EMA20 (close < ema20_15m)
  LONG:  15M EMA20 > EMA50
         AND close > 1H EMA20 AND close > 1H EMA50
         AND candle wick touched EMA20 (low <= ema20_15m)
         AND candle closed above EMA20 (close > ema20_15m)

Filters:
  Session: 06:00–21:00 UTC only (skip Asian session)
  ADX:     adx_1h > 20 (if Pine Script sends adx_1h; skipped otherwise)

SL: EMA50_15m +/- 5pt buffer
TP: risk × 1  (1:1)

GATED: new signal only when previous position is closed.
"""

import json
import logging
import math
import os
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

import pytz
from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger

import config
from notifier import (
    call_fvg_webhook,
    calc_lot,
    clear_ema_skip,
    get_ema_active_slots,
    get_ema_clear_pending,
    get_ema_control,
    get_tradingview_emas,
    send_telegram,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("ema_strategy_agent.log", encoding="utf-8"),
    ],
)
logger = logging.getLogger("ema_strategy_agent")

UTC     = pytz.UTC
VILNIUS = pytz.timezone("Europe/Vilnius")

BASE_DIR   = Path(__file__).resolve().parent
STATE_FILE = BASE_DIR / "ema_strategy_state.json"

SL_BUFFER  = 5.0   # pts above/below EMA50
MAX_SL_PTS = 80.0  # ignore signals with wider SL
SRC_CODE   = 6     # signal ID prefix

_cycle_lock = threading.Lock()
_last_in_session = False


# ── State helpers ─────────────────────────────────────────────────────────────

def _load_state() -> dict:
    try:
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if "tp1" not in state:
            state["tp1"] = None
        return state
    except Exception:
        return {"tp1": None}


def _save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def _restore_tp1_from_supabase() -> None:
    """On startup: restore tp1 state from Supabase if JSON is missing it."""
    state = _load_state()
    if state.get("tp1") is not None:
        logger.info(f"EMA tp1: JSON state present — {state['tp1']['rr']}")
        return

    trades = get_ema_active_slots()
    if not trades:
        logger.info("EMA tp1: no active slots in Supabase — starting fresh")
        return

    for trade in trades:
        try:
            entry = float(trade["entry"])
            sl    = float(trade["sl"])
            tp    = float(trade["tp"])
            risk  = abs(entry - sl)
            if risk <= 0:
                continue
            ratio = abs(tp - entry) / risk
            if abs(ratio - 1.0) < 0.3:
                state["tp1"] = {
                    "dir":       trade["direction"],
                    "entry":     entry,
                    "sl":        sl,
                    "tp":        tp,
                    "risk":      risk,
                    "rr":        "1:1",
                    "lot":       calc_lot(abs(entry - sl)),
                    "opened_at": trade.get("opened_at", ""),
                }
                logger.info(f"EMA tp1 RESTORED from Supabase: {trade['direction']} entry={entry} sl={sl} tp={tp}")
                _save_state(state)
                return
        except Exception as exc:
            logger.warning(f"EMA slot restore failed: {exc} | trade={trade}")


# ── Market / session guards ───────────────────────────────────────────────────

def is_market_open() -> bool:
    now = datetime.now(UTC)
    wd, h = now.weekday(), now.hour
    if wd == 5:
        return False
    if wd == 4 and h >= 21:
        return False
    if wd == 6 and h < 22:
        return False
    if wd == 6 and h == 22 and now.minute < 1:
        return False
    return True


def is_ema_session() -> bool:
    now_utc = datetime.now(UTC)
    return 6 <= now_utc.hour < 21


# ── Signal detection ──────────────────────────────────────────────────────────

def _detect_signal(ema: dict) -> dict | None:
    try:
        e20_15m = float(ema["ema20_15m"])
        e50_15m = float(ema["ema50_15m"])
        e20_1h  = float(ema["ema20_1h"])
        e50_1h  = float(ema["ema50_1h"])
        high    = float(ema["h15m"])
        low     = float(ema["l15m"])
        close   = float(ema["c15m"])
    except (KeyError, TypeError, ValueError):
        logger.warning("EMA data missing OHLC fields — Pine Script not yet updated?")
        return None

    h1_bear = close < e20_1h and close < e50_1h
    h1_bull = close > e20_1h and close > e50_1h

    if (e20_15m < e50_15m and h1_bear and high >= e20_15m and close < e20_15m):
        sl   = e50_15m + SL_BUFFER
        risk = sl - close
        if 0 < risk <= MAX_SL_PTS:
            return {"dir": "SELL", "entry": close, "sl": sl, "risk": risk}

    if (e20_15m > e50_15m and h1_bull and low <= e20_15m and close > e20_15m):
        sl   = e50_15m - SL_BUFFER
        risk = close - sl
        if 0 < risk <= MAX_SL_PTS:
            return {"dir": "BUY", "entry": close, "sl": sl, "risk": risk}

    return None


# ── Position management ───────────────────────────────────────────────────────

def _parse_ts(ts: str) -> datetime | None:
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=UTC)
    except Exception:
        return None


def _check_position_closed(pos: dict, ema: dict) -> str | None:
    ema_time    = _parse_ts(ema.get("updated_at", ""))
    opened_time = _parse_ts(pos.get("opened_at", ""))
    if ema_time and opened_time and ema_time <= opened_time:
        return None

    try:
        high = float(ema["h15m"])
        low  = float(ema["l15m"])
    except (KeyError, TypeError):
        return None

    d  = pos["dir"]
    sl = pos["sl"]
    tp = pos["tp"]

    if d == "SELL":
        sl_hit = high >= sl
        tp_hit = low  <= tp
    else:
        sl_hit = low  <= sl
        tp_hit = high >= tp

    if sl_hit:
        return "SL"
    if tp_hit:
        return "TP"
    return None


def _open_trade(signal: dict) -> dict | None:
    d     = signal["dir"]
    entry = signal["entry"]
    sl    = signal["sl"]
    risk  = signal["risk"]

    if d == "BUY":
        tp = entry + risk
    else:
        tp = entry - risk

    tp    = round(tp, 2)
    entry = math.floor(entry * 2) / 2
    sl    = math.ceil(sl) if d == "SELL" else math.floor(sl)

    lot = calc_lot(abs(entry - sl))

    fvg_signal = {
        "decision":   d,
        "entry":      entry,
        "sl":         sl,
        "tp":         tp,
        "order_type": "market",
        "src_code":   SRC_CODE,
    }

    msg = (
        f"<b>EMA Strategy {'BUY' if d == 'BUY' else 'SELL'} — 1:1</b>\n\n"
        f"Entry: <b>${entry:,.2f}</b>\n"
        f"SL: <b>${sl:,.2f}</b>\n"
        f"TP: <b>${tp:,.2f}</b>\n"
        f"Risk: <b>{risk:.1f}pt</b> | Lot: <b>{lot}</b>"
    )
    send_telegram(msg)

    if config.DEMO_MODE:
        logger.info(f"EMA tp1 DEMO_MODE — skipping live webhook for {d} entry={entry}")
        ok = True
    else:
        ok = call_fvg_webhook(fvg_signal, tp_override=tp, use_dynamic_lot=True)
    if not ok:
        logger.warning(f"EMA tp1: webhook failed for {d} entry={entry}")
        return None

    logger.info(f"EMA tp1 opened: {d} entry={entry} sl={sl} tp={tp} lot={lot} (1:1)")
    return {
        "dir":       d,
        "entry":     entry,
        "sl":        sl,
        "tp":        tp,
        "risk":      risk,
        "rr":        "1:1",
        "lot":       lot,
        "opened_at": datetime.now(UTC).isoformat(),
    }


# ── Supabase reconcile ────────────────────────────────────────────────────────

def _reconcile_with_supabase() -> None:
    state = _load_state()
    pos = state.get("tp1")
    if pos is None:
        return

    active_slots = get_ema_active_slots()
    matching = [
        t for t in active_slots
        if t.get("direction") == pos.get("dir")
        and abs(float(t.get("entry", 0)) - float(pos.get("entry", -999))) < 1.0
    ]
    if not matching:
        logger.info(f"Reconcile: tp1 {pos.get('dir')} @ {pos.get('entry')} not in Supabase — cleared")
        send_telegram(
            f"🔄 <b>EMA 1:1 uždaryta sesijos metu</b>\n"
            f"{pos.get('dir')} @ ${float(pos.get('entry', 0)):,.2f}\n"
            f"(TP arba SL pasiektas kai agentas neveikė)"
        )
        state["tp1"] = None
        _save_state(state)


# ── Main cycle ────────────────────────────────────────────────────────────────

def run_cycle() -> None:
    if not _cycle_lock.acquire(blocking=False):
        logger.info("EMA cycle already running — skipping")
        return
    try:
        _run_cycle_inner()
    finally:
        _cycle_lock.release()


def _run_cycle_inner() -> None:
    global _last_in_session

    control = get_ema_control()
    if control.get("paused"):
        logger.info("EMA agent PAUSED (/ema stop) — skipping cycle")
        return

    if get_ema_clear_pending():
        _save_state({"tp1": None})
        logger.info("EMA state cleared by /clearema command")
        send_telegram("🗑 <b>EMA state išvalytas</b> — tp1 nustatytas į None")

    if not is_market_open():
        _last_in_session = False
        logger.info("Market closed — skipping EMA cycle")
        return

    in_session = is_ema_session()
    if not in_session:
        _last_in_session = False
        logger.info("Outside EMA session (06:00–21:00 UTC) — skipping")
        return

    first_cycle_of_session = not _last_in_session
    _last_in_session = True

    if first_cycle_of_session and _load_state().get("tp1") is not None:
        logger.info("EMA: first cycle of session — reconciling with Supabase")
        _reconcile_with_supabase()

    ema = get_tradingview_emas()
    if not ema:
        logger.info("No EMA data from TradingView yet — skipping")
        return

    if not ema.get("c15m"):
        logger.info("EMA data has no c15m — Pine Script not yet updated, skipping")
        return

    state = _load_state()
    changed = False

    # ── Check existing position ───────────────────────────────────────────────
    pos = state.get("tp1")
    if pos is not None:
        result = _check_position_closed(pos, ema)
        if result:
            pnl_pts = abs(pos["tp"] - pos["entry"]) if result == "TP" else abs(pos["entry"] - pos["sl"])
            pnl_dir = 1 if result == "TP" else -1
            pos_lot = pos.get("lot", 0.1)
            pnl_usd = pnl_pts * pnl_dir * pos_lot * 100
            emoji = "✅" if result == "TP" else "❌"
            send_telegram(
                f"{emoji} <b>EMA 1:1 {result}</b>\n"
                f"{pos['dir']} closed @ ${pos['tp'] if result == 'TP' else pos['sl']:,.2f}\n"
                f"PnL: <b>{pnl_usd:+.0f}$</b> ({pos_lot} lot)"
            )
            logger.info(f"EMA tp1 {result}: {pos['dir']} pnl_pts={pnl_pts * pnl_dir:.1f}")
            state["tp1"] = None
            changed = True

    # ── Look for new signal ───────────────────────────────────────────────────
    signal = _detect_signal(ema)

    skip_cross = control.get("skipUntilCross")
    if skip_cross and signal:
        if signal["dir"] != skip_cross:
            logger.info(f"EMA skip: waiting for {skip_cross} cross, got {signal['dir']} — ignoring")
            signal = None
        else:
            logger.info(f"EMA skip resolved: {skip_cross} cross detected — resuming")
            clear_ema_skip()

    if signal:
        adx_raw = ema.get("adx_1h")
        if adx_raw is not None:
            try:
                adx_val = float(adx_raw)
                if adx_val < 20:
                    logger.info(f"EMA ADX filter: adx_1h={adx_val:.1f} < 20 — signal skipped")
                    signal = None
            except (TypeError, ValueError):
                pass

    if signal:
        logger.info(
            f"EMA signal: {signal['dir']} entry={signal['entry']:.2f} "
            f"sl={signal['sl']:.2f} risk={signal['risk']:.1f}pt"
        )
        if state.get("tp1") is not None:
            logger.info("EMA gated: tp1 active — holding signal until closed")
        else:
            pos = _open_trade(signal)
            if pos:
                state["tp1"] = pos
                changed = True
    else:
        logger.info(
            f"No EMA signal | 15M EMA20={ema.get('ema20_15m')} EMA50={ema.get('ema50_15m')} "
            f"| 1H EMA20={ema.get('ema20_1h')} EMA50={ema.get('ema50_1h')} "
            f"| close={ema.get('c15m')}"
        )

    if changed:
        _save_state(state)


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    if os.environ.get("EMA_STRATEGY_ENABLED", "true").strip().lower() == "false":
        logger.info("EMA_STRATEGY_ENABLED=false — agentas išjungtas")
        return

    logger.info("EMA Strategy agent starting (1:1 only | Session 06-21 UTC | ADX>20 | 1H confluence)")

    _restore_tp1_from_supabase()

    run_cycle()

    scheduler = BlockingScheduler(timezone=UTC)
    scheduler.add_job(
        run_cycle,
        CronTrigger(
            day_of_week="sun,mon,tue,wed,thu,fri",
            hour="*",
            minute="1,16,31,46",
            second=30,
            timezone=UTC,
        ),
        id="ema_strategy_15m",
        name="EMA Strategy 15M",
        max_instances=1,
        misfire_grace_time=180,
    )
    logger.info("EMA Strategy scheduler active — running every 15 min at :01/:16/:31/:46 + 30s")
    try:
        scheduler.start()
    except (KeyboardInterrupt, SystemExit):
        logger.info("EMA Strategy agent stopped")
        scheduler.shutdown(wait=False)


if __name__ == "__main__":
    main()
