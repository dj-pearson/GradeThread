// US-344 / US-345: SSRF guard unit tests. Pure IP-range classification +
// URL validation against literal IPs (no DNS needed, so these run offline).
import { assert, assertEquals, assertRejects } from "@std/assert";
import { assertPublicUrl, isPrivateIp, SsrfError } from "../lib/ssrf.ts";

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
