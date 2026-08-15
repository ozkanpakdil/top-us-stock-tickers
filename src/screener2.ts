// VCP (Volatility Contraction Pattern) screener — "screener-2".
//
// Implements the stock-selection strategy described by Mark Minervini and
// popularised by the "stock talk" guru:
//
//   1. Market cap between $2B and $100B  (sweet spot for explosive % moves)
//   2. Cash flow > 0                     (business is making money)
//   3. Price > 12-month SMA              (long-term macro uptrend — "wind in sails")
//   4. Price > $10                       (institutional money barrier)
//   5. Employees > 20                    (weed out shell companies)
//   6. Price > 200-day SMA               (confirmed long-term uptrend)
//   7. Price > 150-day SMA               (no local consolidation below 150)
//   8. P/E ratio trending upwards        (expanding valuation momentum)
//   9. VCP chart pattern                 (higher lows + flat/ceiling highs = contraction)
//  10. Insiders holding (free float low) (confidence signal)
//  11. Free cash flow trending upwards   (making more money each quarter)
//  12. EPS trending upwards              (shareholders making more money)
//
// History is rebuilt from the git history of tickers/all.csv (same as screener.ts).
// Yahoo Finance is used for P/E, free cash flow, EPS, and insider holdings data
// that isn't available in all.csv.
//
// Outputs (committed to docs/data/screener2/ for GitHub Pages):
//   docs/data/screener2/LATEST.csv   — today's passing stocks
//   docs/data/screener2/hits_log.csv — date,symbol,... append-only, idempotent per day
//
// Run:  bun run screener2          (or: bun run src/screener2.ts)
// Flags: --all-csv <path>  snapshot CSV walked in git (default: tickers/all.csv)
//        --no-yahoo        skip Yahoo fundamental fetch (testing — uses history-only rules)

import { readFileSync } from "node:fs";
import {
  parseCsv,
  parseNumber,
  parseMarketCap,
  fetchYahooChartRaw,
  ensureDir,
  parseArgs,
} from "./lib.ts";
import { generateRssFromLog } from "./rss.ts";
import {
  buildHistory,
  sma,
  toCsv,
  fetchEmployeeCounts,
  type Sym,
} from "./screener.ts";

// --- Tunable criteria (edit here) -------------------------------------------

export const MIN_MARKET_CAP = 2e9; // $2B lower bound
export const MAX_MARKET_CAP = 100e9; // $100B upper bound (adjust up to 500B if desired)
export const MIN_PRICE = 10; // no stocks below $10
export const MIN_EMPLOYEES = 20; // weed out shell companies
export const SMA_12M = 252; // ~12-month trading days
export const SMA_200 = 200;
export const SMA_150 = 150;
export const SMA_50 = 50;
export const SMA_LONG_FLOOR = 120; // below this many bars, long SMA rules are skipped
export const MIN_BARS = 50; // need at least SMA50 to screen
export const MAX_AGE_DAYS = 4; // drop stale symbols
export const VCP_LOOKBACK = 60; // bars to examine for VCP pattern
export const VCP_MIN_CONTRACTIONS = 2; // at least 2 contraction waves
export const VCP_MAX_VOLATILITY_RATIO = 0.6; // latest wave ≤ 60% of prior wave
export const VCP_TOLERANCE_PCT = 2.0; // highs within this % are "flat ceiling"

// Output dir
export const OUT_DIR = "docs/data/screener2";

// --- Yahoo fundamental data -------------------------------------------------

interface Fundamentals {
  pe: number | null;
  peTrend: "up" | "down" | "flat" | "unknown";
  freeCashFlow: number | null;
  fcfTrend: "up" | "down" | "flat" | "unknown";
  eps: number | null;
  epsTrend: "up" | "down" | "flat" | "unknown";
  freeFloatPct: number | null; // % of shares not closely held
  closelyHeldPct: number | null;
}

/** Fetch fundamentals from Yahoo Finance quote summary.
 *  Yahoo's v8 chart endpoint includes some metadata; for deeper fundamentals
 *  we scrape the quoteSummary modules. */
