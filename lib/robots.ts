import { safeFetchText } from "./fetcher";

interface Rule {
  allow: boolean;
  path: string;
}
interface RobotsInfo {
  rules: Rule[];
  crawlDelay: number | null;
  sitemaps: string[];
  fetched: boolean;
}

const cache = new Map<string, { info: RobotsInfo; at: number }>();

function parse(text: string, agentToken: string): RobotsInfo {
  const groups: { agents: string[]; rules: Rule[]; delay: number | null }[] = [];
  const sitemaps: string[] = [];
  let cur: { agents: string[]; rules: Rule[]; delay: number | null } | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [], delay: null };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === "sitemap") sitemaps.push(val);
    else if (cur && (key === "allow" || key === "disallow")) {
      if (val) cur.rules.push({ allow: key === "allow", path: val });
    } else if (cur && key === "crawl-delay") {
      const n = parseFloat(val);
      if (!Number.isNaN(n)) cur.delay = n;
    }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && agentToken.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  return {
    rules: chosen.flatMap((g) => g.rules),
    crawlDelay: chosen.find((g) => g.delay !== null)?.delay ?? null,
    sitemaps,
    fetched: true,
  };
}

function toRegex(path: string): RegExp {
  const esc = path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + (esc.endsWith("\\$") ? esc.slice(0, -2) + "$" : esc));
}

export async function getRobots(origin: string, agentToken: string, timeoutMs: number): Promise<RobotsInfo> {
  const key = `${origin}|${agentToken}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.info;
  let info: RobotsInfo = { rules: [], crawlDelay: null, sitemaps: [], fetched: false };
  try {
    const res = await safeFetchText(`${origin}/robots.txt`, { timeoutMs: Math.min(timeoutMs, 8000), maxBytes: 512_000 });
    if (res.status >= 200 && res.status < 300) info = parse(res.body, agentToken.toLowerCase());
  } catch {
    /* treat unreachable robots.txt as allow-all */
  }
  cache.set(key, { info, at: Date.now() });
  return info;
}

/** Longest-match rule wins; Allow beats Disallow on ties (RFC 9309). */
export function isAllowed(info: RobotsInfo, pathWithQuery: string): boolean {
  let best: { len: number; allow: boolean } | null = null;
  for (const r of info.rules) {
    if (toRegex(r.path).test(pathWithQuery)) {
      const len = r.path.length;
      if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
    }
  }
  return best ? best.allow : true;
}

