# Arachne

**Real-time web scraping studio.** Paste a URL, then watch every request move through the pipeline live. No account and no database.

Built with Next.js 15 (App Router), React 19, TypeScript, Tailwind v4 and Motion.

## Features

| | |
|---|---|
| **Live tracking** | Per-page pipeline lanes (Resolve → Robots → Fetch → Render → Parse → Extract → AI), animated stats, streaming terminal log |
| **Animated crawl map** | A live graph shows links being discovered, queued, visited or failed |
| **Three engines** | Static HTTP (fast), headless **Chromium** (SPAs, lazy-load), or **Auto** (upgrades when a page looks like an empty JS shell) |
| **Crawl mode** | Depth, page cap, parallel workers, delay, same-domain lock, include/exclude regex, **sitemap.xml seeding** |
| **Visual selector picker** | Click elements in a sandboxed page preview to generate CSS selectors |
| **Custom fields** | CSS selector, attribute and "all matches" per field |
| **AI extraction** | Describe the data you want in plain English. Gemini returns structured JSON per page |
| **Auto-extracted data** | Title, meta, OG, headings, links, images, tables, emails, phones, JSON-LD, clean Markdown |
| **Exports** | JSON (full or slim), CSV, Excel, Markdown bundle, links CSV, images CSV |
| **History** | Last runs saved in your browser (localStorage) |
| **Command palette** | `Ctrl/⌘ + K` |
| **Safety** | SSRF protection (including every redirect hop and browser sub-request), robots.txt (RFC 9309 longest-match), size and time caps, per-IP rate and concurrency limits, CSV formula-injection guard, sandboxed preview |

## Quick start

```bash
npm install
npm run browsers      # one-time: downloads Chromium for JS rendering
npm run dev           # http://localhost:3000
```

The browser engine is optional. Without Chromium, Arachne falls back to static fetching and says so in the log.

### Optional environment (`.env.local`)

```
GEMINI_API_KEY=            # server-side AI key (users can also paste their own in the UI)
RATE_LIMIT_PER_MIN=20
MAX_CONCURRENT_RUNS_PER_IP=2
ALLOW_PRIVATE_TARGETS=1    # dev only: allow scraping localhost / LAN
```

## Architecture

```
app/
  page.tsx               UI orchestration
  api/scrape/route.ts    POST → NDJSON event stream (abort-aware)
  api/preview/route.ts   sanitized HTML + click-to-select script (sandboxed iframe)
lib/
  crawler.ts             worker pool, queue, event emission
  fetcher.ts             SSRF-safe fetch (manual redirects) + Playwright rendering
  extract.ts             Cheerio extraction + Turndown Markdown
  robots.ts / security.ts / ratelimit.ts / ai.ts
  use-scrape.ts          stream consumer + reducer for live state
components/              stats, pipeline lanes, crawl graph, terminal, results, overlays
```

The server streams one JSON event per line (`stage`, `log`, `discover`, `page`, `progress`, `done`). The client batches events per animation frame, so large crawls stay smooth.

## Deployment notes

- **Playwright cannot run in typical serverless limits.** Use Docker, Railway, Fly.io or a VPS. Without Chromium, the static engine works anywhere.
- With no authentication, public deployments should keep the rate limits on. The limiter is in-memory per instance, so use Redis or an edge limiter if you scale out.
- Scrape responsibly. Respect site terms, robots.txt and privacy law.