async function fetchFundamentals(symbol: string): Promise<Fundamentals> {
  const empty: Fundamentals = {
    pe: null, peTrend: "unknown",
    freeCashFlow: null, fcfTrend: "unknown",
    eps: null, epsTrend: "unknown",
    freeFloatPct: null, closelyHeldPct: null,
  };

  try {
    // Use the chart endpoint for trailing P/E and EPS (available in summaryDetail)
    const chart = await fetchYahooChartRaw(symbol, { range: "1d", interval: "1d" });
    if (chart?.meta) {
      const meta = chart.meta;
      empty.pe = meta.trailingPE ?? meta.forwardPE ?? null;
      empty.eps = meta.epsTrailingTwelveMonths ?? meta.epsForward ?? null;
    }
  } catch {
    // continue — partial data is fine
  }

  // Fetch quoteSummary for free cash flow, float, and P/E trend data
  // We use the v10 quoteSummary endpoint with multiple modules
  try {
    const sym = symbol.toUpperCase().replace(/\./g, "-").replace(/\//g, "-");
    const modules = ["summaryDetail", "financialData", "defaultKeyStatistics", "incomeStatementHistory"];
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=${modules.join(",")}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const payload: any = await res.json();
      const qs = payload?.quoteSummary?.result?.[0];
      if (qs) {
        // Free cash flow
        const fin = qs.financialData ?? {};
        empty.freeCashFlow = fin.freeCashflow?.raw ?? null;

        // Free float / closely held
        const keys = qs.defaultKeyStatistics ?? {};
        empty.freeFloatPct = keys.floatHeldByInsiders ? (1 - (keys.floatHeldByInsiders.raw ?? 0)) * 100 : null;
        // If we have heldPercentInsiders
        const heldInsiders = keys.heldPercentInsiders?.raw ?? null;
        if (heldInsiders !== null) {
          empty.closelyHeldPct = heldInsiders * 100;
          empty.freeFloatPct = (1 - heldInsiders) * 100;
        }

        // P/E from summaryDetail (more reliable)
        if (empty.pe === null) {
          empty.pe = qs.summaryDetail?.trailingPE?.raw ?? qs.summaryDetail?.forwardPE?.raw ?? null;
        }
      }
    }
  } catch {
    // partial data
  }

  // Fetch historical P/E trend and FCF trend from income statement / cash flow
  // We approximate "trending up" by comparing recent vs prior values from
  // the incomeStatementHistory and cashflowStatementHistory modules.
  try {
    const sym = symbol.toUpperCase().replace(/\./g, "-").replace(/\//g, "-");
    const modules = ["incomeStatementHistory", "cashflowStatementHistory", "earningsTrend"];
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=${modules.join(",")}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const payload: any = await res.json();
      const qs = payload?.quoteSummary?.result?.[0];

      // EPS trend from incomeStatementHistory
      const income = qs?.incomeStatementHistory?.incomeStatementHistory;
      if (Array.isArray(income) && income.length >= 2) {
        const epsValues = income
          .map((s: any) => s.netIncome?.raw && s.dilutedEPS ? s.dilutedEPS.raw : null)
          .filter((v: number | null) => v !== null);
        if (epsValues.length >= 2) {
          const recent = epsValues[0];
          const prior = epsValues[epsValues.length - 1];
          if (recent > prior * 1.05) empty.epsTrend = "up";
          else if (recent < prior * 0.95) empty.epsTrend = "down";
          else empty.epsTrend = "flat";
        }
      }

      // Earnings trend (analyst estimates trending up)
      const et = qs?.earningsTrend?.trend;
      if (Array.isArray(et) && et.length >= 2) {
        const peTrendVals = et.map((t: any) => t.earningsEstimate?.avgEstimate?.raw).filter((v: any) => v != null);
        if (peTrendVals.length >= 2) {
          if (peTrendVals[0] > peTrendVals[peTrendVals.length - 1] * 1.05) empty.epsTrend = "up";
        }
      }

      // Free cash flow trend from cashflowStatementHistory
      const cashflow = qs?.cashflowStatementHistory?.cashflowStatements;
      if (Array.isArray(cashflow) && cashflow.length >= 2) {
        const fcfVals = cashflow
          .map((s: any) => {
            const op = s.totalCashFromOperatingActivities?.raw ?? null;
            const capex = s.capitalExpenditures?.raw ?? null;
            if (op !== null && capex !== null) return op + capex; // capex is negative
            return null;
          })
          .filter((v: number | null) => v !== null);
        if (fcfVals.length >= 2) {
          const recent = fcfVals[0];
          const prior = fcfVals[fcfVals.length - 1];
          if (recent > prior * 1.05) empty.fcfTrend = "up";
          else if (recent < prior * 0.95) empty.fcfTrend = "down";
          else empty.fcfTrend = "flat";
        }
      }
    }
  } catch {
    // partial data
  }

  // P/E trend: we approximate by checking if trailingPE > forwardPE was increasing
  // Since we can't easily get historical P/E, we use earningsTrend as a proxy
  // If EPS is trending up and price is trending up, P/E is likely trending up
  // We'll mark it as "up" if epsTrend is "up" (price above SMA confirms price trend)
  if (empty.peTrend === "unknown") {
    empty.peTrend = empty.epsTrend === "up" ? "up" : "unknown";
  }

  return empty;
}

