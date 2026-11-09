import * as cheerio from "cheerio";
import TurndownService from "turndown";
import type { FieldSpec, ImageInfo, LinkInfo, PageResult } from "./types";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
turndown.remove((node) => ["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "SVG", "CANVAS"].includes(node.nodeName.toUpperCase()));

const NOISE = "script,style,noscript,template,iframe,svg,canvas,link,meta";
const CHROME = "nav,footer,header,aside,form,[role=banner],[role=navigation],[role=contentinfo],[aria-hidden=true],.cookie,.cookies,#cookie-banner,.advert,.ads";

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,4}[\s.-]\d{3,4}(?:[\s.-]\d{2,4})?/g;

function abs(href: string | undefined, base: string): string | null {
  if (!href) return null;
  const h = href.trim();
  if (/^(javascript:|mailto:|tel:|data:|#)/i.test(h)) return null;
  try {
    const u = new URL(h, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function normalizeForCrawl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = "";
    if (x.pathname.length > 1 && x.pathname.endsWith("/")) x.pathname = x.pathname.slice(0, -1);
    return x.toString();
  } catch {
    return u;
  }
}

/** Pick the most content-dense container, falling back to <body>. */
function mainContent($: cheerio.CheerioAPI): cheerio.Cheerio<import("domhandler").Element> {
  const candidates = ["main", "article", "[role=main]", "#content", ".content", "#main", ".post", ".article"];
  for (const sel of candidates) {
    const el = $(sel).first();
    if (el.length && clean(el.text()).length > 200) return el as never;
  }
  return $("body") as never;
}

export interface ExtractInput {
  html: string;
  url: string;
  finalUrl: string;
  status: number;
  depth: number;
  renderedWith: "static" | "browser";
  fetchMs: number;
  bytes: number;
  fields: FieldSpec[];
}

export function extractPage(input: ExtractInput): PageResult {
  const { html, finalUrl } = input;
  const $ = cheerio.load(html);
  const origin = new URL(finalUrl).origin;

  const title = clean($("title").first().text()) || clean($("h1").first().text());
  const meta = (n: string) =>
    $(`meta[name="${n}"]`).attr("content") ?? $(`meta[property="${n}"]`).attr("content") ?? "";
  const description = clean(meta("description") || meta("og:description"));
  const lang = $("html").attr("lang") ?? "";
  const canonical = abs($('link[rel="canonical"]').attr("href"), finalUrl) ?? "";
  const ogImage = abs(meta("og:image"), finalUrl) ?? "";

  // JSON-LD before we strip scripts.
  const jsonLd: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      jsonLd.push(JSON.parse($(el).contents().text()));
    } catch {
      /* ignore malformed */
    }
  });

  // Custom field extraction runs on the untouched DOM.
  const fields: Record<string, string | string[] | null> = {};
  for (const f of input.fields) {
    try {
      const els = $(f.selector);
      const read = (el: ReturnType<typeof $>) =>
        clean(f.attr ? (el.attr(f.attr) ?? "") : el.text());
      if (!els.length) fields[f.name] = f.multiple ? [] : null;
      else if (f.multiple) {
        fields[f.name] = els.toArray().map((e) => read($(e))).filter(Boolean);
      } else {
        fields[f.name] = read(els.first());
      }
    } catch {
      fields[f.name] = null;
    }
  }

  // Links & images from the full document.
  const seenLinks = new Set<string>();
  const links: LinkInfo[] = [];
  $("a[href]").each((_, el) => {
    const href = abs($(el).attr("href"), finalUrl);
    if (!href) return;
    const key = normalizeForCrawl(href);
    if (seenLinks.has(key)) return;
    seenLinks.add(key);
    links.push({
      href: key,
      text: clean($(el).text()).slice(0, 120) || clean($(el).attr("aria-label") ?? "") || "",
      internal: new URL(key).origin === origin,
    });
  });

  const seenImgs = new Set<string>();
  const images: ImageInfo[] = [];
  $("img").each((_, el) => {
    const src = abs($(el).attr("src") || $(el).attr("data-src") || $(el).attr("data-lazy-src"), finalUrl);
    if (!src || seenImgs.has(src)) return;
    seenImgs.add(src);
    images.push({ src, alt: clean($(el).attr("alt") ?? "") });
  });

  // Tables
  const tables: string[][][] = [];
  $("table").each((i, el) => {
    if (i >= 10) return;
    const rows: string[][] = [];
    $(el)
      .find("tr")
      .slice(0, 200)
      .each((_, tr) => {
        const cells = $(tr)
          .children("th,td")
          .toArray()
          .map((c) => clean($(c).text()));
        if (cells.length) rows.push(cells);
      });
    if (rows.length) tables.push(rows);
  });

  // Readable content
  $(NOISE).remove();
  const body = $("body");
  const fullText = clean(body.text());
  const emails = [...new Set(fullText.match(EMAIL_RE) ?? [])].slice(0, 50);
  const phones = [...new Set((fullText.match(PHONE_RE) ?? []).map((p) => p.trim()))]
    .filter((p) => p.replace(/\D/g, "").length >= 7)
    .slice(0, 30);

  const headings: { level: number; text: string }[] = [];
  body.find("h1,h2,h3,h4,h5,h6").each((_, el) => {
    const t = clean($(el).text());
    if (t) headings.push({ level: Number(el.tagName.slice(1)), text: t });
  });

  const clone = cheerio.load($.html());
  clone(CHROME).remove();
  const main = mainContent(clone);
  const mainHtml = main.html() ?? "";
  // Resolve relative URLs in markdown output.
  const m$ = cheerio.load(`<div id="r">${mainHtml}</div>`);
  m$("a[href]").each((_, el) => {
    const h = abs(m$(el).attr("href"), finalUrl);
    if (h) m$(el).attr("href", h);
  });
  m$("img").each((_, el) => {
    const s = abs(m$(el).attr("src") || m$(el).attr("data-src"), finalUrl);
    if (s) m$(el).attr("src", s);
  });
  const markdown = turndown.turndown(m$("#r").html() ?? "").replace(/\n{3,}/g, "\n\n").trim();
  const text = clean(main.text());
  const wordCount = text ? text.split(/\s+/).length : 0;

  return {
    url: input.url,
    finalUrl,
    status: input.status,
    depth: input.depth,
    renderedWith: input.renderedWith,
    fetchMs: input.fetchMs,
    bytes: input.bytes,
    title,
    description,
    lang,
    canonical,
    ogImage,
    headings: headings.slice(0, 100),
    links: links.slice(0, 1000),
    images: images.slice(0, 300),
    tables,
    emails,
    phones,
    jsonLd: jsonLd.slice(0, 10),
    text: text.slice(0, 200_000),
    markdown: markdown.slice(0, 300_000),
    wordCount,
    readingMins: Math.max(1, Math.round(wordCount / 220)),
    fields,
  };
}

/** Parse <loc> entries from a sitemap or sitemap index. */
export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const $ = cheerio.load(xml, { xmlMode: true });
  const urls = $("urlset > url > loc")
    .toArray()
    .map((e) => $(e).text().trim());
  const sitemaps = $("sitemapindex > sitemap > loc")
    .toArray()
    .map((e) => $(e).text().trim());
  return { urls, sitemaps };
}
