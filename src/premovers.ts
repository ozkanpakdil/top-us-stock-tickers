// Premovers — try to catch "tomorrow's VEEA" one day early.
//
// Motivation: on 2026-09-15 the breakout screener caught VEEA +222% AFTER the move.
// Looking one day earlier (2026-09-14) the setup was already visible in this repo's
// own git history of tickers/all.csv: a tiny name that had repriced ~17x, then
// consolidated two weeks in a tight range on drying volume, and on the day before
// the explosion printed a modest +12.8% on a clear volume uptick — invisible to the
// breakout screener because its 50-day volume average was poisoned by the
// pre-reverse-split share units (20x) and the Aug-27/28 spikes.
//
// What this script does:
//   1. Rebuilds the full daily panel (close, volume, marketCap) from the git history
//      of tickers/all.csv — the same source of truth as the screener, plus marketCap.
//   2. Cleans it: reverse/forward splits detected via marketCap-implied share counts
//      (volume units re-scaled) and "repricing artifacts" (|return| > 100% without
//      volume confirmation) are bridged, so returns stay economically meaningful.
//   3. Builds, for every eligible (symbol, day T), a feature vector using ONLY data
//      <= T, with label = next-day (T -> T+1) adjusted return >= RET_TARGET.
//   4. Trains a logistic-regression ranker strictly walk-forward (train on the past,
//      score the next CHUNK_DAYS days, repeat — no lookahead) and evaluates
//      precision@K, lift vs baseline, and whether past big movers appeared in the
//      top-K the day before (incl. a dedicated VEEA 2026-09-14 check).
//   5. Live mode trains on all history through today and scores every eligible
//      symbol for TOMORROW:
//        docs/data/screener/premovers.csv        — today's candidates, overwritten daily
//        docs/data/screener/premovers_log.csv    — append-only record (for later grading)
//      Backtest mode also writes:
//        docs/data/screener/premovers_backtest.csv — per-day top-10 with realized outcomes
//
// Run:  bun run premovers                 (live scoring)
//       bun run premovers -- --backtest   (walk-forward evaluation)
// Flags: --all-csv <path>   snapshot CSV walked in git (default tickers/all.csv)

import {
  parseCsv,
  parseNumber,
  parseIntField,
  ensureDir,
  parseArgs,
} from "./lib.ts";
import {
  snapshotCommits,
  showAt,
  columnIndex,
  toCsv,
  OUT_DIR,
} from "./screener.ts";
import { readFileSync } from "node:fs";

// --- Tunables (edit here, no logic changes needed) --------------------------

export let RET_TARGET = 0.2; // label: next-day adjusted return >= 20% (--ret-target overrides)
export const MIN_PRICE = 1.0; // skip sub-$1 junk (reverse-split zombies)
export const MIN_VOL_TODAY = 10_000; // a tradeable day
export const MIN_AVG_VOL_20 = 5_000; // some liquidity in the past month
export const WARMUP = 60; // bars needed before the first feature row
export const CHUNK_DAYS = 10; // walk-forward: retrain every N trading days
export const SPLIT_SHARES_TOL = 0.25; // implied-share change > 25% => corporate action
export const ARTIFACT_RET = 1.0; // |1-day return| > 100% ...
export const ARTIFACT_VOL_MULT = 1.5; // ... without 1.5x avg volume => bridged as artifact
export const MAX_ARTIFACTS = 3; // more than this => drop the symbol (garbage data)
export const MIN_UNIVERSE = 150; // a test day needs at least this many eligible rows
export let EARLY_MAX_TODAY_RET = 0.2; // "early pool": symbol moved less than +20% today
export let EARLY_MIN_TODAY_RET = -1; // optional floor (--early-min, e.g. -0.15 skips crash-continuation names)
export const TOP_N_LIVE = 25; // rows written to premovers.csv
export const TOP_N_BT = 5; // rows written per day to premovers_backtest.csv

// Logistic regression
export const EPOCHS = 250;
export const LR0 = 0.5;
export const L2 = 1e-4;
export const MOMENTUM = 0.9;

export const PREMOVERS_CSV = `${OUT_DIR}/premovers.csv`;
export const PREMOVERS_LOG = `${OUT_DIR}/premovers_log.csv`;
export const BACKTEST_CSV = `${OUT_DIR}/premovers_backtest.csv`;

// --- Panel build (git history + working snapshot, with marketCap) -----------

interface RawRow {
  date: string;
  symbol: string;
  close: number;
  volume: number;
  mcap: number;
}
export interface SymPanel {
  symbol: string;
  name: string;
  industry: string;
  date: string[];
  close: number[];
  volume: number[];
  mcap: number[];
}

/** Parse one snapshot into rows; close = `price`, plus marketCap. */
function parseSnapshotFull(text: string, date: string): RawRow[] {
  const parsed = parseCsv(text);
  if (parsed.length === 0) return [];
  const [header, ...rows] = parsed;
  const idx = columnIndex(header);
  if (idx.symbol === undefined || idx.price === undefined) return [];
  const out: RawRow[] = [];
  for (const r of rows) {
    const symbol = (r[idx.symbol] ?? "").trim().toUpperCase();
    if (!symbol) continue;
    const close = parseNumber(idx.price !== undefined ? r[idx.price] : "");
    if (close === null) continue;
    const volume = parseIntField(idx.volume !== undefined ? r[idx.volume] : "") ?? 0;
    const mcap = idx.marketCap !== undefined ? (parseNumber(r[idx.marketCap]) ?? 0) : 0;
    out.push({ date, symbol, close, volume, mcap });
  }
  return out;
}

