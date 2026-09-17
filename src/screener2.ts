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
// A symbol is a **hit** only when the hard, computable rules all pass:
// market cap in range, price > $10, employees > 20, above the 12M/200/150-day
// SMAs, and the VCP pattern detected. The fundamental rules (FCF / P/E / EPS
// trends, insiders) are displayed + scored but do not gate — Yahoo data is
// frequently unavailable and they are confirmation signals, not the pattern.
//
// That strictness is the point: a screen that logs ~1,400 partial matches a
// day is not a screen. Hits are a handful (usually 0–10); only hits are
// written to LATEST.csv and hits_log.csv, and a MAX_DAILY_HITS cap guarantees
// the published files (and docs/screener2.html) can never balloon again.
//
// History is rebuilt from the git history of tickers/all.csv (same as screener.ts).
// Yahoo Finance is used for P/E, free cash flow, EPS, and insider holdings data
// that isn't available in all.csv. Legacy hits_log rows that are not VCP picks
// (the old pre-filter-only behaviour) are pruned on the next run.
//
// Outputs (committed to docs/data/screener2/ for GitHub Pages):
//   docs/data/screener2/LATEST.csv          — today's VCP hits (small)
//   docs/data/screener2/hits_log.csv        — date,symbol,... append-only, idempotent per day
//   docs/data/screener2/success.csv         — forward returns for every logged pick
//   docs/data/screener2/success_summary.csv — hit-rate / avg-return summary row
//
// Run:  bun run screener2          (or: bun run src/screener2.ts)
// Flags: --all-csv <path>  snapshot CSV walked in git (default: tickers/all.csv)
//        --no-yahoo        skip Yahoo fundamental fetch (testing — uses history-only rules)
//        --no-employees    skip stockanalysis.com employee gate (testing/CI fallback)

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
  type Bar,
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
export const VCP_REV_PCT = 3.0; // min % reversal to confirm a zigzag pivot (noise floor)
export const VCP_MIN_CONTRACTIONS = 2; // at least 2 contracting pullback waves
export const VCP_MAX_VOLATILITY_RATIO = 0.6; // last pullback ≤ 60% of the first
export const VCP_FIRST_DEPTH_MIN = 4.0; // first pullback must be at least this deep (%)
export const VCP_CEILING_PCT = 7.0; // swing highs flat within this % (the "ceiling")
export const VCP_NEAR_CEILING_PCT = 8; // price must sit within this % under the ceiling
export const VCP_MIN_BASE_BARS = 15; // base must span at least this many bars

// Extra hard filters (all computable from history — zero network cost)
export const NEAR_HIGH_WINDOW = 252; // bars for the 52-week-high proximity check
export const NEAR_HIGH_PCT = 25; // price must sit within 25% of that high (Minervini trend template)
export const MIN_DOLLAR_VOLUME = 5e6; // avg $ turnover (close × volume) over the last 50 bars
export const VCP_VOLUME_DRY_RATIO = 0.9; // avg volume of the last 10 bars ≤ 90% of the base's avg (dry-up)

// Hard-gate + output hygiene
export const MAX_DAILY_HITS = 15; // per-day cap on logged hits (safety valve)
export const MAX_EMPLOYEE_FETCHES = 100; // never fetch employees for more than this
export const MAX_LOG_DAYS = 90; // hits_log keeps a rolling window (full history lives in git)

// Success check: forward returns (trading days) after each logged pick.
export const SUCCESS_HORIZONS = [5, 10, 20] as const;
export const SUCCESS_RUNUP_WINDOW = 10; // bars for max run-up / drawdown

// Output dir
export const OUT_DIR = "docs/data/screener2";

/** Debt instruments, preferred shares, warrants/units/rights are not common
 *  stocks and must not be screened (bonds like EAI "First Mortgage Bonds" and
 *  MFAN "Senior Notes" were surfacing as VCP matches). */
