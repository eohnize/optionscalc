"""
SwingEdge Options Calculator - Local Data Server v1.2
Adds catalyst, contract IV, and market-levels endpoints.
Runs on http://localhost:8765
"""

from datetime import datetime, timedelta
import math
import os
import statistics
import traceback

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
import pandas as pd

for proxy_key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
    os.environ.pop(proxy_key, None)


app = FastAPI(title="SwingEdge Options Calculator", version="1.3")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
HTML_FILE = os.path.join(SCRIPT_DIR, "options_calculator.html")


def _get_yf():
    import yfinance as yf

    return yf


def _ticker(symbol: str):
    return _get_yf().Ticker(symbol.upper().strip())


@app.get("/")
def root(ticker: str | None = None, price: float | None = None,
         strike: float | None = None, dte: int | None = None,
         iv: float | None = None):
    """
    Serves the Options Calculator UI.
    URL params are handled by client-side JS (window.location.search):
      ?ticker=AAPL  - auto-fetch live data and pre-fill ticker
      &price=185    - pre-fill spot price slider
      &strike=180   - pre-fill strike slider
      &dte=270      - pre-fill days-to-expiry slider
      &iv=32        - pre-fill implied volatility (%)
    When price + iv are both present the live yfinance fetch is skipped.
    """
    if os.path.exists(HTML_FILE):
        with open(HTML_FILE, "r", encoding="utf-8") as f:
            return HTMLResponse(f.read())
    return {
        "name": "SwingEdge Options API",
        "status": "ok",
        "version": app.version,
        "message": "Backend-only deployment. Use /health, /quote/{ticker}, /catalyst/{ticker}, /levels/{ticker}, /option_iv/{ticker}, or /contract_assistant/{ticker}.",
    }


def _norm_cdf(x: float) -> float:
    return (1.0 + math.erf(x / math.sqrt(2.0))) / 2.0