/** Build per-symbol panels from git history of all.csv + the working snapshot.
 *  Newest row per (date, symbol) wins, mirroring src/screener.ts buildHistory. */
export function buildPanels(allCsv: string): Map<string, SymPanel> {
  const commits = snapshotCommits(allCsv);
  console.log(`Walking ${commits.length} snapshot commits of ${allCsv}...`);
  const latest = new Map<string, RawRow>(); // date\0symbol -> newest row

  for (const { hash, date } of commits) {
    const text = showAt(hash, allCsv);
    const iso = new Date(date).toISOString().slice(0, 10);
    for (const row of parseSnapshotFull(text, iso)) {
      latest.set(`${row.date}\0${row.symbol}`, row);
    }
  }
  // Working snapshot overlay (not yet committed), mirroring the screener.
  try {
    const text = readFileSync(allCsv, "utf8");
    const lastCommitDate = commits.length ? new Date(commits[commits.length - 1].date).toISOString().slice(0, 10) : "";
    for (const row of parseSnapshotFull(text, lastCommitDate)) {
      latest.set(`${row.date}\0${row.symbol}`, row);
    }
  } catch {
    // working file missing — history ends at last commit
  }

  // Recover name/industry from the newest snapshot containing the symbol.
  const lastName = new Map<string, string>();
  const lastIndustry = new Map<string, string>();
  for (let c = commits.length - 1; c >= 0 && lastName.size < latest.size; c--) {
    const parsed = parseCsv(showAt(commits[c].hash, allCsv));
    if (!parsed.length) continue;
    const idx = columnIndex(parsed[0]);
    if (idx.symbol === undefined) continue;
    for (const r of parsed.slice(1)) {
      const sym = (r[idx.symbol] ?? "").trim().toUpperCase();
      if (!sym) continue;
      if (idx.name !== undefined && r[idx.name] && !lastName.has(sym)) lastName.set(sym, r[idx.name]);
      if (idx.industry !== undefined && r[idx.industry] && !lastIndustry.has(sym)) lastIndustry.set(sym, r[idx.industry]);
    }
  }

  const panels = new Map<string, SymPanel>();
  for (const [key, row] of latest) {
    const symbol = key.slice(key.indexOf("\0") + 1);
    let p = panels.get(symbol);
    if (!p) {
      p = {
        symbol,
        name: lastName.get(symbol) ?? "",
        industry: lastIndustry.get(symbol) ?? "",
        date: [],
        close: [],
        volume: [],
        mcap: [],
      };
      panels.set(symbol, p);
    }
    p.date.push(row.date);
    p.close.push(row.close);
    p.volume.push(row.volume);
    p.mcap.push(row.mcap);
  }
  // Sort each panel by date (same-date duplicates and the working overlay can
  // otherwise land out of order).
  for (const p of panels.values()) {
    const order = p.date
      .map((d, i) => [d, i] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    p.date = order.map(([, i]) => p.date[i]);
    p.close = order.map(([, i]) => p.close[i]);
    p.volume = order.map(([, i]) => p.volume[i]);
    p.mcap = order.map(([, i]) => p.mcap[i]);
  }
  return panels;
}

// --- Cleaning: split-aware adjustment ---------------------------------------

function sharesFar(r: number): boolean {
  return r < 1 - SPLIT_SHARES_TOL || r > 1 + SPLIT_SHARES_TOL;
}

/** In-place cleaning for one panel; returns the number of bridged artifacts.
 *
 *  Step 1 — volume units: marketCap/price = implied shares outstanding. When
 *  implied shares step by > SPLIT_SHARES_TOL (and the new count persists), all
 *  earlier volumes are re-scaled into the new share units — a 1-for-20 reverse
 *  split makes every pre-split volume 20x inflated, which poisons all volume
 *  averages for months.
 *  Step 2 — repricing artifacts: a >100% one-day return without volume
 *  confirmation is bridged to ~0% (the quote jumped, the tape didn't). */
export function cleanPanel(p: SymPanel): number {
  const n = p.close.length;
  const shares = p.mcap.map((m, i) => (m > 0 && p.close[i] > 0 ? m / p.close[i] : 0));

  for (let i = 1; i < n; i++) {
    const s0 = shares[i - 1];
    const s1 = shares[i];
    if (s0 <= 0 || s1 <= 0) continue;
    const ratio = s1 / s0;
    if (!sharesFar(ratio)) continue;
    if (i + 1 < n && shares[i + 1] > 0 && sharesFar(shares[i + 1] / s1)) continue; // one-day noise
    for (let j = 0; j < i; j++) p.volume[j] = p.volume[j] * ratio;
  }

  let artifacts = 0;
  for (let i = 1; i < n; i++) {
    const prev = p.close[i - 1];
    if (prev <= 0) continue;
    const ret = p.close[i] / prev - 1;
    if (Math.abs(ret) <= ARTIFACT_RET) continue;
    let sum = 0;
    let cnt = 0;
    for (let j = Math.max(0, i - 20); j < i; j++) {
      sum += p.volume[j];
      cnt++;
    }
    const avg = cnt ? sum / cnt : 0;
    if (avg > 0 && p.volume[i] < ARTIFACT_VOL_MULT * avg) {
      const f = p.close[i] / prev;
      for (let j = 0; j < i; j++) p.close[j] *= f;
      artifacts++;
      if (artifacts > MAX_ARTIFACTS) return artifacts; // hopeless series
    }
  }
  return artifacts;
}

// --- Features ----------------------------------------------------------------

export const FEATURE_NAMES = [
  "r1", // 1-day return
  "r5", // 5-day return
  "r10", // 10-day return
  "r20", // 20-day return
  "big20", // biggest 1-day return in the last 20 days
  "sinceBig", // days since that jump (0-19) / 20
  "tight10", // (max-min)/close over the last 10 closes — contraction
  "tight20", // same over 20 closes
  "volr", // today's volume / avg(volume, 20)
  "dry5", // avg(volume, last 5) / avg(volume, 50) — dry-up
  "uptick", // today's volume / avg(volume, the 5 days before today)
  "nearHigh", // close / max(close, last 20)
  "smaDev20", // close / SMA20 - 1
  "smaDev50", // close / SMA50 - 1
  "runup", // close / min(close, last 60) - 1
  "upStreak", // consecutive up closes (capped at 10)
  "logMcap", // log10 marketCap
  "logVol", // log10 avg volume (20d)
];
const F = FEATURE_NAMES.length;

export function sumOf(a: number[], from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i];
  return s;
}
export function avgOf(a: number[], from: number, to: number): number {
  if (to <= from) return 0;
  return sumOf(a, from, to) / (to - from);
}

