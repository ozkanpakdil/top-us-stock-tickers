// Shared helpers for the Bun/TypeScript data pipeline (no dependencies).
//
// Ports the helpers from the original Python scripts (update_tickers.py,
// archive_history.py, backfill_history.py) so the generated CSV / SQL output
// stays byte-compatible with what the repo used to ship: pandas float repr
// (integral floats get a trailing ".0"), QUOTE_MINIMAL CSV quoting, the exact
// history.sql shape, Yahoo symbol normalization, and the NASDAQ/Wikipedia
// field mapping.

import { mkdirSync } from "node:fs";

// --- Configuration (mirrors update_tickers.py) ------------------------------

export const NASDAQ_URL = "https://api.nasdaq.com/api/screener/stocks";
export const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/";
export const WIKIPEDIA_SP500_RAW_URL =
  "https://en.wikipedia.org/w/index.php?title=List_of_S%26P_500_companies&action=raw";

export const HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Accept: "application/json",
};

// Yahoo's unofficial chart endpoint rate-limits aggressively; keep this modest.
export const YAHOO_WORKERS = 15;

// Columns stored in the historical archive (CSV + SQL), in order.
export const HISTORY_COLUMNS = [
  "date", "symbol", "name", "price",
  "open", "high", "low", "close",
  "marketCap", "volume", "industry",
];
export const HISTORY_STRING_COLUMNS = new Set(["date", "symbol", "name", "industry"]);

export const HISTORY_CSV_PATH = "tickers/history.csv";
export const HISTORY_SQL_PATH = "tickers/history.sql";

// --- Symbol helpers --------------------------------------------------------

/** NASDAQ↔Wikipedia matching: dot→slash (BRK.B ↔ BRK/B). */
export function normalizeSymbol(s: string): string {
  return s.trim().toUpperCase().replace(/\./g, "/");
}

