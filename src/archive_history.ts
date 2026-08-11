// OHLC History Archiver — TypeScript/Bun port of archive_history.py.
//
// Builds and maintains a per-ticker historical OHLC archive under `ohlc/`,
// consumed by the static GitHub Pages site via the jsDelivr CDN (the orphan
// `data` branch). Each ticker is written to `ohlc/<SYMBOL>.json`:
//
//   {"symbol":"AAPL","name":"Apple Inc. Common Stock","industry":"Technology",
//    "bars":[["2020-01-02",187.15,188.70,184.00,185.64,82456123], ...]}
//
// Bar = [date(ISO), open, high, low, close, volume], ascending by date.
//
// The archive is resumable / incremental:
//   - missing file  → full backfill (period1=0 … period2=now, or --max-years).
//   - existing file → cheap 3-month window merged in (dedup by date, newest wins).
//
// Failures skip the ticker and preserve any existing file. `docs/data/manifest.json`
// lists only tickers that actually have a file; `docs/data/tickers.json` is the
// full all.csv search index.
//
// Run:  bun run src/archive_history.ts [--only AAPL,MSFT] [--limit N] [--max-years Y] [--workers W]

import { renameSync } from "node:fs";

import {
  safeFilename,
  fetchYahooChartRaw,
  utcDate,
  pyFloatRepr,
  intRepr,
  pyJsonString,
  readCsv,
  mapLimit,
  parseArgs,
  ensureDir,
} from "./lib.ts";

const OHLC_DIR = "ohlc";
const DATA_DIR = "docs/data";
const MANIFEST_PATH = `${DATA_DIR}/manifest.json`;
const TICKERS_JSON_PATH = `${DATA_DIR}/tickers.json`;
const TICKERS_CSV = "tickers/all.csv";
const DEFAULT_WORKERS = 12;

interface ArchiveTicker {
  symbol: string;
  name: string;
  industry: string;
}

type Bar = [string, number, number, number, number, number | null];

// --- Fetch ------------------------------------------------------------------

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function parseFloat(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Fetch daily OHLCV bars for one symbol from Yahoo Finance. Returns ascending
 *  [date, open, high, low, close, volume] bars, or null on hard failure. */
async function fetchHistory(
  symbol: string,
  range: string | null = "max",
  maxYears: number | null = null,
  interval = "1d",
): Promise<Bar[] | null> {
  const params: Record<string, string> = { interval };
  if (range && range !== "max") {
    // Short window (incremental merges): range= returns daily fine.
    params.range = range;
  } else if (maxYears) {
    const now = Math.floor(Date.now() / 1000);
    params.period1 = String(now - Math.floor(Number(maxYears) * 365.25 * 86400));
    params.period2 = String(now);
  } else {
    // Full daily backfill. `range=max` down-samples to monthly for very long
    // histories, so use an explicit period1=0 / period2=now window (full daily).
    params.period1 = "0";
    params.period2 = String(Math.floor(Date.now() / 1000));
  }

  const result = await fetchYahooChartRaw(symbol, params, 20000);
  if (!result) return null;

  const timestamps: number[] = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const opens: (number | null)[] = quote.open ?? [];
  const highs: (number | null)[] = quote.high ?? [];
  const lows: (number | null)[] = quote.low ?? [];
  const closes: (number | null)[] = quote.close ?? [];
  const volumes: (number | null)[] = quote.volume ?? [];

  const bars: Bar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (close == null) continue;
    const vol = parseFloat(volumes[i]);
    bars.push([
      utcDate(timestamps[i]),
      round4(parseFloat(opens[i]) ?? 0),
      round4(parseFloat(highs[i]) ?? 0),
      round4(parseFloat(lows[i]) ?? 0),
      round4(Number(close)),
      vol !== null ? Math.trunc(vol) : null,
    ]);
  }
  return bars;
}

function mergeBars(existing: Bar[], incoming: Bar[]): Bar[] {
  const byDate = new Map<string, Bar>();
  for (const b of existing) byDate.set(b[0], b);
  for (const b of incoming) byDate.set(b[0], b);
  return Array.from(byDate.keys()).sort().map((d) => byDate.get(d)!);
}

// --- Archive file I/O -------------------------------------------------------

async function loadExisting(path: string): Promise<{ bars: Bar[] } | null> {
  if (!(await Bun.file(path).exists())) return null;
  try {
    const data: any = await Bun.file(path).json();
    if (data && Array.isArray(data.bars)) return data;
    return null;
  } catch {
    return null;
  }
}

/** Serialize one archive payload byte-for-byte like Python's
 *  `json.dump(payload, separators=(",",":"))`. OHLC zeros render as "0"
 *  (Python `round(x or 0, 4)` yields int 0), close always renders as a float
 *  ("0.0" for zero), volume renders as a plain integer or null. */
function serializeArchive(symbol: string, name: string, industry: string, bars: Bar[]): string {
  const ohlc = (x: number) => (x === 0 ? "0" : pyFloatRepr(x));
  const barStrs = bars.map((b) => {
    const [d, o, h, l, c, v] = b;
    return `[${pyJsonString(d)},${ohlc(o)},${ohlc(h)},${ohlc(l)},${pyFloatRepr(c)},${
      v === null ? "null" : intRepr(v)
    }]`;
  });
  return (
    `{"symbol":${pyJsonString(symbol)},"name":${pyJsonString(name || "")},` +
    `"industry":${pyJsonString(industry || "")},"bars":[${barStrs.join(",")}]}`
  );
}

