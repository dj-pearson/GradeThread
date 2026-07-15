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
// to http://169.254.169.254/).
//
// DNS-rebinding pin (US-1883 AC2): validating the hostname's resolution and then
// handing the ORIGINAL hostname to fetch() lets fetch RE-RESOLVE independently —
// a 0-TTL attacker returns a public IP to assertPublicUrl() and a private IP to
// fetch's resolver, so validation and connection diverge. safeFetch() therefore
// resolves ONCE, validates, then opens the socket to the exact validated IP
// (Deno.connect to the literal IP; for https, Deno.startTls carries the original
// hostname as SNI so the certificate is still verified against the hostname). The
// connection can no longer resolve to anything other than the address we cleared.

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
 * private-range blocklist, connects to the exact validated IP (closing the
 * DNS-rebinding window — see the file header), disables automatic redirects,
 * and caps the body size and total time. Use for ANY fetch of a caller-supplied
 * URL. Optimised for GET fetches of remote images (the only production callers);
 * opts.init may set method/headers/body for other uses.
 */
export async function safeFetch(
  rawUrl: string,
  opts: SafeFetchOptions = {},
): Promise<{ status: number; bytes: Uint8Array; contentType: string | null }> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? 3;
  const deadline = Date.now() + timeoutMs;

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    // Resolve + validate ONCE, then connect to the IP we cleared — validation
    // and connection cannot diverge (no fetch re-resolution).
    const { url, ips } = await assertPublicUrl(current, opts);

    const res = await pinnedRequest(url, ips, {
      init: opts.init,
      maxBytes,
      timeoutMs: Math.max(1, deadline - Date.now()),
    });

    // Manual redirect handling so each Location is re-validated + re-pinned.
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new SsrfError("Redirect without Location header");
      if (hop === maxRedirects) throw new SsrfError("Too many redirects");
      current = new URL(loc, url).toString();
      continue;
    }

    return {
      status: res.status,
      bytes: res.bytes,
      contentType: res.headers.get("content-type"),
    };
  }
  throw new SsrfError("Too many redirects");
}

// ── IP-pinned HTTP/1.1 client ──────────────────────────────────────
// A minimal client that connects to a pre-validated IP literal so the socket
// can't be re-pointed at a private host after validation. Reads the full
// (capped) response and returns it; redirects are handled by the caller.

interface PinnedResponse {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}