/** Compute the feature vector for panel index i (requires i >= WARMUP-1). */
export function featuresAt(p: SymPanel, i: number, out: Float64Array): boolean {
  const n = p.close.length;
  if (i < WARMUP - 1 || i >= n) return false;
  const c = p.close[i];
  if (!(c > 0)) return false;

  out[0] = c / p.close[i - 1] - 1;
  out[1] = c / p.close[Math.max(0, i - 5)] - 1;
  out[2] = c / p.close[Math.max(0, i - 10)] - 1;
  out[3] = c / p.close[Math.max(0, i - 20)] - 1;

  let big = 0;
  let bigAt = i;
  for (let j = Math.max(1, i - 19); j <= i; j++) {
    const r = p.close[j] / p.close[j - 1] - 1;
    if (r > big) {
      big = r;
      bigAt = j;
    }
  }
  out[4] = big;
  out[5] = (i - bigAt) / 20;

  let max10 = -Infinity;
  let min10 = Infinity;
  let max20 = -Infinity;
  let min20 = Infinity;
  for (let j = Math.max(0, i - 19); j <= i; j++) {
    if (p.close[j] > max20) max20 = p.close[j];
    if (p.close[j] < min20) min20 = p.close[j];
    if (j >= i - 9) {
      if (p.close[j] > max10) max10 = p.close[j];
      if (p.close[j] < min10) min10 = p.close[j];
    }
  }
  out[6] = (max10 - min10) / c;
  out[7] = (max20 - min20) / c;

  const v20 = avgOf(p.volume, Math.max(0, i - 19), i + 1);
  const v50 = avgOf(p.volume, Math.max(0, i - 49), i + 1);
  const v5 = avgOf(p.volume, Math.max(0, i - 4), i + 1);
  const vPrev5 = avgOf(p.volume, Math.max(0, i - 9), Math.max(0, i - 4));
  out[8] = v20 > 0 ? p.volume[i] / v20 : 0;
  out[9] = v50 > 0 ? v5 / v50 : 0;
  out[10] = vPrev5 > 0 ? p.volume[i] / vPrev5 : 0;

  out[11] = max20 > 0 ? c / max20 : 0;

  let s20 = 0;
  let s50 = 0;
  for (let j = Math.max(0, i - 19); j <= i; j++) s20 += p.close[j];
  for (let j = Math.max(0, i - 49); j <= i; j++) s50 += p.close[j];
  const n20 = i - Math.max(0, i - 19) + 1;
  const n50 = i - Math.max(0, i - 49) + 1;
  out[12] = s20 / n20 > 0 ? c / (s20 / n20) - 1 : 0;
  out[13] = s50 / n50 > 0 ? c / (s50 / n50) - 1 : 0;

  let min60 = Infinity;
  for (let j = Math.max(0, i - 59); j <= i; j++) if (p.close[j] < min60) min60 = p.close[j];
  out[14] = Number.isFinite(min60) && min60 > 0 ? c / min60 - 1 : 0;

  let streak = 0;
  for (let j = i; j > 0; j--) {
    if (p.close[j] > p.close[j - 1]) streak++;
    else break;
  }
  out[15] = Math.min(streak, 10) / 10;

  out[16] = p.mcap[i] > 0 ? Math.log10(p.mcap[i]) : 0;
  out[17] = v20 > 0 ? Math.log10(v20) : 0;
  return true;
}

// --- Dataset -----------------------------------------------------------------

