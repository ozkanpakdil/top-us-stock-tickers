// US Stock Ticker Update — TypeScript/Bun port of update_tickers.py.
//
// Fetches US stock tickers from NASDAQ's stock screener API (NYSE/NASDAQ/AMEX),
// supplements open/high/low/close from Yahoo Finance for the most recent
// completed session, matches an S&P 500 constituent list from Wikipedia, and
// writes market-cap-sorted CSVs. Also appends one dated cross-section to
// tickers/history.csv (idempotent by date) and regenerates tickers/history.sql.
//
// Run:  bun run src/update_tickers.ts

import {
  NASDAQ_URL,
  WIKIPEDIA_SP500_RAW_URL,
  HEADERS,
  YAHOO_WORKERS,
  HISTORY_COLUMNS,
  HISTORY_STRING_COLUMNS,
  HISTORY_CSV_PATH,
  HISTORY_SQL_PATH,
  normalizeSymbol,
  parseMarketCap,
  parseNumber,
  parseIntField,
  pyFloatRepr,
  intRepr,
  csvField,
  readCsv,
  writeCsv,
  mapLimit,
  fetchYahooChartRaw,
  utcDate,
  sleep,
  ensureDir,
} from "./lib.ts";

import { appendFile } from "node:fs/promises";

// Snapshot CSVs (all.csv, sp500.csv, top_*, by_industry/*) use the history
// columns WITHOUT the `date` column (date only lives in history.csv/.sql).
const OUTPUT_COLUMNS = HISTORY_COLUMNS.filter((c) => c !== "date");