/** Fetch fundamentals for a list of symbols with limited concurrency. */
async function fetchFundamentalsBatch(
  symbols: string[],
  concurrency = 8,
): Promise<Map<string, Fundamentals>> {
  const result = new Map<string, Fundamentals>();
  let next = 0;
  const total = symbols.length;
  const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (true) {
      const i = next++;
      if (i >= total) break;
      const sym = symbols[i];
      result.set(sym, await fetchFundamentals(sym));
    }
  });
  await Promise.all(workers);
  return result;
}

// --- VCP pattern detection --------------------------------------------------

interface VCPResult {
  isVCP: boolean;
  contractions: number;
  volatilityRatio: number; // latest wave / prior wave
  hasHigherLows: boolean;
  hasFlatHighs: boolean;
  lastLow: number | null;
  lastHigh: number | null;
}

/** Detect a Volatility Contraction Pattern (VCP) in the price series.
 *
 *  VCP = a series of contraction waves where:
 *  - Each wave has a low and a high
 *  - Lows are getting higher (higher lows)
 *  - Highs are roughly flat (within tolerance — a "ceiling")
 *  - Each successive wave's amplitude is smaller than the prior (volatility contraction)
 *
 *  We look at the last `VCP_LOOKBACK` bars, find swing lows and swing highs,
 *  and check the pattern. */
