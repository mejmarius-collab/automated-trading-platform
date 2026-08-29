"""
Trendline Break Agent — XAUUSD 15M
Tikrina kas 15min ar kaina kirto trendline'ą. Jei kirto — deda Market + Limit order.
Trendline nustatoma per Telegram: /tl down|up P1 T1 P2 T2 SL TP
"""

import logging
import time
import requests
from datetime import datetime, timezone

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

import config
from config import RAILWAY_SERVER_URL, WEBHOOK_SECRET, TWELVE_DATA_API_KEY
from notifier import send_telegram, calc_lot, _round_price, get_open_positions, get_pending_orders, cancel_pending_magic

logger = logging.getLogger(__name__)

MIN_BREAK_PTS    = 0.5   # min atstumas nuo trendline iki close kad įskaitytų break
SMALL_GAP_PT     = 10.0  # jei gap < šio — 2x limit @ close ± 1pt
MAX_VALID_GAP_PT = 50.0  # jei gap > šio — TL šlaitas per status, breakas ignoruojamas

# market_magic → {limit_magic, tl_id} — stebim kol Market užsidaro
_active_tl_orders: dict[int, dict] = {}

# ── helpers ───────────────────────────────────────────────────────────────────

def _get_trendlines() -> list[dict]:
    try:
        r = requests.get(
            f"{RAILWAY_SERVER_URL}/agent/trendline",
            headers={"x-webhook-secret": WEBHOOK_SECRET},
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()
        return data if isinstance(data, list) else []
    except Exception as e:
        logger.warning(f"Trendline state fetch failed: {e}")
        return []


def _fetch_tv_tl_orders() -> list[dict]:
    try:
        r = requests.get(
            f"{RAILWAY_SERVER_URL}/agent/tv-tl-orders",
            headers={"x-webhook-secret": WEBHOOK_SECRET},
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()
        return data if isinstance(data, list) else []
    except Exception as e:
        logger.warning(f"tv-tl-orders fetch failed: {e}")
        return []


def _remove_tv_tl_order(market_magic: int) -> None:
    try:
        requests.post(
            f"{RAILWAY_SERVER_URL}/agent/tv-tl-orders/remove",
            json={"secret": WEBHOOK_SECRET, "market_magic": market_magic},
            timeout=10,
        )
    except Exception as e:
        logger.warning(f"tv-tl-orders remove failed (magic={market_magic}): {e}")


def _cancel_trendline(tl_id: int) -> None:
    try:
        requests.post(
            f"{RAILWAY_SERVER_URL}/agent/trendline/cancel",
            json={"secret": WEBHOOK_SECRET, "id": tl_id},
            timeout=10,
        )
    except Exception as e:
        logger.warning(f"Trendline cancel failed (id={tl_id}): {e}")


def _fetch_tv_candle() -> dict | None:
    try:
        r = requests.get(
            f"{RAILWAY_SERVER_URL}/agent/trendline/candle",
            headers={"x-webhook-secret": WEBHOOK_SECRET},
            timeout=10,
        )
        if r.status_code == 200:
            d = r.json()
            if d.get("c") and d.get("t"):
                ts_ms = int(d["t"])
                candle_t = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
                return {
                    "t": candle_t,
                    "h": float(d["h"]),
                    "l": float(d["l"]),
                    "c": float(d["c"]),
                }
    except Exception as e:
        logger.warning(f"TV candle fetch failed: {e}")
    return None


def _fetch_twelvedata_candle() -> dict | None:
    try:
        r = requests.get(
            "https://api.twelvedata.com/time_series",
            params={
                "symbol":     "XAU/USD",
                "interval":   "15min",
                "outputsize": 2,
                "timezone":   "UTC",
                "apikey":     TWELVE_DATA_API_KEY,
            },
            timeout=20,
        )
        r.raise_for_status()
        data = r.json()
        if "values" not in data or len(data["values"]) < 2:
            return None
        v = data["values"][1]  # [0]=current forming, [1]=last closed
        logger.info("Trendline: using TwelveData fallback")
        return {
            "t": datetime.strptime(v["datetime"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc),
            "h": float(v["high"]),
            "l": float(v["low"]),
            "c": float(v["close"]),
        }
    except Exception as e:
        logger.warning(f"TwelveData fetch failed: {e}")
    return None


def _fetch_last_15m_candle() -> dict | None:
    # 1. Kas 5 sek tikrina TV iki 1 min
    deadline = time.time() + 60
    time.sleep(5)  # pradinis buffer po žvakės uždarymo
    while time.time() < deadline:
        candle = _fetch_tv_candle()
        if candle:
            return candle
        remaining = deadline - time.time()
        if remaining > 0:
            time.sleep(min(5, remaining))

    # 2. TV per 1 min negavo — bandome TwelveData
    logger.warning("Trendline: TV candle not received in 1min, trying TwelveData")
    candle = _fetch_twelvedata_candle()
    if candle:
        return candle

    # 3. TwelveData irgi nepavyko — paskutinis bandymas TV
    logger.warning("Trendline: TwelveData failed, final TV retry")
    return _fetch_tv_candle()


def _project(t: datetime, t1: datetime, p1: float, t2: datetime, p2: float) -> float:
    slope = (p2 - p1) / (t2 - t1).total_seconds()
    return p1 + slope * (t - t1).total_seconds()


def _place_tl_order(direction: str, entry: float, sl: float, tp: float, is_limit: bool) -> tuple[bool, int | None, str | None]:
    """Place a Market or Limit order via /webhook/fvg (text format, src_code=9)."""
    direction_code = "1" if direction == "BUY" else "2"
    slot_code      = "2" if is_limit else "1"
    now_ms         = int(time.time() * 1000)
    signal_id      = f"{now_ms}9{direction_code}{slot_code}{str(now_ms)[-3:]}"
    magic          = int(signal_id[-9:])

    entry_r = _round_price(entry)
    sl_r    = _round_price(sl)
    tp_r    = _round_price(tp)
    lot     = calc_lot(abs(entry - sl))

    order_label = f"{direction} LIMIT" if is_limit else direction
    lines = [
        f"XAUUSD {order_label} {entry_r}",
        f"TP {tp_r}",
        f"SL {sl_r}",
        f"LOT {lot}",
        f"ID {signal_id}",
        "NOSPLIT",
    ]
    payload = {"text": "\n".join(lines), "secret": WEBHOOK_SECRET}
    label = "LIMIT" if is_limit else "MARKET"
    if config.DEMO_MODE:
        logger.info(f"TL {label} DEMO_MODE — skipping live webhook for {direction} @ {entry_r}")
        return True, magic, signal_id
    try:
        r = requests.post(f"{RAILWAY_SERVER_URL}/webhook/fvg", json=payload, timeout=20)
        r.raise_for_status()
        logger.info(f"TL {label} {direction} @ {entry_r} TP={tp_r} SL={sl_r} lot={lot} magic={magic}")
        return True, magic, signal_id
    except Exception as e:
        logger.error(f"TL {label} order failed: {e}")
        return False, None, None


# ── order monitoring ─────────────────────────────────────────────────────────

def _monitor_active_orders() -> None:
    """Jei Market orderis užsidarė — atšaukia Limit pending (jei dar neužpildytas)."""
    if not _active_tl_orders:
        return

    positions = get_open_positions()
    pending   = get_pending_orders()
    if positions is None:
        return

    open_magics    = {int(p.get("magic", 0)) for p in positions}
    pending_magics = {int(o.get("magic", 0)) for o in (pending or [])}

    for market_magic, info in list(_active_tl_orders.items()):
        limit_magic = info["limit_magic"]
        tl_id       = info["tl_id"]

        if market_magic in open_magics:
            continue  # Market vis dar atviras

        # Market užsidarė
        market_sid = info.get("market_signal_id", str(market_magic))
        limit_sid  = info.get("limit_signal_id",  str(limit_magic))

        send_telegram(
            f"✅ <b>TP hit. TRADE CLOSED</b>\n"
            f"ID {market_sid}"
        )

        if limit_magic in pending_magics:
            ok = cancel_pending_magic(limit_magic)
            if ok:
                send_telegram(
                    f"❌ <b>Order canceled</b> — Market TP hit\n"
                    f"ID {limit_sid}"
                )
            else:
                send_telegram(
                    f"⚠️ <b>Limit atšaukti nepavyko</b> — patikrink rankiniu\n"
                    f"ID {limit_sid}"
                )
            logger.info(f"TL #{tl_id}: market {market_magic} closed → limit {limit_magic} cancelled ok={ok}")
        else:
            logger.info(f"TL #{tl_id}: market {market_magic} closed, limit {limit_magic} not pending (filled or gone)")

        if info.get("from_tv"):
            _remove_tv_tl_order(market_magic)
        del _active_tl_orders[market_magic]


# ── main cycle ────────────────────────────────────────────────────────────────

def _check_one(tl: dict, candle: dict) -> None:
    """Check a single trendline for break and place orders if triggered."""
    direction = tl["direction"]
    t1 = datetime.fromisoformat(tl["t1"].replace("Z", "+00:00"))
    p1 = float(tl["p1"])
    t2 = datetime.fromisoformat(tl["t2"].replace("Z", "+00:00"))
    p2 = float(tl["p2"])
    sl_pt = float(tl["slPt"])
    tp_pt = float(tl["tpPt"])
    tl_id = tl["id"]

    proj  = _project(candle["t"], t1, p1, t2, p2)
    broke = (candle["c"] > proj + MIN_BREAK_PTS) if direction == "down" else (candle["c"] < proj - MIN_BREAK_PTS)
    if not broke:
        return

    order_dir    = "BUY" if direction == "down" else "SELL"
    market_entry = candle["c"]
    limit_entry  = round(proj + 1.0, 2) if order_dir == "BUY" else round(proj - 1.0, 2)
    gap          = abs(market_entry - proj)

    if order_dir == "BUY":
        market_tp = round(market_entry + tp_pt, 2)
        market_sl = round(market_entry - sl_pt, 2)
        limit_tp  = market_tp  # tas pats absoliutus TP lygis
        limit_sl  = round(limit_entry  - sl_pt, 2)
    else:
        market_tp = round(market_entry - tp_pt, 2)
        market_sl = round(market_entry + sl_pt, 2)
        limit_tp  = market_tp  # tas pats absoliutus TP lygis
        limit_sl  = round(limit_entry  + sl_pt, 2)

    ts = candle["t"].strftime("%H:%M UTC")
    logger.info(f"TL #{tl_id} break! {order_dir} @ {market_entry} | proj={proj:.2f} | gap={gap:.1f}pt | [{ts}]")

    if gap > MAX_VALID_GAP_PT:
        # Per didelis gap — TL šlaitas per status, breakas nevalidus
        logger.warning(f"TL #{tl_id} break ignored: gap {gap:.1f}pt > MAX_VALID_GAP_PT ({MAX_VALID_GAP_PT}pt) — TL šlaitas per status")
        send_telegram(
            f"📐 <b>TL #{tl_id} — Ignoruojamas break</b>\n"
            f"Žvakė [{ts}]: C:{market_entry:.2f} | TL projekcija: {proj:.2f} | Gap: {gap:.1f}pt\n"
            f"⚠️ Gap viršija {MAX_VALID_GAP_PT:.0f}pt limitą — TL šlaitas per status, orderių nededama.\n"
            f"TL atšaukta."
        )
        _cancel_trendline(tl_id)
        return

    if gap < SMALL_GAP_PT:
        # Mažas gap (<10pt) — 1x Market, jokio limit
        ok_m, market_magic, market_sid = _place_tl_order(order_dir, market_entry, market_sl, market_tp, is_limit=False)
        send_telegram(
            f"📐 <b>TL #{tl_id} Break — {order_dir} XAUUSD</b>\n"
            f"Žvakė [{ts}]: C:{market_entry:.2f} | TL: {proj:.2f} | Gap: {gap:.2f}pt (<{SMALL_GAP_PT:.0f}pt)\n\n"
            f"{'✅' if ok_m else '❌'} Market {order_dir} @ <b>{market_entry:.2f}</b>\n"
            f"   SL: {market_sl:.2f} | TP: {market_tp:.2f}"
        )
    else:
        # Didesnis gap (10–50pt) — 1x Limit @ TL ± 1pt
        ok_l, _, _ = _place_tl_order(order_dir, limit_entry, limit_sl, limit_tp, is_limit=True)
        send_telegram(
            f"📐 <b>TL #{tl_id} Break — {order_dir} XAUUSD</b>\n"
            f"Žvakė [{ts}]: C:{market_entry:.2f} | TL: {proj:.2f} | Gap: {gap:.2f}pt\n\n"
            f"{'✅' if ok_l else '❌'} Limit {order_dir} @ <b>{limit_entry:.2f}</b>  (retest)\n"
            f"   SL: {limit_sl:.2f} | TP: {limit_tp:.2f}"
        )

    _cancel_trendline(tl_id)
    logger.info(f"TL #{tl_id} deactivated after break.")


def run_trendline_cycle() -> None:
    # Merge TV-triggered orders into monitoring dict (survives only in-process)
    for order in _fetch_tv_tl_orders():
        mm = order.get("market_magic")
        if mm and mm not in _active_tl_orders:
            _active_tl_orders[mm] = {
                "limit_magic":      order.get("limit_magic"),
                "tl_id":            None,
                "market_signal_id": order.get("market_signal_id"),
                "limit_signal_id":  order.get("limit_signal_id"),
                "from_tv":          True,
            }

    _monitor_active_orders()

    trendlines = _get_trendlines()
    if not trendlines:
        return

    candle = _fetch_last_15m_candle()
    if not candle:
        logger.warning("Trendline: candle fetch failed — skip")
        return

    for tl in trendlines:
        try:
            _check_one(tl, candle)
        except Exception as e:
            logger.error(f"TL #{tl.get('id')} check error: {e}")


def _monitor_with_sync() -> None:
    """Sync TV TL orders then monitor — used by the 2-min job."""
    for order in _fetch_tv_tl_orders():
        mm = order.get("market_magic")
        if mm and mm not in _active_tl_orders:
            _active_tl_orders[mm] = {
                "limit_magic":      order.get("limit_magic"),
                "tl_id":            None,
                "market_signal_id": order.get("market_signal_id"),
                "limit_signal_id":  order.get("limit_signal_id"),
                "from_tv":          True,
            }
    _monitor_active_orders()


# ── scheduler ─────────────────────────────────────────────────────────────────

def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logger.info("Trendline agent starting...")

    scheduler = BackgroundScheduler(timezone="UTC")
    scheduler.add_job(
        run_trendline_cycle,
        CronTrigger(minute="0,15,30,45"),  # tiksliai žvakės uždarymas + 5s sleep
        id="trendline-cycle",
        name="Trendline break check",
        max_instances=1,
    )
    scheduler.add_job(
        _monitor_with_sync,
        CronTrigger(minute="*/2"),  # kas 2 min — greitai atšaukia limit kai market užsidaro
        id="tl-monitor",
        name="TL active order monitor",
        max_instances=1,
    )
    scheduler.start()
    logger.info("Trendline agent running (checks at :00, :15, :30, :45 | monitor every 2min)")

    try:
        while True:
            time.sleep(60)
    except (KeyboardInterrupt, SystemExit):
        scheduler.shutdown()
        logger.info("Trendline agent stopped.")