async function writeArchive(path: string, symbol: string, name: string, industry: string, bars: Bar[]): Promise<void> {
  ensureDir(path.slice(0, path.lastIndexOf("/")) || ".");
  const tmp = path + ".tmp";
  await Bun.write(tmp, serializeArchive(symbol, name, industry, bars));
  renameSync(tmp, path);
}

async function processTicker(ticker: ArchiveTicker, maxYears: number | null): Promise<string | null> {
  const symbol = ticker.symbol;
  const name = ticker.name;
  const industry = ticker.industry;
  const path = `${OHLC_DIR}/${safeFilename(symbol)}`;

  const existing = await loadExisting(path);
  if (existing && existing.bars.length) {
    // Incremental: top up with a recent 3-month window.
    const fresh = await fetchHistory(symbol, "3mo", null);
    const bars = fresh ? mergeBars(existing.bars, fresh) : existing.bars;
    await writeArchive(path, symbol, name, industry, bars);
    return symbol;
  }

  // Full backfill.
  const bars = await fetchHistory(symbol, "max", maxYears);
  if (!bars || !bars.length) return null; // leave any empty file untouched
  await writeArchive(path, symbol, name, industry, bars);
  return symbol;
}

// --- Index files -----------------------------------------------------------

async function loadTickers(): Promise<ArchiveTicker[]> {
  if (!(await Bun.file(TICKERS_CSV).exists())) return [];
  const { header, rows } = await readCsv(TICKERS_CSV);
  const sI = header.indexOf("symbol");
  const nI = header.indexOf("name");
  const iI = header.indexOf("industry");
  if (sI < 0) return [];
  // all.csv is already sorted by market cap (desc); preserve that order so the
  // biggest names backfill first and the manifest is market-cap ordered.
  return rows
    .map((r) => ({
      symbol: (r[sI] ?? "").trim().toUpperCase(),
      name: nI >= 0 ? (r[nI] ?? "") : "",
      industry: iI >= 0 ? (r[iI] ?? "") : "",
    }))
    .filter((t) => t.symbol);
}

function serializeTickerList(list: ArchiveTicker[]): string {
  return (
    "[" +
    list
      .map(
        (t) =>
          `{"symbol":${pyJsonString(t.symbol)},"name":${pyJsonString(t.name)},"industry":${pyJsonString(t.industry)}}`,
      )
      .join(",") +
    "]"
  );
}

async function buildManifest(archived: Set<string>, tickers: ArchiveTicker[]): Promise<number> {
  const seen = new Set<string>();
  const ordered: ArchiveTicker[] = [];
  for (const t of tickers) {
    if (archived.has(t.symbol) && !seen.has(t.symbol)) {
      seen.add(t.symbol);
      ordered.push(t);
    }
  }
  ensureDir(DATA_DIR);
  await Bun.write(MANIFEST_PATH, serializeTickerList(ordered));
  return ordered.length;
}

async function writeTickerList(tickers: ArchiveTicker[]): Promise<number> {
  ensureDir(DATA_DIR);
  const tmp = TICKERS_JSON_PATH + ".tmp";
  await Bun.write(tmp, serializeTickerList(tickers));
  renameSync(tmp, TICKERS_JSON_PATH);
  return tickers.length;
}

// --- main ------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const strArg = (k: string): string | null => (typeof args[k] === "string" ? (args[k] as string) : null);
  const limit = strArg("limit") !== null ? Number(strArg("limit")) : null;
  const only = strArg("only");
  const maxYearsEnv = process.env.HISTORY_MAX_YEARS;
  let maxYears = strArg("max-years") !== null ? Number(strArg("max-years")) : null;
  if (maxYears === null && maxYearsEnv && Number.isFinite(Number(maxYearsEnv))) {
    maxYears = Number(maxYearsEnv);
  }
  const workers = strArg("workers") !== null ? Number(strArg("workers")) : DEFAULT_WORKERS;

  ensureDir(DATA_DIR);
  ensureDir(OHLC_DIR);

  // Always refresh the full search index first — even if archiving times out,
  // the site's search box ends up with every ticker in all.csv.
  const allTickers = await loadTickers();
  const nList = await writeTickerList(allTickers);
  console.log(`Wrote docs/data/tickers.json (${nList} tickers).`);

  let tickers = allTickers;
  if (only) {
    const wanted = new Set(only.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
    tickers = tickers.filter((t) => wanted.has(t.symbol));
  }
  if (limit && limit > 0) tickers = tickers.slice(0, limit);

  const total = tickers.length;
  console.log(
    `Archiving history for ${total} tickers (max_years=${maxYears ?? "unlimited"}, workers=${workers})...`,
  );

  const archived = new Set<string>();
  await mapLimit(tickers, workers, async (t) => {
    const result = await processTicker(t, maxYears);
    if (result) archived.add(result);
    return result;
  }, (done) => {
    if (done % 200 === 0 || done === total) {
      console.log(`  Progress: ${done}/${total} (${archived.size} archived)`);
    }
  });

  const refreshed = await loadTickers();
  const count = await buildManifest(archived, refreshed);
  console.log(`Done. ${archived.size}/${total} tickers have archives; manifest lists ${count}.`);
}

if (import.meta.main) {
  await main();
}