export interface RowMeta {
  symbol: string;
  date: string;
  todayRet: number; // the symbol's own move ON day T (0 = flat day)
  fwdRet: number; // next-day adjusted return
  fwdVol: number; // next-day volume (informational)
  close: number;
  mcap: number;
  name: string;
  industry: string;
}

/** Build the full labeled dataset: one row per eligible symbol-day with a
 *  computable next-day return. The final day of each panel has no label and is
 *  only used in live scoring mode (via scoreRows below). */
export function buildDataset(panels: Map<string, SymPanel>): {
  X: Float64Array;
  y: Float64Array;
  rows: RowMeta[];
  dates: string[];
} {
  const datesSet = new Set<string>();
  for (const p of panels.values()) for (const d of p.date) datesSet.add(d);
  const dates = [...datesSet].sort();
  const dateIdx = new Map<string, number>();
  dates.forEach((d, i) => dateIdx.set(d, i));

  const Xs: number[] = [];
  const ys: number[] = [];
  const rows: RowMeta[] = [];
  const feat = new Float64Array(F);

  for (const p of panels.values()) {
    const n = p.close.length;
    for (let i = WARMUP - 1; i < n; i++) {
      const c = p.close[i];
      if (!(c >= MIN_PRICE)) continue;
      if (p.volume[i] < MIN_VOL_TODAY) continue;
      const v20 = avgOf(p.volume, Math.max(0, i - 19), i + 1);
      if (v20 < MIN_AVG_VOL_20) continue;
      if (i + 1 >= n || !(p.close[i + 1] > 0)) continue; // no label yet
      const fwdRet = p.close[i + 1] / c - 1;
      if (!featuresAt(p, i, feat)) continue;
      for (let f = 0; f < F; f++) Xs.push(feat[f]);
      ys.push(fwdRet >= RET_TARGET ? 1 : 0);
      rows.push({
        symbol: p.symbol,
        date: p.date[i],
        todayRet: feat[0],
        fwdRet,
        fwdVol: p.volume[i + 1],
        close: c,
        mcap: p.mcap[i],
        name: p.name,
        industry: p.industry,
      });
    }
  }
  const n = rows.length;
  return { X: Float64Array.from(Xs), y: Float64Array.from(ys), rows, dates: dates.filter((d) => dateIdx.has(d)) };
}

/** Score-only rows for one panel (features at index i, no label). */
export function scoreRowFor(p: SymPanel, i: number): { feat: Float64Array; close: number; mcap: number; todayRet: number } | null {
  const feat = new Float64Array(F);
  if (!featuresAt(p, i, feat)) return null;
  const c = p.close[i];
  if (!(c >= MIN_PRICE)) return null;
  if (p.volume[i] < MIN_VOL_TODAY) return null;
  const v20 = avgOf(p.volume, Math.max(0, i - 19), i + 1);
  if (v20 < MIN_AVG_VOL_20) return null;
  return { feat, close: c, mcap: p.mcap[i], todayRet: feat[0] };
}

// --- Logistic regression -----------------------------------------------------

function sigmoid(z: number): number {
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
}

export interface Model {
  w: Float64Array;
  b: number;
  mean: Float64Array;
  std: Float64Array;
}

/** Standardize features with the TRAINING set stats, then full-batch GD. */
export function trainLR(X: Float64Array, y: Float64Array, trainIdx: Int32Array | number[]): Model {
  const n = trainIdx.length;
  const mean = new Float64Array(F);
  const std = new Float64Array(F);
  for (let k = 0; k < n; k++) {
    const i = trainIdx[k];
    for (let f = 0; f < F; f++) mean[f] += X[i * F + f];
  }
  if (n > 0) for (let f = 0; f < F; f++) mean[f] /= n;
  for (let k = 0; k < n; k++) {
    const i = trainIdx[k];
    for (let f = 0; f < F; f++) {
      const d = X[i * F + f] - mean[f];
      std[f] += d * d;
    }
  }
  for (let f = 0; f < F; f++) std[f] = Math.sqrt(std[f] / Math.max(1, n)) || 1;

  const Xs = new Float64Array(n * F);
  for (let k = 0; k < n; k++) {
    const i = trainIdx[k];
    for (let f = 0; f < F; f++) Xs[k * F + f] = (X[i * F + f] - mean[f]) / std[f];
  }

  let pos = 0;
  for (let k = 0; k < n; k++) pos += y[trainIdx[k]];
  const neg = n - pos;
  const wPos = pos > 0 ? Math.min(200, neg / pos) : 1;

  const w = new Float64Array(F);
  let b = 0;
  const vw = new Float64Array(F);
  let vb = 0;
  let lr = LR0;
  for (let ep = 0; ep < EPOCHS; ep++) {
    const gw = new Float64Array(F);
    let gb = 0;
    for (let k = 0; k < n; k++) {
      let z = b;
      for (let f = 0; f < F; f++) z += w[f] * Xs[k * F + f];
      const p = sigmoid(z);
      const yk = y[trainIdx[k]];
      const cw = yk === 1 ? wPos : 1;
      const err = (p - yk) * cw;
      const base = k * F;
      for (let f = 0; f < F; f++) gw[f] += err * Xs[base + f];
      gb += err;
    }
    const inv = 1 / n;
    for (let f = 0; f < F; f++) {
      const grad = gw[f] * inv + L2 * w[f];
      vw[f] = MOMENTUM * vw[f] - lr * grad;
      w[f] += vw[f];
    }
    vb = MOMENTUM * vb - lr * gb * inv;
    b += vb;
    lr *= 0.985;
  }
  return { w, b, mean, std };
}

