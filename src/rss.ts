// Shared RSS 2.0 feed generator for the screeners.
//
// Each screener calls generateRss() at the end of its run to produce an
// rss.xml file alongside its CSV outputs under docs/data/<screener>/.
//
// The feed has one <item> per day that had hits, newest first. Each item
// lists the top hits for that day in the description (HTML table). This
// makes it easy to follow from any RSS reader — you get a daily digest
// of what the screener found.

import { readFileSync } from "node:fs";
import { parseCsv, parseNumber } from "./lib.ts";

export interface RssHit {
  symbol: string;
  name?: string;
  industry?: string;
  score: number;
  close: number;
  extraFields?: Record<string, string | number | boolean | null>;
}

export interface RssDay {
  date: string; // YYYY-MM-DD
  hits: RssHit[];
}

export interface RssConfig {
  /** Feed title shown in the RSS reader. */
  title: string;
  /** Feed description. */
  description: string;
  /** Output path for the rss.xml file. */
  outPath: string;
  /** Base URL for the GitHub Pages site (no trailing slash).
   *  e.g. "https://ozkanpakdil.github.io/top-us-stock-tickers" */
  siteUrl: string;
  /** Path to the HTML page on the site (e.g. "index.html" or "screener2.html"). */
  pagePath: string;
  /** Path to the data directory on the site (e.g. "data/screener"). */
  dataDir: string;
  /** Max number of days to include in the feed (default 30). */
  maxDays?: number;
  /** Max number of hits per day to show in the description (default 20). */
  maxHitsPerDay?: number;
}

/** XML-escape a string for safe inclusion in RSS. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Convert a YYYY-MM-DD date to an RFC 822 timestamp (RSS 2.0 spec).
 *  e.g. "Wed, 15 Aug 2026 00:00:00 GMT" */
function rfc822Date(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[d.getUTCDay()]}, ${d.getUTCDate().toString().padStart(2, "0")} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} 00:00:00 GMT`;
}

/** Build an HTML table for the hits in a day (for the RSS <description>). */
function hitsToHtmlTable(hits: RssHit[], maxHits: number): string {
  const rows = hits.slice(0, maxHits);
  if (rows.length === 0) return "<p>No hits.</p>";

  let html = '<table style="border-collapse:collapse;font-size:13px;font-family:monospace;">';
  html += "<thead><tr>";
  html += '<th style="text-align:left;padding:3px 8px;border-bottom:1px solid #ccc;">Symbol</th>';
  html += '<th style="text-align:right;padding:3px 8px;border-bottom:1px solid #ccc;">Score</th>';
  html += '<th style="text-align:right;padding:3px 8px;border-bottom:1px solid #ccc;">Close</th>';
  html += '<th style="text-align:left;padding:3px 8px;border-bottom:1px solid #ccc;">Industry</th>';
  html += "</tr></thead><tbody>";
  for (const h of rows) {
    const sym = xmlEscape(h.symbol);
    const name = h.name ? xmlEscape(h.name) : "";
    const ind = h.industry ? xmlEscape(h.industry) : "";
    html += "<tr>";
    html += `<td style="padding:3px 8px;border-bottom:1px solid #eee;"><b>${sym}</b>${name ? `<br><span style="font-size:11px;color:#666;">${name}</span>` : ""}</td>`;
    html += `<td style="text-align:right;padding:3px 8px;border-bottom:1px solid #eee;">${h.score.toFixed(2)}</td>`;
    html += `<td style="text-align:right;padding:3px 8px;border-bottom:1px solid #eee;">$${h.close.toFixed(2)}</td>`;
    html += `<td style="padding:3px 8px;border-bottom:1px solid #eee;">${ind}</td>`;
    html += "</tr>";
  }
  html += "</tbody></table>";
  if (hits.length > maxHits) {
    html += `<p style="font-size:11px;color:#666;">...and ${hits.length - maxHits} more.</p>`;
  }
  return html;
}

/** Generate an RSS 2.0 feed XML string from the collected days. */
export function generateRssXml(config: RssConfig, days: RssDay[]): string {
  const maxDays = config.maxDays ?? 30;
  const maxHits = config.maxHitsPerDay ?? 20;
  const sortedDays = [...days]
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, maxDays);

  const siteUrl = config.siteUrl.replace(/\/$/, "");
  const pageUrl = `${siteUrl}/${config.pagePath}`;
  const dataUrl = `${siteUrl}/${config.dataDir}`;
  const now = new Date().toUTCString();

  let items = "";
  for (const day of sortedDays) {
    const pubDate = rfc822Date(day.date);
    const topHit = day.hits[0];
    const titleSuffix = day.hits.length === 1 ? "1 hit" : `${day.hits.length} hits`;
    const topSym = topHit ? ` — top: ${topHit.symbol} (${topHit.score.toFixed(2)})` : "";
    const title = `${config.title} — ${day.date} — ${titleSuffix}${topSym}`;
    const guid = `${siteUrl}/${config.dataDir}?date=${day.date}`;

    const description = hitsToHtmlTable(day.hits, maxHits);

    items += `
    <item>
      <title>${xmlEscape(title)}</title>
      <link>${pageUrl}</link>
      <description><![CDATA[${description}]]></description>
      <guid isPermaLink="false">${guid}</guid>
      <pubDate>${pubDate}</pubDate>
    </item>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${xmlEscape(config.title)}</title>
    <link>${pageUrl}</link>
    <description>${xmlEscape(config.description)}</description>
    <language>en-us</language>
    <lastBuildDate>${now}</lastBuildDate>
    <docs>https://www.rssboard.org/rss-specification</docs>
    <generator>top-us-stock-tickers screener</generator>${items}
  </channel>