export function isNonCommonStockName(name: string): boolean {
  const n = name.toLowerCase();
  if (/\b(bonds?|notes?|debentures?|preferred|preference|warrants?|rights?|units?|depositary shares)\b/.test(n)) return true;
  if (/\bdue\s+(19|20)\d{2}\b/.test(n)) return true; // "... due 2029"
  if (/%/.test(n) && /\b(due|series|senior|mortgage)\b/.test(n)) return true; // "4.875% Series ..."
  return false;
}

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
 *  Only called for the day's few hits — never for the whole universe. */
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
  volatilityRatio: number; // last pullback / first pullback
  hasHigherLows: boolean;
  hasFlatHighs: boolean;
  lastLow: number | null;
  lastHigh: number | null;
}

/** Zigzag pivot detection: a swing is only confirmed once price reverses by
 *  `revPct` from the running extreme. This keeps 1-day market noise from being
 *  counted as pattern structure — the old 3-bar pivots turned every flat,
 *  frozen chart into dozens of fake "contractions" (the SLAB/OGN bug). */
export function zigzag(
  series: number[],
  revPct: number,
): { index: number; price: number; type: "high" | "low" }[] {
  const pivots: { index: number; price: number; type: "high" | "low" }[] = [];
  if (series.length < 3) return pivots;
  let dir: 0 | 1 | -1 = 0;
  let extIdx = 0;
  for (let i = 1; i < series.length; i++) {
    const p = series[i];
    const ext = series[extIdx];
    if (dir === 0) {
      if (p >= ext * (1 + revPct)) {
        pivots.push({ index: extIdx, price: ext, type: "low" });
        dir = 1;
        extIdx = i;
      } else if (p <= ext * (1 - revPct)) {
        pivots.push({ index: extIdx, price: ext, type: "high" });
        dir = -1;
        extIdx = i;
      } else if (p > ext) extIdx = i;
      else if (p < ext) extIdx = i;
    } else if (dir === 1) {
      if (p > ext) extIdx = i;
      else if (p <= ext * (1 - revPct)) {
        pivots.push({ index: extIdx, price: ext, type: "high" });
        dir = -1;
        extIdx = i;
      }
    } else {
      if (p < ext) extIdx = i;
      else if (p >= ext * (1 + revPct)) {
        pivots.push({ index: extIdx, price: ext, type: "low" });
        dir = 1;
        extIdx = i;
      }
    }
  }
  return pivots;
}

/** Detect a Volatility Contraction Pattern (VCP) in the price series.
 *
 *  A real VCP (Minervini) is a base with 2–4 progressively shallower pullbacks:
 *  - swing highs form a flat "ceiling" (supply absorbed at one level)
 *  - pullback lows rise toward the ceiling (higher lows)
 *  - each pullback is shallower than the previous (volatility contraction)
 *  - price sits just under the ceiling (ready to break out)
 *
 *  Structure comes from percent-based zigzag pivots (VCP_REV_PCT), so a
 *  dead-flat series (SLAB/OGN: ±1.6% over two months) produces no pivots at
 *  all and cannot fake a VCP, and a 2-month base can no longer score "13
 *  contractions" — that was noise. */
