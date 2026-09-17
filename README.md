# Top US Stock Tickers

> **Live site:** <https://ozkanpakdil.github.io/top-us-stock-tickers/> — interactive candlestick charts with RSI / MFI / Stochastic indicators.

Automatically updated CSV lists of US-listed stocks from NASDAQ (grouped by industry), plus a daily S&P 500 constituent list matched against the NASDAQ universe and sorted by market capitalization.

## Folder Structure

```
├── tickers/           # General ticker lists
│   ├── all.csv        # All US stocks (~5,300+), with OHLC
│   ├── sp500.csv      # Current S&P 500 constituents
│   ├── top_50.csv     # Top 50 by market cap
│   ├── top_100.csv    # Top 100 by market cap
│   ├── top_200.csv    # Top 200 by market cap
│   ├── history.csv    # Rebuilt on demand from git (gitignored — see "Historical SQL archive")
│   └── history.sql    # Portable SQL dump, rebuilt on demand from git (gitignored — not committed)
│
└── by_industry/       # Tickers grouped by industry
    ├── technology.csv
    ├── health_care.csv
    ├── finance.csv
    ├── uncategorized.csv
    └── ...            # One file per industry
```

## Update Schedule

Data is automatically updated **daily at 02:37 UTC** (weekdays) via GitHub Actions — ~11h before the US market opens at 9:30 ET and ~6.5h after the previous close, so daily bars are finalized and quotes are clean regular-session closes. The run is deliberately scheduled off the hour because GitHub's cron scheduler queues runs set exactly at `:00` — observed delays of 1–3+ hours pushed the old 10:00 UTC schedule into market hours.

## Historical SQL archive

The CSV lists above are snapshots overwritten every day, and `tickers/all.csv` is
re-committed each daily run. That git history **is** the time series: one commit
per trading day, each holding a full snapshot of every US ticker (with OHLC).

To get the full history as a single portable SQL dump, generate it on demand from
the git history of `tickers/all.csv`:

```bash
bun run src/gen_history_sql.ts
```

This writes `tickers/history.sql` (and `tickers/history.csv`) — both **gitignored**,
nothing is committed. A full dump is ~100 MB+ and grows daily, well past GitHub's
100 MB-per-file push limit, so it is never stored in the repo; run the command
locally whenever you need it.

`history.sql` contains a `CREATE TABLE IF NOT EXISTS us_tickers (...)` statement
with `PRIMARY KEY (date, symbol)`, followed by one multi-row `INSERT` per trading
day. The syntax is portable across SQLite, PostgreSQL, and MySQL.

> **Note on OHLC coverage:** `all.csv` gained `open`/`high`/`low`/`close` columns
> when the pipeline migrated to TypeScript. Snapshots committed before that
> point have `NULL` for `open`/`high`/`low` (only `price` = close is available);
> every snapshot from the first post-migration daily run onward carries real
> OHLC. The generator reads each snapshot's header, so it handles both schemas.

Optional flags:

```bash
bun run src/gen_history_sql.ts --all-csv tickers/all.csv   # source snapshot (default)
bun run src/gen_history_sql.ts --out tickers/history.sql   # SQL output path
bun run src/gen_history_sql.ts --csv-out ''                 # skip the CSV output
```

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

## Premovers — catch tomorrow's mover today

> **Live site:** <https://ozkanpakdil.github.io/top-us-stock-tickers/> — "Premovers" panel.

The breakout screener catches explosions **after** they happen (a hit needs a
≥ 2% day + volume spike *today*). On **2026-09-15** it caught **VEEA +222%** —
but the setup was already visible **the day before** in this repo's own data:
after a ~17× repricing (a hidden 1-for-20 reverse split sat in the data), VEEA
consolidated two weeks in a tight range on drying volume, and on Sep 14 printed
a modest +12.8% on a clear volume uptick. The breakout screener missed it — its
50-day volume average was poisoned by pre-split share units (20×) and the
Aug-27/28 spikes, so Sep 14's ignition read as a dry-up.

`src/premovers.ts` turns the git history of `tickers/all.csv` into a supervised
learning problem and answers exactly that question:

1. **Panel** — close/volume/marketCap for every symbol back to Dec 2025, from the
   git history (same source of truth as everything else here).
2. **Split-aware cleaning** — implied shares (marketCap / price) detect corporate
   actions; pre-split volumes are re-scaled into the new share units, and
   ">100% moves without volume confirmation" are bridged as repricing artifacts.
   Without this, every volume average for months after a split is garbage.
3. **Features (18)** — multi-horizon returns, biggest recent jump + days since,
   10/20-day range tightness, volume ratio vs 20d avg, 5d-vs-50d volume dry-up,
   volume uptick vs prior 5d, distance from the 20-day high, SMA deviations,
   run-up from the 60-day low, up-streak, log market cap, log avg volume.
