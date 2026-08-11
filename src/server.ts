// Static + live-fallback dev server.
//
// Serves the GitHub Pages site from docs/ so `bun run dev` previews the exact
// deployed app. Two API endpoints are kept for LOCAL LIVE PLAY ONLY:
//   /api/tickers  -> reads tickers/all.csv (so the search box can show tickers
//                   that aren't archived yet)
//   /api/history  -> server-side proxy to Yahoo Finance (browsers can't call
//                   Yahoo directly). docs/index.html uses this as a fallback when
//                   a ticker has no docs/data/<SYMBOL>.json file.
// On GitHub Pages these endpoints don't exist; the client then falls back to
// "no archived data" and only archived tickers chart.

const repoRoot = new URL("../", import.meta.url);
const tickerCsvPath = new URL("tickers/all.csv", repoRoot);
const docsDir = new URL("../docs/", import.meta.url);

const tickerRows = await loadTickerRows();

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = Bun.serve({
  port: Number(process.env.PORT || 3000),
  async fetch(req) {
    const url = new URL(req.url);

    // --- API: ticker list -------------------------------------------------
    if (url.pathname === "/api/tickers") {
      return jsonResponse({
        tickers: tickerRows.map((row) => ({
          symbol: row.symbol,
          name: row.name ?? "",
          industry: row.industry ?? "",
        })),
      });
    }

    // --- API: Yahoo history proxy (local live fallback) -------------------
    if (url.pathname === "/api/history") {
      const symbol = url.searchParams.get("symbol")?.trim().toUpperCase();
      const range = url.searchParams.get("range") || "1mo";
      const interval = url.searchParams.get("interval") || "1d";
      const period1Raw = url.searchParams.get("period1");
      const period2Raw = url.searchParams.get("period2");
      const period1 = Number(period1Raw);
      const period2 = Number(period2Raw);
      const hasCustomWindow = Boolean(period1Raw && period2Raw && Number.isFinite(period1) && Number.isFinite(period2));

      if (!symbol) {
        return jsonResponse({ error: "Missing symbol query parameter." }, 400);
      }

      try {
        const yahooUrl = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`);
        if (hasCustomWindow) {
          yahooUrl.searchParams.set("period1", String(Math.floor(period1)));
          yahooUrl.searchParams.set("period2", String(Math.floor(period2)));
          yahooUrl.searchParams.set("interval", interval);
        } else {
          yahooUrl.searchParams.set("range", range);
          yahooUrl.searchParams.set("interval", interval);
        }

        const response = await fetch(yahooUrl, {
          headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        });

        if (!response.ok) {
          return jsonResponse({ error: `Yahoo Finance request failed: ${response.status}` }, 502);
        }

        const payload = await response.json();
        const chart = payload?.chart?.result?.[0];
        if (!chart) {
          return jsonResponse({ error: "No chart data returned for the requested symbol." }, 404);
        }

        const timestamps = chart.timestamp ?? [];
        const quote = chart.indicators?.quote?.[0] ?? {};
        const close = quote.close ?? [];
        const open = quote.open ?? [];
        const high = quote.high ?? [];
        const low = quote.low ?? [];
        const volume = quote.volume ?? [];

        const points = timestamps.map((timestamp: number, index: number) => ({
          timestamp,
          date: new Date(timestamp * 1000).toISOString(),
          close: close[index] ?? null,
          open: open[index] ?? null,
          high: high[index] ?? null,
          low: low[index] ?? null,
          volume: volume[index] ?? null,
        }));

        return jsonResponse({
          symbol,
          range,
          interval,
          points: points.filter((point: any) => point.close !== null),
        });
      } catch (error) {
        return jsonResponse({ error: `Unable to load history: ${error instanceof Error ? error.message : String(error)}` }, 500);
      }
    }

    // --- Static: serve docs/ ---------------------------------------------
    // SPA-style: unknown paths fall back to docs/index.html (the site is one page).
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/index.html";

    const filePath = new URL("." + rel, docsDir);
    if (!filePath.href.startsWith(docsDir.href)) {
      return new Response("Forbidden", { status: 403 });
    }

    const file = Bun.file(filePath);
    if (await file.exists()) {
      const ext = filePath.pathname.slice(filePath.pathname.lastIndexOf("."));
      return new Response(file.stream(), {
        headers: { "Content-Type": MIME[ext] ?? "application/octet-stream" },
      });
    }

    // Fall back to index.html for non-API, non-file routes.
    const indexFile = Bun.file(new URL("index.html", docsDir));
    if (await indexFile.exists()) {
      return new Response(indexFile.stream(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Stock chart server (docs/ + live fallback) running at http://localhost:${server.port}`);

async function loadTickerRows() {
  const csv = await Bun.file(tickerCsvPath).text();
  const lines = csv.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]);
  const records = lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ""]));
  });

  return records
    .filter((record) => record.symbol)
    .map((record) => ({
      symbol: record.symbol.trim().toUpperCase(),
      name: record.name?.trim() ?? "",
      industry: record.industry?.trim() ?? "",
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function splitCsvLine(line: string) {
  const result: string[] = [];
  let current = "";
  let insideQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      const next = line[i + 1];
      if (insideQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        insideQuotes = !insideQuotes;
      }
      continue;
    }
    if (char === "," && !insideQuotes) {
      result.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  result.push(current);
  return result;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}