export function detectVCP(closes: number[]): VCPResult {
  const fail = { isVCP: false, contractions: 0, volatilityRatio: 0, hasHigherLows: false, hasFlatHighs: false, lastLow: null, lastHigh: null };
  const n = closes.length;
  const lookback = Math.min(VCP_LOOKBACK, n);
  if (lookback < 20) return fail;

  const series = closes.slice(n - lookback);
  const pivots = zigzag(series, VCP_REV_PCT / 100);
  const highs = pivots.filter((p) => p.type === "high");
  const lows = pivots.filter((p) => p.type === "low");
  if (highs.length < 2 || lows.length < 2) return fail; // no real waves in the base

  // Pullback depths: each confirmed swing high to the swing low that follows it.
  const depths: { high: number; low: number; depth: number }[] = [];
  for (let i = 0; i < pivots.length - 1; i++) {
    if (pivots[i].type !== "high") continue;
    const next = pivots[i + 1];
    if (next.type !== "low") continue;
    depths.push({ high: pivots[i].price, low: next.price, depth: (pivots[i].price - next.price) / pivots[i].price });
  }
  if (depths.length < VCP_MIN_CONTRACTIONS + 1) return fail; // first wave + 2 contracting ones

  // Contraction count: successive pullbacks strictly shallower.
  let contractions = 0;
  for (let i = 1; i < depths.length; i++) {
    if (depths[i].depth < depths[i - 1].depth) contractions++;
  }
  if (contractions < VCP_MIN_CONTRACTIONS) return fail;

  const firstDepth = depths[0].depth;
  const lastDepth = depths[depths.length - 1].depth;
  const volatilityRatio = firstDepth > 0 ? lastDepth / firstDepth : 0;
  if (firstDepth < VCP_FIRST_DEPTH_MIN / 100) return fail; // first wave must be a real swing
  if (volatilityRatio > VCP_MAX_VOLATILITY_RATIO) return fail;

  // Higher lows: pullback lows rise toward the ceiling (1% tolerance for noise).
  let hasHigherLows = true;
  for (let i = 1; i < lows.length; i++) {
    if (lows[i].price < lows[i - 1].price * 0.99) {
      hasHigherLows = false;
      break;
    }
  }
  if (!hasHigherLows) return fail;

  // Flat ceiling: swing highs cluster within tolerance of the highest high.
  const highPrices = highs.map((h) => h.price);
  const maxHigh = Math.max(...highPrices);
  const minHigh = Math.min(...highPrices);
  const hasFlatHighs = ((maxHigh - minHigh) / maxHigh) * 100 <= VCP_CEILING_PCT;
  if (!hasFlatHighs) return fail;

  // Price must sit just under the ceiling — a VCP is a breakout *setup*.
  const price = series[series.length - 1];
  if (price < maxHigh * (1 - VCP_NEAR_CEILING_PCT / 100)) return fail;

  // The base must span a real stretch of the lookback (not two pivots in a week).
  const span = pivots[pivots.length - 1].index - pivots[0].index;
  if (span < VCP_MIN_BASE_BARS) return fail;

  return {
    isVCP: true,
    contractions,
    volatilityRatio: Math.round(volatilityRatio * 100) / 100,
    hasHigherLows,
    hasFlatHighs,
    lastLow: lows[lows.length - 1].price,
    lastHigh: maxHigh,
  };
}

// --- screening --------------------------------------------------------------

interface TrendScreen {
  sym: string;
  price: number;
  sma12m: number | null;
  sma200: number | null;
  sma150: number | null;
  sma50: number | null;
  aboveSma12m: boolean;
  aboveSma200: boolean;
  aboveSma150: boolean;
  vcp: VCPResult;
}

/** History-only hard screen: trend gates + VCP pattern. No network involved —
 *  this runs for every symbol so only true setups reach the (slow) fetches.
 *  Extra quality gates beyond the strategy's 12 rules (all free to compute):
 *  above the 50-day SMA, 150-day SMA above the 200-day, price within 25% of
 *  its 52-week high, real dollar liquidity, and volume drying up into the base. */
