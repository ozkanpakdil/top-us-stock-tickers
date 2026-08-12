// Rebuild the portable SQL history dump on demand from git.
//
// The committed `tickers/all.csv` is overwritten and re-committed every daily
// run, so walking its git log yields one snapshot per trading day. This script
// reads each historical version of `tickers/all.csv` straight out of git (no
// working-tree checkout needed), maps every row to the `us_tickers` schema,
// dedups by (date, symbol) keeping the newest commit per day, and writes a
// single portable `tickers/history.sql` (plus an optional `history.csv`).
//
// Nothing is committed: history.sql / history.csv are gitignored. Run it only
// when you want the dump:
//
//   bun run src/gen_history_sql.ts
//
// Flags (all optional):
//   --all-csv <path>   snapshot CSV to walk in git (default: tickers/all.csv)
//   --out <path>       SQL output path            (default: tickers/history.sql)
//   --csv-out <path>   CSV output path            (default: tickers/history.csv)
//                     pass '' / omit value to skip the CSV.

import { spawnSync } from "node:child_process";
import {
  HISTORY_COLUMNS,
  HISTORY_STRING_COLUMNS,
  parseCsv,
  writeCsv,
  ensureDir,
  pyFloatRepr,
  parseArgs,
} from "./lib.ts";

// --- git helpers ------------------------------------------------------------