</rss>
`;
}

/** Read a screener hits_log.csv and convert it to RssDay[] grouped by date.
 *
 *  This is a generic reader that works with both screener formats — it just
 *  needs the columns: date, symbol, score, close, and optionally name,
 *  industry. Extra columns are captured in extraFields. */
export function hitsLogToRssDays(logPath: string): RssDay[] {
  let text = "";
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  const parsed = parseCsv(text);
  if (parsed.length <= 1) return [];
  const [header, ...rows] = parsed;
  const idx: Record<string, number> = {};
  header.forEach((h, i) => (idx[h] = i));

  const byDate = new Map<string, RssHit[]>();
  for (const r of rows) {
    if (!r.length) continue;
    const date = r[idx.date] ?? "";
    if (!date) continue;
    const symbol = r[idx.symbol] ?? "";
    if (!symbol) continue;
    const score = parseNumber(r[idx.score]) ?? 0;
    const close = parseNumber(r[idx.close]) ?? 0;
    const name = idx.name !== undefined ? r[idx.name] : undefined;
    const industry = idx.industry !== undefined ? r[idx.industry] : undefined;

    // Capture extra fields for richer descriptions
    const extraFields: Record<string, string | number | boolean | null> = {};
    for (const col of header) {
      if (["date", "symbol", "score", "close", "name", "industry"].includes(col)) continue;
      const val = r[idx[col]] ?? "";
      if (val === "") extraFields[col] = null;
      else if (val === "true") extraFields[col] = true;
      else if (val === "false") extraFields[col] = false;
      else {
        const n = parseNumber(val);
        extraFields[col] = n !== null ? n : val;
      }
    }

    const hit: RssHit = {
      symbol,
      name: name || undefined,
      industry: industry || undefined,
      score,
      close,
      extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
    };

    let arr = byDate.get(date);
    if (!arr) {
      arr = [];
      byDate.set(date, arr);
    }
    arr.push(hit);
  }

  // Sort hits within each day by score descending
  const days: RssDay[] = [];
  for (const [date, hits] of byDate) {
    hits.sort((a, b) => b.score - a.score);
    days.push({ date, hits });
  }
  return days;
}

/** Convenience: read hits_log.csv, generate RSS XML, and write it to the
 *  configured path. Returns the number of days included. */
export async function generateRssFromLog(config: RssConfig): Promise<number> {
  const logPath = config.outPath.replace(/rss\.xml$/, "hits_log.csv");
  const days = hitsLogToRssDays(logPath);
  const xml = generateRssXml(config, days);
  await Bun.write(config.outPath, xml);
  return days.length;
}