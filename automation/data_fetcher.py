import logging
import requests
import pandas as pd
from config import LOOKBACK_DAYS, TWELVE_DATA_API_KEY, get_broker_utc_offset

logger = logging.getLogger(__name__)


def _fetch_twelvedata() -> pd.DataFrame | None:
    """XAU/USD spot 1H candles from TwelveData. Returns None on any failure."""
    if not TWELVE_DATA_API_KEY:
        logger.warning("TWELVE_DATA_API_KEY not set — skipping TwelveData")
        return None
    try:
        resp = requests.get(
            'https://api.twelvedata.com/time_series',
            params={
                'symbol': 'XAU/USD',
                'interval': '1h',
                'outputsize': min(5000, LOOKBACK_DAYS * 24),
                'timezone': 'UTC',
                'apikey': TWELVE_DATA_API_KEY,
            },
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get('status') != 'ok' or not data.get('values'):
            logger.warning(f"TwelveData error: {data.get('message', data.get('status'))}")
            return None

        df = pd.DataFrame(data['values'])
        df['datetime'] = pd.to_datetime(df['datetime'], utc=True)
        df = df.set_index('datetime').sort_index()
        df = df.rename(columns={
            'open': 'Open', 'high': 'High', 'low': 'Low', 'close': 'Close',
        })
        for col in ('Open', 'High', 'Low', 'Close'):
            df[col] = df[col].astype(float)
        df['Volume'] = 0.0  # spot metals have no volume on TwelveData

        df = df[['Open', 'High', 'Low', 'Close', 'Volume']].dropna()
        if len(df) < 50:
            logger.warning(f"TwelveData returned too few candles: {len(df)}")
            return None

        logger.info(f"TwelveData: {len(df)} 1H candles (XAU/USD spot)")
        return df
    except Exception as e:
        logger.warning(f"TwelveData fetch failed: {e}")
        return None


def _fetch_twelvedata_interval(interval: str, outputsize: int) -> pd.DataFrame | None:
    """Generic TwelveData fetch for any supported interval."""
    if not TWELVE_DATA_API_KEY:
        return None
    try:
        resp = requests.get(
            'https://api.twelvedata.com/time_series',
            params={
                'symbol': 'XAU/USD', 'interval': interval,
                'outputsize': outputsize, 'timezone': 'UTC',
                'apikey': TWELVE_DATA_API_KEY,
            },
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get('status') != 'ok' or not data.get('values'):
            logger.warning(f"TwelveData {interval} error: {data.get('message', data.get('status'))}")
            return None
        df = pd.DataFrame(data['values'])
        df['datetime'] = pd.to_datetime(df['datetime'], utc=True)
        df = df.set_index('datetime').sort_index()
        df = df.rename(columns={'open': 'Open', 'high': 'High', 'low': 'Low', 'close': 'Close'})
        for col in ('Open', 'High', 'Low', 'Close'):
            df[col] = df[col].astype(float)
        df['Volume'] = 0.0
        return df[['Open', 'High', 'Low', 'Close', 'Volume']].dropna()
    except Exception as e:
        logger.warning(f"TwelveData {interval} fetch failed: {e}")
        return None


def fetch_ohlcv_d1() -> tuple[pd.DataFrame, None, None]:
    """Returns (df_daily, None, None). Used by cycle_main for daily pivot analysis."""
    df_daily = _fetch_twelvedata_interval('1day', 200)
    if df_daily is None or df_daily.empty:
        raise ValueError("TwelveData daily data unavailable")
    df_daily = df_daily.iloc[:-1]  # drop incomplete current day
    logger.info(f"[Daily] {len(df_daily)} candles | price={df_daily['Close'].iloc[-1]:.2f}")
    return df_daily, None, None


def fetch_ohlcv() -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    Returns (df_4h, df_1h). TwelveData XAU/USD spot only — no fallback.
    1H data is resampled to 4H aligned to broker candles.
    """
    df_1h = _fetch_twelvedata()

    if df_1h is None or df_1h.empty:
        raise ValueError("TwelveData unavailable — skipping cycle")

    # Align 4H boundaries to broker candles: GMT+3 broker → grid at 01,05,09... UTC
    df_4h = df_1h.resample('4h', offset=f'{(-get_broker_utc_offset()) % 4}h').agg({
        'Open': 'first',
        'High': 'max',
        'Low': 'min',
        'Close': 'last',
        'Volume': 'sum',
    }).dropna()

    df_4h = df_4h.iloc[:-1]

    logger.info(
        f"[TwelveData XAU/USD] {len(df_4h)} 4H candles | "
        f"latest close = {df_4h['Close'].iloc[-1]:.2f}"
    )
    return df_4h, df_1h
