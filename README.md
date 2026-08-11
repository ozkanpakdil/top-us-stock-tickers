# Top US Stock Tickers

Automatically updated CSV lists of US-listed stocks from NASDAQ (grouped by industry), plus a daily S&P 500 constituent list matched against the NASDAQ universe and sorted by market capitalization.

## Folder Structure

```
├── tickers/           # General ticker lists
│   ├── all.csv        # All US stocks (~5,300+)
│   ├── sp500.csv      # Current S&P 500 constituents
│   ├── top_50.csv     # Top 50 by market cap
│   ├── top_100.csv    # Top 100 by market cap
│   ├── top_200.csv    # Top 200 by market cap
│   ├── history.csv    # Daily dated snapshots (accumulating)
│   └── history.sql    # Same history as an importable SQL dump
│
└── by_industry/       # Tickers grouped by industry
    ├── technology.csv
    ├── health_care.csv
    ├── finance.csv
    ├── uncategorized.csv
    └── ...            # One file per industry
```

## Update Schedule

Data is automatically updated **daily at 10:00 UTC** (before US market open) via GitHub Actions.

## Historical SQL archive

The CSV lists above are snapshots overwritten every day. For people who want the
time series without digging through git history, there is an accumulating archive:

- `tickers/history.csv` — one dated row per symbol per trading day, appended daily.
- `tickers/history.sql` — the same data regenerated each run as a portable SQL dump.

Each daily run captures the most recent **completed** US trading session, so:

- A Monday run records Friday's session, a Tuesday run records Monday's session, etc.
- Re-running the workflow on the same day does **not** create duplicate rows (the
  snapshot date is skipped if already present).
- `tickers/history.sql` contains a `CREATE TABLE IF NOT EXISTS us_tickers (...)`
  statement with `PRIMARY KEY (date, symbol)`, followed by one multi-row `INSERT`
  per trading day. The syntax is portable across SQLite, PostgreSQL, and MySQL.

Import it, for example with SQLite:

```bash
sqlite3 tickers.db < tickers/history.sql
```

Then query the history directly:

```sql
-- Latest close for every symbol
SELECT symbol, date, close
FROM us_tickers
WHERE date = (SELECT MAX(date) FROM us_tickers);

-- Apple's daily close over time
SELECT date, close FROM us_tickers WHERE symbol = 'AAPL' ORDER BY date;
```

## Data Fields

| Column | Description |
|--------|-------------|
| `symbol` | Stock ticker symbol (e.g., AAPL) |
| `name` | Company name |
| `price` | Last market price |
| `open` | Daily opening price (most recent completed session, from Yahoo Finance) |
| `high` | Daily high (most recent completed session, from Yahoo Finance) |
| `low` | Daily low (most recent completed session, from Yahoo Finance) |
| `close` | Daily closing price (most recent completed session, from Yahoo Finance) |
| `marketCap` | Market capitalization (USD) |
| `volume` | Trading volume |
| `industry` | Sector/industry |

**All files are sorted by market cap (largest first).**

## Data Sources

- `tickers/all.csv`, `tickers/top_50.csv`, `tickers/top_100.csv`, `tickers/top_200.csv`, and `by_industry/*.csv` are generated from the NASDAQ Stock Screener API, with the `open`/`high`/`low`/`close` columns supplemented from the Yahoo Finance chart API for the most recent completed trading session.
- `tickers/sp500.csv` uses Wikipedia only for S&P 500 membership and then matches those symbols back to NASDAQ rows for the output fields (OHLC also added from Yahoo Finance).
- `tickers/sp500.csv` currently contains all matched constituent tickers, which can be more than 500 rows because the index can include multiple share classes.

## How to Use the Data

Other people can use this repo in a few simple ways:

1. Consume the CSVs directly from the raw GitHub URLs without cloning the repository.
2. Use the generated files as static datasets in scripts, notebooks, dashboards, or screeners.
3. Read only the specific file you need, such as the full list, the S&P 500 list, or an industry slice.

Common starting points:

- `tickers/all.csv`: all US tickers in this dataset
- `tickers/sp500.csv`: current S&P 500 constituent tickers
- `tickers/top_50.csv`, `tickers/top_100.csv`, `tickers/top_200.csv`: largest names by market cap
- `by_industry/*.csv`: sector-grouped subsets
- `by_industry/uncategorized.csv`: rows where NASDAQ does not provide a sector value

Raw GitHub URL examples:

```text
https://raw.githubusercontent.com/Ate329/top-us-stock-tickers/main/tickers/all.csv
https://raw.githubusercontent.com/Ate329/top-us-stock-tickers/main/tickers/sp500.csv
https://raw.githubusercontent.com/Ate329/top-us-stock-tickers/main/tickers/top_50.csv
https://raw.githubusercontent.com/Ate329/top-us-stock-tickers/main/by_industry/technology.csv
```

Example with Python:

```python
import pandas as pd

df = pd.read_csv(
    "https://raw.githubusercontent.com/Ate329/top-us-stock-tickers/main/tickers/sp500.csv"
)
print(df.head())
```

Example with the standard library:

```python
import csv
import urllib.request

url = "https://raw.githubusercontent.com/Ate329/top-us-stock-tickers/main/tickers/top_50.csv"
with urllib.request.urlopen(url) as response:
    rows = list(csv.DictReader(line.decode("utf-8") for line in response))

print(rows[0])
```

## Local Development

```bash
python -m pip install -r requirements.txt
python update_tickers.py
```

## Notes

- NASDAQ provides the base fields used in every generated CSV: `symbol`, `name`, `price`, `marketCap`, `volume`, `industry`. The `open`, `high`, `low`, and `close` columns are fetched per symbol from the Yahoo Finance chart API; symbols Yahoo cannot resolve (e.g. some share classes or recently delisted tickers) are left with blank OHLC cells rather than failing the run.
- Wikipedia is used only to determine current S&P 500 membership.
- Symbol normalization is required for some share classes, such as `BRK.B` <-> `BRK/B` and `BF.B` <-> `BF/B`.
- The GitHub Actions workflow runs the update automatically on weekdays.


## added web app to show graphics from the CSVs
Run it

From the repo root:

```bash
bun install
bun run dev
```

Then open:

```text
http://localhost:3000
```

If you want the server on a different port:

```bash
PORT=3100 bun run src/server.ts
```

Then open:

```text
http://localhost:3100
```