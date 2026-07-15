// US-344 / US-345: SSRF guard unit tests. Pure IP-range classification +
// URL validation against literal IPs (no DNS needed, so these run offline).
// US-1883 (AC2/AC5): DNS-rebinding pin — the client connects to the validated
// IP, never a re-resolution of the hostname — plus the HTTP response parser.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { assertPublicUrl, isPrivateIp, parseHttpResponse, pinnedRequest, SsrfError } from "../lib/ssrf.ts";

Deno.test("isPrivateIp: blocks the cloud metadata address", () => {
  assertEquals(isPrivateIp("169.254.169.254"), true);
});

Deno.test("isPrivateIp: blocks RFC1918 ranges", () => {
  for (const ip of ["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.1", "192.168.1.1"]) {
    assert(isPrivateIp(ip), `${ip} should be private`);
  }
});

Deno.test("isPrivateIp: blocks loopback / unspecified / link-local / CGNAT / reserved", () => {
  for (const ip of ["127.0.0.1", "0.0.0.0", "169.254.1.1", "100.64.0.1", "224.0.0.1", "255.255.255.255"]) {
    assert(isPrivateIp(ip), `${ip} should be private`);
  }
});

Deno.test("isPrivateIp: allows public IPv4", () => {
  for (const ip of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.15.0.1", "172.32.0.1"]) {
    assertEquals(isPrivateIp(ip), false, `${ip} should be public`);
  }
});

Deno.test("isPrivateIp: blocks IPv6 loopback / ULA / link-local / mapped-private", () => {
  for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:169.254.169.254"]) {
    assert(isPrivateIp(ip), `${ip} should be private`);
  }
});

Deno.test("isPrivateIp: allows public IPv6 + mapped-public", () => {
  assertEquals(isPrivateIp("2606:4700:4700::1111"), false);
  assertEquals(isPrivateIp("::ffff:8.8.8.8"), false);
});

Deno.test("isPrivateIp: unparseable fails closed", () => {
  assertEquals(isPrivateIp("not-an-ip"), true);
});

Deno.test("assertPublicUrl: rejects the metadata endpoint (literal IP, no DNS)", async () => {
  await assertRejects(
    () => assertPublicUrl("https://169.254.169.254/latest/meta-data/", { requireHttps: false }),
    SsrfError,
  );
});

Deno.test("assertPublicUrl: rejects an RFC1918 host", async () => {
  await assertRejects(
    () => assertPublicUrl("https://10.0.0.5/internal", { requireHttps: false }),
    SsrfError,
  );
});

Deno.test("assertPublicUrl: rejects http when https is required", async () => {
  await assertRejects(
    () => assertPublicUrl("http://1.1.1.1/x", { requireHttps: true }),
    SsrfError,
  );
});

Deno.test("assertPublicUrl: rejects non-http(s) schemes", async () => {
  await assertRejects(
    () => assertPublicUrl("file:///etc/passwd", { requireHttps: false }),
    SsrfError,
  );
  await assertRejects(
    () => assertPublicUrl("gopher://1.1.1.1/", { requireHttps: false }),
    SsrfError,
  );
});

Deno.test("assertPublicUrl: rejects bracketed IPv6 loopback", async () => {
  await assertRejects(
    () => assertPublicUrl("https://[::1]:8080/", { requireHttps: false }),
    SsrfError,
  );
});

Deno.test("assertPublicUrl: allows a public literal IP", async () => {
  const { url, ips } = await assertPublicUrl("https://1.1.1.1/image.jpg", { requireHttps: true });
  assertEquals(url.hostname, "1.1.1.1");
  assertEquals(ips, ["1.1.1.1"]);
});

// ── HTTP response parser (US-1883 AC5) ─────────────────────────────
// Offline, byte-level coverage of the risky parsing path in the IP-pinned
// client. Bodies are pre-split at the header terminator like readResponseCapped.

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

Deno.test("parseHttpResponse: content-length slices the body exactly", () => {
  const head = enc("HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: 5");
  const body = enc("hello-trailing-garbage");
  const res = parseHttpResponse(head, body);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "image/jpeg");
  assertEquals(dec(res.bytes), "hello");
});

