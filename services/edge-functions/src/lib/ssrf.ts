// SSRF defense for server-side fetches of caller-controlled URLs (US-344, US-345).
//
// The edge service runs with the service-role key on an internal network that
// can reach Supabase, cloud metadata (169.254.169.254), and other private
// hosts. Two surfaces accept a URL from an authenticated-but-untrusted caller:
//   - POST /api/v1/grades — image `url` (api-v1.ts)
//   - PATCH /api/v1/webhook + grade-delivery (webhook-delivery.ts)
// Both MUST resolve the target hostname and refuse any address that maps to a
// private / loopback / link-local / metadata / reserved range BEFORE the
// socket is opened, and re-validate every redirect hop (a public host can 302
// to http://169.254.169.254/). DNS is resolved here and the validated literal
// IP is what we connect to, closing the TOCTOU/rebinding window.

import { isProduction } from "./env.ts";

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

// ── IP literal parsing + range classification ──────────────────────

function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 192 && b === 0 && octets[2] === 0) return true; // 192.0.0.0/24 IETF protocol
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255
  return false;
}

// Parse an IPv6 literal (no brackets, no zone) into 8 16-bit groups, handling
// "::" compression and embedded IPv4 (e.g. ::ffff:1.2.3.4).
function parseIpv6(host: string): number[] | null {
  let h = host;
  // Strip a zone id (fe80::1%eth0) — never routable; treat as parse-able.
  const pct = h.indexOf("%");
  if (pct !== -1) h = h.slice(0, pct);

  // Embedded IPv4 tail.
  let tail: number[] = [];
  const lastColon = h.lastIndexOf(":");
  if (lastColon !== -1 && h.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4(h.slice(lastColon + 1));
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    h = h.slice(0, lastColon + 1) + "0:0";
  }

  const halves = h.split("::");
  if (halves.length > 2) return null;

  const toGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  let groups: number[];
  if (halves.length === 2) {
    const head = toGroups(halves[0]);
    const back = toGroups(halves[1]);
    if (head === null || back === null) return null;
    const fill = 8 - head.length - back.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array(fill).fill(0), ...back];
  } else {
    const all = toGroups(halves[0]);
    if (all === null) return null;
    groups = all;
  }
  if (tail.length) {
    // Replace the synthetic trailing "0:0" with the embedded v4 groups.
    groups = [...groups.slice(0, 6), ...tail];
  }
  return groups.length === 8 ? groups : null;
}

function isPrivateIpv6(groups: number[]): boolean {
  const [g0] = groups;
  // ::1 loopback and :: unspecified.
  if (groups.every((g) => g === 0)) return true;
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  // IPv4-mapped ::ffff:0:0/96 — check the embedded v4.
  if (
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 &&
    groups[4] === 0 && groups[5] === 0xffff
  ) {
    const v4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
    return isPrivateIpv4(v4);
  }
  return false;
}

/** True when the given IP literal is NOT globally routable (must be refused). */
export function isPrivateIp(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) return isPrivateIpv4(v4);
  const v6 = parseIpv6(ip);
  if (v6) return isPrivateIpv6(v6);
  // Unparseable — fail closed.
  return true;
}

// ── Hostname resolution + validation ───────────────────────────────

async function resolveHostIps(hostname: string): Promise<string[]> {
  // Literal IP host — no DNS.
  if (parseIpv4(hostname) || hostname.includes(":") || /^\[.*\]$/.test(hostname)) {
    return [hostname.replace(/^\[|\]$/g, "")];
  }
  const ips: string[] = [];
  for (const kind of ["A", "AAAA"] as const) {
    try {
      const recs = await Deno.resolveDns(hostname, kind);
      ips.push(...recs);
    } catch {
      // No record of this kind — ignore; we require at least one usable IP.
    }
  }
  return ips;
}

export interface UrlGuardOptions {
  /** When true (default), require https. Set false to allow http in dev. */
  requireHttps?: boolean;
}

/**
 * Validates that `rawUrl` is an https (or http in dev) URL whose hostname
 * resolves only to public, routable addresses. Throws SsrfError otherwise.
 * Returns the parsed URL and the validated IPs to connect to.
 */
export async function assertPublicUrl(
  rawUrl: string,
  opts: UrlGuardOptions = {},
): Promise<{ url: URL; ips: string[] }> {
  const requireHttps = opts.requireHttps ?? isProduction();

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError("URL is malformed");
  }

  if (url.protocol === "http:") {
    if (requireHttps) throw new SsrfError("URL must use https");
  } else if (url.protocol !== "https:") {
    throw new SsrfError(`URL protocol ${url.protocol} is not allowed`);
  }

  const ips = await resolveHostIps(url.hostname);
  if (ips.length === 0) {
    throw new SsrfError("URL hostname does not resolve");
  }
  for (const ip of ips) {
    if (isPrivateIp(ip)) {
      throw new SsrfError("URL resolves to a non-public address");
    }
  }
  return { url, ips };
}

export interface SafeFetchOptions extends UrlGuardOptions {
  /** Max bytes to read from the body before aborting. Default 25 MiB. */
  maxBytes?: number;
  /** Per-request timeout in ms. Default 10s. */
  timeoutMs?: number;
  /** Max redirect hops to follow (each re-validated). Default 3. */
  maxRedirects?: number;
  /** fetch init (method/headers/body). `redirect` is forced to "manual". */
  init?: RequestInit;
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * SSRF-safe fetch: validates the target (and every redirect hop) against the
 * private-range blocklist, disables automatic redirects, and caps the body
 * size and total time. Use for ANY fetch of a caller-supplied URL.
 */
export async function safeFetch(
  rawUrl: string,
  opts: SafeFetchOptions = {},
): Promise<{ status: number; bytes: Uint8Array; contentType: string | null }> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? 3;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let current = rawUrl;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      await assertPublicUrl(current, opts); // throws SsrfError on private/invalid

      const response = await fetch(current, {
        ...opts.init,
        redirect: "manual",
        signal: controller.signal,
      });

      // Manual redirect handling so each Location is re-validated.
      if (response.status >= 300 && response.status < 400) {
        const loc = response.headers.get("location");
        await response.body?.cancel().catch(() => {});
        if (!loc) throw new SsrfError("Redirect without Location header");
        if (hop === maxRedirects) throw new SsrfError("Too many redirects");
        current = new URL(loc, current).toString();
        continue;
      }

      const contentType = response.headers.get("content-type");
      const bytes = await readCapped(response, maxBytes);
      return { status: response.status, bytes, contentType };
    }
    throw new SsrfError("Too many redirects");
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new SsrfError("Response exceeds maximum allowed size");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
