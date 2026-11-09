import { assertPublicUrl } from "./security";
import type { ScrapeConfig } from "./types";

export const USER_AGENTS: Record<ScrapeConfig["userAgent"], string> = {
  arachne: "Mozilla/5.0 (compatible; ArachneBot/1.0; +https://github.com/arachne)",
  chrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  mobile:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
};

export interface FetchOptions {
  timeoutMs: number;
  maxBytes?: number;
  userAgent?: string;
  signal?: AbortSignal;
  retries?: number;
}
export interface FetchResult {
  status: number;
  finalUrl: string;
  body: string;
  bytes: number;
  contentType: string;
  ms: number;
}

const MAX_REDIRECTS = 5;

async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; bytes: number }> {
  if (!res.body) return { text: "", bytes: 0 };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Response exceeded ${(maxBytes / 1_048_576).toFixed(1)} MB limit`);
    }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const ct = res.headers.get("content-type") ?? "";
  const charset = /charset=([\w-]+)/i.exec(ct)?.[1] ?? "utf-8";
  let text: string;
  try {
    text = new TextDecoder(charset).decode(buf);
  } catch {
    text = buf.toString("utf8");
  }
  return { text, bytes: total };
}

/** fetch() with SSRF validation on every redirect hop, size cap, timeout and retries. */
export async function safeFetchText(url: string, opts: FetchOptions): Promise<FetchResult> {
  const attempts = (opts.retries ?? 0) + 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const started = Date.now();
    try {
      let current = url;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        await assertPublicUrl(current);
        const signals = [AbortSignal.timeout(opts.timeoutMs)];
        if (opts.signal) signals.push(opts.signal);
        const res = await fetch(current, {
          redirect: "manual",
          signal: AbortSignal.any(signals),
          headers: {
            "user-agent": opts.userAgent ?? USER_AGENTS.arachne,
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
            "accept-language": "en-US,en;q=0.9",
          },
        });
        if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
          current = new URL(res.headers.get("location")!, current).toString();
          await res.body?.cancel();
          continue;
        }
        const { text, bytes } = await readCapped(res, opts.maxBytes ?? 5_000_000);
        return {
          status: res.status,
          finalUrl: current,
          body: text,
          bytes,
          contentType: res.headers.get("content-type") ?? "",
          ms: Date.now() - started,
        };
      }
      throw new Error("Too many redirects");
    } catch (e) {
      lastErr = e;
      if (opts.signal?.aborted) throw e;
      const msg = e instanceof Error ? e.message : "";
      // Never retry policy failures.
      if (/private|Invalid URL|Only http|Credentials/i.test(msg)) throw e;
      if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Fetch failed");
}

// ---------- Browser (Playwright) ----------

type PW = typeof import("playwright");
type Browser = import("playwright").Browser;

const g = globalThis as unknown as { __arachneBrowser?: Promise<Browser | null> };

export async function getBrowser(): Promise<Browser | null> {
  if (!g.__arachneBrowser) {
    g.__arachneBrowser = (async () => {
      try {
        const pw: PW = await import("playwright");
        const browser = await pw.chromium.launch({ headless: true });
        browser.on("disconnected", () => {
          g.__arachneBrowser = undefined;
        });
        return browser;
      } catch {
        g.__arachneBrowser = undefined;
        return null;
      }
    })();
  }
  return g.__arachneBrowser;
}

export async function browserAvailable(): Promise<boolean> {
  return (await getBrowser()) !== null;
}

export async function browserFetch(url: string, opts: FetchOptions): Promise<FetchResult> {
  const browser = await getBrowser();
  if (!browser) throw new Error("Browser engine unavailable (run `npm run browsers`)");
  const started = Date.now();
  const ctx = await browser.newContext({
    userAgent: opts.userAgent ?? USER_AGENTS.chrome,
    viewport: { width: 1366, height: 900 },
    serviceWorkers: "block",
  });
  try {
    // Block private-network requests and heavy assets.
    await ctx.route("**/*", async (route) => {
      const req = route.request();
      const type = req.resourceType();
      if (type === "media" || type === "font") return route.abort();
      try {
        await assertPublicUrl(req.url());
      } catch {
        return route.abort();
      }
      return route.continue();
    });
    const page = await ctx.newPage();
    const onAbort = () => void ctx.close().catch(() => {});
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: Math.min(opts.timeoutMs, 6000) }).catch(() => {});
    // Trigger lazy content.
    await page
      .evaluate(async () => {
        for (let y = 0; y < 3; y++) {
          window.scrollBy(0, window.innerHeight);
          await new Promise((r) => setTimeout(r, 150));
        }
        window.scrollTo(0, 0);
      })
      .catch(() => {});
    const html = await page.content();
    const finalUrl = page.url();
    await assertPublicUrl(finalUrl);
    return {
      status: resp?.status() ?? 200,
      finalUrl,
      body: html,
      bytes: Buffer.byteLength(html),
      contentType: resp?.headers()["content-type"] ?? "text/html",
      ms: Date.now() - started,
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** Heuristic: does static HTML look like an empty JS app shell? */
export function looksLikeSpaShell(html: string, wordCount: number): boolean {
  if (wordCount > 120) return false;
  return (
    /<div[^>]+id=["'](root|app|__next|__nuxt)["'][^>]*>\s*<\/div>/i.test(html) ||
    /<noscript[^>]*>[^<]*(enable|require)[^<]*javascript/i.test(html) ||
    wordCount < 40
  );
}

