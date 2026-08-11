# Top US Stock Tickers

> **Live site:** <https://ozkanpakdil.github.io/top-us-stock-tickers/> — interactive candlestick charts with RSI / MFI / Stochastic indicators.

Automatically updated CSV lists of US-listed stocks from NASDAQ (grouped by industry), plus a daily S&P 500 constituent list matched against the NASDAQ universe and sorted by market capitalization.

## Folder Structure

```
├── tickers/           # General ticker lists
│   ├── all.csv        # All US stocks (~5,300+)
│   ├── sp500.csv      # Current S&P 500 constituents
│   ├── top_50.csv     # Top 50 by market cap
│   ├── top_100.csv    # Top 100 by market cap
│   ├── top_200.csv    # Top 200 by market cap
│   ├── history.csv    # Full OHLC backfill (generated locally; gitignored — see "Historical SQL archive")
│   └── history.sql    # Same data as a portable SQL dump (shipped as a CI artifact, not committed)
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
full time series without digging through git history, the daily workflow also
produces a **portable SQL dump with decades of daily OHLC** — but it is published
as a downloadable **GitHub Actions artifact**, not committed to the repo.

Why not committed? A full backfill (top 200 tickers × full listing history) is
already ~240 MB and grows every day — well past GitHub's 100 MB-per-file push
limit. So the dump is regenerated each run from the per-ticker JSON archives
(`ohlc/<SYMBOL>.json`) and uploaded under the **`history-sql`** artifact of
the latest *Daily Stock Ticker Update* run. Download it from:

```text
https://github.com/ozkanpakdil/top-us-stock-tickers/actions/workflows/daily_update.yml
```

Open the most recent successful run → scroll to **Artifacts** → download
`history-sql` → unzip → you get `tickers/history.sql`.

`history.sql` contains a `CREATE TABLE IF NOT EXISTS us_tickers (...)` statement
with `PRIMARY KEY (date, symbol)`, followed by one multi-row `INSERT` per trading
day. The syntax is portable across SQLite, PostgreSQL, and MySQL.

Scope is controlled by repository variables (Settings → Secrets and variables →
Actions → Variables):

- `HISTORY_SQL_LIMIT` — number of tickers by market cap (default **200**; set `0`
  for every archived ticker — note the artifact then grows into the gigabytes).
- `HISTORY_SQL_YEARS` — depth cap in years (default: full listing history).

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
bun install
bun run update
```

## Notes

- NASDAQ provides the base fields used in every generated CSV: `symbol`, `name`, `price`, `marketCap`, `volume`, `industry`. The `open`, `high`, `low`, and `close` columns are fetched per symbol from the Yahoo Finance chart API; symbols Yahoo cannot resolve (e.g. some share classes or recently delisted tickers) are left with blank OHLC cells rather than failing the run.
- Wikipedia is used only to determine current S&P 500 membership.
- Symbol normalization is required for some share classes, such as `BRK.B` <-> `BRK/B` and `BF.B` <-> `BF/B`.
- The GitHub Actions workflow runs the update automatically on weekdays.


## Web app — stock charts with indicators

A static single-page app (`docs/index.html`) renders Revolut/IBKR-style candlestick
charts with volume, a right-side price axis, a crosshair + OHLCV tooltip, and the
RSI / HRSI / MFI / Stochastic %K indicators. It is deployed to **GitHub Pages** and
runs entirely client-side.

### GitHub Pages deployment

The site lives in `docs/` and is deployed by `.github/workflows/pages.yml`, which
uploads `docs/` and deploys it on every push to `main` (and via `workflow_dispatch`).

The site is live at **<https://ozkanpakdil.github.io/top-us-stock-tickers/>**
(deployed automatically by the `pages.yml` workflow on every push to `main`).

**One-time setup (already done):** the repo's *Settings → Pages → Build and
deployment → Source* is set to **GitHub Actions** (not "Deploy from a branch").
For a new repo, set that, then push to `main` — the site goes live at
`https://<your-user>.github.io/<repo>/`.

The historical OHLC data the charts read is **not committed to `main`**. The
per-ticker JSONs live on an orphan `data` branch and are served to the page by
the **jsDelivr CDN**, one ~50–600 KB file per ticker (lazy-loaded when you click a
symbol):

```text
https://cdn.jsdelivr.net/gh/ozkanpakdil/top-us-stock-tickers@data/ohlc/<SYMBOL>.json
```

Only the small indexes that the search box and picker need are committed to
`main` under `docs/data/`:

- `docs/data/tickers.json` — every ticker in `all.csv` (the search index; ~5,000 rows, ~500 KB).
- `docs/data/manifest.json` — only the tickers that actually have an OHLC file (the picker list).

The orphan `data` branch is force-pushed as a fresh single-commit orphan each
daily run, so its history never grows; because git stores blobs by content hash,
only changed/new files are actually transferred on each push.

### Archiving history

`archive_history.ts` builds and refreshes the per-ticker OHLC archive:

- A **missing** file → full backfill of daily OHLCV from Yahoo Finance
  (`period1=0 … period2=now`).
- An **existing** file → a cheap 3-month window is fetched and merged in, so a run
  that times out simply resumes the long tail next time. Failed tickers are
  skipped; `manifest.json` lists only the tickers that have a file.

Files are written to `ohlc/<SYMBOL>.json` (gitignored on `main`), then the daily
workflow publishes them to the orphan `data` branch for jsDelivr to serve. It runs
in the daily workflow after `update_tickers.ts`. You can also run it locally:

```bash
bun run src/archive_history.ts --only AAPL,MSFT,NVDA   # a few tickers (smoke test)
bun run src/archive_history.ts --limit 100            # first 100 by market cap
bun run src/archive_history.ts --max-years 10         # cap history depth
```

History depth defaults to **unlimited** (full listing history). Full coverage of
all ~5,000 US tickers is ~0.5–1.5 GB of JSON; since each file lives on the `data`
branch (not `main`) and only one loads per view, the repo and the site both stay
light. To cap the depth, set the `HISTORY_MAX_YEARS` repository variable (e.g.
`20`) or pass `--max-years`.

### Local development

`bun run dev` runs `src/server.ts`, which serves `docs/` (so you preview the exact
deployed site) **and** keeps two local-only endpoints for live play:

- `/api/tickers` — reads `tickers/all.csv`
- `/api/history` — a server-side proxy to Yahoo Finance (browsers can't call Yahoo
  directly)

The page first tries the jsDelivr CDN (`<repo>@data/ohlc/<SYMBOL>.json`); if that
has no file for a ticker yet, it falls back to `/api/history` so you can chart any
ticker live while developing. On GitHub Pages that fallback is absent, so only
archived tickers chart there.

```bash
bun install
bun run dev
# open http://localhost:3000
```

Different port:

```bash
PORT=3100 bun run src/server.ts
# open http://localhost:3100
```