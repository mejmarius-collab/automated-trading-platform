"""
HHHL Local Agent — polls Railway for HHHL signals, executes limit orders on MT5.
Run locally on Windows (MetaTrader5 library requires same machine as MT5 terminal).

Setup:
  pip install MetaTrader5 requests python-dotenv
  Set in .env: MT5_LOGIN, MT5_PASSWORD, MT5_SERVER, HHHL_LOT
               RAILWAY_SERVER_URL, WEBHOOK_SECRET
Run:
  python agent_hhhl.py
"""

import logging
import os
import sys
import time
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / '.env', override=True, encoding='utf-8-sig')

DEMO_MODE = os.environ.get('DEMO_MODE', 'true').lower() == 'true'

try:
    import MetaTrader5 as mt5
    MT5_AVAILABLE = True
except ImportError:
    MT5_AVAILABLE = False

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
    datefmt='%H:%M:%S',
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger('agent_hhhl')

RAILWAY_URL    = os.environ.get('RAILWAY_SERVER_URL', '').rstrip('/')
WEBHOOK_SECRET = os.environ.get('WEBHOOK_SECRET', '')
MT5_LOGIN      = int(os.environ.get('MT5_LOGIN', 0))
MT5_PASSWORD   = os.environ.get('MT5_PASSWORD', '')
MT5_SERVER     = os.environ.get('MT5_SERVER', '')
HHHL_LOT       = float(os.environ.get('HHHL_LOT', '0.01'))
SYMBOL         = 'XAUUSD'

MAGIC_HHHL    = 20260826
POLL_INTERVAL = 5  # seconds


def _poll() -> list[dict]:
    try:
        r = requests.get(
            f'{RAILWAY_URL}/hhhl-poll',
            params={'secret': WEBHOOK_SECRET},
            timeout=10,
        )
        if r.ok:
            return r.json().get('signals', [])
        logger.warning(f'Poll HTTP {r.status_code}')
    except Exception as exc:
        logger.warning(f'Poll error: {exc}')
    return []


def _ensure_symbol() -> bool:
    if mt5.symbol_info(SYMBOL) is None:
        mt5.symbol_select(SYMBOL, True)
    return mt5.symbol_info(SYMBOL) is not None


def _place_limit(direction: str, price: float, sl: float, tp: float,
                 lot: float, magic: int, tf: str = 'HHHL') -> int | None:
    order_type = mt5.ORDER_TYPE_SELL_LIMIT if direction == 'SELL' else mt5.ORDER_TYPE_BUY_LIMIT
    request = {
        'action':       mt5.TRADE_ACTION_PENDING,
        'symbol':       SYMBOL,
        'volume':       round(lot, 2),
        'type':         order_type,
        'price':        round(price, 2),
        'sl':           round(sl,    2),
        'tp':           round(tp,    2),
        'magic':        magic,
        'comment':      f'{tf}_{direction}',
        'type_time':    mt5.ORDER_TIME_GTC,
        'type_filling': mt5.ORDER_FILLING_RETURN,
    }
    result = mt5.order_send(request)
    if result is None:
        logger.error(f'order_send None: {mt5.last_error()}')
        return None
    if result.retcode == mt5.TRADE_RETCODE_DONE:
        logger.info(f'✅ {direction} LIMIT @ {price:.2f} | SL={sl:.2f} TP={tp:.2f} | ticket={result.order}')
        return result.order
    logger.error(f'❌ retcode={result.retcode} "{result.comment}"')
    return None


def _process_signal(sig: dict) -> None:
    direction = sig.get('dir', '').upper()
    price     = float(sig.get('price', 0))
    sl_pt     = float(sig.get('sl_pt', 20))
    tp_pt     = float(sig.get('tp_pt',  9))
    tf        = sig.get('tf') or 'HHHL'

    if direction not in ('BUY', 'SELL') or price <= 0:
        logger.warning(f'Invalid signal: {sig}')
        return

    if not _ensure_symbol():
        logger.error(f'{SYMBOL} not available in MT5')
        return

    mul = 1 if direction == 'BUY' else -1
    sl  = price - mul * sl_pt
    tp  = price + mul * tp_pt

    logger.info(f'Signal: {direction} @ {price:.2f} | SL={sl:.2f} TP={tp:.2f} | lot={HHHL_LOT}')
    _place_limit(direction, price, sl, tp, HHHL_LOT, MAGIC_HHHL, tf)


def main() -> None:
    if DEMO_MODE:
        logger.info('DEMO_MODE=true — MT5 execution disabled (portfolio/demo mode).')
        return
    if not MT5_AVAILABLE:
        print('pip install MetaTrader5')
        sys.exit(1)
    if not RAILWAY_URL or not WEBHOOK_SECRET:
        print('RAILWAY_SERVER_URL ir WEBHOOK_SECRET turi būti .env faile')
        sys.exit(1)
    if not MT5_LOGIN or not MT5_PASSWORD or not MT5_SERVER:
        print('MT5_LOGIN, MT5_PASSWORD, MT5_SERVER turi būti .env faile')
        sys.exit(1)

    if not mt5.initialize(login=MT5_LOGIN, password=MT5_PASSWORD, server=MT5_SERVER):
        logger.error(f'MT5 init failed: {mt5.last_error()}')
        sys.exit(1)

    acc = mt5.account_info()
    logger.info(f'MT5: {acc.name} | balance={acc.balance:.2f} | server={acc.server}')
    logger.info(f'Polling {RAILWAY_URL}/hhhl-poll every {POLL_INTERVAL}s | lot={HHHL_LOT}')

    try:
        while True:
            try:
                for sig in _poll():
                    logger.info(f'Signal: {sig}')
                    _process_signal(sig)
            except Exception as exc:
                logger.error(f'Loop error: {exc}', exc_info=True)
            time.sleep(POLL_INTERVAL)
    finally:
        mt5.shutdown()


if __name__ == '__main__':
    main()
