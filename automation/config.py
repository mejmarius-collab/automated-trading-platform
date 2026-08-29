import os
from datetime import datetime
from pathlib import Path

import pytz
from dotenv import load_dotenv

# Load .env from project root (parent of python_agent/)
load_dotenv(Path(__file__).parent.parent / '.env', override=True, encoding='utf-8-sig')

# Demo mode — when True, no live trades are executed via the webhook
DEMO_MODE = os.environ.get('DEMO_MODE', 'true').lower() == 'true'

ANTHROPIC_API_KEY = os.environ.get('ANTHROPIC_API_KEY', '')
TELEGRAM_BOT_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN', '')

# Use TELEGRAM_AGENT_CHAT_ID if set, otherwise fall back to admin chat
TELEGRAM_CHAT_ID = os.environ.get(
    'TELEGRAM_AGENT_CHAT_ID',
    os.environ.get('TELEGRAM_ADMIN_CHAT_ID', '')
)

RAILWAY_SERVER_URL = os.environ.get('RAILWAY_SERVER_URL', '').rstrip('/')
INTERNAL_SERVER_URL = RAILWAY_SERVER_URL
WEBHOOK_SECRET = os.environ.get('WEBHOOK_SECRET', '')
DEFAULT_LOT_SIZE = float(os.environ.get('DEFAULT_LOT_SIZE', '0.10'))

# TwelveData — primary source for XAU/USD spot candles (same key as Node.js service)
TWELVE_DATA_API_KEY = os.environ.get('TWELVE_DATA_API_KEY', '')

# Signal quality gates
MIN_CONFIDENCE = int(os.environ.get('MIN_CONFIDENCE', '70'))  # skip signals below this %
MIN_SL_ATR_MULT = 0.5  # SL must be at least this × ATR away from entry

# Broker MT4/MT5 server timezone vs UTC. Broker laikrodis seka JAV DST:
# GMT+3 kai New York vasaros laiku, GMT+2 žiemą (kad daily candle uždarytų NY 17:00).
# Skaičiuojama dinamiškai kiekvieną kartą — perėjimas spalio/kovo mėn. automatinis.
# BROKER_UTC_OFFSET env kintamasis, jei nustatytas, perrašo automatiką.
def get_broker_utc_offset() -> int:
    override = os.environ.get('BROKER_UTC_OFFSET')
    if override:
        return int(override)
    ny = pytz.timezone('America/New_York')
    return 3 if datetime.now(ny).dst() else 2

# Technical indicator periods
EMA_FAST = 20
EMA_MID = 50
EMA_SLOW = 200
RSI_PERIOD = 14
ATR_PERIOD = 14
SWING_WINDOW = 5   # candles each side for swing high/low detection
LOOKBACK_DAYS = 90 # days of history to fetch
