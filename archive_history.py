"""
OHLC History Archiver
====================
Builds and maintains a per-ticker historical OHLC archive under `docs/data/`,
consumed by the static GitHub Pages site (docs/index.html).

Each ticker is written to `docs/data/<SYMBOL>.json`:

    {
      "symbol": "AAPL",
      "name": "Apple Inc. Common Stock",
      "industry": "Technology",
      "bars": [["2020-01-02", 187.15, 188.70, 184.00, 185.64, 82456123], ...]
    }

Bar = [date(ISO), open, high, low, close, volume], ascending by date.

The archive is **resumable / incremental**:
  - A missing file -> full backfill from Yahoo (`range=max`, or capped by
    `--max-years` / `HISTORY_MAX_YEARS`).
  - An existing file -> fetch a short 3-month window and merge any new bars
    (dedup by date, newest wins). Cheap, self-heals gaps, and means a run that
    times out just resumes the long tail next time.

Failures (rate limit, 404, network) skip the ticker; the existing file (if any)
is preserved. `docs/data/manifest.json` lists only the tickers that actually
have a file, so the picker never shows a dead ticker.

Reuses `yahoo_symbol` / `HEADERS` from update_tickers so the Yahoo symbol
formatting stays identical to the daily updater.
"""

import os
import re
import sys
import json
import time
import random
import argparse
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
import pandas as pd

from update_tickers import yahoo_symbol, HEADERS, normalize_symbol

YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{}"
DATA_DIR = os.path.join("docs", "data")
MANIFEST_PATH = os.path.join(DATA_DIR, "manifest.json")
TICKERS_CSV = os.path.join("tickers", "all.csv")
DEFAULT_WORKERS = 12


def safe_filename(symbol):
    """Filename for a ticker's JSON. Must stay in sync with the client, which
    computes the path as `symbol.toUpperCase().replace('.', '-').replace('/', '-')`."""
    return symbol.strip().upper().replace(".", "-").replace("/", "-") + ".json"


def parse_float(value):
    if value is None:
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if v != v:  # NaN
        return None
    return v


def fetch_history(symbol, range_="max", max_years=None, interval="1d"):
    """Fetch daily OHLCV bars for one symbol from Yahoo Finance.

    Returns a list of [date, open, high, low, close, volume] bars (ascending),
    or None on hard failure / unknown symbol.
    """
    url = YAHOO_CHART_URL.format(yahoo_symbol(symbol))

    if range_ != "max":
        # Short window (used for incremental merges): range= returns daily fine.
        params = {"range": range_, "interval": interval}
    elif max_years:
        now = int(time.time())
        period1 = now - int(float(max_years) * 365.25 * 86400)
        params = {"period1": period1, "period2": now, "interval": interval}
    else:
        # Full daily backfill. NOTE: `range=max` down-samples to *monthly* for very
        # long histories, so use an explicit period1=0 / period2=now window, which
        # Yahoo returns as full daily bars (e.g. AAPL -> 11.5k daily bars since 1980).
        params = {"period1": 0, "period2": int(time.time()), "interval": interval}

    for attempt in range(3):
        try:
            time.sleep(random.uniform(0, 0.05))
            response = requests.get(url, params=params, headers=HEADERS, timeout=20)

            if response.status_code in (401, 429) and attempt < 2:
                time.sleep(2 ** attempt)
                continue
            if response.status_code == 404:
                return None
            response.raise_for_status()

            result = response.json().get("chart", {}).get("result", [None])[0]
            if not result:
                return None

            timestamps = result.get("timestamp") or []
            quote = (result.get("indicators") or {}).get("quote", [{}])[0]
            opens = quote.get("open", [])
            highs = quote.get("high", [])
            lows = quote.get("low", [])
            closes = quote.get("close", [])
            volumes = quote.get("volume", [])

            bars = []
            for i, ts in enumerate(timestamps):
                close = closes[i] if i < len(closes) else None
                if close is None:
                    continue
                vol = volumes[i] if i < len(volumes) else None
                bars.append([
                    datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat(),
                    round(parse_float(opens[i] if i < len(opens) else None) or 0, 4),
                    round(parse_float(highs[i] if i < len(highs) else None) or 0, 4),
                    round(parse_float(lows[i] if i < len(lows) else None) or 0, 4),
                    round(float(close), 4),
                    int(vol) if parse_float(vol) is not None else None,
                ])
            return bars
        except Exception:
            if attempt < 2:
                time.sleep(2 ** attempt)
                continue
            return None