4. **Label** — next-day (close→close) return ≥ **+20%** (`--ret-target` to change).
5. **Model** — logistic regression, trained **walk-forward** (train only on days
   before the test chunk, retrain every 10 trading days — no lookahead).
6. **Outputs** (committed to `docs/data/screener/`, rendered on the site):
   `premovers.csv` (today's top candidates for *tomorrow*), `premovers_log.csv`
   (append-only, for later grading), and `premovers_backtest.csv` (per-day
   early-pool top-5 with realized outcomes).

```bash
bun run premovers              # score today, write premovers.csv (+ log)
bun run premovers:backtest     # full walk-forward evaluation
bun run premovers -- --ret-target 0.1 --early-min -0.15   # optional knobs
```

**Walk-forward backtest (100 test days, ~4,000 eligible symbols/day, base rate
0.31% for a ≥ +20% next day):**

| Metric | Full pool | Early pool (not already exploded today) |
|---|---|---|
| Precision@5 | 9.0% (27× lift) | 7.6% (25× lift) |
| Precision@10 | 7.1% (21× lift) | 5.5% (18× lift) |
| Explosions ranked in the day's top 1% | 17.5% | 16.2% |
| Explosions ranked in the day's top 5% | 41.3% | 38.2% |
| Explosions ranked in the day's top 10% | 53.3% | 51.0% |
| Avg next-day return, top-10 | −1.0% | −1.0% |

**VEEA check:** scored on 2026-09-14 with a model trained only on data before
that day, VEEA ranked **#39 of ~3,650 (top 1.2%)** in the early pool — the
+222% came the next day. It was not in the top-10, so a top-40 daily list would
have caught it, a top-10 would not.

**Honest caveats.** The edge is lottery-shaped: the ranked names bleed slightly
on average (−1%/day) and win through rare ≥ +20% (sometimes ≥ +100%) hits.
This is a research screener built on one short, quirky history (close+volume
only, splits inferred from marketCap, no open/high/low for most of it) —
position sizing, spreads and slippage are not modeled. Not financial advice.

## VCP screener-2

A second daily screener (`bun run screener2`, rendered by `docs/screener2.html`)
implements the Minervini-style VCP checklist (market cap $2B–$100B, price >
12M/200/150-day SMAs, P/E/FCF/EPS trending up, insiders holding, etc.). Its VCP
pattern detector was rebuilt after it started flagging dead-flat charts
(SLAB/OGN) and bonds (EAI/MFAN):

- **Structure is detected with percent-based zigzag pivots** (`VCP_REV_PCT = 3%`)
  — a swing is confirmed only after price reverses ≥ 3%. The old 3-bar pivots
  counted every 1-day wiggle, so a frozen flat chart scored "13 contractions".
- A valid VCP now needs ≥ 2 **real** contracting pullbacks (first pullback ≥ 4%
  deep, last ≤ 60% of the first), a flat ceiling of swing highs, rising lows,
  price within 8% under the ceiling, and a base spanning ≥ 15 bars.
- **Bonds, preferreds, warrants, units and rights are excluded** from the
  universe by name matching (`isNonCommonStockName`).

### Strict hits — a screen logs picks, not candidates

An earlier build logged *every* candidate that cleared the pre-filters
(~1,400 rows/day) into `hits_log.csv`; after a month the file hit 3.5 MB /
36k rows and rendering it froze Chrome and Firefox. The funnel now works the
other way around:

1. **History-only hard screen first** (no network): market cap in range,
   price > $10, above the 12M/200/150/50-day SMAs, 150-day SMA above the
   200-day, price within 25% of its 52-week high, ≥ $5M/day average dollar
   volume, the VCP pattern, and volume drying up into the base (last 10 bars
   ≤ 90% of the base's average) — only true setups survive (typically 0–5
   names/day, capped at 15).
2. **Network last, for survivors only**: employee count (stockanalysis.com,
   hard weed-out rule) then Yahoo fundamentals (P/E / FCF / EPS / insiders —
   scored and displayed, not gating).

Only hits are written to `LATEST.csv` and `hits_log.csv`; the log is
append-only and idempotent per day, prunes rows that were never VCP picks, and
keeps a rolling 90-day window (the full history stays in the git history of
the file). Outputs (committed to `docs/data/screener2/`):

```
docs/data/screener2/
├── LATEST.csv          # today's VCP hits (small, overwritten daily)
├── hits_log.csv        # date,symbol,... append-only record of picks
├── success.csv         # forward returns for every logged pick
├── success_summary.csv # win rates / avg returns + universe baseline
└── rss.xml             # daily digest feed
```

### Success check — did the picks work?

Every logged pick is graded against the same git-history bars (close-to-close
forward returns, no lookahead): 5 / 10 / 20-day returns, max run-up and
drawdown within 10 bars. `success_summary.csv` holds the aggregate — pick win
rates vs the universe baseline (average forward 10-day return of every stock
in the archive over the same period). First verdict on the legacy picks
(2026-08-15 → 2026-09-17, 55 picks with a completed 10-day window — still
containing preferred/notes junk flagged by the old detector): 10-day win rate
60.0% vs a 49.1% universe baseline, but an average 10-day return of **−0.01%
vs +4.25% for the universe** — the legacy picks barely moved (avg max run-up
10d +0.38%): low-volatility junk, no magnitude edge. The strict
common-stock-only picks going forward are graded by the same table.

## Daily Screener

> **Live site:** <https://ozkanpakdil.github.io/top-us-stock-tickers/> —
> today's breakout hits, watchlist, and conviction list, rendered from the CSVs below.

A daily breakout screener runs right after the ticker update (same GitHub Action,
`bun run src/screener.ts`). It scans **every US stock** in `tickers/all.csv` for
"trend is friend" candidates — institutions moving in, making new highs, in an
uptrend — and records the results so recurring names surface on a watchlist /
conviction list over time.

**History source:** the git history of `tickers/all.csv` (close = its `price`
column + `volume`, one row per trading day), plus today's working snapshot. There
is no `open`/`high`/`low` in that history, so **gap-up is proxied by the
close-vs-prev-close day change**. VIX (not in `all.csv`) is fetched from Yahoo
(`^VIX`) and used as a global market gate.

**A symbol is a hit when ALL hold:**

1. **VIX < 21** — global market gate.
2. **Close at 20-day high** — `lastClose >= max(close, last 20)`.
3. **Volume spike** — `lastVolume >= 1.5 × avg(volume, last 50)`.
4. **Above 50-day SMA** — `lastClose > SMA50`.
5. **Trend up** — `SMA50 > SMA(long)`, where `long = 200` if ≥200 bars exist,
   else `long = bars.length` if ≥120 bars, else the rule is **skipped** (history
   doesn't reach back far enough yet — the rule tightens automatically as the
   archive grows past 120 then 200 trading days).
6. **Momentum** — `dayChangePct >= 2` (close vs prev close; the gap-up proxy).

All thresholds are top-of-file constants in `src/screener.ts` — edit them there,
no logic changes needed.

**Outputs (all committed to main under `docs/data/screener/`, published to the
GitHub Pages site and rendered by `docs/index.html`):**

```
docs/data/screener/
├── LATEST.csv          # today's hits, overwritten daily
├── hits_log.csv        # date,symbol,score,... append-only time series
├── watchlist_15.csv    # symbols hitting >=8 of last 15 calendar days
└── conviction_30.csv   # symbols hitting >=15 of last 30 calendar days
```

`hits_log.csv` is the screener's persistent record (append-only, idempotent per
day) — same idea as `all.csv`'s git history being the source of truth elsewhere.
Run locally any time:

