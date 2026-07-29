// US-2238: the URL-fed sourcing appraisal (/api/flipdesk/scout/appraise-url).
//
// The route's I/O half (grade → comps → decision) needs Vision + eBay, so what
// is unit-tested is the guard that runs BEFORE either: URL validation. It is the
// only thing standing between an attacker-supplied string and quickGrade's
// fetcher, and it is what keeps a malformed request from reserving an AI action
// the caller then has to have refunded.
//
// Prime env then dynamic-import (the route pulls in supabase.ts via quick-grade).
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key");
Deno.env.set("ANTHROPIC_API_KEY", Deno.env.get("ANTHROPIC_API_KEY") ?? "test-key");

const { parseAppraiseUrls, APPRAISE_URL_DISCLAIMER } = await import(
  "../routes/flipdesk-scout.ts"
);

Deno.test("parseAppraiseUrls: accepts a list and caps it at 4", () => {
  const r = parseAppraiseUrls([
    "https://i.ebayimg.com/1.jpg",
    "https://i.ebayimg.com/2.jpg",
    "https://i.ebayimg.com/3.jpg",
    "https://i.ebayimg.com/4.jpg",
    "https://i.ebayimg.com/5.jpg",
  ]);
  assert(r.ok);
  assertEquals(r.urls.length, 4);
  assertEquals(r.urls[0], "https://i.ebayimg.com/1.jpg");
});

Deno.test("parseAppraiseUrls: accepts a bare string", () => {
  const r = parseAppraiseUrls("https://i.ebayimg.com/1.jpg");
  assert(r.ok);
  assertEquals(r.urls, ["https://i.ebayimg.com/1.jpg"]);
});

Deno.test("parseAppraiseUrls: rejects a non-http(s) scheme", () => {
  // The schemes that matter: file:// and data: would be read locally, and
  // javascript: is junk that should never reach a fetcher at all.
  for (const bad of [
    "file:///etc/passwd",
    "data:image/png;base64,AAAA",
    "javascript:alert(1)",
    "ftp://example.com/a.jpg",
  ]) {
    const r = parseAppraiseUrls([bad]);
    assertEquals(r.ok, false, `${bad} must be rejected before any fetch`);
  }
});

Deno.test("parseAppraiseUrls: rejects a malformed URL outright", () => {
  const r = parseAppraiseUrls(["not a url"]);
  assertEquals(r.ok, false);
});

Deno.test("parseAppraiseUrls: a private-range host still parses here", () => {
  // Deliberate: this guard is SHAPE only. The private-range blocklist lives in
  // safeFetch (inside quickGrade), which also re-validates every redirect hop —
  // a check this pure function could not do correctly on its own, since a public
  // hostname can resolve to a private address.
  const r = parseAppraiseUrls(["http://169.254.169.254/latest/meta-data/"]);
  assert(r.ok, "shape validation passes it; safeFetch is what blocks it");
});

Deno.test("parseAppraiseUrls: empty / junk input is an error, not an empty pass", () => {
  for (const input of [[], null, undefined, 42, {}, [""], ["   "], [123, null]]) {
    const r = parseAppraiseUrls(input);
    assertEquals(
      r.ok,
      false,
      `${JSON.stringify(input)} must fail — an empty url list must never reach the grader`,
    );
  }
});

Deno.test("parseAppraiseUrls: skips non-string entries but keeps the valid ones", () => {
  const r = parseAppraiseUrls([null, "https://a.test/1.jpg", 7, "https://a.test/2.jpg"]);
  assert(r.ok);
  assertEquals(r.urls, ["https://a.test/1.jpg", "https://a.test/2.jpg"]);
});

Deno.test("the disclaimer states it is private and not a certificate (US-620)", () => {
  assert(/private/i.test(APPRAISE_URL_DISCLAIMER));
  assert(/not a GradeThread certificate/i.test(APPRAISE_URL_DISCLAIMER));
  assert(
    /never shown to the seller/i.test(APPRAISE_URL_DISCLAIMER),
    "a shadow grade must never be presented as something the listing's seller sees",
  );
});