const SP500_SYMBOL_RE = /^\|\{\{(?:NyseSymbol|NasdaqSymbol|BZX link)\|([^}|]+)/gm;

interface Ticker {
  symbol: string;
  name: string;
  price: number | null;
  marketCap: number | null;
  volume: number | null;
  industry: string;
}

interface Ohlc {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
}

// --- S&P 500 constituents from Wikipedia (raw wikitext) --------------------

async function fetchSp500Symbols(): Promise<string[]> {
  console.log("Fetching S&P 500 constituents from Wikipedia...");
  await sleep(500 + Math.random() * 1000);
  try {
    const response = await fetch(WIKIPEDIA_SP500_RAW_URL, {
      headers: HEADERS,
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Wikipedia ${response.status}`);
    const content = await response.text();

    const startMarker = "== S&P 500 component stocks ==";
    const endMarker = "== Selected changes to the list of S&P 500 components ==";
    if (!content.includes(startMarker)) {
      throw new Error("Wikipedia page format changed: missing constituents section");
    }
    let section = content.split(startMarker)[1] ?? "";
    if (section.includes(endMarker)) section = section.split(endMarker)[0];

    const symbols: string[] = [];
    const seen = new Set<string>();
    for (const match of section.matchAll(SP500_SYMBOL_RE)) {
      const raw = match[1];
      const normalized = normalizeSymbol(raw);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      symbols.push(raw.trim().toUpperCase());
    }
    if (symbols.length < 450) {
      throw new Error(`Wikipedia parse returned too few symbols: ${symbols.length}`);
    }
    console.log(`  Found ${symbols.length} S&P 500 constituent tickers`);
    return symbols;
  } catch (e) {
    console.log(`  Error: ${e}`);
    return [];
  }
}

// --- NASDAQ screener --------------------------------------------------------

async function fetchTickers(): Promise<{ us: Ticker[]; all: Ticker[] }> {
  console.log("Fetching tickers from NASDAQ...");
  await sleep(500 + Math.random() * 1000);
  try {
    const url = `${NASDAQ_URL}?tableonly=true&download=true`;
    const response = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`NASDAQ ${response.status}`);
    const payload: any = await response.json();
    const rows: any[] = payload?.data?.rows ?? [];
    if (!rows.length) {
      console.log("  No data returned from API");
      return { us: [], all: [] };
    }
    console.log(`  Fetched ${rows.length} tickers from API`);

    const all: Ticker[] = [];
    const us: Ticker[] = [];
    const seen = new Set<string>();
    let nonUs = 0;
    let duplicates = 0;

    for (const row of rows) {
      const symbol = String(row.symbol ?? "").trim();
      if (!symbol || seen.has(symbol)) {
        duplicates++;
        continue;
      }
      seen.add(symbol);
      const ticker: Ticker = {
        symbol,
        name: String(row.name ?? ""),
        price: parseNumber(row.lastsale ?? ""),
        marketCap: parseMarketCap(row.marketCap ?? ""),
        volume: parseIntField(row.volume ?? ""),
        industry: String(row.sector ?? ""),
      };
      all.push(ticker);
      if (row.country === "United States") us.push(ticker);
      else nonUs++;
    }

    console.log(`  Excluded: ${nonUs} non-US, ${duplicates} duplicates`);
    console.log(`  Found ${us.length} unique US tickers`);
    console.log(`  Found ${all.length} total unique listed tickers`);
    return { us, all };
  } catch (e) {
    console.log(`  Error: ${e}`);
    return { us: [], all: [] };
  }
}

// --- Yahoo OHLC (most recent completed session) -----------------------------

async function fetchYahooOhlc(symbol: string): Promise<Ohlc | null> {
  const result = await fetchYahooChartRaw(symbol, { range: "5d", interval: "1d" }, 10000);
  if (!result) return null;
  const timestamps: number[] = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const opens: (number | null)[] = quote.open ?? [];
  const highs: (number | null)[] = quote.high ?? [];
  const lows: (number | null)[] = quote.low ?? [];
  const closes: (number | null)[] = quote.close ?? [];

  for (let i = timestamps.length - 1; i >= 0; i--) {
    const close = closes[i];
    if (close == null) continue;
    return {
      date: utcDate(timestamps[i]),
      open: opens[i] ?? null,
      high: highs[i] ?? null,
      low: lows[i] ?? null,
      close,
    };
  }
  return null;
}

async function fetchOhlcMap(symbols: Iterable<string>): Promise<Map<string, Ohlc>> {
  const list = Array.from(symbols);
  const total = list.length;
  console.log(`\nFetching OHLC for ${total} symbols from Yahoo Finance...`);
  console.log(`  (this is the slowest step; ~${total} requests)`);

  const ohlcMap = new Map<string, Ohlc>();
  await mapLimit(list, YAHOO_WORKERS, async (sym) => {
    const result = await fetchYahooOhlc(sym);
    if (result) ohlcMap.set(sym, result);
    return result;
  }, (done) => {
    if (done % 500 === 0 || done === total) {
      console.log(`  Progress: ${done}/${total} (${ohlcMap.size} with OHLC)`);
    }
  });

  console.log(`  Got OHLC for ${ohlcMap.size}/${total} symbols`);
  return ohlcMap;
}

// --- History archive (CSV + SQL) -------------------------------------------

function snapshotDateFromOhlc(ohlcMap: Map<string, Ohlc>, fallback: string | null): string | null {
  let max: string | null = null;
  for (const v of ohlcMap.values()) {
    if (v?.date && (max === null || v.date > max)) max = v.date;
  }
  return max ?? fallback;
}

function tickerHistoryRow(t: Ticker, o: Ohlc | null, snapshotDate: string): string[] {
  return [
    snapshotDate, // date
    t.symbol, // symbol
    t.name, // name
    pyFloatRepr(t.price), // price
    pyFloatRepr(o?.open ?? null), // open
    pyFloatRepr(o?.high ?? null), // high
    pyFloatRepr(o?.low ?? null), // low
    pyFloatRepr(o?.close ?? null), // close
    pyFloatRepr(t.marketCap), // marketCap
    intRepr(t.volume), // volume
    t.industry, // industry
  ];
}

async function appendHistoryCsv(
  tickers: Ticker[],
  ohlcMap: Map<string, Ohlc>,
  snapshotDate: string,
  path = HISTORY_CSV_PATH,
): Promise<boolean> {
  ohlcMap = ohlcMap ?? new Map();
  ensureDir(path.slice(0, path.lastIndexOf("/")) || ".");

  // Idempotency: skip if the snapshot date is already present.
  if (await Bun.file(path).exists()) {
    try {
      const { header, rows } = await readCsv(path);
      const dateI = header.indexOf("date");
      if (dateI >= 0) {
        const existing = new Set(rows.map((r) => r[dateI] ?? ""));
        if (existing.has(snapshotDate)) {
          console.log(`  history.csv already contains ${snapshotDate}; skipping append`);
          return false;
        }
      }
    } catch {
      // corrupt/empty file → fall through and append
    }
  }

  const dayRows = tickers
    .map((t) => ({ mc: t.marketCap, cells: tickerHistoryRow(t, ohlcMap.get(t.symbol) ?? null, snapshotDate) }))
    .sort((a, b) => {
      const ma = a.mc === null ? -Infinity : a.mc;
      const mb = b.mc === null ? -Infinity : b.mc;
      return mb - ma; // marketCap desc, nulls last
    });

  const exists = await Bun.file(path).exists();
  const body = dayRows.map((r) => r.cells.map(csvField).join(",")).join("\n") + "\n";
  if (!exists) {
    const header = HISTORY_COLUMNS.map(csvField).join(",");
    await Bun.write(path, header + "\n" + body);
  } else {
    await appendFile(path, body, "utf8");
  }
  console.log(`  Appended ${dayRows.length} rows for ${snapshotDate} to ${path}`);
  return true;
}

/** Render a CSV cell of a numeric column as a SQL literal, replicating pandas'
 *  per-column dtype inference: a column is int64 only if every cell is an
 *  integer string and none are empty — otherwise float64. This keeps the SQL
 *  byte-identical to what pandas `str(value)` produced. */
function makeSqlLiteral(dtype: Record<string, "int" | "float">) {
  return (cell: string, col: string): string => {
    if (HISTORY_STRING_COLUMNS.has(col)) {
      return "'" + cell.replace(/'/g, "''") + "'";
    }
    if (cell === "") return "NULL";
    if (dtype[col] === "int") return cell;
    const n = Number(cell);
    if (Number.isNaN(n)) return "NULL";
    return pyFloatRepr(n);
  };
}

export async function generateHistorySql(
  csvPath = HISTORY_CSV_PATH,
  sqlPath = HISTORY_SQL_PATH,
): Promise<boolean> {
  if (!(await Bun.file(csvPath).exists())) {
    console.log("  No history.csv found; skipping SQL generation");
    return false;
  }
  const { header, rows } = await readCsv(csvPath);
  if (!header.length) return false;

  const idx: Record<string, number> = {};
  header.forEach((h, i) => (idx[h] = i));

  // Per-column dtype inference (pandas read_csv behavior).
  const numericCols = HISTORY_COLUMNS.filter((c) => !HISTORY_STRING_COLUMNS.has(c));
  const dtype: Record<string, "int" | "float"> = {};
  for (const c of numericCols) {
    const ci = idx[c];
    let allInt = true;
    let hasEmpty = false;
    for (const r of rows) {
      const cell = r[ci] ?? "";
      if (cell === "") {
        hasEmpty = true;
        continue;
      }
      if (!/^-?\d+$/.test(cell)) allInt = false;
    }
    dtype[c] = allInt && !hasEmpty ? "int" : "float";
  }

  const dateI = idx["date"];
  const mcI = idx["marketCap"];
  const sorted = [...rows].sort((a, b) => {
    const da = a[dateI] ?? "";
    const db = b[dateI] ?? "";
    if (da < db) return -1;
    if (da > db) return 1;
    const ma = (a[mcI] ?? "") === "" ? -Infinity : Number(a[mcI]);
    const mb = (b[mcI] ?? "") === "" ? -Infinity : Number(b[mcI]);
    return mb - ma; // marketCap desc, nulls last
  });

  // Group consecutive rows by date (already sorted by date asc).
  const groups: { date: string; rows: string[][] }[] = [];
  for (const r of sorted) {
    const d = r[dateI];
    if (!groups.length || groups[groups.length - 1].date !== d) {
      groups.push({ date: d, rows: [] });
    }
    groups[groups.length - 1].rows.push(r);
  }

  const lines: string[] = [
    "-- US stock ticker history (auto-generated daily by update_tickers.ts).",
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
  ];

  const sqlLiteral = makeSqlLiteral(dtype);
  let totalRows = 0;
  for (const group of groups) {
    lines.push("INSERT INTO us_tickers (" + HISTORY_COLUMNS.join(", ") + ") VALUES");
    const valueRows = group.rows.map(
      (r) => "    (" + HISTORY_COLUMNS.map((c) => sqlLiteral(r[idx[c]] ?? "", c)).join(", ") + ")",
    );
    totalRows += valueRows.length;
    lines.push(valueRows.join(",\n") + ";");
    lines.push("");
  }

  await Bun.write(sqlPath, lines.join("\n"));
  console.log(`  Wrote ${sqlPath} (${totalRows} rows across ${groups.length} dates)`);
  return true;
}

// --- Filtering + file output -----------------------------------------------

function filterSp500Tickers(tickers: Ticker[], sp500Symbols: string[]): Ticker[] {
  if (!tickers.length || !sp500Symbols.length) return [];
  const sp500Map = new Map(sp500Symbols.map((s) => [normalizeSymbol(s), s]));
  const matched: Ticker[] = [];
  const unmatched = new Set(sp500Map.keys());

  for (const t of tickers) {
    const n = normalizeSymbol(t.symbol);
    if (sp500Map.has(n)) {
      matched.push(t);
      unmatched.delete(n);
    }
  }
  console.log(`  Matched ${matched.length} NASDAQ rows to S&P 500 constituents`);
  if (unmatched.size) {
    const sample = Array.from(unmatched).sort().slice(0, 10).join(", ");
    const suffix = unmatched.size > 10 ? "..." : "";
    console.log(`  Warning: ${unmatched.size} S&P symbols not found in NASDAQ data: ${sample}${suffix}`);
  }
  return matched;
}

/** Build one output row in the exact column order, attaching OHLC. */
function tickerOutputRow(t: Ticker, ohlcMap: Map<string, Ohlc>, industry: string): string[] {
  const o = ohlcMap.get(t.symbol) ?? null;
  return [
    t.symbol,
    t.name,
    pyFloatRepr(t.price),
    pyFloatRepr(o?.open ?? null),
    pyFloatRepr(o?.high ?? null),
    pyFloatRepr(o?.low ?? null),
    pyFloatRepr(o?.close ?? null),
    pyFloatRepr(t.marketCap),
    intRepr(t.volume),
    industry,
  ];
}

function sortByMarketCapDesc(tickers: Ticker[]): Ticker[] {
  return [...tickers].sort((a, b) => {
    const ma = a.marketCap === null ? -Infinity : a.marketCap;
    const mb = b.marketCap === null ? -Infinity : b.marketCap;
    return mb - ma;
  });
}

function safeIndustryFilename(industry: string): string {
  let safe = industry.toLowerCase().replace(/[^\w\s-]/g, "");
  safe = safe.trim().replace(/\s+/g, "_");
  return safe;
}

async function saveFiles(
  tickers: Ticker[],
  sp500Tickers: Ticker[] | null,
  ohlcMap: Map<string, Ohlc>,
): Promise<boolean> {
  if (!tickers.length) {
    console.log("No tickers to save!");
    return false;
  }

  // all.csv: normalize blank industry → Uncategorized, sort by market cap.
  const normalized = tickers.map((t) => ({
    t,
    industry: t.industry.trim() === "" ? "Uncategorized" : t.industry.trim(),
  }));
  const orderedUs = sortByMarketCapDesc(normalized.map((n) => n.t));
  const industryBySymbol = new Map(normalized.map((n) => [n.t.symbol, n.industry]));
  const allRows = orderedUs.map((t) => tickerOutputRow(t, ohlcMap, industryBySymbol.get(t.symbol) ?? "Uncategorized"));

  ensureDir("tickers");
  ensureDir("by_industry");

  console.log("\nSaving ticker lists...");
  await writeCsv("tickers/all.csv", [OUTPUT_COLUMNS, ...allRows]);
  console.log(`  - tickers/all.csv (${allRows.length} rows)`);

  if (sp500Tickers && sp500Tickers.length) {
    const spOrdered = sortByMarketCapDesc(sp500Tickers);
    const spRows = spOrdered.map((t) => tickerOutputRow(t, ohlcMap, t.industry));
    await writeCsv("tickers/sp500.csv", [OUTPUT_COLUMNS, ...spRows]);
    console.log(`  - tickers/sp500.csv (${spRows.length} rows)`);
  }

  for (const n of [50, 100, 200]) {
    await writeCsv(`tickers/top_${n}.csv`, [OUTPUT_COLUMNS, ...allRows.slice(0, n)]);
    console.log(`  - tickers/top_${n}.csv`);
  }

  console.log("\nSaving by industry...");
  // Group by industry in market-cap order, write one file per (alphabetical).
  const byIndustry = new Map<string, string[][]>();
  for (let i = 0; i < orderedUs.length; i++) {
    const ind = industryBySymbol.get(orderedUs[i].symbol) ?? "Uncategorized";
    if (!byIndustry.has(ind)) byIndustry.set(ind, []);
    byIndustry.get(ind)!.push(allRows[i]);
  }
  for (const industry of Array.from(byIndustry.keys()).sort()) {
    const rows = byIndustry.get(industry)!;
    const safe = safeIndustryFilename(industry);
    await writeCsv(`by_industry/${safe}.csv`, [OUTPUT_COLUMNS, ...rows]);
    console.log(`  - by_industry/${safe}.csv (${rows.length} tickers)`);
  }
  return true;
}

// --- main -------------------------------------------------------------------

async function main() {
  console.log("==================================================");
  console.log("US Stock Ticker Update");
  console.log("==================================================");

  const { us: tickers, all: allTickers } = await fetchTickers();
  const sp500Symbols = await fetchSp500Symbols();

  if (!tickers.length) {
    console.log("\nNo data found!");
    process.exit(1);
  }
  if (!sp500Symbols.length) {
    console.log("\nNo S&P 500 data found!");
    process.exit(1);
  }

  const sp500Tickers = filterSp500Tickers(allTickers, sp500Symbols);

  // OHLC for every symbol we will write out (US list + S&P 500 match).
  const ohlcSymbols = new Set<string>();
  for (const t of tickers) ohlcSymbols.add(t.symbol);
  for (const t of sp500Tickers) ohlcSymbols.add(t.symbol);
  const ohlcMap = await fetchOhlcMap(ohlcSymbols);

  const fallback = new Date().toISOString().slice(0, 10);
  const snapshotDate = snapshotDateFromOhlc(ohlcMap, fallback);
  console.log(`\nSnapshot date for history archive: ${snapshotDate}`);

  console.log("\nUpdating history archive...");
  await appendHistoryCsv(tickers, ohlcMap, snapshotDate);
  await generateHistorySql();

  if (await saveFiles(tickers, sp500Tickers, ohlcMap)) {
    console.log("\n==================================================");
    console.log("Update completed!");
    console.log("==================================================");
  } else {
    console.log("\nFailed to save!");
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}