function detectVCP(closes: number[]): VCPResult {
  const n = closes.length;
  const lookback = Math.min(VCP_LOOKBACK, n);
  if (lookback < 20) {
    return { isVCP: false, contractions: 0, volatilityRatio: 0, hasHigherLows: false, hasFlatHighs: false, lastLow: null, lastHigh: null };
  }

  const series = closes.slice(n - lookback);

  // Find swing highs and lows using a simple pivot detection (3-bar)
  const pivots: { index: number; price: number; type: "high" | "low" }[] = [];
  for (let i = 1; i < series.length - 1; i++) {
    if (series[i] > series[i - 1] && series[i] > series[i + 1]) {
      pivots.push({ index: i, price: series[i], type: "high" });
    } else if (series[i] < series[i - 1] && series[i] < series[i + 1]) {
      pivots.push({ index: i, price: series[i], type: "low" });
    }
  }

  const highs = pivots.filter((p) => p.type === "high");
  const lows = pivots.filter((p) => p.type === "low");

  if (highs.length < 2 || lows.length < 2) {
    return { isVCP: false, contractions: 0, volatilityRatio: 0, hasHigherLows: false, hasFlatHighs: false, lastLow: null, lastHigh: null };
  }

  // Check higher lows: each successive low should be higher than the previous
  let hasHigherLows = true;
  for (let i = 1; i < lows.length; i++) {
    if (lows[i].price < lows[i - 1].price * 0.99) {
      hasHigherLows = false;
      break;
    }
  }

  // Check flat highs: highs should be within tolerance of each other (ceiling)
  const highPrices = highs.map((h) => h.price);
  const maxHigh = Math.max(...highPrices);
  const minHigh = Math.min(...highPrices);
  const hasFlatHighs = (maxHigh - minHigh) / maxHigh * 100 <= VCP_TOLERANCE_PCT + 5; // slightly relaxed

  // Calculate contraction waves: pair each high with the adjacent low
  // A wave = high to next low (or low to next high). We measure amplitude.
  const waves: { amplitude: number }[] = [];
  const sortedPivots = [...pivots].sort((a, b) => a.index - b.index);
  for (let i = 0; i < sortedPivots.length - 1; i++) {
    const a = sortedPivots[i];
    const b = sortedPivots[i + 1];
    if (a.type !== b.type) {
      waves.push({ amplitude: Math.abs(a.price - b.price) / a.price });
    }
  }

  // Count contractions: successive waves with decreasing amplitude
  let contractions = 0;
  for (let i = 1; i < waves.length; i++) {
    if (waves[i].amplitude < waves[i - 1].amplitude) {
      contractions++;
    }
  }

  // Volatility ratio: latest wave / prior wave
  let volatilityRatio = 0;
  if (waves.length >= 2) {
    const last = waves[waves.length - 1].amplitude;
    const prev = waves[waves.length - 2].amplitude;
    volatilityRatio = prev > 0 ? last / prev : 0;
  }

  const lastLow = lows.length ? lows[lows.length - 1].price : null;
  const lastHigh = highs.length ? highs[highs.length - 1].price : null;

  const isVCP =
    hasHigherLows &&
    hasFlatHighs &&
    contractions >= VCP_MIN_CONTRACTIONS &&
    volatilityRatio > 0 &&
    volatilityRatio <= VCP_MAX_VOLATILITY_RATIO;

  return { isVCP, contractions, volatilityRatio, hasHigherLows, hasFlatHighs, lastLow, lastHigh };
}

// --- screening --------------------------------------------------------------

interface HitRow {
  symbol: string;
  name: string;
  industry: string;
  close: number;
  marketCap: number | null;
  sma12m: number | null;
  sma200: number | null;
  sma150: number | null;
  sma50: number | null;
  aboveSma12m: boolean;
  aboveSma200: boolean;
  aboveSma150: boolean;
  vcp: boolean;
  contractions: number;
  volatilityRatio: number;
  pe: number | null;
  peTrend: string;
  fcf: number | null;
  fcfTrend: string;
  eps: number | null;
  epsTrend: string;
  freeFloatPct: number | null;
  closelyHeldPct: number | null;
  employees: number | null;
  score: number;
  rulesPassed: number;
  rulesTotal: number;
}

