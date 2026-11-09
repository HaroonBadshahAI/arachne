import { lookup } from "node:dns/promises";
import net from "node:net";

/** Returns true for loopback, private, link-local, CGNAT, multicast and reserved addresses. */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique local
    if (v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb")) return true;
    if (v.startsWith("ff")) return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true;
}

const dnsCache = new Map<string, { ok: boolean; at: number }>();

/**
 * SSRF guard. Throws if the URL is not http(s) or resolves to a non-public address.
 * Set ALLOW_PRIVATE_TARGETS=1 for local development against localhost.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed");
  }
  if (url.username || url.password) throw new Error("Credentials in URLs are not allowed");
  if (process.env.ALLOW_PRIVATE_TARGETS === "1") return url;

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const cached = dnsCache.get(host);
  if (cached && Date.now() - cached.at < 60_000) {
    if (!cached.ok) throw new Error("Target resolves to a private or reserved address");
    return url;
  }
  let ok = true;
  if (net.isIP(host)) {
    ok = !isPrivateIp(host);
  } else {
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) ok = false;
    else {
      try {
        const addrs = await lookup(host, { all: true });
        ok = addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
      } catch {
        throw new Error(`Could not resolve host: ${host}`);
      }
    }
  }
  dnsCache.set(host, { ok, at: Date.now() });
  if (!ok) throw new Error("Target resolves to a private or reserved address");
  return url;
}

export function normalizeUserUrl(input: string): string {
  const t = input.trim();
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

