// Daily breakout screener — "trend is friend".
//
// Scans every US stock in tickers/all.csv for breakout candidates: institutional volume
// moving in, making new highs, in an uptrend. History (close = `price` + `volume`) is
// rebuilt each run from the git history of tickers/all.csv (one commit per trading day),
// plus today's working snapshot overlaid as the newest day. There is no `open`/`high`/`low`
// in that history, so "gap up" is proxied by the close-vs-prev-close day change.
//
// VIX (not in all.csv) is fetched from Yahoo (^VIX) and used as a global market gate.
//
// Outputs (all committed to main under docs/data/screener/, so they're published to
// the GitHub Pages site and rendered by docs/screener.html; hits_log.csv is the
// append-only time series, mirroring how tickers/all.csv's git history is the source
// of truth elsewhere):
//   docs/data/screener/LATEST.csv         — today's hits, overwritten daily
//   docs/data/screener/hits_log.csv       — date,symbol,score,... append-only, idempotent per day
//   docs/data/screener/watchlist_15.csv   — symbols hitting >=8 of last 15 calendar days
//   docs/data/screener/conviction_30.csv  — symbols hitting >=15 of last 30 calendar days
//
// Run:  bun run screener            (or: bun run src/screener.ts)
// Flags: --no-vix     skip the VIX<21 gate (testing)
//        --all-csv <path>  snapshot CSV walked in git (default: tickers/all.csv)

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  parseCsv,
  parseNumber,
  parseIntField,
  fetchYahooChartRaw,
  utcDate,
  ensureDir,
  parseArgs,
} from "./lib.ts";

// --- Tunable criteria (edit here, no logic changes needed) -----------------

export const VIX_MAX = 21; // global market gate
export const SMA_SHORT = 50; // uptrend short window
export const SMA_LONG_TARGET = 200; // uptrend long window (degrades until history grows)
export const SMA_LONG_FLOOR = 120; // below this many bars, trend rule is skipped
export const HIGH_WINDOW = 20; // "making highs" = new N-day high
export const VOL_SPIKE_MULT = 1.5; // volume >= MULT x 50-day avg volume
export const DAY_CHANGE_MIN = 2; // gap-up proxy: close vs prev close, percent
export const MIN_BARS = 50; // need SMA50 + a day change to screen at all

// Highlight windows (calendar days, ending today).
export const WATCH_DAYS = 15;
export const WATCH_MIN_HITS = 8;
export const CONVICTION_DAYS = 30;
export const CONVICTION_MIN_HITS = 15;

// Output dir: under docs/ so the files are published to GitHub Pages and the
// site can fetch them at runtime (docs/data/ is already committed daily).
export const OUT_DIR = "docs/data/screener";

// --- git helpers (mirror src/gen_history_sql.ts) ----------------------------