Deno.test("parseHttpResponse: header lookup is case-insensitive", () => {
  const head = enc("HTTP/1.1 204 No Content\r\ncOnTeNt-TyPe: text/plain");
  const res = parseHttpResponse(head, new Uint8Array(0));
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("Content-Type"), "text/plain");
});

Deno.test("parseHttpResponse: decodes chunked transfer-encoding", () => {
  const head = enc("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked");
  // "Wiki" + "pedia" then terminating 0-chunk, with trailing garbage after.
  const body = enc("4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\nIGNORED");
  const res = parseHttpResponse(head, body);
  assertEquals(dec(res.bytes), "Wikipedia");
});

Deno.test("parseHttpResponse: no content-length reads the whole body (EOF)", () => {
  const head = enc("HTTP/1.1 200 OK\r\nContent-Type: image/png");
  const body = enc("raw-bytes-to-eof");
  const res = parseHttpResponse(head, body);
  assertEquals(dec(res.bytes), "raw-bytes-to-eof");
});

Deno.test("parseHttpResponse: surfaces a redirect status + Location", () => {
  const head = enc("HTTP/1.1 302 Found\r\nLocation: https://cdn.example/img.jpg");
  const res = parseHttpResponse(head, new Uint8Array(0));
  assertEquals(res.status, 302);
  assertEquals(res.headers.get("location"), "https://cdn.example/img.jpg");
});

Deno.test("parseHttpResponse: throws on a malformed status line", () => {
  assertThrows(
    () => parseHttpResponse(enc("garbage not http"), new Uint8Array(0)),
    SsrfError,
  );
});

// ── DNS-rebinding pin proof (US-1883 AC2) ──────────────────────────
// The client must connect to the IP it was handed, NOT re-resolve the hostname.
// We start a loopback HTTP server and dial it with a URL whose hostname is a
// bogus public-looking name — the connection only succeeds because pinnedRequest
// uses the provided IP (127.0.0.1). A re-resolving fetch could never reach this.

async function withRawHttpServer(
  handle: (line0: string, headers: string) => string,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const serving = (async () => {
    const conn = await listener.accept(); // one request per test
    try {
      const buf = new Uint8Array(8192);
      const n = await conn.read(buf);
      const req = new TextDecoder().decode(buf.subarray(0, n ?? 0));
      const [line0, ...rest] = req.split("\r\n");
      const resp = handle(line0, rest.join("\r\n"));
      await conn.write(new TextEncoder().encode(resp));
    } finally {
      try {
        conn.close();
      } catch { /* client may have closed first */ }
    }
  })();
  try {
    await fn(port);
  } finally {
    await serving.catch(() => {});
    try {
      listener.close();
    } catch { /* already closed */ }
  }
}

Deno.test("pinnedRequest: connects to the supplied IP, not the URL hostname", async () => {
  let sawHost = "";
  await withRawHttpServer(
    (_line0, headers) => {
      sawHost = (headers.match(/host:\s*(.+)/i)?.[1] ?? "").trim();
      const body = "PINNED-OK";
      return `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`;
    },
    async (port) => {
      // Hostname resolves to NOTHING routable here; the pin uses 127.0.0.1.
      const url = new URL(`http://attacker.invalid:${port}/x`);
      const res = await pinnedRequest(url, ["127.0.0.1"], { maxBytes: 1024, timeoutMs: 5000 });
      assertEquals(res.status, 200);
      assertEquals(dec(res.bytes), "PINNED-OK");
      // Host header carried the original hostname (so a vhost/cert still matches).
      assertEquals(sawHost, `attacker.invalid:${port}`);
    },
  );
});

Deno.test("pinnedRequest: caps the body at maxBytes", async () => {
  await withRawHttpServer(
    () => {
      const body = "x".repeat(4096);
      return `HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`;
    },
    async (port) => {
      const url = new URL(`http://attacker.invalid:${port}/big`);
      await assertRejects(
        () => pinnedRequest(url, ["127.0.0.1"], { maxBytes: 512, timeoutMs: 5000 }),
        SsrfError,
      );
    },
  );
});
