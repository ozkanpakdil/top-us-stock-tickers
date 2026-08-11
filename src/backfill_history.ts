// Backfill history.csv / history.sql from the per-ticker JSON archives.
// ====================================================================
// Seeds `tickers/history.csv` (and regenerates `tickers/history.sql`) with a
// FULL OHLC backfill, built from the archives in `ohlc/<SYMBOL>.json`
// (produced by archive_history.ts). This gives the SQL dump decades of OHLC
// immediately, instead of waiting for the forward-only daily appends in
// update_tickers.ts to accumulate one row per run.
//
// One row is emitted per (symbol, bar) using HISTORY_COLUMNS:
//   date, symbol, name, price(=close), open, high, low, close,
//   marketCap(=NULL), volume, industry
//
// `marketCap` is left NULL for backfilled rows — there is no per-day market-cap
// history; the daily append_history_csv fills it from the NASDAQ snapshot for
// new forward days. `price` is set to `close` (the daily append uses the
// NASDAQ last-traded price; for historical bars the close is the natural
// equivalent).
//
// Run (not part of the daily workflow):
//   bun run src/backfill_history.ts [--max-years Y] [--limit N] [--no-sql]

import { readdir } from "node:fs/promises";

import {
  HISTORY_COLUMNS,
  HISTORY_CSV_PATH,
  safeFilename,
  pyFloatRepr,
  intRepr,
  writeCsv,
  parseArgs,
  ensureDir,
} from "./lib.ts";
import { generateHistorySql } from "./update_tickers.ts";

const DATA_DIR = "docs/data"; // manifest.json lives here (committed)
const MANIFEST_PATH = `${DATA_DIR}/manifest.json`;
const OHLC_DIR = "ohlc";
const HISTORY_SQL_PATH = "tickers/history.sql";

async function symbolOrder(limit: number | null): Promise<string[]> {
  // Market-cap order (manifest.json) if present, else a sorted glob of the archives.
  let syms: string[];
  if (await Bun.file(MANIFEST_PATH).exists()) {
    try {
      const manifest: any = await Bun.file(MANIFEST_PATH).json();
      syms = manifest.map((m: any) => m.symbol);
    } catch {
      syms = [];
    }
  } else {
    syms = [];
  }
  if (!syms.length) {
    try {
      const files = await readdir(OHLC_DIR);
      syms = files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
    } catch {
      syms = [];
    }
  }
  if (limit && limit > 0) syms = syms.slice(0, limit);
  return syms;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const strArg = (k: string): string | null => (typeof args[k] === "string" ? (args[k] as string) : null);
  const maxYears = strArg("max-years") !== null ? Number(strArg("max-years")) : null;
  const limit = strArg("limit") !== null ? Number(strArg("limit")) : null;
  const noSql = args["no-sql"] === true;

  const syms = await symbolOrder(limit);
  let cutoff: string | null = null;
  if (maxYears) {
    cutoff = new Date(Date.now() - maxYears * 365.25 * 86400 * 1000).toISOString().slice(0, 10);
  }

  ensureDir("tickers");

  const rows: string[][] = [HISTORY_COLUMNS];
  let totalBars = 0;
  let writtenSyms = 0;

  for (const sym of syms) {
    const path = `${OHLC_DIR}/${safeFilename(sym)}`;
    if (!(await Bun.file(path).exists())) continue;
    let d: any;
    try {
      d = await Bun.file(path).json();
    } catch {
      continue;
    }
    const name = d.name ?? "";
    const industry = d.industry ?? "";
    const bars: any[] = d.bars ?? [];
    let symBars = 0;
    for (const bar of bars) {
      const [date, o, h, l, c, v] = bar;
      if (cutoff && date < cutoff) continue;
      // HISTORY_COLUMNS: date, symbol, name, price, open, high, low, close,
      // marketCap, volume, industry. price = close; marketCap = "" (NULL).
      rows.push([
        String(date),
        String(sym),
        String(name),
        pyFloatRepr(c),
        pyFloatRepr(o),
        pyFloatRepr(h),
        pyFloatRepr(l),
        pyFloatRepr(c),
        "",
        intRepr(v),
        String(industry),
      ]);
      symBars++;
    }
    if (symBars) writtenSyms++;
    totalBars += symBars;
  }

  await writeCsv(HISTORY_CSV_PATH, rows);
  const depth = maxYears ? `${maxYears}y` : "full";
  console.log(
    `Wrote ${HISTORY_CSV_PATH}: ${totalBars} bars across ${writtenSyms} tickers ` +
      `(depth=${depth}, limit=${limit ?? "none"}).`,
  );

  if (!noSql) {
    await generateHistorySql(); // reads history.csv, writes history.sql
  }

  // Report sizes so the 100MB GitHub limit is visible.
  for (const pth of [HISTORY_CSV_PATH, HISTORY_SQL_PATH]) {
    if (await Bun.file(pth).exists()) {
      const sz = (await Bun.file(pth).size) / 1e6;
      const over = sz > 100 ? "  (over GitHub's 100MB/file limit!)" : "";
      console.log(`  ${pth}: ${sz.toFixed(1)} MB${over}`);
    }
  }
}

if (import.meta.main) {
  await main();
}