export async function pinnedRequest(
  url: URL,
  ips: string[],
  opts: { init?: RequestInit; maxBytes: number; timeoutMs: number },
): Promise<PinnedResponse> {
  const isHttps = url.protocol === "https:";
  const port = url.port ? Number(url.port) : (isHttps ? 443 : 80);
  // Prefer the first validated IP; every entry already passed isPrivateIp.
  const ip = ips[0];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let conn: Deno.Conn | null = null;
  try {
    const tcp = await Deno.connect({ hostname: ip, port });
    // Upgrade to TLS carrying the ORIGINAL hostname as SNI so the certificate is
    // verified against the hostname, not the IP we dialled.
    conn = isHttps
      ? await Deno.startTls(tcp, { hostname: url.hostname, alpnProtocols: ["http/1.1"] })
      : tcp;

    if (controller.signal.aborted) throw new SsrfError("Request timed out");

    await writeRequest(conn, url, opts.init);
    const raw = await readResponseCapped(conn, opts.maxBytes, controller.signal);
    return parseHttpResponse(raw.head, raw.body);
  } catch (err) {
    if (controller.signal.aborted) throw new SsrfError("Request timed out");
    if (err instanceof SsrfError) throw err;
    throw new SsrfError(`Fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
    try {
      conn?.close();
    } catch {
      // already closed / never opened
    }
  }
}

async function writeRequest(conn: Deno.Conn, url: URL, init?: RequestInit): Promise<void> {
  const method = (init?.method ?? "GET").toUpperCase();
  const path = `${url.pathname}${url.search}` || "/";
  const headers = new Headers(init?.headers);
  headers.set("host", url.host);
  headers.set("connection", "close"); // read-to-EOF; no keep-alive to hang on
  // Ask for an unencoded body so we never have to decompress (images are already
  // compressed; grading/webhook callers want the raw bytes).
  if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");
  if (!headers.has("user-agent")) headers.set("user-agent", "GradeThread-SafeFetch/1.0");

  let bodyBytes: Uint8Array | null = null;
  if (init?.body != null && method !== "GET" && method !== "HEAD") {
    const b: Uint8Array = init.body instanceof Uint8Array
      ? init.body
      : new TextEncoder().encode(
        typeof init.body === "string" ? init.body : String(init.body),
      );
    bodyBytes = b;
    headers.set("content-length", String(b.byteLength));
  }

  let reqLine = `${method} ${path} HTTP/1.1\r\n`;
  for (const [k, v] of headers) reqLine += `${k}: ${v}\r\n`;
  reqLine += "\r\n";

  const enc = new TextEncoder();
  await writeAll(conn, enc.encode(reqLine));
  if (bodyBytes) await writeAll(conn, bodyBytes);
}

async function writeAll(conn: Deno.Conn, data: Uint8Array): Promise<void> {
  let off = 0;
  while (off < data.byteLength) {
    off += await conn.write(data.subarray(off));
  }
}

// Read the response, capping the BODY at maxBytes. Splits the head (up to the
// first CRLFCRLF) from the body bytes. Connection: close ⇒ read to EOF.
async function readResponseCapped(
  conn: Deno.Conn,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ head: Uint8Array; body: Uint8Array }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let headEnd = -1;
  const buf = new Uint8Array(64 * 1024);
  while (true) {
    if (signal.aborted) throw new SsrfError("Request timed out");
    const n = await conn.read(buf);
    if (n === null) break; // EOF
    chunks.push(buf.slice(0, n));
    total += n;
    if (headEnd === -1) {
      const joined = concat(chunks);
      headEnd = indexOfCrlfCrlf(joined);
    }
    // Cap the BODY (bytes past the header terminator) at maxBytes.
    if (headEnd !== -1 && total - (headEnd + 4) > maxBytes) {
      throw new SsrfError("Response exceeds maximum allowed size");
    }
    // Bound total buffering even before headers are seen (malicious huge header).
    if (headEnd === -1 && total > maxBytes + 64 * 1024) {
      throw new SsrfError("Response headers exceed maximum allowed size");
    }
  }
  const all = concat(chunks);
  if (headEnd === -1) headEnd = indexOfCrlfCrlf(all);
  if (headEnd === -1) throw new SsrfError("Malformed HTTP response (no header terminator)");
  return { head: all.subarray(0, headEnd), body: all.subarray(headEnd + 4) };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function indexOfCrlfCrlf(b: Uint8Array): number {
  for (let i = 0; i + 3 < b.byteLength; i++) {
    if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) return i;
  }
  return -1;
}

// Parse the status line + headers, and decode the body per Transfer-Encoding /
// Content-Length. Exported for offline unit tests (the risky parsing path).
export function parseHttpResponse(head: Uint8Array, body: Uint8Array): PinnedResponse {
  const text = new TextDecoder("latin1").decode(head);
  const lines = text.split("\r\n");
  const statusLine = lines[0] ?? "";
  const m = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/);
  if (!m) throw new SsrfError("Malformed HTTP status line");
  const status = Number(m[1]);

  const headers = new Headers();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!name) continue;
    try {
      headers.append(name, value);
    } catch {
      // Skip a header name/value Headers rejects rather than failing the fetch.
    }
  }

  let decoded = body;
  const te = headers.get("transfer-encoding");
  if (te && te.toLowerCase().includes("chunked")) {
    decoded = dechunk(body);
  } else {
    const cl = headers.get("content-length");
    if (cl !== null) {
      const n = Number(cl);
      if (Number.isFinite(n) && n >= 0 && n <= body.byteLength) decoded = body.subarray(0, n);
    }
  }
  return { status, headers, bytes: decoded };
}

// Decode HTTP/1.1 chunked transfer-encoding. Tolerant of a missing final chunk
// (connection closed mid-stream) — returns what was decoded.
function dechunk(body: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [];
  let pos = 0;
  while (pos < body.byteLength) {
    // Read the chunk-size line (hex, up to CRLF; ignore any ;ext).
    let lineEnd = -1;
    for (let i = pos; i + 1 < body.byteLength; i++) {
      if (body[i] === 13 && body[i + 1] === 10) {
        lineEnd = i;
        break;
      }
    }
    if (lineEnd === -1) break;
    const sizeLine = new TextDecoder("latin1").decode(body.subarray(pos, lineEnd));
    const size = parseInt(sizeLine.split(";")[0].trim(), 16);
    if (!Number.isFinite(size) || size < 0) break;
    if (size === 0) break; // final chunk
    const dataStart = lineEnd + 2;
    const dataEnd = dataStart + size;
    if (dataEnd > body.byteLength) {
      out.push(body.subarray(dataStart)); // truncated stream — keep what we have
      break;
    }
    out.push(body.subarray(dataStart, dataEnd));
    pos = dataEnd + 2; // skip trailing CRLF after chunk data
  }
  return concat(out);
}