export function predict(m: Model, feat: Float64Array | Float64ArrayLike): number {
  let z = m.b;
  for (let f = 0; f < F; f++) {
    const x = (feat[f] - m.mean[f]) / m.std[f];
    z += m.w[f] * x;
  }
  return sigmoid(z);
}
interface Float64ArrayLike {
  [index: number]: number;
}

// --- Main --------------------------------------------------------------------

interface Scored {
  row: number; // index into rows (backtest) or -1 (live)
  symbol: string;
  name: string;
  industry: string;
  close: number;
  mcap: number;
  prob: number;
  fwdRet: number; // NaN when unknown (live)
  feat: Float64Array;
  todayRet: number;
}

function pct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const allCsv = typeof args["all-csv"] === "string" ? (args["all-csv"] as string) : "tickers/all.csv";
  const backtest = args.backtest === true;
  if (typeof args["ret-target"] === "string") {
    const v = parseFloat(args["ret-target"]);
    if (Number.isFinite(v) && v > 0.01) RET_TARGET = v;
  }
  if (typeof args["early-min"] === "string") {
    const v = parseFloat(args["early-min"]);
    if (Number.isFinite(v)) EARLY_MIN_TODAY_RET = v;
  }
  ensureDir(OUT_DIR);

  // 1. Panels + cleaning.
  const panelsRaw = buildPanels(allCsv);
  let artifactSyms = 0;
  let droppedSyms = 0;
  const panels = new Map<string, SymPanel>();
  for (const [sym, p] of panelsRaw) {
    const a = cleanPanel(p);
    if (a > MAX_ARTIFACTS) {
      droppedSyms++;
      continue;
    }
    if (a > 0) artifactSyms++;
    panels.set(sym, p);
  }
  const allDates = new Set<string>();
  for (const p of panels.values()) for (const d of p.date) allDates.add(d);
  const dates = [...allDates].sort();
  const today = dates[dates.length - 1];
  console.log(
    `History: ${dates.length} dates (${dates[0]} → ${today}), ${panels.size} symbols` +
      ` (cleaned: ${artifactSyms} with artifacts bridged, ${droppedSyms} dropped).`,
  );

  // 2. Dataset.
  console.log("Building labeled dataset...");
  const { X, y, rows, dates: dsDates } = buildDataset(panels);
  const posTotal = [...y].reduce((a, b) => a + b, 0);
  console.log(`Dataset: ${rows.length} eligible symbol-days, ${posTotal} positive labels (next-day >= ${(RET_TARGET * 100).toFixed(0)}%).`);

  // Row indices grouped by date (dataset rows only cover dates with labels).
  const byDate = new Map<string, number[]>();
  dsDates.forEach((d) => byDate.set(d, []));
  for (let r = 0; r < rows.length; r++) byDate.get(rows[r].date)!.push(r);
  const testDates = dsDates.filter((d) => (byDate.get(d) ?? []).length >= MIN_UNIVERSE);
  console.log(`Evaluable days: ${testDates.length} (of ${dsDates.length} labeled days, universe >= ${MIN_UNIVERSE}).`);

  if (backtest) {
    await runBacktest(testDates, byDate, X, y, rows);
    gradeScreenerHits(panels);
  }

  // 3. Live scoring for TOMORROW (train on everything with a label).
  console.log("\n--- Live scoring (candidates for tomorrow) ---");
  const lastDayRows = byDate.get(today) ?? [];
  // Model trained on every labeled row strictly before the last day.
  const trainIdxLive: number[] = [];
  for (let r = 0; r < rows.length; r++) if (rows[r].date < today) trainIdxLive.push(r);
  const modelLive = trainLR(X, y, trainIdxLive);

  // Feature vectors for the last day come straight from the panels.
  // The published list is the EARLY pool: the stock has NOT already exploded
  // today (todayRet < EARLY_MAX_TODAY_RET) — that is the "catch it a day
  // early" use-case. Names that already jumped today are chase trades.
  const scored: Scored[] = [];
  for (const p of panels.values()) {
    const i = p.date.length - 1;
    if (p.date[i] !== today) continue; // stale symbol
    const sr = scoreRowFor(p, i);
    if (!sr) continue;
    scored.push({
      row: -1,
      symbol: p.symbol,
      name: p.name,
      industry: p.industry,
      close: sr.close,
      mcap: sr.mcap,
      prob: predict(modelLive, sr.feat),
      fwdRet: NaN,
      feat: sr.feat,
      todayRet: sr.todayRet,
    });
  }
  const early = scored.filter((s) => s.todayRet < EARLY_MAX_TODAY_RET && s.todayRet > EARLY_MIN_TODAY_RET);
  early.sort((a, b) => b.prob - a.prob);
  console.log(
    `Scored ${scored.length} eligible symbols for ${nextLabel(today)}; early pool (not yet exploded today): ${early.length}. Top ${Math.min(TOP_N_LIVE, early.length)}:`,
  );
  for (const [i, s] of early.slice(0, TOP_N_LIVE).entries()) {
    console.log(
      `  ${String(i + 1).padStart(2)}. ${s.symbol.padEnd(7)} p=${(s.prob * 100).toFixed(1).padStart(5)}%  today ${(s.todayRet * 100).toFixed(1).padStart(6)}%  close ${s.close.toFixed(2).padStart(8)}  ${s.industry}`,
    );
  }

  // Write premovers.csv (today's candidates for tomorrow, early pool).
  const header = [
    "runDate", "forDate", "rank", "symbol", "name", "industry", "close", "prob", "todayRet",
    "r5", "big20", "sinceBig", "tight10", "volr", "dry5", "uptick", "runup", "mcap", "avgVol20",
  ];
  const rowsOut = early.slice(0, TOP_N_LIVE).map((s, i) => {
    return [
      today, nextLabel(today), i + 1, s.symbol, s.name, s.industry,
      round(s.close, 4), round(s.prob, 4), round(s.todayRet * 100, 2),
      round(s.feat[1], 4), round(s.feat[4], 4), Math.round(s.feat[5] * 20),
      round(s.feat[6], 4), round(s.feat[8], 2), round(s.feat[9], 3), round(s.feat[10], 2),
      round(s.feat[14], 3), round(s.mcap, 0), round(Math.pow(10, s.feat[17]), 0),
    ];
  });
  await Bun.write(PREMOVERS_CSV, toCsv(header, rowsOut));

  // Append-only premovers_log.csv (idempotent per day).
  let prevLog: string[][] = [];
  try {
    const parsed = parseCsv(readFileSync(PREMOVERS_LOG, "utf8"));
    if (parsed.length > 1) {
      const idx = columnIndex(parsed[0]);
      for (const r of parsed.slice(1)) {
        if (!r.length) continue;
        if (r[idx.runDate] === today) continue; // idempotent re-run
        prevLog.push(r);
      }
    }
  } catch {
    // first run
  }
  const logRows = [
    ...prevLog,
    ...early.slice(0, TOP_N_LIVE).map((s, i) => [today, nextLabel(today), String(i + 1), s.symbol, String(round(s.prob, 4)), String(round(s.close, 4)), s.industry]),
  ];
  await Bun.write(PREMOVERS_LOG, toCsv(["runDate", "forDate", "rank", "symbol", "prob", "close", "industry"], logRows));

  // 4. "Would we have caught VEEA?" — score the day before the last day with a
  //    model trained only on data before it, then check where VEEA ranked.
  const prevDate = dates.length >= 2 ? dates[dates.length - 2] : null;
  if (prevDate) {
    console.log(`\n--- Retrospective: scoring ${prevDate} (trained on data strictly before it) ---`);
    const trainIdx: number[] = [];
    for (let r = 0; r < rows.length; r++) if (rows[r].date < prevDate) trainIdx.push(r);
    const m = trainLR(X, y, trainIdx);
    const dayRows = (byDate.get(prevDate) ?? []).map((row) => ({ row, prob: predict(m, rowFeat(X, row)) }));
    dayRankReport(prevDate, dayRows, rows, "VEEA");
  }

  console.log("\nDone.");
}