function trendScreen(sym: string, s: Sym, today: string): TrendScreen | null {
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

  // Long SMAs: target window if history reaches it, else whole-history above the
  // floor, else skip (null — rule not passed but history simply isn't there yet).
  const sma50v = sma(closes, SMA_50);
  const sma150v = bars.length >= SMA_150 ? sma(closes, SMA_150) : (bars.length >= SMA_LONG_FLOOR ? sma(closes, bars.length) : null);
  const sma200v = bars.length >= SMA_200 ? sma(closes, SMA_200) : (bars.length >= SMA_LONG_FLOOR ? sma(closes, bars.length) : null);
  const sma12mV = bars.length >= SMA_12M ? sma(closes, SMA_12M) : (bars.length >= SMA_LONG_FLOOR ? sma(closes, bars.length) : null);

  const aboveSma12m = sma12mV !== null && price > sma12mV;
  const aboveSma200 = sma200v !== null && price > sma200v;
  const aboveSma150 = sma150v !== null && price > sma150v;

  // The three trend gates are hard rules of the strategy.
  if (!aboveSma12m || !aboveSma200 || !aboveSma150) return null;

  // Above the 50-day SMA — mid-term momentum must also be intact.
  const aboveSma50 = sma50v !== null && price > sma50v;
  if (!aboveSma50) return null;

  // Trend structure: the 150-day SMA must sit above the 200-day (only when
  // both are real windows, not whole-history fallbacks).
  if (bars.length >= SMA_200) {
    const s150 = sma(closes, SMA_150);
    const s200 = sma(closes, SMA_200);
    if (s150 === null || s200 === null || s150 <= s200) return null;
  }

  // Near the 52-week high — VCPs break out into new-high territory, not from
  // deep in a downtrend (Minervini's "within 25% of the high" template).
  const highWindow = closes.slice(Math.max(0, closes.length - NEAR_HIGH_WINDOW));
  const high52 = Math.max(...highWindow);
  if (price < high52 * (1 - NEAR_HIGH_PCT / 100)) return null;

  // Real dollar liquidity — weed out illiquid slivers that fake every pattern.
  const recent = bars.slice(-SMA_50);
  const dollarVol = recent.reduce((a, b) => a + b.close * b.volume, 0) / recent.length;
  if (dollarVol < MIN_DOLLAR_VOLUME) return null;

  // VCP pattern — the core rule, also hard.
  const vcp = detectVCP(closes);
  if (!vcp.isVCP) return null;

  // Volume dry-up: a real VCP contracts on volume too — the last 10 bars must
  // trade lighter than the base's average (institutions stop selling).
  const vols = bars.map((b) => b.volume);
  const volRecent = sma(vols, 10);
  const volBase = sma(vols.slice(-VCP_LOOKBACK), VCP_LOOKBACK);
  if (volRecent === null || volBase === null || volBase <= 0 || volRecent > volBase * VCP_VOLUME_DRY_RATIO) return null;

  return {
    sym,
    price,
    sma12m: sma12mV !== null ? Math.round(sma12mV * 100) / 100 : null,
    sma200: sma200v !== null ? Math.round(sma200v * 100) / 100 : null,
    sma150: sma150v !== null ? Math.round(sma150v * 100) / 100 : null,
    sma50: sma50v !== null ? Math.round(sma50v * 100) / 100 : null,
    aboveSma12m,
    aboveSma200,
    aboveSma150,
    vcp,
  };
}

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

