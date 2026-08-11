"""
US Stock Ticker Fetcher
=======================
Fetches US stock tickers from NASDAQ's stock screener API (covers NYSE, NASDAQ, AMEX),
then saves to CSV files sorted by market capitalization.
"""

import os
import re
import math
import random
import time
import requests
import pandas as pd
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed

# Configuration
NASDAQ_URL = "https://api.nasdaq.com/api/screener/stocks"
YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{}"
WIKIPEDIA_SP500_RAW_URL = "https://en.wikipedia.org/w/index.php?title=List_of_S%26P_500_companies&action=raw"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
}

# How many symbols to fetch from Yahoo Finance in parallel. Yahoo's unofficial
# chart endpoint rate-limits aggressively, so keep this modest.
YAHOO_WORKERS = 15
SP500_SYMBOL_PATTERN = re.compile(
    r"^\|\{\{(?:NyseSymbol|NasdaqSymbol|BZX link)\|([^}|]+)",
    re.MULTILINE,
)


def normalize_symbol(symbol):
    """Normalize symbol formatting across data sources."""
    return symbol.strip().upper().replace(".", "/")


def fetch_sp500_symbols():
    """Fetch current S&P 500 constituent tickers from Wikipedia."""
    print("Fetching S&P 500 constituents from Wikipedia...")

    time.sleep(random.uniform(0.5, 1.5))

    try:
        response = requests.get(WIKIPEDIA_SP500_RAW_URL, headers=HEADERS, timeout=30)
        response.raise_for_status()

        content = response.text
        start_marker = "== S&P 500 component stocks =="
        end_marker = "== Selected changes to the list of S&P 500 components =="

        if start_marker not in content:
            raise ValueError("Wikipedia page format changed: missing constituents section")

        section = content.split(start_marker, 1)[1]
        if end_marker in section:
            section = section.split(end_marker, 1)[0]

        symbols = []
        seen = set()
        for symbol in SP500_SYMBOL_PATTERN.findall(section):
            normalized = normalize_symbol(symbol)
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            symbols.append(symbol.strip().upper())

        if len(symbols) < 450:
            raise ValueError(f"Wikipedia parse returned too few symbols: {len(symbols)}")

        print(f"  Found {len(symbols)} S&P 500 constituent tickers")
        return symbols

    except Exception as e:
        print(f"  Error: {e}")
        return []


def fetch_tickers():
    """
    Fetches NASDAQ screener rows and splits them into all listings and US listings.
    """
    print("Fetching tickers from NASDAQ...")
    
    # Random initial delay (0.5-1.5s) to avoid predictable patterns
    time.sleep(random.uniform(0.5, 1.5))
    
    try:
        params = {
            "tableonly": "true",
            "download": "true"
        }
        
        response = requests.get(NASDAQ_URL, params=params, headers=HEADERS, timeout=30)
        response.raise_for_status()
        
        rows = response.json().get('data', {}).get('rows', [])
        
        if not rows:
            print("  No data returned from API")
            return []
        
        print(f"  Fetched {len(rows)} tickers from API")
        
        # Parse tickers with deduplication
        all_tickers = []
        us_tickers = []
        seen_symbols = set()
        non_us_count = 0
        duplicate_count = 0
        
        for row in rows:
            symbol = row.get('symbol', '').strip()
            
            # Skip duplicates
            if not symbol or symbol in seen_symbols:
                duplicate_count += 1
                continue
            seen_symbols.add(symbol)

            ticker = {
                'symbol': symbol,
                'name': row.get('name', ''),
                'price': parse_number(row.get('lastsale', '')),
                'marketCap': parse_market_cap(row.get('marketCap', '')),
                'volume': parse_int(row.get('volume', '')),
                'industry': row.get('sector', ''),
            }
            all_tickers.append(ticker)

            if row.get('country') == 'United States':
                us_tickers.append(ticker)
            else:
                non_us_count += 1
        
        print(f"  Excluded: {non_us_count} non-US, {duplicate_count} duplicates")
        print(f"  Found {len(us_tickers)} unique US tickers")
        print(f"  Found {len(all_tickers)} total unique listed tickers")
        return us_tickers, all_tickers
        
    except Exception as e:
        print(f"  Error: {e}")
        return [], []


def parse_market_cap(s):
    """Parse market cap string like '$1.2T' or '$500M' to numeric."""
    if not s or s == 'N/A':
        return None
    try:
        s = s.replace('$', '').replace(',', '').strip()
        multipliers = {'T': 1e12, 'B': 1e9, 'M': 1e6, 'K': 1e3}
        for suffix, mult in multipliers.items():
            if s.endswith(suffix):
                return float(s[:-1]) * mult
        return float(s)
    except:
        return None