/** Screen one symbol against the VCP strategy rules. */
function screenSymbol(
  sym: string,
  s: Sym,
  today: string,
  fundamentals: Fundamentals | null,
  employees: number | null,
): HitRow | null {
  const bars = s.bars;
  if (bars.length < MIN_BARS) return null;

  // Recency gate
  const last = bars[bars.length - 1];
  const ageDays = Math.round(
    (new Date(today + "T00:00:00Z").getTime() - new Date(last.date + "T00:00:00Z").getTime()) / 86400000,
  );
  if (ageDays > MAX_AGE_DAYS) return null;

  const closes = bars.map((b) => b.close);
  const price = last.close;

  // Market cap — we need to get this from the latest snapshot, not from history.
  // The all.csv working file has marketCap. We'll pass it in via the Sym metadata.
  // Since Sym doesn't carry marketCap, we read it from the working CSV separately.
  // For now, we'll use a separate map passed in. See main() for that.
  // Here we just use the close as a proxy and filter later.
  // Actually, let's read marketCap from the working file in main() and pass it.

  // SMAs
  const sma50v = sma(closes, SMA_50);
  const sma150v = bars.length >= SMA_150 ? sma(closes, SMA_150) : (bars.length >= SMA_LONG_FLOOR ? sma(closes, bars.length) : null);
  const sma200v = bars.length >= SMA_200 ? sma(closes, SMA_200) : (bars.length >= SMA_LONG_FLOOR ? sma(closes, bars.length) : null);
  const sma12mV = bars.length >= SMA_12M ? sma(closes, SMA_12M) : (bars.length >= SMA_LONG_FLOOR ? sma(closes, bars.length) : null);

  const aboveSma12m = sma12mV !== null && price > sma12mV;
  const aboveSma200 = sma200v !== null && price > sma200v;
  const aboveSma150 = sma150v !== null && price > sma150v;

  // VCP pattern
  const vcp = detectVCP(closes);

  // Fundamentals
  const pe = fundamentals?.pe ?? null;
  const peTrend = fundamentals?.peTrend ?? "unknown";
  const fcf = fundamentals?.freeCashFlow ?? null;
  const fcfTrend = fundamentals?.fcfTrend ?? "unknown";
  const eps = fundamentals?.eps ?? null;
  const epsTrend = fundamentals?.epsTrend ?? "unknown";
  const freeFloatPct = fundamentals?.freeFloatPct ?? null;
  const closelyHeldPct = fundamentals?.closelyHeldPct ?? null;

  // Count rules passed (for scoring, not hard filtering — we want to see partial matches)
  let rulesPassed = 0;
  let rulesTotal = 0;

  // Rule 1: Market cap in range (checked in main with marketCap map)
  // We'll count it here based on a passed-in value — for now skip, handle in main
  rulesTotal++;

  // Rule 2: Cash flow > 0 (proxy: FCF > 0)
  rulesTotal++;
  if (fcf !== null && fcf > 0) rulesPassed++;

  // Rule 3: Price > 12-month SMA
  rulesTotal++;
  if (aboveSma12m) rulesPassed++;

  // Rule 4: Price > $10
  rulesTotal++;
  if (price > MIN_PRICE) rulesPassed++;

  // Rule 5: Employees > 20
  rulesTotal++;
  if (employees !== null && employees > MIN_EMPLOYEES) rulesPassed++;

  // Rule 6: Price > 200-day SMA
  rulesTotal++;
  if (aboveSma200) rulesPassed++;

  // Rule 7: Price > 150-day SMA
  rulesTotal++;
  if (aboveSma150) rulesPassed++;

  // Rule 8: P/E trending up
  rulesTotal++;
  if (peTrend === "up") rulesPassed++;

  // Rule 9: VCP pattern
  rulesTotal++;
  if (vcp.isVCP) rulesPassed++;

  // Rule 10: Insiders holding (free float < 70% or closely held > 20%)
  rulesTotal++;
  if (freeFloatPct !== null && freeFloatPct < 70) rulesPassed++;
  else if (closelyHeldPct !== null && closelyHeldPct > 20) rulesPassed++;

  // Rule 11: FCF trending up
  rulesTotal++;
  if (fcfTrend === "up") rulesPassed++;

  // Rule 12: EPS trending up
  rulesTotal++;
  if (epsTrend === "up") rulesPassed++;

  // Score: weighted combination of rules passed + VCP quality
  const vcpScore = vcp.isVCP ? (vcp.contractions * 2 + (1 - vcp.volatilityRatio) * 3) : 0;
  const score = Math.round((rulesPassed + vcpScore) * 100) / 100;

  return {
    symbol: sym,
    name: s.name,
    industry: s.industry,
    close: price,
    marketCap: null, // filled in main
    sma12m: sma12mV !== null ? Math.round(sma12mV * 100) / 100 : null,
    sma200: sma200v !== null ? Math.round(sma200v * 100) / 100 : null,
    sma150: sma150v !== null ? Math.round(sma150v * 100) / 100 : null,
    sma50: sma50v !== null ? Math.round(sma50v * 100) / 100 : null,
    aboveSma12m,
    aboveSma200,
    aboveSma150,
    vcp: vcp.isVCP,
    contractions: vcp.contractions,
    volatilityRatio: Math.round(vcp.volatilityRatio * 100) / 100,
    pe: pe !== null ? Math.round(pe * 100) / 100 : null,
    peTrend,
    fcf: fcf,
    fcfTrend,
    eps: eps !== null ? Math.round(eps * 100) / 100 : null,
    epsTrend,
    freeFloatPct: freeFloatPct !== null ? Math.round(freeFloatPct * 100) / 100 : null,
    closelyHeldPct: closelyHeldPct !== null ? Math.round(closelyHeldPct * 100) / 100 : null,
    employees,
    score,
    rulesPassed,
    rulesTotal,
  };
}