/** Build the full hit row (with fundamental columns) for an already-strict setup. */
function buildHitRow(
  ts: TrendScreen,
  s: Sym,
  fundamentals: Fundamentals | null,
  employees: number | null,
): HitRow {
  const { sym, price, vcp } = ts;
  const pe = fundamentals?.pe ?? null;
  const peTrend = fundamentals?.peTrend ?? "unknown";
  const fcf = fundamentals?.freeCashFlow ?? null;
  const fcfTrend = fundamentals?.fcfTrend ?? "unknown";
  const eps = fundamentals?.eps ?? null;
  const epsTrend = fundamentals?.epsTrend ?? "unknown";
  const freeFloatPct = fundamentals?.freeFloatPct ?? null;
  const closelyHeldPct = fundamentals?.closelyHeldPct ?? null;

  // Count rules passed (for scoring/display — the gates above already passed).
  let rulesPassed = 0;
  let rulesTotal = 0;

  // Rule 1: Market cap in range (checked in main with the marketCap map)
  rulesTotal++;

  // Rule 2: Cash flow > 0 (proxy: FCF > 0)
  rulesTotal++;
  if (fcf !== null && fcf > 0) rulesPassed++;

  // Rule 3: Price > 12-month SMA
  rulesTotal++;
  if (ts.aboveSma12m) rulesPassed++;

  // Rule 4: Price > $10
  rulesTotal++;
  if (price > MIN_PRICE) rulesPassed++;

  // Rule 5: Employees > 20
  rulesTotal++;
  if (employees !== null && employees > MIN_EMPLOYEES) rulesPassed++;

  // Rule 6: Price > 200-day SMA
  rulesTotal++;
  if (ts.aboveSma200) rulesPassed++;

  // Rule 7: Price > 150-day SMA
  rulesTotal++;
  if (ts.aboveSma150) rulesPassed++;

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
    sma12m: ts.sma12m,
    sma200: ts.sma200,
    sma150: ts.sma150,
    sma50: ts.sma50,
    aboveSma12m: ts.aboveSma12m,
    aboveSma200: ts.aboveSma200,
    aboveSma150: ts.aboveSma150,
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

const SUCCESS_COLUMNS = [
  "date", "symbol", "industry", "entry", "rulesPassed", "score",
  "ret5", "ret10", "ret20", "maxRunup10", "maxDrawdown10", "win10",
];

const SUCCESS_SUMMARY_COLUMNS = [
  "generatedAt", "gradedPicks", "ungradedPicks",
  "universeAvgRet10", "universeWin10",
  "win5", "win10", "win20",
  "avgRet5", "avgRet10", "avgRet20",
  "avgMaxRunup10", "avgMaxDrawdown10",
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

// --- success check: forward returns for every logged pick --------------------

interface SuccessRow {
  date: string;
  symbol: string;
  industry: string;
  entry: number;
  rulesPassed: number;
  score: number;
  ret5: number | null;
  ret10: number | null;
  ret20: number | null;
  maxRunup10: number | null;
  maxDrawdown10: number | null;
  win10: boolean | null;
}

interface SuccessSummary {
  gradedPicks: number;
  ungradedPicks: number;
  universeAvgRet10: number | null;
  universeWin10: number | null;
  win5: number | null;
  win10: number | null;
  win20: number | null;
  avgRet5: number | null;
  avgRet10: number | null;
  avgRet20: number | null;
  avgMaxRunup10: number | null;
  avgMaxDrawdown10: number | null;
}

const pct = (x: number | null | undefined, d = 2): number | null =>
  x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 100) / 100;

/** Mean of finite values, or null when empty. */
function mean(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x));
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

/** Forward-return evaluation for every logged pick, graded against the same
 *  git-history bars the screener uses (no lookahead: returns start *after*
 *  the pick date's close). A pick is graded once an entry bar exists; each
 *  horizon needs its full window (5/10/20 bars) — otherwise it stays null. */