/** Run a git command and return stdout (utf8). Throws on non-zero exit. */
function git(args: string[]): string {
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 512 });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${r.status}):\n${r.stderr || ""}`);
  }
  return r.stdout ?? "";
}

/** (commitHash, committerDateISO) for every commit touching `path`, oldest first. */
function snapshotCommits(path: string): { hash: string; date: string }[] {
  // %H = full hash, %cI = strict-ISO committer date.
  const out = git(["log", "--format=%H %cI", "--reverse", "--", path]).trim();
  if (!out) return [];
  return out.split("\n").map((line) => {
    const sp = line.indexOf(" ");
    return { hash: line.slice(0, sp), date: line.slice(sp + 1) };
  });
}

/** File contents at a given commit (`git show <hash>:<path>`). */
function showAt(hash: string, path: string): string {
  return git(["show", `${hash}:${path}`]);
}

/** UTC calendar date (YYYY-MM-DD) for an ISO 8601 timestamp. */
function utcDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

// --- snapshot → history row mapping -----------------------------------------

/** Build a column-name → index map for a snapshot's header row. */
function columnIndex(header: string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  header.forEach((h, i) => (idx[h] = i));
  return idx;
}

/**
 * Map one snapshot's rows into `us_tickers` rows (HISTORY_COLUMNS order).
 * `date` comes from the commit (each daily commit = one trading snapshot).
 * Old snapshots predate the OHLC columns; their open/high/low/close are NULL.
 */
function snapshotToHistory(
  rows: string[][],
  idx: Record<string, number>,
  date: string,
): string[][] {
  const at = (r: string[], col: string) => (col in idx ? (r[idx[col]] ?? "") : "");
  const out: string[][] = [];
  for (const r of rows) {
    const symbol = at(r, "symbol");
    if (!symbol) continue;
    out.push([
      date, // date
      symbol, // symbol
      at(r, "name"), // name
      at(r, "price"), // price
      at(r, "open"), // open (NULL on pre-OHLC snapshots)
      at(r, "high"), // high
      at(r, "low"), // low
      at(r, "close"), // close
      at(r, "marketCap"), // marketCap
      at(r, "volume"), // volume
      at(r, "industry"), // industry
    ]);
  }
  return out;
}

// --- SQL emission (ported from the old generateHistorySql) ------------------

/** Per-column dtype inference, mirroring pandas read_csv: a numeric column is
 *  int64 only if every non-empty cell is an integer and none are empty —
 *  otherwise float64. Keeps the SQL byte-compatible with the old output. */
function inferDtypes(rows: string[][]): Record<string, "int" | "float"> {
  const idx: Record<string, number> = {};
  HISTORY_COLUMNS.forEach((c, i) => (idx[c] = i));
  const dtype: Record<string, "int" | "float"> = {};
  for (const c of HISTORY_COLUMNS) {
    if (HISTORY_STRING_COLUMNS.has(c)) continue;
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
  return dtype;
}

function makeSqlLiteral(dtype: Record<string, "int" | "float">) {
  const idx: Record<string, number> = {};
  HISTORY_COLUMNS.forEach((c, i) => (idx[c] = i));
  return (row: string[], col: string): string => {
    const cell = row[idx[col]] ?? "";
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

function emitSql(rows: string[][]): string {
  const idx: Record<string, number> = {};
  HISTORY_COLUMNS.forEach((c, i) => (idx[c] = i));
  const dateI = idx["date"];
  const mcI = idx["marketCap"];

  // date asc, then marketCap desc (nulls last) — matches the legacy ordering.
  const sorted = [...rows].sort((a, b) => {
    const da = a[dateI] ?? "";
    const db = b[dateI] ?? "";
    if (da < db) return -1;
    if (da > db) return 1;
    const ma = (a[mcI] ?? "") === "" ? -Infinity : Number(a[mcI]);
    const mb = (b[mcI] ?? "") === "" ? -Infinity : Number(b[mcI]);
    return mb - ma;
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
    "-- US stock ticker history (generated on demand from the git history of",
    "-- tickers/all.csv by src/gen_history_sql.ts — not committed to the repo).",
    "-- One row per (trading day, symbol). date = the day the snapshot was",
    "-- committed; price/marketCap/volume/industry are the NASDAQ screener",
    "-- snapshot for that day; open/high/low/close are the Yahoo Finance OHLC",
    "-- for the most recent completed session. Snapshots taken before OHLC",
    "-- was added to all.csv have NULL open/high/low.",
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

  const sqlLiteral = makeSqlLiteral(inferDtypes(sorted));
  let totalRows = 0;
  for (const group of groups) {
    lines.push("INSERT INTO us_tickers (" + HISTORY_COLUMNS.join(", ") + ") VALUES");
    const valueRows = group.rows.map(
      (r) => "    (" + HISTORY_COLUMNS.map((c) => sqlLiteral(r, c)).join(", ") + ")",
    );
    totalRows += valueRows.length;
    lines.push(valueRows.join(",\n") + ";");
    lines.push("");
  }
  return lines.join("\n");
}

// --- main -------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const allCsv = typeof args["all-csv"] === "string" ? (args["all-csv"] as string) : "tickers/all.csv";
  const sqlOut = typeof args.out === "string" ? (args.out as string) : "tickers/history.sql";
  const csvOut =
    "csv-out" in args
      ? typeof args["csv-out"] === "string"
        ? (args["csv-out"] as string)
        : "" // flag with no value → skip
      : "tickers/history.csv";

  console.log("Rebuilding history.sql from git history of", allCsv);
  const commits = snapshotCommits(allCsv);
  if (!commits.length) {
    console.error(`No commits found touching ${allCsv}. Run from the repo root.`);
    process.exit(1);
  }
  console.log(`  ${commits.length} snapshot commits: ${commits[0].date.slice(0, 10)} → ${commits[commits.length - 1].date.slice(0, 10)}`);

  // Walk oldest → newest so later commits overwrite earlier ones for the same
  // (date, symbol) — i.e. the newest snapshot for a given day wins.
  const seen = new Map<string, string[]>(); // key `${date}\0${symbol}` → row
  let snapshots = 0;
  let rowsInSnapshots = 0;
  for (const { hash, date } of commits) {
    const text = showAt(hash, allCsv);
    const parsed = parseCsv(text);
    if (parsed.length === 0) continue;
    const [header, ...dataRows] = parsed;
    if (!header.length) continue;
    const idx = columnIndex(header);
    if (!(idx.symbol >= 0)) continue;
    const day = utcDate(date);
    snapshots++;
    for (const row of snapshotToHistory(dataRows, idx, day)) {
      rowsInSnapshots++;
      seen.set(`${day}\0${row[1]}`, row);
    }
  }

  const rows = [...seen.values()];
  console.log(`  ${snapshots} snapshots parsed, ${rowsInSnapshots} rows; ${rows.length} unique (date, symbol) rows after dedup.`);

  // SQL output.
  ensureDir(sqlOut.slice(0, sqlOut.lastIndexOf("/")) || ".");
  const sql = emitSql(rows);
  await Bun.write(sqlOut, sql);
  const mb = Bun.file(sqlOut).size / (1024 * 1024);
  console.log(`  Wrote ${sqlOut} (${mb.toFixed(1)} MB)`);
  if (mb > 100) console.log("  WARNING: output exceeds GitHub's 100 MB-per-file limit — do not commit.");

  // Optional CSV output (handy for inspection / non-SQL consumers).
  if (csvOut) {
    ensureDir(csvOut.slice(0, csvOut.lastIndexOf("/")) || ".");
    await writeCsv(csvOut, [HISTORY_COLUMNS, ...rows]);
    console.log(`  Wrote ${csvOut}`);
  }
}

if (import.meta.main) {
  await main();
}