def parse_number(s):
    """Parse price/number string to float."""
    if not s or s == 'N/A':
        return None
    try:
        return float(s.replace('$', '').replace(',', '').strip())
    except:
        return None


def parse_int(s):
    """Parse volume string to integer."""
    if not s or s == 'N/A':
        return None
    try:
        return int(str(s).replace(',', '').strip())
    except:
        return None


def yahoo_symbol(symbol):
    """Convert a NASDAQ symbol to the Yahoo Finance format.

    NASDAQ uses dots for share classes (e.g. BRK.B, BF.B); Yahoo uses dashes
    (BRK-B, BF-B). Some symbols use slashes; Yahoo also wants dashes there.
    """
    return symbol.strip().upper().replace(".", "-").replace("/", "-")


def fetch_yahoo_ohlc(symbol):
    """Fetch the most recent completed trading day's OHLC from Yahoo Finance.

    Uses a 5-day window so we still get the latest close when the script runs
    before US market open (10:00 UTC) and today's session has no data yet.
    Returns a dict {open, high, low, close} or None on failure/404.
    """
    url = YAHOO_CHART_URL.format(yahoo_symbol(symbol))
    params = {"range": "5d", "interval": "1d"}

    for attempt in range(3):
        try:
            time.sleep(random.uniform(0, 0.05))
            response = requests.get(url, params=params, headers=HEADERS, timeout=10)

            # Rate limited / temporarily blocked: back off and retry.
            if response.status_code in (401, 429) and attempt < 2:
                time.sleep(2 ** attempt)
                continue
            # Unknown symbol or delisted: no point retrying.
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

            # Walk backwards to the most recent day that has a valid close.
            for i in range(len(timestamps) - 1, -1, -1):
                close = closes[i] if i < len(closes) else None
                if close is None:
                    continue
                trade_date = datetime.fromtimestamp(timestamps[i], tz=timezone.utc).date().isoformat()
                return {
                    "date": trade_date,
                    "open": opens[i] if i < len(opens) else None,
                    "high": highs[i] if i < len(highs) else None,
                    "low": lows[i] if i < len(lows) else None,
                    "close": close,
                }
            return None
        except Exception:
            if attempt < 2:
                time.sleep(2 ** attempt)
                continue
            return None


def fetch_ohlc_map(symbols):
    """Fetch latest-day OHLC for a set of symbols concurrently from Yahoo Finance.

    Best-effort: symbols that fail or are not found are simply left without
    OHLC (the columns will be blank in the CSV) rather than failing the run.
    """
    symbols = list(symbols)
    total = len(symbols)
    print(f"\nFetching OHLC for {total} symbols from Yahoo Finance...")
    print("  (this is the slowest step; ~{:d} requests)".format(total))

    ohlc_map = {}
    completed = 0

    with ThreadPoolExecutor(max_workers=YAHOO_WORKERS) as executor:
        futures = {executor.submit(fetch_yahoo_ohlc, s): s for s in symbols}
        for future in as_completed(futures):
            sym = futures[future]
            completed += 1
            try:
                result = future.result()
            except Exception:
                result = None
            if result:
                ohlc_map[sym] = result
            if completed % 500 == 0 or completed == total:
                print(f"  Progress: {completed}/{total} ({len(ohlc_map)} with OHLC)")

    print(f"  Got OHLC for {len(ohlc_map)}/{total} symbols")
    return ohlc_map


# Columns stored in the historical archive (CSV + SQL), in order.
HISTORY_COLUMNS = [
    "date", "symbol", "name", "price",
    "open", "high", "low", "close",
    "marketCap", "volume", "industry",
]
HISTORY_STRING_COLUMNS = {"date", "symbol", "name", "industry"}

HISTORY_CSV_PATH = "tickers/history.csv"
HISTORY_SQL_PATH = "tickers/history.sql"


def snapshot_date_from_ohlc(ohlc_map, fallback=None):
    """Pick the trading day this run represents.

    Each run captures the most recent *completed* US trading session (the
    workflow runs at 10:00 UTC, before US market open), so the snapshot date is
    the latest trade date returned by Yahoo across all symbols. Falls back to
    `fallback` (e.g. today's UTC date) when Yahoo returned nothing.
    """
    dates = [v.get("date") for v in ohlc_map.values() if v and v.get("date")]
    if dates:
        return max(dates)
    return fallback


