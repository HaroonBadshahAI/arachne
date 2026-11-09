interface Bucket {
  hits: number[];
  active: number;
}
const buckets = new Map<string, Bucket>();

function bucket(key: string): Bucket {
  let b = buckets.get(key);
  if (!b) {
    b = { hits: [], active: 0 };
    buckets.set(key, b);
  }
  return b;
}

export function clientIp(req: Request): string {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "local";
}

/** Sliding-window limiter. Returns seconds to wait, or 0 if allowed. */
export function rateLimit(key: string, limit: number, windowMs = 60_000): number {
  const b = bucket(key);
  const now = Date.now();
  b.hits = b.hits.filter((t) => now - t < windowMs);
  if (b.hits.length >= limit) return Math.ceil((windowMs - (now - b.hits[0])) / 1000);
  b.hits.push(now);
  return 0;
}

export function acquireRun(key: string, max: number): boolean {
  const b = bucket(key);
  if (b.active >= max) return false;
  b.active++;
  return true;
}
export function releaseRun(key: string) {
  const b = bucket(key);
  b.active = Math.max(0, b.active - 1);
}

// Periodically drop idle buckets so memory doesn't grow.
const g = globalThis as unknown as { __arachneGc?: NodeJS.Timeout };
if (!g.__arachneGc) {
  g.__arachneGc = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) {
      if (b.active === 0 && b.hits.every((t) => now - t > 120_000)) buckets.delete(k);
    }
  }, 120_000);
  g.__arachneGc.unref?.();
}

