import numpy as np
import pandas as pd
from config import EMA_FAST, EMA_MID, EMA_SLOW, RSI_PERIOD, ATR_PERIOD, SWING_WINDOW


def _ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, adjust=False).mean()


def _rsi(close: pd.Series, period: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.where(delta > 0, 0.0).ewm(alpha=1 / period, adjust=False).mean()
    loss = (-delta.where(delta < 0, 0.0)).ewm(alpha=1 / period, adjust=False).mean()
    rs = gain / loss.replace(0, np.nan)
    return (100 - 100 / (1 + rs)).fillna(50)


def _atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    hl = df['High'] - df['Low']
    hc = (df['High'] - df['Close'].shift()).abs()
    lc = (df['Low'] - df['Close'].shift()).abs()
    tr = pd.concat([hl, hc, lc], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / period, adjust=False).mean()


def _pivot_points(high: float, low: float, close: float) -> dict:
    pp = (high + low + close) / 3
    return {
        'PP': round(pp, 2),
        'R1': round(2 * pp - low, 2),
        'R2': round(pp + (high - low), 2),
        'R3': round(high + 2 * (pp - low), 2),
        'S1': round(2 * pp - high, 2),
        'S2': round(pp - (high - low), 2),
        'S3': round(low - 2 * (high - pp), 2),
    }


def _swing_levels(df: pd.DataFrame, window: int = 5) -> tuple[list, list]:
    """Detect swing highs/lows from the last 120 candles."""
    data = df.tail(120)
    w = window * 2 + 1
    rolling_high = data['High'].rolling(w, center=True, min_periods=1).max()
    rolling_low = data['Low'].rolling(w, center=True, min_periods=1).min()

    swing_highs = data['High'][data['High'] == rolling_high].tail(6).values
    swing_lows = data['Low'][data['Low'] == rolling_low].tail(6).values

    resistance = sorted({round(h, 2) for h in swing_highs})
    support = sorted({round(l, 2) for l in swing_lows})
    return resistance, support


def _candle_structure(candle: pd.Series) -> str:
    body = abs(candle['Close'] - candle['Open'])
    total = candle['High'] - candle['Low']
    ratio = body / total if total > 0 else 0
    if candle['Close'] > candle['Open']:
        return f"Bullish {'strong' if ratio > 0.6 else 'doji' if ratio < 0.2 else 'candle'}"
    return f"Bearish {'strong' if ratio > 0.6 else 'doji' if ratio < 0.2 else 'candle'}"



def compute_1h_indicators(df_1h: pd.DataFrame, tv_emas: dict | None = None) -> dict:
    """Momentum confirmation from the 1H timeframe."""
    close = df_1h['Close']
    ema20 = round(float(tv_emas['ema20_1h']), 2) if tv_emas and tv_emas.get('ema20_1h') else round(_ema(close, 20).iloc[-1], 2)
    rsi_val = round(_rsi(close, 14).iloc[-1], 1)
    trend = 'BULLISH' if close.iloc[-1] > ema20 else 'BEARISH'
    rsi_state = 'OVERBOUGHT' if rsi_val > 70 else 'OVERSOLD' if rsi_val < 30 else 'NEUTRAL'
    last_3 = [
        {
            'open': round(row['Open'], 2), 'high': round(row['High'], 2),
            'low': round(row['Low'], 2), 'close': round(row['Close'], 2),
            'structure': _candle_structure(row),
        }
        for _, row in df_1h.tail(3).iterrows()
    ]
    result = {
        'h1_ema20': ema20, 'h1_rsi': rsi_val,
        'h1_rsi_state': rsi_state, 'h1_trend': trend,
        'h1_last_3_candles': last_3,
    }
    if tv_emas and tv_emas.get('ema50_1h'):
        result['h1_ema50'] = round(float(tv_emas['ema50_1h']), 2)
    if tv_emas and tv_emas.get('ema200_1h'):
        result['h1_ema200'] = round(float(tv_emas['ema200_1h']), 2)
    return result


def compute_daily_indicators(df_daily: pd.DataFrame, tv_emas: dict | None = None) -> dict:
    """Macro bias and key levels from the daily timeframe."""
    close = df_daily['Close']
    current = close.iloc[-1]
    ema20 = round(float(tv_emas['ema20_d']), 2) if tv_emas and tv_emas.get('ema20_d') else round(_ema(close, 20).iloc[-1], 2)
    ema50 = round(float(tv_emas['ema50_d']), 2) if tv_emas and tv_emas.get('ema50_d') else round(_ema(close, 50).iloc[-1], 2)
    rsi_val = round(_rsi(close, 14).iloc[-1], 1)
    trend = (
        'STRONG_BULLISH' if current > ema20 > ema50 else
        'STRONG_BEARISH' if current < ema20 < ema50 else
        'BULLISH' if current > ema50 else 'BEARISH'
    )
    rsi_state = 'OVERBOUGHT' if rsi_val > 70 else 'OVERSOLD' if rsi_val < 30 else 'NEUTRAL'
    prev = df_daily.iloc[-1]
    pivots = _pivot_points(prev['High'], prev['Low'], prev['Close'])
    resistance, support = _swing_levels(df_daily, window=3)
    return {
        'daily_ema20': ema20, 'daily_ema50': ema50,
        'daily_rsi': rsi_val, 'daily_rsi_state': rsi_state,
        'daily_trend': trend, 'daily_pivots': pivots,
        'daily_resistance': resistance[-3:], 'daily_support': support[:3],
        'daily_prev_high': round(prev['High'], 2),
        'daily_prev_low': round(prev['Low'], 2),
        'daily_prev_close': round(prev['Close'], 2),
    }


def compute_indicators(df_4h: pd.DataFrame, df_1h: pd.DataFrame | None = None, tv_emas: dict | None = None) -> dict:
    close = df_4h['Close']
    # Use last 1H close as current price — more up-to-date than last completed 4H candle
    current = round((df_1h['Close'].iloc[-1] if df_1h is not None else close.iloc[-1]), 2)

    ema20 = round(float(tv_emas['ema20_4h']), 2) if tv_emas and tv_emas.get('ema20_4h') else round(_ema(close, EMA_FAST).iloc[-1], 2)
    ema50 = round(float(tv_emas['ema50_4h']), 2) if tv_emas and tv_emas.get('ema50_4h') else round(_ema(close, EMA_MID).iloc[-1], 2)
    ema200 = round(float(tv_emas['ema200_4h']), 2) if tv_emas and tv_emas.get('ema200_4h') else round(_ema(close, EMA_SLOW).iloc[-1], 2)
    rsi_val = round(_rsi(close, RSI_PERIOD).iloc[-1], 1)
    atr_val = round(_atr(df_4h, ATR_PERIOD).iloc[-1], 2)

    # Pivot points from the last completed daily session (~6 candles = 24H)
    recent_day = df_4h.tail(6)
    pivots = _pivot_points(
        recent_day['High'].max(),
        recent_day['Low'].min(),
        close.iloc[-1],
    )

    resistance, support = _swing_levels(df_4h, SWING_WINDOW)

    # Last 5 closed 4H candles for price action context
    last_5 = []
    for _, row in df_4h.tail(5).iterrows():
        last_5.append({
            'open': round(row['Open'], 2),
            'high': round(row['High'], 2),
            'low': round(row['Low'], 2),
            'close': round(row['Close'], 2),
            'structure': _candle_structure(row),
        })

    # Trend context
    trend_ema = (
        'STRONG_BULLISH' if current > ema20 > ema50 > ema200 else
        'STRONG_BEARISH' if current < ema20 < ema50 < ema200 else
        'BULLISH' if current > ema50 > ema200 else
        'BEARISH' if current < ema50 < ema200 else
        'NEUTRAL'
    )

    # RSI state
    rsi_state = (
        'OVERBOUGHT' if rsi_val > 70 else
        'OVERSOLD' if rsi_val < 30 else
        'NEUTRAL'
    )

    return {
        'current_price': current,
        'ema20': ema20,
        'ema50': ema50,
        'ema200': ema200,
        'rsi': rsi_val,
        'rsi_state': rsi_state,
        'atr': atr_val,
        'trend': trend_ema,
        'above_ema200': current > ema200,
        'pivots': pivots,
        'resistance': resistance[-5:],
        'support': support[:5],
        'last_5_candles': last_5,
        # Suggested SL/TP based on ATR
        'atr_sl': round(atr_val * 1.5, 2),
        'atr_tp_1r': round(atr_val * 1.5, 2),
        'atr_tp_2r': round(atr_val * 3.0, 2),
    }