def _bs_price(S: float, K: float, T: float, r: float,
              sigma: float, is_call: bool = True) -> float:
    if T <= 0 or sigma <= 0:
        return max(0.0, S - K) if is_call else max(0.0, K - S)
    d1 = (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    if is_call:
        return S * _norm_cdf(d1) - K * math.exp(-r * T) * _norm_cdf(d2)
    return K * math.exp(-r * T) * _norm_cdf(-d2) - S * _norm_cdf(-d1)


def _calc_iv_from_price(mkt_price: float, S: float, K: float, T: float,
                        r: float = 0.045, is_call: bool = True) -> float | None:
    if T <= 0 or mkt_price <= 0 or S <= 0 or K <= 0:
        return None
    intrinsic = max(0.0, S - K) if is_call else max(0.0, K - S)
    if mkt_price < intrinsic:
        return None
    lo, hi = 0.001, 5.0
    for _ in range(120):
        mid = (lo + hi) / 2.0
        price = _bs_price(S, K, T, r, mid, is_call)
        diff = price - mkt_price
        if abs(diff) < 0.001:
            return mid
        if diff < 0:
            lo = mid
        else:
            hi = mid
    result = (lo + hi) / 2.0
    return result if 0.01 <= result <= 5.0 else None


def _get_last_price(ticker_obj, info: dict | None = None) -> float | None:
    info = info or {}
    price = (info.get("regularMarketPrice") or info.get("currentPrice") or
             info.get("previousClose") or info.get("navPrice"))
    if price is None:
        hist = ticker_obj.history(period="5d")
        if hist.empty:
            return None
        price = float(hist["Close"].iloc[-1])
    return round(float(price), 2)


def _get_previous_close(ticker_obj, info: dict | None = None) -> float | None:
    info = info or {}
    try:
        hist = ticker_obj.history(period="7d")
        if hist is not None and not hist.empty and "Close" in hist.columns:
            closes = [float(value) for value in hist["Close"].dropna().tolist() if value]
            if len(closes) >= 2:
                return round(closes[-2], 2)
            if closes:
                return round(closes[-1], 2)
    except Exception:
        pass

    prev_close = info.get("previousClose") or info.get("regularMarketPreviousClose")
    return round(float(prev_close), 2) if prev_close else None


def _safe_float(value) -> float | None:
    try:
        if value is None:
            return None
        number = float(value)
        if math.isnan(number) or math.isinf(number):
            return None
        return number
    except Exception:
        return None


def _positive_money(value) -> float | None:
    number = _safe_float(value)
    return round(number, 2) if number is not None and number > 0 else None


def _resolve_target_expiry(exps: list[str], expiry: str | None = None, target_dte: int | None = None) -> str | None:
    if not exps:
        return None

    today_dt = datetime.today()

    if expiry:
        exp_clean = expiry[:10]
        if exp_clean in exps:
            return exp_clean
        try:
            target_dt = datetime.strptime(exp_clean, "%Y-%m-%d")
            return min(exps, key=lambda value: abs((datetime.strptime(value, "%Y-%m-%d") - target_dt).days))
        except Exception:
            pass

    if target_dte is not None:
        target_dt = today_dt + timedelta(days=max(int(target_dte), 1))
        return min(exps, key=lambda value: abs((datetime.strptime(value, "%Y-%m-%d") - target_dt).days))

    fallback_dt = today_dt + timedelta(days=30)
    return min(exps, key=lambda value: abs((datetime.strptime(value, "%Y-%m-%d") - fallback_dt).days))


def _prepare_contracts_frame(contracts):
    if contracts is None or getattr(contracts, "empty", True):
        return contracts

    needed = [
        col
        for col in [
            "contractSymbol",
            "strike",
            "impliedVolatility",
            "bid",
            "ask",
            "lastPrice",
            "change",
            "percentChange",
            "openInterest",
            "volume",
        ]
        if col in contracts.columns
    ]
    frame = contracts[needed].copy()
    if "strike" in frame.columns:
        frame = frame[frame["strike"].notna()]
    if "openInterest" in frame.columns:
        frame["openInterest"] = frame["openInterest"].fillna(0)
    if "volume" in frame.columns:
        frame["volume"] = frame["volume"].fillna(0)
    return frame


def _contract_market_snapshot(row, spot: float, previous_spot: float | None, target_exp: str, option_type: str) -> dict:
    is_call = option_type.lower() != "put"
    strike_used = float(row["strike"])
    exp_dt = datetime.strptime(target_exp, "%Y-%m-%d")
    now_dt = datetime.today()
    T = max((exp_dt - now_dt).days, 1) / 365.0
    prev_T = max((exp_dt - (now_dt - timedelta(days=1))).days, 1) / 365.0

    bid = _positive_money(row["bid"]) if "bid" in row.index else None
    ask = _positive_money(row["ask"]) if "ask" in row.index else None
    last = _positive_money(row["lastPrice"]) if "lastPrice" in row.index else None
    change = round(_safe_float(row["change"]), 2) if "change" in row.index and _safe_float(row["change"]) is not None else None
    percent_change = (
        round(_safe_float(row["percentChange"]), 2)
        if "percentChange" in row.index and _safe_float(row["percentChange"]) is not None
        else None
    )
    open_interest = int(_safe_float(row["openInterest"]) or 0) if "openInterest" in row.index else 0
    volume = int(_safe_float(row["volume"]) or 0) if "volume" in row.index else 0

    mark_price = None
    mark_source = None
    if bid is not None and ask is not None:
        mark_price = round((bid + ask) / 2.0, 2)
        mark_source = "mid"
    elif bid is not None:
        mark_price = bid
        mark_source = "bid"
    elif ask is not None:
        mark_price = ask
        mark_source = "ask"
    elif last is not None:
        mark_price = last
        mark_source = "last"

    spread = round(max(ask - bid, 0), 2) if bid is not None and ask is not None else None
    spread_pct = round((spread / mark_price) * 100, 1) if spread is not None and mark_price else None

    current_iv_pct = None
    current_iv_source = "options_chain"
    if mark_price and mark_price > 0:
        iv_raw = _calc_iv_from_price(mark_price, spot, strike_used, T, is_call=is_call)
        if iv_raw is not None:
            current_iv_pct = round(iv_raw * 100, 1)
            current_iv_source = "bs_inversion"

    raw_chain_iv_pct = None
    iv_raw_yf = _safe_float(row["impliedVolatility"]) if "impliedVolatility" in row.index else None
    if iv_raw_yf is not None and iv_raw_yf > 0.01:
        raw_chain_iv_pct = round(min(iv_raw_yf, 2.5) * 100, 1)
        if current_iv_pct is None:
            current_iv_pct = raw_chain_iv_pct
            current_iv_source = "yf_chain"

    previous_contract_close = None
    previous_close_source = None
    if last is not None:
        if change is not None:
            inferred_close = last - change
            if inferred_close > 0:
                previous_contract_close = round(inferred_close, 2)
                previous_close_source = "yahoo_change"
        elif percent_change is not None and percent_change > -99:
            inferred_close = last / (1 + percent_change / 100.0)
            if inferred_close > 0:
                previous_contract_close = round(inferred_close, 2)
                previous_close_source = "yahoo_percent_change"

    previous_contract_iv_pct = None
    if previous_contract_close and previous_spot:
        prev_iv_raw = _calc_iv_from_price(previous_contract_close, previous_spot, strike_used, prev_T, is_call=is_call)
        if prev_iv_raw is not None:
            previous_contract_iv_pct = round(prev_iv_raw * 100, 1)

    return {
        "strike_used": round(strike_used, 2),
        "bid": bid,
        "ask": ask,
        "last": last,
        "mark_price": mark_price,
        "mark_source": mark_source,
        "spread": spread,
        "spread_pct": spread_pct,
        "iv_pct": current_iv_pct,
        "iv_source": current_iv_source,
        "chain_iv_pct": raw_chain_iv_pct,
        "previous_contract_close": previous_contract_close,
        "previous_close_source": previous_close_source,
        "previous_contract_iv_pct": previous_contract_iv_pct,
        "contract_change": change,
        "contract_change_pct": percent_change,
        "open_interest": open_interest,
        "volume": volume,
    }


def _extract_earnings_info(ticker_obj, info: dict | None = None) -> tuple[str | None, int | None]:
    info = info or {}
    earnings_date = None
    days_to_earnings = None

    try:
        cal = ticker_obj.calendar
        if cal is not None:
            if hasattr(cal, "get"):
                ed = cal.get("Earnings Date")
                if ed is not None:
                    earnings_date = str(ed[0])[:10] if hasattr(ed, "__iter__") and not isinstance(ed, str) else str(ed)[:10]
            elif hasattr(cal, "loc"):
                ed = cal.loc["Earnings Date"] if "Earnings Date" in cal.index else None
                if ed is not None:
                    earnings_date = str(ed.iloc[0])[:10] if hasattr(ed, "iloc") else str(ed)[:10]
        if earnings_date:
            ed_dt = datetime.strptime(earnings_date[:10], "%Y-%m-%d")
            days_to_earnings = (ed_dt - datetime.today()).days
            if days_to_earnings < -3:
                earnings_date = None
                days_to_earnings = None
    except Exception:
        pass

    if earnings_date is None:
        try:
            ets = info.get("earningsTimestamp") or info.get("earningsTimestampStart")
            if ets:
                ed_dt = datetime.fromtimestamp(int(ets))
                days_to_earnings = (ed_dt - datetime.today()).days
                if days_to_earnings >= -3:
                    earnings_date = ed_dt.strftime("%Y-%m-%d")
                else:
                    earnings_date = None
                    days_to_earnings = None
        except Exception:
            pass

    return earnings_date, days_to_earnings


def _select_reference_expiry(expiries: list[str], days_to_earnings: int | None = None) -> tuple[str | None, int | None]:
    if not expiries:
        return None, None

    today = datetime.today()
    exp_dts = [(e, (datetime.strptime(e, "%Y-%m-%d") - today).days) for e in expiries]
    exp_dts = [(e, d) for e, d in exp_dts if d >= 1]
    if not exp_dts:
        return None, None

    if days_to_earnings and days_to_earnings > 0:
        after = [(e, d) for e, d in exp_dts if d >= days_to_earnings]
        return after[0] if after else exp_dts[0]

    decent = [(e, d) for e, d in exp_dts if d >= 14]
    return decent[0] if decent else exp_dts[0]


def _candidate_expiries(expiries: list[str], days_to_earnings: int | None = None, max_count: int = 6) -> list[tuple[str, int]]:
    if not expiries:
        return []

    today = datetime.today()
    exp_dts = [(e, (datetime.strptime(e, "%Y-%m-%d") - today).days) for e in expiries]
    exp_dts = [(e, d) for e, d in exp_dts if d >= 1]
    if not exp_dts:
        return []

    _, ref_dte = _select_reference_expiry(expiries, days_to_earnings)
    if ref_dte is None:
        return exp_dts[:max_count]

    ranked = sorted(exp_dts, key=lambda item: (abs(item[1] - ref_dte), item[1]))
    return ranked[:max_count]


def get_atm_iv(ticker_obj, spot: float) -> tuple[float | None, str]:
    try:
        exps = ticker_obj.options
        if not exps:
            return None, "no_chain"
        today = datetime.today()
        target = today + timedelta(days=30)
        best_exp = min(exps, key=lambda e: abs((datetime.strptime(e, "%Y-%m-%d") - target).days))
        chain = ticker_obj.option_chain(best_exp)
        frames = []
        for leg in (chain.calls, chain.puts):
            if leg is None or leg.empty or "strike" not in leg.columns or "impliedVolatility" not in leg.columns:
                continue
            frame = leg[["strike", "impliedVolatility"]].dropna().copy()
            frame = frame[(frame["impliedVolatility"] >= 0.05) & (frame["impliedVolatility"] <= 2.5)]
            if not frame.empty:
                frames.append(frame)

        if not frames:
            return None, "no_chain"

        iv_frame = frames[0] if len(frames) == 1 else pd.concat(frames, ignore_index=True)
        iv_frame["dist"] = abs(iv_frame["strike"] - spot)
        sample = iv_frame.nsmallest(6, "dist")["impliedVolatility"].tolist()
        if not sample:
            return None, "no_chain"
        atm_iv = min(float(statistics.median(sample)), 2.5)
        return round(atm_iv * 100, 1), "options_chain"
    except Exception:
        return None, "no_chain"


def get_hv30(ticker_obj) -> float | None:
    try:
        hist = ticker_obj.history(period="3mo")
        if hist.empty or len(hist) < 22:
            return None
        closes = [float(x) for x in hist["Close"].dropna().tolist() if x and float(x) > 0]
        if len(closes) < 22:
            return None

        log_ret = [math.log(curr / prev) for prev, curr in zip(closes, closes[1:]) if prev > 0 and curr > 0]
        if len(log_ret) < 21:
            return None

        sample = log_ret[-21:]
        mean = sum(sample) / len(sample)
        variance = sum((value - mean) ** 2 for value in sample) / (len(sample) - 1)
        hv = math.sqrt(variance) * math.sqrt(252) * 100
        return round(hv, 1)
    except Exception:
        return None


def _serialize_wall_rows(df, side: str, spot: float, top_n: int = 3) -> list[dict]:
    if df is None or df.empty or "strike" not in df.columns or "openInterest" not in df.columns:
        return []

    walls = df.copy()
    walls["openInterest"] = walls["openInterest"].fillna(0)
    walls["volume"] = walls["volume"].fillna(0) if "volume" in walls.columns else 0
    walls = walls[(walls["strike"] >= spot * 0.7) & (walls["strike"] <= spot * 1.3)]
    walls = walls[walls["openInterest"] > 0]
    if walls.empty:
        return []

    walls["score"] = walls["openInterest"] + walls["volume"] * 0.35
    best = walls.nlargest(top_n, "score")
    rows = []
    for _, row in best.iterrows():
        strike = float(row["strike"])
        volume = float(row["volume"])
        rows.append({
            "side": side,
            "strike": round(strike, 2),
            "open_interest": int(row["openInterest"]),
            "volume": int(volume) if volume >= 0 else 0,
            "pct_from_spot": round((strike / spot - 1.0) * 100.0, 2),
        })
    return rows


def _collect_wall_candidates(ticker_obj, expiries: list[tuple[str, int]], spot: float) -> tuple[list[dict], list[dict]]:
    call_buckets: dict[float, dict] = {}
    put_buckets: dict[float, dict] = {}

    for expiry, dte in expiries:
        try:
            chain = ticker_obj.option_chain(expiry)
        except Exception:
            continue

        expiry_weight = 1.0 / (1.0 + max(dte - 1, 0) / 35.0)
        for df, side, buckets in ((chain.calls, "call", call_buckets), (chain.puts, "put", put_buckets)):
            if df is None or df.empty or "strike" not in df.columns:
                continue

            frame = df.copy()
            if "openInterest" not in frame.columns and "volume" not in frame.columns:
                continue

            frame["openInterest"] = frame["openInterest"].fillna(0) if "openInterest" in frame.columns else 0
            frame["volume"] = frame["volume"].fillna(0) if "volume" in frame.columns else 0
            frame = frame[(frame["strike"] >= spot * 0.72) & (frame["strike"] <= spot * 1.28)]
            frame = frame[(frame["openInterest"] > 0) | (frame["volume"] > 0)]
            if frame.empty:
                continue

            for _, row in frame.iterrows():
                strike = round(float(row["strike"]), 2)
                bucket = buckets.setdefault(strike, {
                    "side": side,
                    "strike": strike,
                    "open_interest": 0.0,
                    "volume": 0.0,
                    "weighted_score": 0.0,
                    "expiries": set(),
                })
                oi = float(row["openInterest"])
                volume = float(row["volume"])
                bucket["open_interest"] += oi
                bucket["volume"] += volume
                bucket["weighted_score"] += (oi + volume * 0.35) * expiry_weight
                bucket["expiries"].add(expiry)

    def finalize(buckets: dict[float, dict], side: str) -> list[dict]:
        rows = []
        for strike, bucket in buckets.items():
            distance_pct = abs(strike / spot - 1.0)
            if side == "call" and strike < spot:
                continue
            if side == "put" and strike > spot:
                continue
            proximity_bonus = 1.0 / (1.0 + distance_pct * 12.0)
            rows.append({
                "side": side,
                "strike": strike,
                "open_interest": int(round(bucket["open_interest"])),
                "volume": int(round(bucket["volume"])),
                "pct_from_spot": round((strike / spot - 1.0) * 100.0, 2),
                "weighted_score": bucket["weighted_score"] * proximity_bonus,
                "expiry_count": len(bucket["expiries"]),
            })
        rows.sort(key=lambda item: item["weighted_score"], reverse=True)
        return rows

    return finalize(call_buckets, "call"), finalize(put_buckets, "put")


def _pick_wall_rows(rows: list[dict], top_n: int = 3) -> list[dict]:
    selected: list[dict] = []
    for row in rows:
        if any(abs(row["strike"] - existing["strike"]) <= max(1.0, existing["strike"] * 0.01) for existing in selected):
            continue
        selected.append({
            "side": row["side"],
            "strike": round(float(row["strike"]), 2),
            "open_interest": int(row["open_interest"]),
            "volume": int(row["volume"]),
            "pct_from_spot": round(float(row["pct_from_spot"]), 2),
            "expiry_count": int(row.get("expiry_count", 1)),
        })
        if len(selected) >= top_n:
            break
    return selected


def _extract_market_levels(ticker_obj, price: float, days_to_earnings: int | None = None) -> dict:
    hist = ticker_obj.history(period="1y")
    moving_averages = {}
    previous_session = {"high": None, "low": None, "close": None}
    atr_14 = None

    if hist is not None and not hist.empty:
        close = hist["Close"].dropna()
        if len(close) >= 8:
            moving_averages["ema_8"] = round(float(close.ewm(span=8, adjust=False).mean().iloc[-1]), 2)
        if len(close) >= 21:
            moving_averages["ema_21"] = round(float(close.ewm(span=21, adjust=False).mean().iloc[-1]), 2)
            moving_averages["sma_20"] = round(float(close.tail(20).mean()), 2)
        if len(close) >= 50:
            moving_averages["sma_50"] = round(float(close.tail(50).mean()), 2)
        if len(close) >= 200:
            moving_averages["sma_200"] = round(float(close.tail(200).mean()), 2)

        session = hist.dropna(subset=["High", "Low", "Close"]).tail(2)
        if not session.empty:
            ref = session.iloc[-2] if len(session) >= 2 else session.iloc[-1]
            previous_session = {
                "high": round(float(ref["High"]), 2),
                "low": round(float(ref["Low"]), 2),
                "close": round(float(ref["Close"]), 2),
            }

        tr_frame = hist.dropna(subset=["High", "Low", "Close"]).copy()
        if len(tr_frame) >= 15:
            prev_close = tr_frame["Close"].shift(1)
            true_range = pd.concat(
                [
                    tr_frame["High"] - tr_frame["Low"],
                    (tr_frame["High"] - prev_close).abs(),
                    (tr_frame["Low"] - prev_close).abs(),
                ],
                axis=1,
            ).max(axis=1)
            atr_series = true_range.rolling(14).mean().dropna()
            if not atr_series.empty:
                atr_14 = round(float(atr_series.iloc[-1]), 2)

    all_expiries = ticker_obj.options
    reference_expiry, reference_dte = _select_reference_expiry(all_expiries, days_to_earnings)
    call_walls = []
    put_walls = []
    source_expiries: list[str] = []
    if reference_expiry:
        try:
            candidates = _candidate_expiries(all_expiries, days_to_earnings, max_count=6)
            source_expiries = [expiry for expiry, _ in candidates]
            call_candidates, put_candidates = _collect_wall_candidates(ticker_obj, candidates, price)
            call_walls = _pick_wall_rows(call_candidates, top_n=3)
            put_walls = _pick_wall_rows(put_candidates, top_n=3)
        except Exception:
            pass

    return {
        "reference_expiry": reference_expiry,
        "reference_dte": reference_dte,
        "source_expiries": source_expiries,
        "call_walls": call_walls,
        "put_walls": put_walls,
        "moving_averages": moving_averages,
        "previous_session": previous_session,
        "atr_14": atr_14,
    }


@app.get("/quote/{ticker}")
def quote(ticker: str):
    try:
        t = _ticker(ticker)
        info = t.info
        price = _get_last_price(t, info)
        if price is None:
            return JSONResponse({"error": f"No data for {ticker.upper()}"}, 400)
        iv_pct, iv_source = get_atm_iv(t, price)
        if iv_pct is None:
            iv_pct = get_hv30(t)
            iv_source = "hv30_fallback"
        hv30 = get_hv30(t)
        return {
            "ticker": ticker.upper(),
            "price": price,
            "iv_pct": iv_pct,
            "iv_source": iv_source,
            "company": info.get("longName", ticker.upper()),
            "sector": info.get("sector", "-"),
            "hv30": hv30,
            "52w_high": round(float(info.get("fiftyTwoWeekHigh", 0) or 0), 2),
            "52w_low": round(float(info.get("fiftyTwoWeekLow", 0) or 0), 2),
        }
    except Exception as e:
        traceback.print_exc()
        return JSONResponse({"error": str(e)}, 500)


@app.get("/catalyst/{ticker}")
def catalyst(ticker: str):
    try:
        t = _ticker(ticker)
        info = t.info
        price = _get_last_price(t, info)
        if price is None:
            return JSONResponse({"error": "No price data"}, 400)

        earnings_date, days_to_earnings = _extract_earnings_info(t, info)

        implied_move_pct = None
        straddle_expiry = None
        straddle_dte = None
        try:
            target_exp, target_dte = _select_reference_expiry(t.options, days_to_earnings)
            if target_exp:
                chain = t.option_chain(target_exp)
                straddle_expiry = target_exp
                straddle_dte = target_dte

                calls = chain.calls[["strike", "lastPrice", "bid", "ask"]].dropna()
                puts = chain.puts[["strike", "lastPrice", "bid", "ask"]].dropna()

                calls["dist"] = abs(calls["strike"] - price)
                puts["dist"] = abs(puts["strike"] - price)
                atm_call_row = calls.nsmallest(1, "dist").iloc[0]
                atm_put_row = puts.nsmallest(1, "dist").iloc[0]

                def mid(row):
                    bid, ask = row.get("bid", 0), row.get("ask", 0)
                    if bid > 0 and ask > 0:
                        return (bid + ask) / 2
                    return row.get("lastPrice", 0)

                straddle_price = mid(atm_call_row) + mid(atm_put_row)
                if straddle_price > 0 and price > 0:
                    implied_move_pct = round(straddle_price / price * 100, 1)
        except Exception:
            pass

        return {
            "ticker": ticker.upper(),
            "price": price,
            "earnings_date": earnings_date,
            "days_to_earnings": days_to_earnings,
            "implied_move_pct": implied_move_pct,
            "straddle_expiry": straddle_expiry,
            "straddle_dte": straddle_dte,
            "company": info.get("longName", ticker.upper()),
        }
    except Exception as e:
        traceback.print_exc()
        return JSONResponse({"error": str(e)}, 500)


@app.get("/levels/{ticker}")
def levels(ticker: str):
    try:
        t = _ticker(ticker)
        info = t.info
        price = _get_last_price(t, info)
        if price is None:
            return JSONResponse({"error": f"No price data for {ticker.upper()}"}, 400)

        earnings_date, days_to_earnings = _extract_earnings_info(t, info)
        data = _extract_market_levels(t, price, days_to_earnings)
        return {
            "ticker": ticker.upper(),
            "price": price,
            "earnings_date": earnings_date,
            "days_to_earnings": days_to_earnings,
            "reference_expiry": data["reference_expiry"],
            "reference_dte": data["reference_dte"],
            "source_expiries": data["source_expiries"],
            "call_walls": data["call_walls"],
            "put_walls": data["put_walls"],
            "moving_averages": data["moving_averages"],
            "previous_session": data["previous_session"],
        }
    except Exception as e:
        traceback.print_exc()
        return JSONResponse({"error": str(e)}, 500)


@app.get("/option_iv/{ticker}")
def option_iv(
    ticker: str,
    strike: float | None = None,
    expiry: str | None = None,
    target_dte: int | None = None,
    option_type: str = "call",
):
    try:
        t = _ticker(ticker)
        info = t.info
        spot = _get_last_price(t, info)
        if spot is None:
            return JSONResponse({"error": f"No price data for {ticker.upper()}"}, 400)
        previous_spot = _get_previous_close(t, info) or spot

        exps = t.options
        if not exps:
            return JSONResponse({"error": "No options chain available"}, 400)

        target_exp = _resolve_target_expiry(exps, expiry=expiry, target_dte=target_dte)
        if target_exp is None:
            return JSONResponse({"error": "Could not resolve target expiry"}, 400)

        chain = t.option_chain(target_exp)
        contracts = _prepare_contracts_frame(chain.calls if option_type.lower() != "put" else chain.puts)
        if contracts is None or contracts.empty:
            contracts = contracts.iloc[0:0] if contracts is not None else None

        if contracts is None or contracts.empty:
            iv_pct, _ = get_atm_iv(t, spot)
            if iv_pct is None:
                iv_pct = get_hv30(t)
            return {
                "ticker": ticker.upper(),
                "iv_pct": iv_pct,
                "iv_source": "atm_fallback",
                "atm_iv_pct": iv_pct,
                "chain_iv_pct": None,
                "previous_contract_iv_pct": None,
                "previous_contract_close": None,
                "previous_close_source": None,
                "bid": None,
                "ask": None,
                "last": None,
                "mark_price": None,
                "mark_source": None,
                "spread": None,
                "spread_pct": None,
                "contract_change": None,
                "contract_change_pct": None,
                "open_interest": 0,
                "volume": 0,
                "expiry_used": target_exp,
            }

        ref_strike = strike if strike is not None else spot
        contracts["dist"] = abs(contracts["strike"] - ref_strike)
        row = contracts.nsmallest(1, "dist").iloc[0]
        snapshot = _contract_market_snapshot(row, spot, previous_spot, target_exp, option_type)
        if snapshot["iv_pct"] is None:
            fallback_iv, _ = get_atm_iv(t, spot)
            snapshot["iv_pct"] = fallback_iv
            snapshot["iv_source"] = "atm_fallback"
        atm_iv_pct, _ = get_atm_iv(t, spot)

        return {
            "ticker": ticker.upper(),
            "option_type": option_type.lower(),
            "spot_price": spot,
            "previous_spot_close": previous_spot,
            "atm_iv_pct": atm_iv_pct,
            "expiry_used": target_exp,
            **snapshot,
        }
    except Exception as e:
        traceback.print_exc()
        return JSONResponse({"error": str(e)}, 500)


@app.get("/contract_assistant/{ticker}")
def contract_assistant(
    ticker: str,
    min_dte: int = 180,
    max_dte: int = 270,
    max_otm_pct: float = 10.0,
    option_type: str = "call",
    max_results: int = 3,
):
    try:
        t = _ticker(ticker)
        info = t.info
        spot = _get_last_price(t, info)
        if spot is None:
            return JSONResponse({"error": f"No price data for {ticker.upper()}"}, 400)
        previous_spot = _get_previous_close(t, info) or spot

        exps = t.options
        if not exps:
            return JSONResponse({"error": "No options chain available"}, 400)

        min_dte = max(int(min_dte), 1)
        max_dte = max(int(max_dte), min_dte)
        max_otm_pct = max(float(max_otm_pct), 0.0)
        max_results = max(int(max_results), 1)
        side = "put" if option_type.lower() == "put" else "call"

        today_dt = datetime.today()
        expiry_rows = []
        for expiry in exps:
            dte = (datetime.strptime(expiry, "%Y-%m-%d") - today_dt).days
            if min_dte <= dte <= max_dte:
                expiry_rows.append((expiry, dte))

        if not expiry_rows:
            return {
                "ticker": ticker.upper(),
                "option_type": side,
                "spot_price": spot,
                "min_dte": min_dte,
                "max_dte": max_dte,
                "max_otm_pct": max_otm_pct,
                "candidates": [],
                "best_candidate": None,
                "note": f"No {side} contracts were found inside {min_dte}-{max_dte} DTE.",
            }

        candidates = []
        for expiry, dte in expiry_rows:
            try:
                chain = t.option_chain(expiry)
            except Exception:
                continue

            contracts = _prepare_contracts_frame(chain.calls if side == "call" else chain.puts)
            if contracts is None or contracts.empty:
                continue

            if side == "call":
                contracts = contracts[(contracts["strike"] >= spot) & (contracts["strike"] <= spot * (1 + max_otm_pct / 100.0))]
            else:
                contracts = contracts[(contracts["strike"] <= spot) & (contracts["strike"] >= spot * (1 - max_otm_pct / 100.0))]

            if contracts.empty:
                continue

            for _, row in contracts.iterrows():
                strike = round(float(row["strike"]), 2)
                otm_pct = ((strike / spot) - 1) * 100 if side == "call" else (1 - strike / spot) * 100
                if otm_pct < 0 or otm_pct > max_otm_pct:
                    continue

                snapshot = _contract_market_snapshot(row, spot, previous_spot, expiry, side)
                if snapshot["iv_pct"] is None:
                    continue

                spread_pct = snapshot["spread_pct"] if snapshot["spread_pct"] is not None else 999.0
                liquidity = snapshot["open_interest"] + snapshot["volume"] * 0.5
                if snapshot["mark_price"] is None and snapshot["last"] is None:
                    continue

                candidate = {
                    "expiry": expiry,
                    "dte": dte,
                    "strike": strike,
                    "otm_pct": round(otm_pct, 2),
                    "liquidity_score": round(liquidity, 1),
                    **snapshot,
                }
                candidate["_sort"] = (
                    snapshot["iv_pct"],
                    spread_pct,
                    round(otm_pct, 2),
                    -liquidity,
                    dte,
                )
                candidates.append(candidate)

        if not candidates:
            return {
                "ticker": ticker.upper(),
                "option_type": side,
                "spot_price": spot,
                "min_dte": min_dte,
                "max_dte": max_dte,
                "max_otm_pct": max_otm_pct,
                "candidates": [],
                "best_candidate": None,
                "note": f"No liquid {side} contracts met the <{max_otm_pct:.1f}% OTM filter inside {min_dte}-{max_dte} DTE.",
            }

        ranked = sorted(candidates, key=lambda item: item["_sort"])
        trimmed = []
        for row in ranked[: max(max_results, 3)]:
            clean = {key: value for key, value in row.items() if key != "_sort"}
            if clean["previous_contract_iv_pct"] is not None:
                clean["iv_change_pct_pts"] = round(clean["iv_pct"] - clean["previous_contract_iv_pct"], 1)
            else:
                clean["iv_change_pct_pts"] = None
            trimmed.append(clean)

        return {
            "ticker": ticker.upper(),
            "option_type": side,
            "spot_price": spot,
            "previous_spot_close": previous_spot,
            "min_dte": min_dte,
            "max_dte": max_dte,
            "max_otm_pct": max_otm_pct,
            "best_candidate": trimmed[0],
            "candidates": trimmed,
            "note": (
                "Lowest contract IV wins first. Spread quality, distance from spot, and Yahoo chain liquidity "
                "break ties inside the selected DTE window."
            ),
        }
    except Exception as e:
        traceback.print_exc()
        return JSONResponse({"error": str(e)}, 500)


@app.get("/health")
def health():
    return {"status": "ok", "version": "1.2"}


if __name__ == "__main__":
    import uvicorn

    print("\n" + "=" * 55)
    print("  SwingEdge Options Calculator - Local Server v1.2")
    print("=" * 55)
    print("  Open in browser: http://localhost:8765")
    print("  Press Ctrl+C to stop\n")
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")
