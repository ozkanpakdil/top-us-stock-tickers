// US Stock Ticker Update — TypeScript/Bun port of update_tickers.py.
//
// Fetches US stock tickers from NASDAQ's stock screener API (NYSE/NASDAQ/AMEX),
// supplements open/high/low/close from Yahoo Finance for the most recent
// completed session, matches an S&P 500 constituent list from Wikipedia, and
// writes market-cap-sorted CSVs (one daily snapshot per run, committed to git).
//
// The full historical SQL dump is NOT maintained here — it is rebuilt on demand
// from the git history of tickers/all.csv by src/gen_history_sql.ts.
//
// Run:  bun run src/update_tickers.ts

import {
  NASDAQ_URL,
  WIKIPEDIA_SP500_RAW_URL,
  HEADERS,
  YAHOO_WORKERS,
  HISTORY_COLUMNS,
  normalizeSymbol,
  parseMarketCap,
  parseNumber,
  parseIntField,
  pyFloatRepr,
  intRepr,
  csvField,
  writeCsv,
  mapLimit,
  fetchYahooChartRaw,
  utcDate,
  sleep,
  ensureDir,
} from "./lib.ts";

// Snapshot CSVs (all.csv, sp500.csv, top_*, by_industry/*) use the history
// columns WITHOUT the `date` column (date only lives in the on-demand
// history.sql built from git by src/gen_history_sql.ts).
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