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

/** Format a market cap value for display. */
function fmtMarketCap(mc: number | null | undefined): string {
  if (mc === null || mc === undefined) return "—";
  if (mc >= 1e12) return `$${(mc / 1e12).toFixed(2)}T`;
  if (mc >= 1e9) return `$${(mc / 1e9).toFixed(1)}B`;
  if (mc >= 1e6) return `$${(mc / 1e6).toFixed(0)}M`;
  return `$${mc.toFixed(0)}`;
}

/** Format an employee count with k suffix. */
function fmtEmployees(emp: number | null | undefined): string {
  if (emp === null || emp === undefined) return "—";
  if (emp >= 1000) return `${(emp / 1000).toFixed(0)}k`;
  return String(emp);
}

/** Format a trend value as an arrow symbol. */
function fmtTrend(t: string | null | undefined): string {
  if (t === "up") return "↑";
  if (t === "down") return "↓";
  if (t === "flat") return "→";
  return "?";
}

/** Build an HTML table for the hits in a day (for the RSS <description>).
 *
 *  The table adapts to the available data: if the hits have VCP / rules /
 *  fundamentals in extraFields (screener-2 style), a rich multi-column table
 *  is produced. Otherwise it falls back to the basic 4-column format. */
function hitsToHtmlTable(hits: RssHit[], maxHits: number): string {
  const rows = hits.slice(0, maxHits);
  if (rows.length === 0) return "<p>No hits.</p>";

  // Detect if we have rich VCP/screener-2 data
  const hasVcp = rows.some((h) => h.extraFields && "vcp" in h.extraFields);
  const hasRules = rows.some((h) => h.extraFields && "rulesPassed" in h.extraFields);

  const thStyle = "text-align:left;padding:3px 6px;border-bottom:2px solid #ccc;font-size:11px;text-transform:uppercase;letter-spacing:0.3px;color:#888;";
  const thR = "text-align:right;padding:3px 6px;border-bottom:2px solid #ccc;font-size:11px;text-transform:uppercase;letter-spacing:0.3px;color:#888;";
  const tdStyle = "padding:3px 6px;border-bottom:1px solid #eee;";
  const tdR = "text-align:right;padding:3px 6px;border-bottom:1px solid #eee;";
  const upColor = "color:#16a06a;font-weight:bold;";
  const downColor = "color:#e23b3b;";
  const mutedColor = "color:#999;";

  let html = '<table style="border-collapse:collapse;font-size:12px;font-family:monospace;">';

  if (hasVcp || hasRules) {
    // Rich table for screener-2 (VCP) data
    html += "<thead><tr>";
    html += `<th style="${thStyle}">Symbol</th>`;
    html += `<th style="${thR}">Score</th>`;
    html += `<th style="${thR}">Rules</th>`;
    html += `<th style="${thR}">Close</th>`;
    html += `<th style="${thR}">Mkt Cap</th>`;
    html += `<th style="${thR}">VCP</th>`;
    html += `<th style="${thR}">Contr.</th>`;
    html += `<th style="${thR}">Vol Ratio</th>`;
    html += `<th style="${thR}">P/E</th>`;
    html += `<th style="${thR}">P/E↑</th>`;
    html += `<th style="${thR}">FCF↑</th>`;
    html += `<th style="${thR}">EPS↑</th>`;
    html += `<th style="${thR}">Emp</th>`;
    html += `<th style="${thStyle}">Industry</th>`;
    html += "</tr></thead><tbody>";

    for (const h of rows) {
      const sym = xmlEscape(h.symbol);
      const name = h.name ? xmlEscape(h.name) : "";
      const ind = h.industry ? xmlEscape(h.industry) : "";
      const ef = h.extraFields ?? {};
      const vcp = ef.vcp === true;
      const rulesPassed = typeof ef.rulesPassed === "number" ? ef.rulesPassed : null;
      const rulesTotal = typeof ef.rulesTotal === "number" ? ef.rulesTotal : null;
      const contractions = typeof ef.contractions === "number" ? ef.contractions : null;
      const volRatio = typeof ef.volatilityRatio === "number" ? ef.volatilityRatio : null;
      const pe = typeof ef.pe === "number" ? ef.pe : null;
      const peTrend = typeof ef.peTrend === "string" ? ef.peTrend : null;
      const fcfTrend = typeof ef.fcfTrend === "string" ? ef.fcfTrend : null;
      const epsTrend = typeof ef.epsTrend === "string" ? ef.epsTrend : null;
      const employees = typeof ef.employees === "number" ? ef.employees : null;
      const marketCap = typeof ef.marketCap === "number" ? ef.marketCap : null;

      const trendColor = (t: string | null) => t === "up" ? upColor : t === "down" ? downColor : mutedColor;

      html += "<tr>";
      html += `<td style="${tdStyle}"><b>${sym}</b>${name ? `<br><span style="font-size:10px;color:#999;">${name}</span>` : ""}</td>`;
      html += `<td style="${tdR}"><b>${h.score.toFixed(2)}</b></td>`;
      html += `<td style="${tdR}">${rulesPassed !== null ? `${rulesPassed}/${rulesTotal ?? "?"}` : "—"}</td>`;
      html += `<td style="${tdR}">$${h.close.toFixed(2)}</td>`;
      html += `<td style="${tdR}">${fmtMarketCap(marketCap)}</td>`;
      html += `<td style="${tdR}${vcp ? upColor : mutedColor}">${vcp ? "✓" : "—"}</td>`;
      html += `<td style="${tdR}">${contractions !== null ? contractions : "—"}</td>`;
      html += `<td style="${tdR}">${volRatio !== null ? volRatio.toFixed(2) + "×" : "—"}</td>`;
      html += `<td style="${tdR}">${pe !== null ? pe.toFixed(1) : "—"}</td>`;
      html += `<td style="${tdR}${trendColor(peTrend)}">${fmtTrend(peTrend)}</td>`;
      html += `<td style="${tdR}${trendColor(fcfTrend)}">${fmtTrend(fcfTrend)}</td>`;
      html += `<td style="${tdR}${trendColor(epsTrend)}">${fmtTrend(epsTrend)}</td>`;
      html += `<td style="${tdR}">${fmtEmployees(employees)}</td>`;
      html += `<td style="${tdStyle}">${ind}</td>`;
      html += "</tr>";
    }
  } else {
    // Basic table for screener-1 (breakout) data
    html += "<thead><tr>";
    html += `<th style="${thStyle}">Symbol</th>`;
    html += `<th style="${thR}">Score</th>`;
    html += `<th style="${thR}">Close</th>`;
    html += `<th style="${thR}">Day%</th>`;
    html += `<th style="${thR}">Vol Ratio</th>`;
    html += `<th style="${thR}">Emp</th>`;
    html += `<th style="${thStyle}">Industry</th>`;
    html += "</tr></thead><tbody>";

    for (const h of rows) {
      const sym = xmlEscape(h.symbol);
      const name = h.name ? xmlEscape(h.name) : "";
      const ind = h.industry ? xmlEscape(h.industry) : "";
      const ef = h.extraFields ?? {};
      const dayChange = typeof ef.dayChangePct === "number" ? ef.dayChangePct : null;
      const volRatio = typeof ef.volRatio === "number" ? ef.volRatio : null;
      const employees = typeof ef.employees === "number" ? ef.employees : null;

      html += "<tr>";
      html += `<td style="${tdStyle}"><b>${sym}</b>${name ? `<br><span style="font-size:10px;color:#999;">${name}</span>` : ""}</td>`;
      html += `<td style="${tdR}"><b>${h.score.toFixed(2)}</b></td>`;
      html += `<td style="${tdR}">$${h.close.toFixed(2)}</td>`;
      html += `<td style="${tdR}${dayChange !== null && dayChange >= 0 ? upColor : downColor}">${dayChange !== null ? (dayChange >= 0 ? "+" : "") + dayChange.toFixed(2) + "%" : "—"}</td>`;
      html += `<td style="${tdR}">${volRatio !== null ? volRatio.toFixed(1) + "×" : "—"}</td>`;
      html += `<td style="${tdR}">${fmtEmployees(employees)}</td>`;
      html += `<td style="${tdStyle}">${ind}</td>`;
      html += "</tr>";
    }
  }

  html += "</tbody></table>";
  if (hits.length > maxHits) {
    html += `<p style="font-size:11px;color:#999;">...and ${hits.length - maxHits} more — see full table at the link.</p>`;
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
    const hitCount = day.hits.length;
    const titleSuffix = hitCount === 1 ? "1 hit" : `${hitCount} hits`;

    // Count VCP matches and strong candidates (rules >= 7) for the title
    const vcpCount = day.hits.filter((h) => h.extraFields?.vcp === true).length;
    const strongCount = day.hits.filter((h) => {
      const rp = h.extraFields?.rulesPassed;
      const rt = h.extraFields?.rulesTotal;
      return typeof rp === "number" && typeof rt === "number" && rp >= rt - 2;
    }).length;

    const topSym = topHit ? ` — top: ${topHit.symbol} (${topHit.score.toFixed(2)})` : "";
    const vcpStr = vcpCount > 0 ? ` — ${vcpCount} VCP` : "";
    const strongStr = strongCount > 0 && strongCount !== hitCount ? ` — ${strongCount} strong` : "";
    const title = `${config.title} — ${day.date} — ${titleSuffix}${vcpStr}${strongStr}${topSym}`;
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