// --- market cap from working CSV --------------------------------------------

/** Read market cap for each symbol from the working all.csv snapshot. */
function readMarketCaps(allCsv: string): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const text = readFileSync(allCsv, "utf8");
    const parsed = parseCsv(text);
    if (parsed.length < 2) return map;
    const [header, ...rows] = parsed;
    const idx: Record<string, number> = {};
    header.forEach((h, i) => (idx[h] = i));
    if (idx.symbol === undefined || idx.marketCap === undefined) return map;
    for (const r of rows) {
      const sym = (r[idx.symbol] ?? "").trim().toUpperCase();
      if (!sym) continue;
      const mc = parseMarketCap(r[idx.marketCap]);
      if (mc !== null) map.set(sym, mc);
    }
  } catch {
    // file missing
  }
  return map;
}

// --- CSV output -------------------------------------------------------------

const LATEST_COLUMNS = [
  "symbol", "name", "industry", "close", "marketCap",
  "aboveSma12m", "aboveSma200", "aboveSma150",
  "vcp", "contractions", "volatilityRatio",
  "pe", "peTrend", "fcf", "fcfTrend", "eps", "epsTrend",
  "freeFloatPct", "closelyHeldPct", "employees",
  "rulesPassed", "rulesTotal", "score",
];

const HITS_LOG_COLUMNS = [
  "date", "symbol", "industry", "close", "marketCap",
  "vcp", "contractions", "volatilityRatio",
  "pe", "peTrend", "fcfTrend", "epsTrend",
  "freeFloatPct", "closelyHeldPct", "employees",
  "rulesPassed", "score",
];

// --- hits log ---------------------------------------------------------------

interface LogRow {
  date: string;
  symbol: string;
  industry: string;
  close: number;
  marketCap: number | null;
  vcp: boolean;
  contractions: number;
  volatilityRatio: number;
  pe: number | null;
  peTrend: string;
  fcfTrend: string;
  epsTrend: string;
  freeFloatPct: number | null;
  closelyHeldPct: number | null;
  employees: number | null;
  rulesPassed: number;
  score: number;
}

function readHitsLog(path: string): LogRow[] {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const parsed = parseCsv(text);
  if (parsed.length <= 1) return [];
  const [header, ...rows] = parsed;
  const idx: Record<string, number> = {};
  header.forEach((h, i) => (idx[h] = i));
  const out: LogRow[] = [];
  for (const r of rows) {
    if (!r.length) continue;
    out.push({
      date: r[idx.date] ?? "",
      symbol: r[idx.symbol] ?? "",
      industry: r[idx.industry] ?? "",
      close: parseNumber(r[idx.close]) ?? 0,
      marketCap: idx.marketCap !== undefined ? parseNumber(r[idx.marketCap]) : null,
      vcp: r[idx.vcp] === "true",
      contractions: idx.contractions !== undefined ? (parseNumber(r[idx.contractions]) ?? 0) : 0,
      volatilityRatio: idx.volatilityRatio !== undefined ? (parseNumber(r[idx.volatilityRatio]) ?? 0) : 0,
      pe: idx.pe !== undefined ? parseNumber(r[idx.pe]) : null,
      peTrend: idx.peTrend !== undefined ? r[idx.peTrend] : "unknown",
      fcfTrend: idx.fcfTrend !== undefined ? r[idx.fcfTrend] : "unknown",
      epsTrend: idx.epsTrend !== undefined ? r[idx.epsTrend] : "unknown",
      freeFloatPct: idx.freeFloatPct !== undefined ? parseNumber(r[idx.freeFloatPct]) : null,
      closelyHeldPct: idx.closelyHeldPct !== undefined ? parseNumber(r[idx.closelyHeldPct]) : null,
      employees: idx.employees !== undefined ? parseNumber(r[idx.employees]) : null,
      rulesPassed: idx.rulesPassed !== undefined ? (parseNumber(r[idx.rulesPassed]) ?? 0) : 0,
      score: idx.score !== undefined ? (parseNumber(r[idx.score]) ?? 0) : 0,
    });
  }
  return out;
}