def append_history_csv(tickers, ohlc_map, snapshot_date, path=HISTORY_CSV_PATH):
    """Append one dated cross-section of all US tickers to the history CSV.

    Idempotent: if the snapshot date is already present, the run is skipped,
    so re-running the workflow the same day (or running before the next session
    closes) does not create duplicate rows.
    """
    ohlc_map = ohlc_map or {}
    os.makedirs(os.path.dirname(path), exist_ok=True)

    # Idempotency: only the date column is needed to decide whether to skip.
    if os.path.exists(path):
        try:
            existing_dates = set(
                pd.read_csv(path, usecols=["date"])["date"].astype(str).unique()
            )
        except Exception:
            existing_dates = set()
        if snapshot_date in existing_dates:
            print(f"  history.csv already contains {snapshot_date}; skipping append")
            return False

    rows = []
    for t in tickers:
        o = ohlc_map.get(t.get("symbol")) or {}
        rows.append({
            "date": snapshot_date,
            "symbol": t.get("symbol"),
            "name": t.get("name"),
            "price": t.get("price"),
            "open": o.get("open"),
            "high": o.get("high"),
            "low": o.get("low"),
            "close": o.get("close"),
            "marketCap": t.get("marketCap"),
            "volume": t.get("volume"),
            "industry": t.get("industry"),
        })

    new_df = pd.DataFrame(rows, columns=HISTORY_COLUMNS)
    # Stable ordering within a day (largest market cap first) keeps the file tidy.
    new_df = new_df.sort_values("marketCap", ascending=False, na_position="last").reset_index(drop=True)

    write_header = not os.path.exists(path)
    new_df.to_csv(path, mode="a", header=write_header, index=False)
    print(f"  Appended {len(new_df)} rows for {snapshot_date} to {path}")
    return True


def _sql_literal(value, column):
    """Render a Python value as a SQL literal (portable across SQLite/PG/MySQL)."""
    if value is None:
        return "NULL"
    if isinstance(value, float) and math.isnan(value):
        return "NULL"
    if column in HISTORY_STRING_COLUMNS:
        text = "" if value is None else str(value)
        return "'" + text.replace("'", "''") + "'"
    return str(value)