```bash
bun run screener                 # full run
bun run screener -- --no-vix     # skip the VIX<21 gate (testing)
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
bun run update        # fetch + write the daily CSV snapshots (tickers/, by_industry/)
bun run history-sql   # rebuild tickers/history.sql on demand from git (gitignored)
```

## Notes

- NASDAQ provides the base fields used in every generated CSV: `symbol`, `name`, `price`, `marketCap`, `volume`, `industry`. The `open`, `high`, `low`, and `close` columns are fetched per symbol from the Yahoo Finance chart API; symbols Yahoo cannot resolve (e.g. some share classes or recently delisted tickers) are left with blank OHLC cells rather than failing the run.
- Wikipedia is used only to determine current S&P 500 membership.
- Symbol normalization is required for some share classes, such as `BRK.B` <-> `BRK/B` and `BF.B` <-> `BF/B`.
- The GitHub Actions workflow runs the update automatically on weekdays.


## Web app — daily screener

A static single-page app (`docs/index.html`) renders the daily breakout screener:
today's hits, conviction list, watchlist, and the full append-only hit log. It is
deployed to **GitHub Pages** and runs entirely client-side (fetches CSVs from
`docs/data/screener/`).

### GitHub Pages deployment

The site lives in `docs/` and is deployed by the daily workflow
(`.github/workflows/daily_update.yml`), which uploads `docs/` and deploys it on
every push to `main` (and via `workflow_dispatch`).

The site is live at **<https://ozkanpakdil.github.io/top-us-stock-tickers/>**.

**One-time setup (already done):** the repo's *Settings → Pages → Build and
deployment → Source* is set to **GitHub Actions** (not "Deploy from a branch").
For a new repo, set that, then push to `main` — the site goes live at
`https://<your-user>.github.io/<repo>/`.

### Local development

`bun run dev` runs `src/server.ts`, which serves `docs/` (so you preview the exact
deployed site) **and** keeps two local-only endpoints for live play:

- `/api/tickers` — reads `tickers/all.csv`
- `/api/history` — a server-side proxy to Yahoo Finance (browsers can't call Yahoo
  directly)

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