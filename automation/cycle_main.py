"""
XAUUSD Time Cycle Agent
Runs daily after candle close. Detects ZigZag pivots and sends Telegram alerts:
- When a new pivot is confirmed
- When timer window is active + confirmation candle found -> BUY/SELL hint
- When timer window is active but no confirmation yet -> watch alert (once)
"""
import json
import logging
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

import numpy as np
from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger

import requests as _requests
from config import RAILWAY_SERVER_URL, INTERNAL_SERVER_URL, WEBHOOK_SECRET
from data_fetcher import fetch_ohlcv_d1
from zigzag import find_pivots, compute_zigzag_context, LOOKBACK
from notifier import send_telegram

logger = logging.getLogger(__name__)
UTC = timezone.utc

STATE_FILE = Path(__file__).parent / "cycle_state.json"
TIMER_TOLERANCE   = 3   # ±days — considered "in timer window"
WATCH_ALERT_ONCE  = True  # send "watch" alert only once per timer window


# ── State ─────────────────────────────────────────────────────────────────────
def _load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def _push_state_to_server(state: dict, zz: dict) -> None:
    payload = {
        "secret": WEBHOOK_SECRET,
        "state": {
            "last_pivot_type":   state.get("last_pivot_type"),
            "last_pivot_date":   state.get("last_pivot_date"),
            "last_pivot_price":  zz.get("last_pivot_price"),
            "next_expected":     zz.get("next_expected"),
            "days_ago":          zz.get("last_pivot_days_ago"),
            "avg_cycle":         zz.get("avg_cycle_days"),
            "in_timer_window":   state.get("in_timer_window", False),
            "watch_alert_sent":  state.get("watch_alert_sent", False),
            "confirmed_signal_date": state.get("confirmed_signal_date"),
        }
    }
    base = INTERNAL_SERVER_URL or RAILWAY_SERVER_URL
    try:
        _requests.post(f"{base}/cycle/state", json=payload, timeout=5)
    except Exception as exc:
        logger.warning(f"Failed to push cycle state to server: {exc}")


# ── Confirmation patterns (Daily candles) ─────────────────────────────────────
def _check_confirmation(df_daily, expected: str) -> tuple[bool, str]:
    """
    Check last 2 daily candles for confirmation of expected pivot type.
    expected: 'High' (looking for bearish confirmation) or 'Low' (bullish confirmation).
    Returns (confirmed: bool, reason: str).
    """
    if len(df_daily) < 3:
        return False, ""

    c0 = df_daily.iloc[-3]  # 2 candles ago
    c1 = df_daily.iloc[-2]  # yesterday (last closed)

    if expected == "Low":
        # Looking for bullish confirmation: Higher High break or bullish engulfing
        # Bullish engulfing: yesterday closed above day before's high
        if c1["Close"] > c0["High"]:
            return True, "Bullish engulfing / Higher High break"
        # Strong bullish close: body > 60% of range, closed in upper 30%
        body = c1["Close"] - c1["Open"]
        rng = c1["High"] - c1["Low"]
        if body > 0 and rng > 0 and (body / rng) > 0.6 and (c1["Close"] - c1["Low"]) / rng > 0.7:
            return True, "Strong bullish candle close"

    elif expected == "High":
        # Looking for bearish confirmation
        if c1["Close"] < c0["Low"]:
            return True, "Bearish engulfing / Lower Low break"
        body = c1["Open"] - c1["Close"]
        rng = c1["High"] - c1["Low"]
        if body > 0 and rng > 0 and (body / rng) > 0.6 and (c1["High"] - c1["Close"]) / rng > 0.7:
            return True, "Strong bearish candle close"

    return False, ""