def generate_history_sql(csv_path=HISTORY_CSV_PATH, sql_path=HISTORY_SQL_PATH):
    """Regenerate the SQL dump from the history CSV.

    One multi-row INSERT is emitted per trading day, which keeps import fast
    while staying well within statement-size limits. Output is deterministic so
    the committed file only diffs by the newly appended day.
    """
    if not os.path.exists(csv_path):
        print("  No history.csv found; skipping SQL generation")
        return False

    df = pd.read_csv(csv_path, dtype={"date": str})
    # Keep NULLs as None; sort for stable, grouped output.
    df = df.sort_values(["date", "marketCap"], ascending=[True, False], na_position="last")

    lines = [
        "-- US stock ticker history (auto-generated daily by update_tickers.py).",
        "-- Columns: date = trading day of the OHLC bar; price/marketCap/volume",
        "-- are the NASDAQ screener snapshot taken during the same run.",
        "-- Portable SQL: works on SQLite, PostgreSQL, and MySQL.",
        "",
        "CREATE TABLE IF NOT EXISTS us_tickers (",
        "    date      DATE        NOT NULL,",
        "    symbol    VARCHAR(32) NOT NULL,",
        "    name      VARCHAR(255),",
        "    price     DECIMAL(18,4),",
        "    open      DECIMAL(18,4),",
        "    high      DECIMAL(18,4),",
        "    low       DECIMAL(18,4),",
        "    close     DECIMAL(18,4),",
        "    marketCap DECIMAL(24,2),",
        "    volume    BIGINT,",
        "    industry  VARCHAR(128),",
        "    PRIMARY KEY (date, symbol)",
        ");",
        "",
    ]

    cols = HISTORY_COLUMNS
    total_rows = 0
    for date_val, group in df.groupby("date", sort=True):
        lines.append(
            "INSERT INTO us_tickers (" + ", ".join(cols) + ") VALUES"
        )
        value_rows = []
        for record in group[cols].itertuples(index=False, name=None):
            literals = [_sql_literal(v, c) for v, c in zip(record, cols)]
            value_rows.append("    (" + ", ".join(literals) + ")")
            total_rows += 1
        lines.append(",\n".join(value_rows) + ";")
        lines.append("")

    with open(sql_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(f"  Wrote {sql_path} ({total_rows} rows across {df['date'].nunique()} dates)")
    return True


def filter_sp500_tickers(tickers, sp500_symbols):
    """Filter ticker rows down to S&P 500 constituents."""
    if not tickers or not sp500_symbols:
        return []

    sp500_map = {normalize_symbol(symbol): symbol for symbol in sp500_symbols}
    matched_tickers = []
    unmatched_symbols = set(sp500_map)

    for ticker in tickers:
        normalized = normalize_symbol(ticker.get('symbol', ''))
        if normalized in sp500_map:
            matched_tickers.append(ticker)
            unmatched_symbols.discard(normalized)

    print(f"  Matched {len(matched_tickers)} NASDAQ rows to S&P 500 constituents")
    if unmatched_symbols:
        sample = ", ".join(sorted(unmatched_symbols)[:10])
        suffix = "..." if len(unmatched_symbols) > 10 else ""
        print(f"  Warning: {len(unmatched_symbols)} S&P symbols not found in NASDAQ data: {sample}{suffix}")

    return matched_tickers


def attach_ohlc(df, ohlc_map):
    """Attach open/high/low/close columns to a ticker DataFrame and order them
    right after price. Symbols missing from ohlc_map get blank OHLC cells."""
    ohlc_map = ohlc_map or {}
    for col in ["open", "high", "low", "close"]:
        df[col] = df["symbol"].map(lambda s, c=col: (ohlc_map.get(s) or {}).get(c))

    desired = [
        "symbol", "name", "price",
        "open", "high", "low", "close",
        "marketCap", "volume", "industry",
    ]
    return df[[c for c in desired if c in df.columns]]


def save_files(tickers, sp500_tickers=None, ohlc_map=None):
    """Save tickers to organized folder structure."""
    if not tickers:
        print("No tickers to save!")
        return False

    # Sort by market cap (descending)
    df = pd.DataFrame(tickers)
    df['industry'] = df['industry'].fillna('').astype(str).str.strip()
    df.loc[df['industry'] == '', 'industry'] = 'Uncategorized'
    df = df.sort_values('marketCap', ascending=False).reset_index(drop=True)
    df = attach_ohlc(df, ohlc_map)

    # Create output directories
    os.makedirs("tickers", exist_ok=True)
    os.makedirs("by_industry", exist_ok=True)

    # === GENERAL TICKER LISTS ===
    print("\nSaving ticker lists...")

    df.to_csv("tickers/all.csv", index=False)
    print(f"  - tickers/all.csv ({len(df)} rows)")

    if sp500_tickers:
        sp500_df = pd.DataFrame(sp500_tickers)
        sp500_df = sp500_df.sort_values('marketCap', ascending=False).reset_index(drop=True)
        sp500_df = attach_ohlc(sp500_df, ohlc_map)
        sp500_df.to_csv("tickers/sp500.csv", index=False)
        print(f"  - tickers/sp500.csv ({len(sp500_df)} rows)")

    for n in [50, 100, 200]:
        df.head(n).to_csv(f"tickers/top_{n}.csv", index=False)
        print(f"  - tickers/top_{n}.csv")
    
    # === BY INDUSTRY ===
    print("\nSaving by industry...")
    
    industries = df['industry'].unique()
    
    for industry in sorted(industries):
        industry_df = df[df['industry'] == industry]
        if len(industry_df) == 0:
            continue
        
        # Safe filename
        safe_name = re.sub(r'[^\w\s-]', '', industry.lower())
        safe_name = re.sub(r'\s+', '_', safe_name.strip())
        
        industry_df.to_csv(f"by_industry/{safe_name}.csv", index=False)
        print(f"  - by_industry/{safe_name}.csv ({len(industry_df)} tickers)")
    
    return True


if __name__ == "__main__":
    print("=" * 50)
    print("US Stock Ticker Update")
    print("=" * 50)
    
    tickers, all_tickers = fetch_tickers()
    sp500_symbols = fetch_sp500_symbols()
    
    if not tickers:
        print("\nNo data found!")
        exit(1)

    if not sp500_symbols:
        print("\nNo S&P 500 data found!")
        exit(1)

    sp500_tickers = filter_sp500_tickers(all_tickers, sp500_symbols)

    # Fetch latest-day OHLC for every symbol we will write out (US list plus
    # the S&P 500 match). The NASDAQ screener does not provide open/high/low,
    # so we supplement it from Yahoo Finance.
    ohlc_symbols = {t.get("symbol") for t in tickers} | {t.get("symbol") for t in sp500_tickers}
    ohlc_map = fetch_ohlc_map(ohlc_symbols)

    # Determine the trading day this run represents (most recent completed US
    # session), then append a dated cross-section to the history archive and
    # regenerate the importable SQL dump from it.
    snapshot_date = snapshot_date_from_ohlc(
        ohlc_map, fallback=datetime.now(timezone.utc).date().isoformat()
    )
    print(f"\nSnapshot date for history archive: {snapshot_date}")

    print("\nUpdating history archive...")
    append_history_csv(tickers, ohlc_map, snapshot_date)
    generate_history_sql()

    if save_files(tickers, sp500_tickers, ohlc_map):
        print("\n" + "=" * 50)
        print("Update completed!")
        print("=" * 50)
    else:
        print("\nFailed to save!")
        exit(1)