function git(args: string[]): string {
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 512 });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${r.status}):\n${r.stderr || ""}`);
  }
  return r.stdout ?? "";
}

/** (commitHash, committerDateISO) for every commit touching `path`, oldest first. */
function snapshotCommits(path: string): { hash: string; date: string }[] {
  const out = git(["log", "--format=%H %cI", "--reverse", "--", path]).trim();
  if (!out) return [];
  return out.split("\n").map((line) => {
    const sp = line.indexOf(" ");
    return { hash: line.slice(0, sp), date: line.slice(sp + 1) };
  });
}

function showAt(hash: string, path: string): string {
  return git(["show", `${hash}:${path}`]);
}

// --- history build ----------------------------------------------------------

interface Bar {
  date: string;
  close: number;
  volume: number;
}
interface Sym {
  name: string;
  industry: string;
  bars: Bar[];
}

function columnIndex(header: string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  header.forEach((h, i) => (idx[h] = i));
  return idx;
}

/** Parse one snapshot (git version or working file) into per-symbol bars for `date`.
 *  close = `price` column (all.csv has no close/open/high/low; price is the last close).
 *  Returns rows as [date, symbol, name, close, volume, industry] for merging. */
function parseSnapshot(
  text: string,
  date: string,
): { date: string; symbol: string; name: string; close: number; volume: number; industry: string }[] {
  const parsed = parseCsv(text);
  if (parsed.length === 0) return [];
  const [header, ...rows] = parsed;
  if (!header.length) return [];
  const idx = columnIndex(header);
  if (idx.symbol === undefined) return [];
  const out = [];
  for (const r of rows) {
    const symbol = (r[idx.symbol] ?? "").trim().toUpperCase();
    if (!symbol) continue;
    const close = parseNumber(idx.price !== undefined ? r[idx.price] : "");
    const volume = parseIntField(idx.volume !== undefined ? r[idx.volume] : "") ?? 0;
    if (close === null) continue; // no price → unusable bar
    out.push({
      date,
      symbol,
      name: idx.name !== undefined ? r[idx.name] ?? "" : "",
      close,
      volume,
      industry: idx.industry !== undefined ? r[idx.industry] ?? "" : "",
    });
  }
  return out;
}

/** Build the full symbol→Sym history map from git history of all.csv + today's working
 *  snapshot. Newest snapshot per (date, symbol) wins (walked oldest→newest, then today). */
async function buildHistory(allCsv: string, today: string): Promise<Map<string, Sym>> {
  const symbols = new Map<string, Sym>();
  // date+symbol → last bar seen (for dedup within the same day across commits)
  const latest = new Map<string, { bar: Bar; name: string; industry: string }>();

  const merge = (rows: ReturnType<typeof parseSnapshot>) => {
    for (const row of rows) {
      const key = `${row.date}\0${row.symbol}`;
      const prev = latest.get(key);
      // newest snapshot per day wins; within one snapshot just take the row.
      if (prev) {
        prev.bar = { date: row.date, close: row.close, volume: row.volume };
        prev.name = row.name || prev.name;
        prev.industry = row.industry || prev.industry;
      } else {
        latest.set(key, {
          bar: { date: row.date, close: row.close, volume: row.volume },
          name: row.name,
          industry: row.industry,
        });
      }
    }
  };

  const commits = snapshotCommits(allCsv);
  console.log(`Walking ${commits.length} snapshot commits of ${allCsv}...`);
  let parsedCommits = 0;
  for (const { hash, date } of commits) {
    const text = showAt(hash, allCsv);
    const rows = parseSnapshot(text, utcDate(new Date(date).getTime() / 1000));
    if (rows.length) parsedCommits++;
    merge(rows);
  }

  // Overlay today's working snapshot (not yet committed at screener time in CI).
  try {
    const working = await Bun.file(allCsv).text();
    merge(parseSnapshot(working, today));
  } catch {
    // working file missing — history ends at last commit
  }

  // Fold latest → per-symbol sorted bars.
  for (const [key, entry] of latest) {
    const sym = key.slice(key.indexOf("\0") + 1);
    let s = symbols.get(sym);
    if (!s) {
      s = { name: entry.name, industry: entry.industry, bars: [] };
      symbols.set(sym, s);
    }
    if (!s.name && entry.name) s.name = entry.name;
    if (!s.industry && entry.industry) s.industry = entry.industry;
    s.bars.push(entry.bar);
  }
  for (const s of symbols.values()) {
    s.bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  console.log(`  ${parsedCommits} snapshots parsed, ${symbols.size} symbols with history.`);
  return symbols;
}

// --- indicators -------------------------------------------------------------

function sma(values: number[], window: number): number | null {
  if (values.length < window) return null;
  let sum = 0;
  for (let i = values.length - window; i < values.length; i++) sum += values[i];
  return sum / window;
}

function maxLast(values: number[], window: number): number | null {
  if (values.length < window) return null;
  let m = -Infinity;
  for (let i = values.length - window; i < values.length; i++) if (values[i] > m) m = values[i];
  return m;
}

interface HitRow {
  symbol: string;
  name: string;
  industry: string;
  close: number;
  dayChangePct: number;
  volume: number;
  volRatio: number;
  sma50: number | null;
  smaLong: number | null;
  at20DayHigh: boolean;
  trendUp: boolean;
  trendSkipped: boolean;
  score: number;
}

/** Screen one symbol; returns a HitRow if it passes all rules, else null. */
function screenSymbol(sym: string, s: Sym, vixOk: boolean): HitRow | null {
  const bars = s.bars;
  if (bars.length < MIN_BARS) return null;
  const closes = bars.map((b) => b.close);
  const vols = bars.map((b) => b.volume);

  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const dayChangePct = prev && prev.close ? ((last.close - prev.close) / prev.close) * 100 : 0;

  const sma50 = sma(closes, SMA_SHORT);
  // Long SMA: target 200, else whole-history if >= floor, else skip (null).
  let smaLong: number | null = null;
  let trendSkipped = false;
  if (bars.length >= SMA_LONG_TARGET) smaLong = sma(closes, SMA_LONG_TARGET);
  else if (bars.length >= SMA_LONG_FLOOR) smaLong = sma(closes, bars.length);
  else trendSkipped = true;

  const high20 = maxLast(closes.slice(0, closes.length - 1), Math.min(HIGH_WINDOW, closes.length - 1));
  const at20DayHigh = high20 !== null && last.close >= high20;

  const avgVol50 = sma(vols, Math.min(SMA_SHORT, vols.length));
  const volRatio = avgVol50 && avgVol50 > 0 ? last.volume / avgVol50 : 0;
  const volSpike = avgVol50 !== null && volRatio >= VOL_SPIKE_MULT;

  const aboveSma50 = sma50 !== null && last.close > sma50;
  const trendUp = smaLong !== null && sma50 !== null ? sma50 > smaLong : true;

  if (!vixOk) return null;
  if (!at20DayHigh) return null;
  if (!volSpike) return null;
  if (!aboveSma50) return null;
  if (!trendUp) return null;
  if (dayChangePct < DAY_CHANGE_MIN) return null;

  const score = Math.round((dayChangePct + 2 * volRatio) * 100) / 100;
  return {
    symbol: sym,
    name: s.name,
    industry: s.industry,
    close: last.close,
    dayChangePct: Math.round(dayChangePct * 100) / 100,
    volume: last.volume,
    volRatio: Math.round(volRatio * 100) / 100,
    sma50: sma50 !== null ? Math.round(sma50 * 100) / 100 : null,
    smaLong: smaLong !== null ? Math.round(smaLong * 100) / 100 : null,
    at20DayHigh,
    trendUp,
    trendSkipped,
    score,
  };
}

// --- CSV output -------------------------------------------------------------

const LATEST_COLUMNS = [
  "symbol", "name", "industry", "close", "dayChangePct", "volume", "volRatio",
  "sma50", "smaLong", "at20DayHigh", "trendUp", "trendSkipped", "score", "vix",
];
const HITS_LOG_COLUMNS = ["date", "symbol", "score", "dayChangePct", "close", "industry"];
const HIGHLIGHT_COLUMNS = [
  "symbol", "industry", "hits", "firstHit", "lastHit", "avgScore", "latestClose", "latestDayChange",
];

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

// --- highlight lists from hits_log ------------------------------------------

interface LogRow {
  date: string;
  symbol: string;
  score: number;
  dayChangePct: number;
  close: number;
  industry: string;
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
  const idx = columnIndex(header);
  const out: LogRow[] = [];
  for (const r of rows) {
    if (!r.length) continue;
    out.push({
      date: r[idx.date] ?? "",
      symbol: r[idx.symbol] ?? "",
      score: parseNumber(r[idx.score]) ?? 0,
      dayChangePct: parseNumber(r[idx.dayChangePct]) ?? 0,
      close: parseNumber(r[idx.close]) ?? 0,
      industry: r[idx.industry] ?? "",
    });
  }
  return out;
}

/** Distinct hit-days per symbol within the last `days` calendar days ending today. */
function highlightFromLog(
  log: LogRow[],
  today: string,
  days: number,
  minHits: number,
): { symbol: string; industry: string; hits: number; firstHit: string; lastHit: string; avgScore: number; latestClose: number; latestDayChange: number }[] {
  const todayMs = new Date(today + "T00:00:00Z").getTime();
  const cutoff = todayMs - days * 86400000;
  const bySymbol = new Map<string, LogRow[]>();
  for (const row of log) {
    const t = new Date(row.date + "T00:00:00Z").getTime();
    if (Number.isNaN(t) || t < cutoff || t > todayMs) continue;
    let arr = bySymbol.get(row.symbol);
    if (!arr) {
      arr = [];
      bySymbol.set(row.symbol, arr);
    }
    arr.push(row);
  }
  const out = [];
  for (const [symbol, arr] of bySymbol) {
    // distinct hit-days
    const daysSet = new Set(arr.map((r) => r.date));
    if (daysSet.size < minHits) continue;
    arr.sort((a, b) => (a.date < b.date ? -1 : 1));
    const scores = arr.map((r) => r.score);
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const last = arr[arr.length - 1];
    out.push({
      symbol,
      industry: last.industry,
      hits: daysSet.size,
      firstHit: arr[0].date,
      lastHit: last.date,
      avgScore: Math.round(avg * 100) / 100,
      latestClose: last.close,
      latestDayChange: last.dayChangePct,
    });
  }
  out.sort((a, b) => b.hits - a.hits || b.avgScore - a.avgScore);
  return out;
}

// --- main -------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const allCsv = typeof args["all-csv"] === "string" ? (args["all-csv"] as string) : "tickers/all.csv";
  const noVix = args["no-vix"] === true;

  ensureDir(OUT_DIR);
  const today = new Date().toISOString().slice(0, 10);

  // VIX gate.
  let vix: number | null = null;
  let vixOk = true;
  if (noVix) {
    console.log("VIX gate skipped (--no-vix).");
  } else {
    console.log("Fetching VIX from Yahoo (^VIX)...");
    const res = await fetchYahooChartRaw("^VIX", { range: "1y", interval: "1d" });
    if (res?.indicators?.quote?.[0]?.close) {
      const closes = res.indicators.quote[0].close.filter((x: number | null) => x != null);
      vix = closes.length ? closes[closes.length - 1] : null;
    }
    vixOk = vix !== null && vix < VIX_MAX;
    console.log(`  VIX = ${vix !== null ? vix.toFixed(2) : "n/a"} → gate ${vixOk ? "OPEN" : "CLOSED (>= " + VIX_MAX + ")"}`);
  }

  // History.
  const symbols = await buildHistory(allCsv, today);

  // Screen.
  const hits: HitRow[] = [];
  let screened = 0;
  for (const [sym, s] of symbols) {
    screened++;
    const hit = screenSymbol(sym, s, vixOk);
    if (hit) hits.push(hit);
  }
  hits.sort((a, b) => b.score - a.score || b.dayChangePct - a.dayChangePct);

  // Write LATEST.csv.
  const latestRows = hits.map((h) => [
    h.symbol, h.name, h.industry, h.close, h.dayChangePct, h.volume, h.volRatio,
    h.sma50 ?? "", h.smaLong ?? "", h.at20DayHigh, h.trendUp, h.trendSkipped, h.score,
    vix !== null ? Math.round(vix * 100) / 100 : "",
  ]);
  await Bun.write(`${OUT_DIR}/LATEST.csv`, toCsv(LATEST_COLUMNS, latestRows));

  // Append today's hits to hits_log.csv (idempotent: drop today's rows first).
  const logPath = `${OUT_DIR}/hits_log.csv`;
  const existingLog = readHitsLog(logPath).filter((r) => r.date !== today);
  const newLogRows = hits.map((h) => [today, h.symbol, h.score, h.dayChangePct, h.close, h.industry]);
  const allLog = existingLog.map((r) => [r.date, r.symbol, r.score, r.dayChangePct, r.close, r.industry]);
  await Bun.write(logPath, toCsv(HITS_LOG_COLUMNS, [...allLog, ...newLogRows]));

  // Highlight lists.
  const fullLog = readHitsLog(logPath);
  const watch = highlightFromLog(fullLog, today, WATCH_DAYS, WATCH_MIN_HITS);
  const convict = highlightFromLog(fullLog, today, CONVICTION_DAYS, CONVICTION_MIN_HITS);
  await Bun.write(`${OUT_DIR}/watchlist_15.csv`, toCsv(HIGHLIGHT_COLUMNS, watch.map((w) => [w.symbol, w.industry, w.hits, w.firstHit, w.lastHit, w.avgScore, w.latestClose, w.latestDayChange])));
  await Bun.write(`${OUT_DIR}/conviction_30.csv`, toCsv(HIGHLIGHT_COLUMNS, convict.map((w) => [w.symbol, w.industry, w.hits, w.firstHit, w.lastHit, w.avgScore, w.latestClose, w.latestDayChange])));

  // Summary.
  console.log("---");
  console.log(`Screener ${today}: screened ${screened} symbols, ${hits.length} hits.`);
  if (!vixOk) console.log(`  (VIX gate CLOSED at ${vix !== null ? vix.toFixed(2) : "n/a"} — no hits recorded.)`);
  console.log(`  watchlist_15: ${watch.length} symbols (>=${WATCH_MIN_HITS} hits in ${WATCH_DAYS}d)`);
  console.log(`  conviction_30: ${convict.length} symbols (>=${CONVICTION_MIN_HITS} hits in ${CONVICTION_DAYS}d)`);
  if (hits.length) {
    console.log("  Top hits:");
    for (const h of hits.slice(0, 10)) {
      console.log(`    ${h.symbol.padEnd(8)} ${h.dayChangePct >= 0 ? "+" : ""}${h.dayChangePct}%  vol×${h.volRatio}  score ${h.score}  ${h.industry}`);
    }
  }
}

if (import.meta.main) {
  await main();
}