/** Yahoo Finance format: dots and slashes both become dashes (BRK-B, BF-B). */
export function yahooSymbol(s: string): string {
  return s.trim().toUpperCase().replace(/\./g, "-").replace(/\//g, "-");
}

/** Filename for a ticker's OHLC JSON. Stays in sync with the client's
 *  `symbol.toUpperCase().replace('.', '-').replace('/', '-')` path. */
export function safeFilename(s: string): string {
  return s.trim().toUpperCase().replace(/\./g, "-").replace(/\//g, "-") + ".json";
}

// --- Small utils -----------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** Tiny `--key value` / `--flag` parser for the args the pipeline accepts. */
export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

// --- Number parsing (mirrors parse_market_cap / parse_number / parse_int) ---

export function parseMarketCap(s: unknown): number | null {
  if (!s || s === "N/A") return null;
  const t = String(s).replace(/\$/g, "").replace(/,/g, "").trim();
  if (!t) return null;
  const mults: [string, number][] = [["T", 1e12], ["B", 1e9], ["M", 1e6], ["K", 1e3]];
  for (const [suffix, mult] of mults) {
    if (t.endsWith(suffix)) {
      const n = Number(t.slice(0, -1));
      return Number.isFinite(n) ? n * mult : null;
    }
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function parseNumber(s: unknown): number | null {
  if (!s || s === "N/A") return null;
  const n = Number(String(s).replace(/\$/g, "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

/** Parse a volume string to an integer. Mirrors Python `int(...)` which raises
 *  (→ None) on anything with a decimal point, so we reject non-integer strings. */
export function parseIntField(s: unknown): number | null {
  if (!s || s === "N/A") return null;
  const cleaned = String(s).replace(/,/g, "").trim();
  if (!cleaned || !/^-?\d+$/.test(cleaned)) return null;
  return Number(cleaned);
}

// --- Float / int / CSV rendering (pandas-compatible) ------------------------

/** Render a float the way pandas `repr`/`str` does for our value ranges:
 *  null/NaN → "" (CSV empty cell); integral floats → "N.0"; else shortest
 *  round-trip (JS String() == Python repr for prices/caps < 1e16). */
export function pyFloatRepr(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "";
  if (Number.isInteger(n)) return `${n}.0`;
  return String(n);
}

/** Render an integer field (volume). null/NaN → "" ; else plain integer. */
export function intRepr(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "";
  return String(Math.trunc(n));
}

/** QUOTE_MINIMAL: quote a CSV field only if it contains , " \n or \r. */
export function csvField(v: string | null | undefined): string {
  const s = v ?? "";
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Write rows (already stringified) as CSV with a trailing newline (pandas). */
export async function writeCsv(path: string, rows: string[][]): Promise<void> {
  const body = rows.map((r) => r.map(csvField).join(",")).join("\n") + "\n";
  await Bun.write(path, body);
}

/** Hand-rolled CSV parser tolerant of quoted fields and embedded newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop blank trailing lines (a file ending in "\n" yields a final [""]).
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export async function readCsv(path: string): Promise<{ header: string[]; rows: string[][] }> {
  const text = await Bun.file(path).text();
  const all = parseCsv(text);
  if (all.length === 0) return { header: [], rows: [] };
  const [header, ...rows] = all;
  return { header, rows };
}

// --- Concurrency limiter (replaces ThreadPoolExecutor) ----------------------

/** Run `fn` over `items` with at most `concurrency` in flight, preserving
 *  input order in the result array. A thrown error → `undefined` for that item
 *  (mirrors the Python `try/except → result = None` pattern). */
export async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array(items.length);
  let next = 0;
  let done = 0;
  const total = items.length;
  const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (true) {
      const i = next++;
      if (i >= total) break;
      try {
        results[i] = await fn(items[i], i);
      } catch {
        results[i] = undefined;
      }
      done++;
      onProgress?.(done, total);
    }
  });
  await Promise.all(workers);
  return results;
}

// --- Yahoo Finance chart fetch ---------------------------------------------

/** Fetch one Yahoo chart payload with the same retry policy as the Python
 *  code: 401/429 → exponential backoff + retry; 404 → null (unknown symbol);
 *  other errors → retry up to 3 times then null. Returns chart.result[0]. */
export async function fetchYahooChartRaw(
  symbol: string,
  params: Record<string, string>,
  timeoutMs = 20000,
): Promise<any | null> {
  const url =
    YAHOO_CHART_URL + yahooSymbol(symbol) + "?" + new URLSearchParams(params).toString();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await sleep(Math.random() * 50);
      const response = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if ((response.status === 401 || response.status === 429) && attempt < 2) {
        await sleep(2 ** attempt * 1000);
        continue;
      }
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Yahoo ${response.status}`);
      const payload: any = await response.json();
      return payload?.chart?.result?.[0] ?? null;
    } catch {
      if (attempt < 2) {
        await sleep(2 ** attempt * 1000);
        continue;
      }
      return null;
    }
  }
  return null;
}

/** UTC calendar date (YYYY-MM-DD) for a unix timestamp — matches
 *  datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat(). */
export function utcDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/** Escape a string the way Python's `json.dump(ensure_ascii=True)` does:
 *  quotes/backslash/control chars escaped, and every code unit >= 0x7f
 *  emitted as a lowercase \uXXXX. Keeps archive/manifest JSON byte-identical
 *  to the Python output. */
export function pyJsonString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0x22) out += '\\"';
    else if (code === 0x5c) out += "\\\\";
    else if (code === 0x08) out += "\\b";
    else if (code === 0x09) out += "\\t";
    else if (code === 0x0a) out += "\\n";
    else if (code === 0x0c) out += "\\f";
    else if (code === 0x0d) out += "\\r";
    else if (code < 0x20 || code >= 0x7f) out += "\\u" + code.toString(16).padStart(4, "0");
    else out += s[i];
  }
  return out + '"';
}