// --- main -------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const allCsv = typeof args["all-csv"] === "string" ? (args["all-csv"] as string) : "tickers/all.csv";
  const noYahoo = args["no-yahoo"] === true;

  ensureDir(OUT_DIR);
  const today = new Date().toISOString().slice(0, 10);

  console.log(`=== VCP Screener (screener-2) — ${today} ===`);

  // History
  const symbols = await buildHistory(allCsv, today);

  // Market caps from working CSV
  const marketCaps = readMarketCaps(allCsv);
  console.log(`  Market caps loaded for ${marketCaps.size} symbols.`);

  // Pre-filter by market cap and price to reduce Yahoo calls
  const candidates: string[] = [];
  for (const [sym, s] of symbols) {
    const bars = s.bars;
    if (bars.length < MIN_BARS) continue;
    const last = bars[bars.length - 1];
    const ageDays = Math.round(
      (new Date(today + "T00:00:00Z").getTime() - new Date(last.date + "T00:00:00Z").getTime()) / 86400000,
    );
    if (ageDays > MAX_AGE_DAYS) continue;

    const mc = marketCaps.get(sym);
    if (mc === undefined) continue; // no market cap data
    if (mc < MIN_MARKET_CAP || mc > MAX_MARKET_CAP) continue;
    if (last.close < MIN_PRICE) continue;

    candidates.push(sym);
  }
  console.log(`  After market cap + price filter: ${candidates.length} candidates.`);

  // Fetch employee counts for candidates
  console.log(`Fetching employee counts for ${candidates.length} candidates...`);
  const empMap = await fetchEmployeeCounts(candidates, 10);
  let empFound = 0;
  for (const sym of candidates) {
    if (empMap.get(sym) !== null) empFound++;
  }
  console.log(`  Employee counts: ${empFound}/${candidates.length} found.`);

  // Filter by employees
  const afterEmployees = candidates.filter((sym) => {
    const emp = empMap.get(sym);
    return emp !== null && emp > MIN_EMPLOYEES;
  });
  console.log(`  After employee filter (> ${MIN_EMPLOYEES}): ${afterEmployees.length} candidates.`);

  // Fetch fundamentals from Yahoo
  let fundamentalsMap = new Map<string, Fundamentals>();
  if (!noYahoo) {
    console.log(`Fetching Yahoo fundamentals for ${afterEmployees.length} symbols...`);
    fundamentalsMap = await fetchFundamentalsBatch(afterEmployees, 8);
    let fcfFound = 0;
    for (const [, f] of fundamentalsMap) {
      if (f.freeCashFlow !== null) fcfFound++;
    }
    console.log(`  FCF data: ${fcfFound}/${afterEmployees.length} found.`);
  }

  // Screen all candidates (we keep partial matches for the table, but score them)
  const hits: HitRow[] = [];
  let screened = 0;
  for (const sym of afterEmployees) {
    const s = symbols.get(sym);
    if (!s) continue;
    screened++;
    const fund = fundamentalsMap.get(sym) ?? null;
    const emp = empMap.get(sym) ?? null;
    const hit = screenSymbol(sym, s, today, fund, emp);
    if (hit) {
      hit.marketCap = marketCaps.get(sym) ?? null;
      // Recount rule 1 (market cap in range)
      if (hit.marketCap !== null && hit.marketCap >= MIN_MARKET_CAP && hit.marketCap <= MAX_MARKET_CAP) {
        hit.rulesPassed++;
      }
      hits.push(hit);
    }
  }

  // Sort by score (rules passed + VCP quality)
  hits.sort((a, b) => b.score - a.score || b.rulesPassed - a.rulesPassed);

  // Write LATEST.csv
  const latestRows = hits.map((h) => [
    h.symbol, h.name, h.industry, h.close,
    h.marketCap !== null ? h.marketCap : "",
    h.aboveSma12m, h.aboveSma200, h.aboveSma150,
    h.vcp, h.contractions, h.volatilityRatio,
    h.pe ?? "", h.peTrend,
    h.fcf ?? "", h.fcfTrend,
    h.eps ?? "", h.epsTrend,
    h.freeFloatPct ?? "", h.closelyHeldPct ?? "",
    h.employees ?? "",
    h.rulesPassed, h.rulesTotal, h.score,
  ]);
  await Bun.write(`${OUT_DIR}/LATEST.csv`, toCsv(LATEST_COLUMNS, latestRows));

  // Append to hits_log.csv (idempotent: drop today's rows first)
  const logPath = `${OUT_DIR}/hits_log.csv`;
  const existingLog = readHitsLog(logPath).filter((r) => r.date !== today);
  const newLogRows = hits.map((h) => [
    today, h.symbol, h.industry, h.close,
    h.marketCap !== null ? h.marketCap : "",
    h.vcp, h.contractions, h.volatilityRatio,
    h.pe ?? "", h.peTrend,
    h.fcfTrend, h.epsTrend,
    h.freeFloatPct ?? "", h.closelyHeldPct ?? "",
    h.employees ?? "",
    h.rulesPassed, h.score,
  ]);
  const allLog = existingLog.map((r) => [
    r.date, r.symbol, r.industry, r.close,
    r.marketCap ?? "",
    r.vcp, r.contractions, r.volatilityRatio,
    r.pe ?? "", r.peTrend,
    r.fcfTrend, r.epsTrend,
    r.freeFloatPct ?? "", r.closelyHeldPct ?? "",
    r.employees ?? "",
    r.rulesPassed, r.score,
  ]);
  await Bun.write(logPath, toCsv(HITS_LOG_COLUMNS, [...allLog, ...newLogRows]));

  // RSS feed — one item per day with that day's top results.
  const rssDays = await generateRssFromLog({
    title: "VCP Screener-2 — Volatility Contraction Pattern",
    description: "Daily VCP screener scanning US stocks for Minervini-style volatility contraction patterns with fundamental confirmation.",
    outPath: `${OUT_DIR}/rss.xml`,
    siteUrl: "https://ozkanpakdil.github.io/top-us-stock-tickers",
    pagePath: "screener2.html",
    dataDir: "data/screener2",
  });
  console.log(`  RSS feed: ${rssDays} days → ${OUT_DIR}/rss.xml`);

  // Summary
  console.log("---");
  console.log(`Screener-2 ${today}: screened ${screened} symbols, ${hits.length} results.`);
  const vcpHits = hits.filter((h) => h.vcp);
  console.log(`  VCP pattern matches: ${vcpHits.length}`);
  const fullPass = hits.filter((h) => h.rulesPassed >= h.rulesTotal - 2);
  console.log(`  Near-complete pass (≥ ${hits[0]?.rulesTotal - 2 ?? 0} / ${hits[0]?.rulesTotal ?? 0} rules): ${fullPass.length}`);
  if (hits.length) {
    console.log("  Top results:");
    for (const h of hits.slice(0, 15)) {
      const mcStr = h.marketCap !== null ? `$${(h.marketCap / 1e9).toFixed(1)}B` : "?";
      console.log(
        `    ${h.symbol.padEnd(8)} ${h.rulesPassed}/${h.rulesTotal} rules  score ${h.score}  ${mcStr}  VCP:${h.vcp ? "✓" : "✗"}  PE↑:${h.peTrend === "up" ? "✓" : "✗"}  FCF↑:${h.fcfTrend === "up" ? "✓" : "✗"}  EPS↑:${h.epsTrend === "up" ? "✓" : "✗"}  ${h.industry}`,
      );
    }
  }
}

if (import.meta.main) {
  await main();
}