# ── Main cycle check ──────────────────────────────────────────────────────────
def run_cycle_check() -> None:
    logger.info("=== Cycle check starting ===")
    try:
        df_daily, _, _ = fetch_ohlcv_d1()
    except Exception as exc:
        logger.warning(f"Cycle check: data fetch failed: {exc}")
        return

    if df_daily is None or len(df_daily) < 30:
        logger.warning("Cycle check: not enough daily candles")
        return

    pivots = find_pivots(df_daily)
    if len(pivots) < 4:
        logger.warning("Cycle check: not enough pivots detected")
        return

    current_price = float(df_daily["Close"].iloc[-1])
    zz = compute_zigzag_context(df_daily, current_price)
    state = _load_state()

    last_pivot_date  = zz["last_pivot_date"]
    last_pivot_type  = zz["last_pivot_type"]
    last_pivot_price = zz["last_pivot_price"]
    next_expected    = zz["next_expected"]
    avg_cycle        = zz.get("avg_cycle_days") or 20
    days_ago         = zz.get("last_pivot_days_ago", 0)

    # ── 1. New pivot detected ──────────────────────────────────────────────
    prev_pivot_date = state.get("last_pivot_date")
    if last_pivot_date != prev_pivot_date:
        emoji = "🔻" if last_pivot_type == "Low" else "🔺"
        state["last_pivot_date"]  = last_pivot_date
        state["last_pivot_type"]  = last_pivot_type
        state["watch_alert_sent"] = False
        state["confirmed_signal_date"] = None
        _save_state(state)

        send_telegram(
            f"🔄 <b>XAUUSD — Naujas ciklo pivotas</b>\n\n"
            f"{emoji} <b>{last_pivot_type}</b> patvirtintas @ <b>${last_pivot_price:,.2f}</b> ({last_pivot_date})\n"
            f"Laukiamas: <b>{next_expected}</b>\n"
            f"Vidutinis ciklas: {avg_cycle:.0f}d\n\n"
            f"Stebiu patvirtinimo..."
        )
        logger.info(f"New pivot alert sent: {last_pivot_type} @ {last_pivot_date}")
        return

    # ── 2. Timer window check ──────────────────────────────────────────────
    in_timer_window = days_ago >= (avg_cycle - TIMER_TOLERANCE)
    state["in_timer_window"] = in_timer_window
    _push_state_to_server(state, zz)

    if not in_timer_window:
        logger.info(
            f"Cycle: {days_ago}d since last {last_pivot_type} — "
            f"timer window opens in {max(0, avg_cycle - TIMER_TOLERANCE - days_ago):.0f}d"
        )
        return

    # ── 3. Check confirmation ─────────────────────────────────────────────
    confirmed, reason = _check_confirmation(df_daily, next_expected)
    today_str = datetime.now(UTC).strftime("%Y-%m-%d")

    if confirmed:
        # Don't repeat signal on same day
        if state.get("confirmed_signal_date") == today_str:
            logger.info("Cycle: confirmation already sent today")
            return

        state["confirmed_signal_date"] = today_str
        state["watch_alert_sent"] = True
        _save_state(state)

        direction = "BUY" if next_expected == "Low" else "SELL"
        arrow = "🟢" if direction == "BUY" else "🔴"
        send_telegram(
            f"{arrow} <b>XAUUSD — Ciklo signalas</b>\n\n"
            f"Kryptis: <b>{direction}</b>\n"
            f"Patvirtinimas: {reason}\n"
            f"Kaina: <b>${current_price:,.2f}</b>\n\n"
            f"Ciklas: {days_ago}d nuo paskutinio {last_pivot_type} ({last_pivot_date})\n"
            f"Laukiamas: <b>{next_expected}</b> (avg {avg_cycle:.0f}d ciklas)\n\n"
            f"⚠️ Tai ciklo signalas — papildomai patikrink grafikus."
        )
        logger.info(f"Cycle signal sent: {direction} — {reason}")

    else:
        # Send "watch" alert once per timer window
        if state.get("watch_alert_sent"):
            logger.info("Cycle: in timer window, watch alert already sent — waiting for confirmation")
            return

        state["watch_alert_sent"] = True
        _save_state(state)

        emoji = "🔻" if next_expected == "Low" else "🔺"
        send_telegram(
            f"⏰ <b>XAUUSD — Ciklo timer aktyvus</b>\n\n"
            f"Laukiamas: {emoji} <b>{next_expected}</b>\n"
            f"Praėjo: <b>{days_ago}d</b> nuo paskutinio {last_pivot_type} ({last_pivot_date})\n"
            f"Vidutinis ciklas: {avg_cycle:.0f}d\n\n"
            f"Patvirtinimo dar nėra — stebiu kasdien..."
        )
        logger.info(f"Cycle watch alert sent: expecting {next_expected}, day {days_ago} of avg {avg_cycle:.0f}d")


# ── Entry point ───────────────────────────────────────────────────────────────
def main() -> None:
    logger.info("Cycle Agent — starting up")

    scheduler = BlockingScheduler(timezone=UTC)
    # 22:05 UTC — after daily candle close
    scheduler.add_job(
        run_cycle_check,
        CronTrigger(hour=22, minute=5, timezone=UTC),
        id="cycle_check_eod",
        name="Cycle Check EOD",
        max_instances=1,
        misfire_grace_time=3600,
    )
    # 14:45 UTC — 15min before NY open (17:45 Vilnius)
    scheduler.add_job(
        run_cycle_check,
        CronTrigger(hour=14, minute=45, timezone=UTC),
        id="cycle_check_ny",
        name="Cycle Check pre-NY",
        max_instances=1,
        misfire_grace_time=3600,
    )

    logger.info("Cycle scheduler active — checks at 14:45 UTC (pre-NY) and 22:05 UTC (EOD)")
    try:
        scheduler.start()
    except (KeyboardInterrupt, SystemExit):
        logger.info("Cycle agent stopped")


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)],
    )
    main()