function rowFeat(X: Float64Array, row: number): Float64Array {
  const f = new Float64Array(F);
  for (let i = 0; i < F; i++) f[i] = X[row * F + i];
  return f;
}
function round(x: number, d: number): number {
  const m = Math.pow(10, d);
  return Math.round(x * m) / m;
}
function avgOfFeature(feat: Float64Array): number {
  // avgVol20 stored as log10 — invert for display
  return Math.pow(10, feat[17]);
}
function nextLabel(today: string): string {
  // The next calendar day the CI will run (approximate; it's a label for humans).
  const d = new Date(today + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// --- Backtest ----------------------------------------------------------------

async function runBacktest(
  testDates: string[],
  byDate: Map<string, number[]>,
  X: Float64Array,
  y: Float64Array,
  rows: RowMeta[],
): Promise<void> {
  console.log("\n--- Walk-forward backtest ---");
  const evalsFull: DailyEval[] = [];
  const evalsEarly: DailyEval[] = [];
  const btRows: string[][] = [];

  for (let start = 0; start < testDates.length; start += CHUNK_DAYS) {
    const chunk = testDates.slice(start, start + CHUNK_DAYS);
    const chunkStart = chunk[0];
    const trainIdx: number[] = [];
    for (let r = 0; r < rows.length; r++) if (rows[r].date < chunkStart) trainIdx.push(r);
    if (new Set(trainIdx.map((i) => y[i])).size < 2) continue; // need both classes
    const model = trainLR(X, y, trainIdx);
    for (const date of chunk) {
      const all = (byDate.get(date) ?? []).map((row) => ({ row, prob: predict(model, rowFeat(X, row)) }));
      if (!all.length) continue;
      evalsFull.push(evalDay(date, all, rows));
      const earlyPool = all.filter((d) => rows[d.row].todayRet < EARLY_MAX_TODAY_RET && rows[d.row].todayRet > EARLY_MIN_TODAY_RET);
      if (earlyPool.length >= 5) evalsEarly.push(evalDay(date, earlyPool, rows));
      for (const [i, d] of earlyPool.slice(0, TOP_N_BT).entries()) {
        const rm = rows[d.row];
        btRows.push([
          date, String(i + 1), rm.symbol, rm.name, rm.industry,
          String(round(rm.close, 4)), String(round(d.prob, 4)),
          String(round(rm.todayRet * 100, 2)),
          String(round(rm.fwdRet * 100, 2)),
          rm.fwdRet >= RET_TARGET ? "HIT" : "",
        ]);
      }
    }
  }

  // Aggregate: the full pool is the raw model; the early pool is the
  // actionable "catch it before the move" strategy.
  reportPool("FULL pool", evalsFull);
  reportPool("EARLY pool (not already exploded today)", evalsEarly);

  // Best days showcase.
  const best = [...evalsFull].sort((a, b) => b.top10 - a.top10);
  console.log("\nBest test days by top-10 hits (full pool):");
  for (const e of best.slice(0, 5)) {
    console.log(`  ${e.date}: ${e.top10}/10 hits, avgFwd ${pct(e.avgFwd10)}, universe ${e.universe}`);
  }

  await Bun.write(
    BACKTEST_CSV,
    toCsv(["date", "rank", "symbol", "name", "industry", "close", "prob", "todayRetPct", "fwdRetPct", "hit"], btRows),
  );
  console.log(`Wrote ${BACKTEST_CSV} (${btRows.length} rows — early-pool top-${TOP_N_BT} per day).`);
}

function reportPool(label: string, evs: DailyEval[]): void {
  const days = evs.length;
  if (!days) return;
  const totUniverse = evs.reduce((a, e) => a + e.universe, 0);
  const totPos = evs.reduce((a, e) => a + e.positives, 0);
  const baseRate = totUniverse ? totPos / totUniverse : 0;
  const p5 = evs.reduce((a, e) => a + e.top5, 0);
  const p10 = evs.reduce((a, e) => a + e.top10, 0);
  const p20 = evs.reduce((a, e) => a + e.top20, 0);
  const avgFwd10 = evs.reduce((a, e) => a + e.avgFwd10, 0) / days;
  const medFwd10 = evs.reduce((a, e) => a + e.medFwd10, 0) / days;
  const tail10 = evs.reduce((a, e) => a + e.tail10, 0) / days;
  const baseFwd = evs.reduce((a, e) => a + e.baseFwd, 0) / days;
  const caught10 = evs.reduce((a, e) => a + e.top10, 0);
  const positives = evs.reduce((a, e) => a + e.positives, 0);

  console.log(`\n[${label}] test days: ${days}, avg universe/day: ${Math.round(totUniverse / days)}, positives/day: ${(totPos / days).toFixed(1)}`);
  console.log(`Baseline P(next-day >= ${(RET_TARGET * 100).toFixed(0)}%): ${(baseRate * 100).toFixed(2)}%`);
  console.log(`Model precision@5:  ${(p5 / (days * 5) * 100).toFixed(1)}%  (lift ${baseRate ? (p5 / (days * 5) / baseRate).toFixed(1) : "n/a"}x)`);
  console.log(`Model precision@10: ${(p10 / (days * 10) * 100).toFixed(1)}%  (lift ${baseRate ? (p10 / (days * 10) / baseRate).toFixed(1) : "n/a"}x)`);
  console.log(`Model precision@20: ${(p20 / (days * 20) * 100).toFixed(1)}%  (lift ${baseRate ? (p20 / (days * 20) / baseRate).toFixed(1) : "n/a"}x)`);
  console.log(`Avg next-day return, top-10 picks: ${pct(avgFwd10)} (median ${pct(medFwd10)}) vs universe avg: ${pct(baseFwd)}`);
  console.log(`Share of top-10 picks that lose >= 20% the next day: ${(tail10 * 100).toFixed(1)}%`);
  console.log(`Explosions caught in day's top-10 (recall@10): ${caught10}/${positives} = ${positives ? ((caught10 / positives) * 100).toFixed(1) : "0"}%`);
  const t1 = evs.reduce((a, e) => a + e.posTop1, 0);
  const t5 = evs.reduce((a, e) => a + e.posTop5, 0);
  const t10 = evs.reduce((a, e) => a + e.posTop10, 0);
  if (positives) {
    console.log(`Explosions ranked in the day's top 1%: ${(t1 / positives * 100).toFixed(1)}%, top 5%: ${(t5 / positives * 100).toFixed(1)}%, top 10%: ${(t10 / positives * 100).toFixed(1)}%`);
  }
}

interface DailyEval {
  date: string;
  universe: number;
  positives: number;
  top5: number;
  top10: number;
  top20: number;
  avgFwd10: number;
  medFwd10: number;
  tail10: number; // fraction of top-10 with next-day <= -20%
  baseFwd: number;
  posTop1: number; // positives ranked in the day's top 1%
  posTop5: number; // ... top 5%
  posTop10: number; // ... top 10%
}

function evalDay(date: string, dayRows: { row: number; prob: number }[], rows: RowMeta[]): DailyEval {
  dayRows.sort((a, b) => b.prob - a.prob);
  const hitsIn = (k: number) => {
    let hits = 0;
    for (let i = 0; i < Math.min(k, dayRows.length); i++) if (rows[dayRows[i].row].fwdRet >= RET_TARGET) hits++;
    return hits;
  };
  const top10 = dayRows.slice(0, 10);
  let sumFwd = 0;
  const fwds: number[] = [];
  for (const d of top10) {
    sumFwd += rows[d.row].fwdRet;
    fwds.push(rows[d.row].fwdRet);
  }
  fwds.sort((a, b) => a - b);
  let baseSum = 0;
  for (const d of dayRows) baseSum += rows[d.row].fwdRet;
  let posTop1 = 0;
  let posTop5 = 0;
  let posTop10 = 0;
  const univ = dayRows.length;
  for (let i = 0; i < univ; i++) {
    if (rows[dayRows[i].row].fwdRet < RET_TARGET) continue;
    const pctRank = (i + 1) / univ;
    if (pctRank <= 0.01) posTop1++;
    if (pctRank <= 0.05) posTop5++;
    if (pctRank <= 0.1) posTop10++;
  }
  return {
    date,
    universe: univ,
    positives: hitsIn(univ),
    top5: hitsIn(5),
    top10: hitsIn(10),
    top20: hitsIn(20),
    avgFwd10: top10.length ? sumFwd / top10.length : 0,
    medFwd10: fwds.length ? fwds[Math.floor(fwds.length / 2)] : 0,
    tail10: fwds.length ? fwds.filter((f) => f <= -0.2).length / fwds.length : 0,
    baseFwd: univ ? baseSum / univ : 0,
    posTop1,
    posTop5,
    posTop10,
  };
}

/** Grade the existing breakout screener's own history (docs/data/screener/hits_log.csv):
 *  for every past hit, what did the stock do the NEXT day (adjusted)? This answers
 *  "is the current screener's signal actually predictive?" without any model. */
export function gradeScreenerHits(panels: Map<string, SymPanel>): void {
  let text = "";
  try {
    text = readFileSync("docs/data/screener/hits_log.csv", "utf8");
  } catch {
    console.log("\n(hits_log.csv not found — skipping screener grading)");
    return;
  }
  // (symbol, date) -> next-day adjusted return
  const fwd = new Map<string, number>();
  for (const p of panels.values()) {
    for (let i = 0; i + 1 < p.close.length; i++) {
      const c = p.close[i];
      if (c > 0 && p.close[i + 1] > 0) fwd.set(`${p.symbol}\0${p.date[i]}`, p.close[i + 1] / c - 1);
    }
  }
  const parsed = parseCsv(text);
  if (parsed.length <= 1) return;
  const idx = columnIndex(parsed[0]);
  const rets: number[] = [];
  let unknown = 0;
  let bigHits = 0; // the hit day itself was a >= 20% day (that's the screener's job)
  let nextBig = 0;
  for (const r of parsed.slice(1)) {
    if (!r.length) continue;
    const sym = r[idx.symbol];
    const date = r[idx.date];
    const ownRet = parseNumber(r[idx.dayChangePct]) ?? 0;
    if (ownRet >= 20) bigHits++;
    const f = fwd.get(`${sym}\0${date}`);
    if (f === undefined) {
      unknown++;
      continue;
    }
    rets.push(f);
    if (f >= RET_TARGET) nextBig++;
  }
  if (!rets.length) {
    console.log("\nScreener hits: no gradable rows (all unknown).");
    return;
  }
  rets.sort((a, b) => a - b);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const median = rets[Math.floor(rets.length / 2)];
  const winRate = rets.filter((x) => x > 0).length / rets.length;
  console.log(`\n--- Grading the existing screener's hit log ---`);
  console.log(`${rets.length} gradable hits (${unknown} unknown), ${bigHits} of them were >= +20% on the hit day itself.`);
  console.log(`Next-day after a hit: mean ${pct(mean)}, median ${pct(median)}, win rate ${(winRate * 100).toFixed(0)}%, next-day >= +20%: ${(nextBig / rets.length * 100).toFixed(1)}%`);
}

/** Print where `focusSymbol` ranked on `date` (full + early pool) + the day's
 *  early-pool top-10 with outcomes. */
function dayRankReport(
  date: string,
  dayRows: { row: number; prob: number }[],
  rows: RowMeta[],
  focusSymbol: string,
): void {
  dayRows.sort((a, b) => b.prob - a.prob);
  const early = dayRows.filter((d) => rows[d.row].todayRet < EARLY_MAX_TODAY_RET && rows[d.row].todayRet > EARLY_MIN_TODAY_RET);
  for (const [label, pool] of [["full", dayRows], ["early", early]] as const) {
    const rank = pool.findIndex((d) => rows[d.row].symbol === focusSymbol);
    if (rank >= 0) {
      const d = pool[rank];
      console.log(
        `  ${focusSymbol} ${label}-pool rank #${rank + 1} of ${pool.length} (p=${(d.prob * 100).toFixed(1)}%) → next-day ${pct(rows[d.row].fwdRet)}`,
      );
    } else {
      console.log(`  ${focusSymbol} not in the ${label} pool that day.`);
    }
  }
  console.log(`  Early-pool top-10 that day:`);
  for (const [i, d] of early.slice(0, 10).entries()) {
    const rm = rows[d.row];
    console.log(
      `    ${String(i + 1).padStart(2)}. ${rm.symbol.padEnd(7)} p=${(d.prob * 100).toFixed(1).padStart(5)}% → next-day ${pct(rm.fwdRet).padStart(7)}  ${rm.industry}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});