function evaluateSuccess(
  log: LogRow[],
  symbols: Map<string, Sym>,
  today: string,
): { rows: SuccessRow[]; summary: SuccessSummary } {
  const rows: SuccessRow[] = [];
  let ungraded = 0;

  // date → bar index per symbol (built once).
  const dateIndex = new Map<string, Map<string, number>>();
  for (const [sym, s] of symbols) {
    const m = new Map<string, number>();
    s.bars.forEach((b, i) => m.set(b.date, i));
    dateIndex.set(sym, m);
  }

  // Universe benchmark: average forward 10-bar return over every bar that has
  // 10 bars ahead of it — the "buy anything" baseline for the same period.
  let univSum = 0;
  let univN = 0;
  let univWin = 0;
  for (const s of symbols.values()) {
    const closes = s.bars.map((b) => b.close);
    for (let i = 0; i + 10 < closes.length; i++) {
      const base = closes[i];
      if (!(base > 0)) continue;
      const r = (closes[i + 10] - base) / base;
      univSum += r;
      univN++;
      if (r > 0) univWin++;
    }
  }

  for (const row of log) {
    if (row.date >= today) continue; // today's picks can't be graded yet
    const s = symbols.get(row.symbol);
    const idxMap = dateIndex.get(row.symbol);
    const entryIdx = idxMap?.get(row.date) ?? -1;
    const entry = entryIdx >= 0 ? s!.bars[entryIdx].close : row.close;
    const bars: Bar[] | undefined = s?.bars;
    const forward = entryIdx >= 0 && bars ? bars.slice(entryIdx + 1) : undefined;

    const fwdRet = (h: number): number | null =>
      forward && forward.length >= h && entry > 0 ? ((forward[h - 1].close - entry) / entry) * 100 : null;

    const ret5 = fwdRet(5);
    const ret10 = fwdRet(10);
    const ret20 = fwdRet(20);

    let maxRunup10: number | null = null;
    let maxDrawdown10: number | null = null;
    if (forward && forward.length && entry > 0) {
      const window = forward.slice(0, Math.min(10, forward.length));
      maxRunup10 = pct(Math.max(...window.map((b) => ((b.close - entry) / entry) * 100)));
      maxDrawdown10 = pct(Math.min(...window.map((b) => ((b.close - entry) / entry) * 100)));
    }

    if (!forward || forward.length === 0) ungraded++;

    rows.push({
      date: row.date,
      symbol: row.symbol,
      industry: row.industry,
      entry: Math.round(entry * 100) / 100,
      rulesPassed: row.rulesPassed,
      score: row.score,
      ret5: pct(ret5),
      ret10: pct(ret10),
      ret20: pct(ret20),
      maxRunup10,
      maxDrawdown10,
      win10: ret10 !== null ? ret10 > 0 : null,
    });
  }

  // Per-horizon stats: each horizon is graded only over picks whose window
  // completed (ret != null) — no silent mixing of partial windows into rates.
  const winRate = (key: "ret5" | "ret10" | "ret20"): number | null => {
    const graded = rows.filter((r) => r[key] !== null);
    if (!graded.length) return null;
    const wins = graded.filter((r) => (r[key] as number) > 0).length;
    return Math.round((wins / graded.length) * 10000) / 100;
  };

  const summary: SuccessSummary = {
    gradedPicks: rows.filter((r) => r.ret10 !== null).length,
    ungradedPicks: ungraded,
    universeAvgRet10: univN ? Math.round((univSum / univN) * 10000) / 100 : null,
    universeWin10: univN ? Math.round((univWin / univN) * 10000) / 100 : null,
    win5: winRate("ret5"),
    win10: winRate("ret10"),
    win20: winRate("ret20"),
    avgRet5: pct(mean(rows.map((r) => r.ret5))),
    avgRet10: pct(mean(rows.map((r) => r.ret10))),
    avgRet20: pct(mean(rows.map((r) => r.ret20))),
    avgMaxRunup10: pct(mean(rows.map((r) => r.maxRunup10))),
    avgMaxDrawdown10: pct(mean(rows.map((r) => r.maxDrawdown10))),
  };

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { rows, summary };
}