def merge_bars(existing, incoming):
    """Merge two ascending bar lists by date; incoming overrides on conflict."""
    by_date = {bar[0]: bar for bar in existing}
    for bar in incoming:
        by_date[bar[0]] = bar
    return [by_date[d] for d in sorted(by_date)]


def load_existing(path):
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (ValueError, OSError):
        return None


def write_archive(path, symbol, name, industry, bars):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    payload = {
        "symbol": symbol,
        "name": name or "",
        "industry": industry or "",
        "bars": bars,
    }
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))
    os.replace(tmp, path)


def process_ticker(ticker, max_years):
    """Backfill or merge one ticker. Returns the symbol if a file exists after
    the attempt, else None."""
    symbol = ticker["symbol"]
    name = ticker.get("name", "")
    industry = ticker.get("industry", "")
    path = os.path.join(DATA_DIR, safe_filename(symbol))

    existing = load_existing(path)
    if existing and existing.get("bars"):
        # Incremental: top up with a recent window.
        fresh = fetch_history(symbol, range_="3mo", max_years=None)
        if fresh:
            bars = merge_bars(existing["bars"], fresh)
        else:
            bars = existing["bars"]  # fetch failed; keep what we have
        write_archive(path, symbol, name, industry, bars)
        return symbol

    # Full backfill.
    bars = fetch_history(symbol, range_="max", max_years=max_years)
    if not bars:
        return None  # leave any (empty) file untouched; skip from manifest
    write_archive(path, symbol, name, industry, bars)
    return symbol


def load_tickers():
    df = pd.read_csv(TICKERS_CSV, dtype={"symbol": str})
    df = df.dropna(subset=["symbol"])
    # all.csv is already sorted by market cap (desc); preserve that order so the
    # biggest names backfill first and the manifest is market-cap ordered.
    return [
        {
            "symbol": str(row.symbol).strip().upper(),
            "name": "" if pd.isna(row.name) else str(row.name),
            "industry": "" if pd.isna(row.industry) else str(row.industry),
        }
        for row in df.itertuples(index=False)
    ]


def build_manifest(archived_symbols, tickers):
    """manifest.json = only tickers that have a file, in all.csv (market-cap) order."""
    seen = set()
    ordered = []
    for t in tickers:
        sym = t["symbol"]
        if sym in archived_symbols and sym not in seen:
            seen.add(sym)
            ordered.append({"symbol": sym, "name": t["name"], "industry": t["industry"]})
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(ordered, f, separators=(",", ":"))
    return len(ordered)


def main():
    parser = argparse.ArgumentParser(description="Archive per-ticker OHLC history for the static site.")
    parser.add_argument("--limit", type=int, default=None, help="Cap number of tickers processed (tests / chunked backfill).")
    parser.add_argument("--only", type=str, default=None, help="Comma-separated symbols to process (case-insensitive).")
    parser.add_argument("--max-years", type=float, default=None, help="Cap history depth in years (overrides HISTORY_MAX_YEARS env).")
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS, help="Concurrent Yahoo requests.")
    args = parser.parse_args()

    max_years = args.max_years
    if max_years is None:
        env = os.environ.get("HISTORY_MAX_YEARS")
        if env:
            try:
                max_years = float(env)
            except ValueError:
                max_years = None

    os.makedirs(DATA_DIR, exist_ok=True)

    tickers = load_tickers()
    if args.only:
        wanted = {s.strip().upper() for s in args.only.split(",") if s.strip()}
        tickers = [t for t in tickers if t["symbol"] in wanted]
    if args.limit:
        tickers = tickers[: args.limit]

    total = len(tickers)
    print(f"Archiving history for {total} tickers (max_years={max_years or 'unlimited'}, workers={args.workers})...")

    archived = set()
    completed = 0

    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(process_ticker, t, max_years): t["symbol"] for t in tickers}
        for future in as_completed(futures):
            completed += 1
            sym = futures[future]
            try:
                result = future.result()
            except Exception:
                result = None
            if result:
                archived.add(result)
            if completed % 200 == 0 or completed == total:
                print(f"  Progress: {completed}/{total} ({len(archived)} archived)")

    count = build_manifest(archived, load_tickers())
    print(f"Done. {len(archived)}/{total} tickers have archives; manifest lists {count}.")


if __name__ == "__main__":
    main()