// --- main -------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const allCsv = typeof args["all-csv"] === "string" ? (args["all-csv"] as string) : "tickers/all.csv";
  const noYahoo = args["no-yahoo"] === true;
  const noEmployees = args["no-employees"] === true;

  ensureDir(OUT_DIR);
  const today = new Date().toISOString().slice(0, 10);

  console.log(`=== VCP Screener (screener-2) — ${today} ===`);

  // History
  const symbols = await buildHistory(allCsv, today);

  // Market caps from working CSV
  const marketCaps = readMarketCaps(allCsv);
  console.log(`  Market caps loaded for ${marketCaps.size} symbols.`);

  // 1) History-only hard screen — no network. Only true VCP setups survive.
  const setups: TrendScreen[] = [];
  let skippedNonStock = 0;
  for (const [sym, s] of symbols) {
    if (isNonCommonStockName(s.name)) {
      skippedNonStock++;
      continue;
    }
    const mc = marketCaps.get(sym);
    if (mc === undefined) continue; // no market cap data
    if (mc < MIN_MARKET_CAP || mc > MAX_MARKET_CAP) continue;
    const ts = trendScreen(sym, s, today);
    if (!ts) continue;
    if (ts.price < MIN_PRICE) continue;
    setups.push(ts);
  }
  console.log(`  VCP setups (market cap + price + all SMAs + pattern): ${setups.length} (skipped ${skippedNonStock} bonds/preferred/warrants/units).`);

  // Safety valve: never process/publish more than MAX_DAILY_HITS per day.
  // (TrendScreen has no score yet; order by contractions + tightness as a tiebreak.)
  const capped = [...setups]
    .sort((a, b) =>
      (b.vcp.contractions * 2 + (1 - b.vcp.volatilityRatio) * 3) -
      (a.vcp.contractions * 2 + (1 - a.vcp.volatilityRatio) * 3))
    .slice(0, MAX_EMPLOYEE_FETCHES);

  // 2) Employees for the survivors only (weed-out rule).
  const symbolsMap = symbols;
  const empMap = new Map<string, number | null>();
  let afterEmployees = capped;
  if (noEmployees) {
    console.log("  Employee gate skipped (--no-employees).");
  } else {
    console.log(`Fetching employee counts for ${capped.length} setups...`);
    for (const [sym, emp] of await fetchEmployeeCounts(capped.map((t) => t.sym), 10)) {
      empMap.set(sym, emp ?? null);
    }
    afterEmployees = capped.filter((t) => {
      const emp = empMap.get(t.sym) ?? null;
      if (emp !== null && emp > MIN_EMPLOYEES) return true;
      console.log(`    dropped ${t.sym} (employees ${emp === null ? "unknown" : emp} ≤ ${MIN_EMPLOYEES})`);
      return false;
    });
    console.log(`  After employee filter (> ${MIN_EMPLOYEES}): ${afterEmployees.length} setups.`);
  }

  // 3) Yahoo fundamentals for the few survivors only (score enrichment).
  const fundamentalsMap = new Map<string, Fundamentals>();
  if (!noYahoo && afterEmployees.length) {
    console.log(`Fetching Yahoo fundamentals for ${afterEmployees.length} setups...`);
    const fetched = await fetchFundamentalsBatch(afterEmployees.map((t) => t.sym), 8);
    for (const [sym, f] of fetched) fundamentalsMap.set(sym, f);
    let fcfFound = 0;
    for (const [, f] of fundamentalsMap) if (f.freeCashFlow !== null) fcfFound++;
    console.log(`  FCF data: ${fcfFound}/${afterEmployees.length} found.`);
  }

  // 4) Final hits (already strict: market cap, price, employees, SMAs, VCP).
  const hits: HitRow[] = [];
  for (const ts of afterEmployees) {
    const s = symbolsMap.get(ts.sym);
    if (!s) continue;
    const fund = fundamentalsMap.get(ts.sym) ?? null;
    const emp = noEmployees ? null : (empMap.get(ts.sym) ?? null);
    const hit = buildHitRow(ts, s, fund, emp);
    if (hit.marketCap === null) hit.marketCap = marketCaps.get(ts.sym) ?? null;
    // Rule 1 (market cap in range) — the pre-filter guarantees it; count it.
    if (hit.marketCap !== null && hit.marketCap >= MIN_MARKET_CAP && hit.marketCap <= MAX_MARKET_CAP) {
      hit.rulesPassed++;
    }
    hits.push(hit);
  }
  hits.sort((a, b) => b.score - a.score || b.rulesPassed - a.rulesPassed);
  if (hits.length > MAX_DAILY_HITS) hits.length = MAX_DAILY_HITS;

  // Write LATEST.csv (hits only — the screener's small daily list).
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

  // Append to hits_log.csv (idempotent: drop today's rows first; prune legacy
  // rows that were never VCP picks; keep a rolling MAX_LOG_DAYS window — the
  // full history stays in the git history of this file).
  const logPath = `${OUT_DIR}/hits_log.csv`;
  const existingLog = readHitsLog(logPath).filter((r) => r.date !== today);
  const cutoffMs = new Date(today + "T00:00:00Z").getTime() - MAX_LOG_DAYS * 86400000;
  const prunedCount = existingLog.filter((r) => !r.vcp).length;
  const expiredCount = existingLog.filter((r) => r.vcp && new Date(r.date + "T00:00:00Z").getTime() < cutoffMs).length;
  const keptLog = existingLog.filter((r) => r.vcp && new Date(r.date + "T00:00:00Z").getTime() >= cutoffMs);
  if (prunedCount > 0) console.log(`  Pruning ${prunedCount} legacy non-VCP rows from hits_log.csv (partial matches the old build logged).`);
  if (expiredCount > 0) console.log(`  Dropping ${expiredCount} rows older than the ${MAX_LOG_DAYS}-day window (history stays in git).`);
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
  const allLog = keptLog.map((r) => [
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

  // 5) Success check — forward returns for every logged pick (history only).
  const fullLog = readHitsLog(logPath);
  const { rows: successRows, summary: successSummary } = evaluateSuccess(fullLog, symbolsMap, today);
  await Bun.write(
    `${OUT_DIR}/success.csv`,
    toCsv(SUCCESS_COLUMNS, successRows.map((r) => [
      r.date, r.symbol, r.industry, r.entry, r.rulesPassed, r.score,
      r.ret5 ?? "", r.ret10 ?? "", r.ret20 ?? "",
      r.maxRunup10 ?? "", r.maxDrawdown10 ?? "",
      r.win10 === null ? "" : r.win10,
    ])),
  );
  await Bun.write(
    `${OUT_DIR}/success_summary.csv`,
    toCsv(SUCCESS_SUMMARY_COLUMNS, [[
      today, successSummary.gradedPicks, successSummary.ungradedPicks,
      successSummary.universeAvgRet10 ?? "", successSummary.universeWin10 ?? "",
      successSummary.win5 ?? "", successSummary.win10 ?? "", successSummary.win20 ?? "",
      successSummary.avgRet5 ?? "", successSummary.avgRet10 ?? "", successSummary.avgRet20 ?? "",
      successSummary.avgMaxRunup10 ?? "", successSummary.avgMaxDrawdown10 ?? "",
    ]]),
  );

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
  console.log(`Screener-2 ${today}: ${hits.length} VCP hits (max ${MAX_DAILY_HITS}/day).`);
  if (successRows.length) {
    const graded = successSummary.gradedPicks;
    console.log(`  Success check: ${successRows.length} logged picks, ${graded} with a completed 10-day window.`);
    console.log(`    pick win rates — 5d: ${successSummary.win5 ?? "?"}%  10d: ${successSummary.win10 ?? "?"}%  20d: ${successSummary.win20 ?? "?"}%`);
    console.log(`    avg return     — 5d: ${fmtPct(successSummary.avgRet5)}  10d: ${fmtPct(successSummary.avgRet10)}  20d: ${fmtPct(successSummary.avgRet20)}`);
    console.log(`    avg max run-up 10d: ${fmtPct(successSummary.avgMaxRunup10)}  avg max drawdown 10d: ${fmtPct(successSummary.avgMaxDrawdown10)}`);
    console.log(`    universe baseline avg 10d return: ${fmtPct(successSummary.universeAvgRet10)} (win rate ${successSummary.universeWin10 ?? "?"}%)`);
  }
  if (hits.length) {
    console.log("  Today's hits:");
    for (const h of hits) {
      const mcStr = h.marketCap !== null ? `$${(h.marketCap / 1e9).toFixed(1)}B` : "?";
      console.log(
        `    ${h.symbol.padEnd(8)} ${h.rulesPassed}/${h.rulesTotal} rules  score ${h.score}  ${mcStr}  ${h.contractions}c  vol×${h.volatilityRatio}  PE↑:${h.peTrend === "up" ? "✓" : "✗"}  FCF↑:${h.fcfTrend === "up" ? "✓" : "✗"}  EPS↑:${h.epsTrend === "up" ? "✓" : "✗"}  ${h.industry}`,
      );
    }
  }
}

function fmtPct(x: number | null): string {
  return x === null ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;
}

if (import.meta.main) {
  await main();
}