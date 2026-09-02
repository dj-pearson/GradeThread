// US-1687: the free grade-checker's upload hardening + per-IP rate limit. The
// quickGrade AI call isn't unit-tested (needs Vision); the pure guard logic is.
// Prime env then dynamic-import (the route pulls in supabase.ts via quick-grade).
import { assert, assertEquals } from "@std/assert";
import { describeValueBasis } from "../lib/value-disclosure.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key");
Deno.env.set("ANTHROPIC_API_KEY", Deno.env.get("ANTHROPIC_API_KEY") ?? "test-key");

const {
  prepareGradeCheckImage,
  gradeCheckRateLimited,
  publicValueFromRange,
  extGradeRateLimited,
  extGradeRemaining,
  parseGradeFromUrlBody,
  parseAuthenticityCheckBody,
  publicAuthenticityCheckEnabled,
  assignGalleryImageTypes,
  shouldRequestCoveragePhotos,
  clientIpFor,
  NO_TRUSTWORTHY_IP,
  atCapacityBody,
  AT_CAPACITY_CODE,
} = await import("../routes/public-grading.ts");

// Minimal Hono-Context stand-in exposing only what clientIpFor reads.
function ipCtx(headers: Record<string, string>): Parameters<typeof clientIpFor>[0] {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    req: { header: (name: string) => lower[name.toLowerCase()] },
  } as unknown as Parameters<typeof clientIpFor>[0];
}

// A canonical 1x1 PNG (valid magic bytes + IHDR + IDAT + IEND).
const ONE_PX_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

Deno.test("prepareGradeCheckImage: accepts a valid PNG data URL and strips metadata", () => {
  const r = prepareGradeCheckImage(ONE_PX_PNG);
  assert(r.ok, r.ok ? "" : r.error);
  if (r.ok) assert(r.cleanDataUri.startsWith("data:image/png;base64,"));
});

Deno.test("prepareGradeCheckImage: rejects a non-data-URL", () => {
  const r = prepareGradeCheckImage("https://example.com/x.jpg");
  assert(!r.ok);
  if (!r.ok) assertEquals(r.status, 400);
});

Deno.test("prepareGradeCheckImage: rejects non-string input", () => {
  assert(!prepareGradeCheckImage(undefined).ok);
  assert(!prepareGradeCheckImage(null).ok);
  assert(!prepareGradeCheckImage(123).ok);
});

// ─── US-1883 AC1: hardened client-IP for the public grading quota ─────────
// The per-IP free-grade quota is keyed by clientIpFor(). It MUST resolve the IP
// via the hardened clientIp() (US-354): CF-Connecting-IP only, and only when the
// request proved it transited Cloudflare. Trusting the client-controlled
// X-Forwarded-For in production let an attacker rotate the header to mint an
// unlimited number of distinct per-IP buckets (an unmetered-grading bypass).

Deno.test("US-1883: in production, rotating X-Forwarded-For all collapses to ONE shared bucket (no per-header bypass)", () => {
  const prev = Deno.env.get("EDGE_ENV");
  Deno.env.set("EDGE_ENV", "production");
  try {
    // No CF-Connecting-IP (direct-to-origin), attacker rotates XFF each request.
    const a = clientIpFor(ipCtx({ "x-forwarded-for": "1.2.3.4" }));
    const b = clientIpFor(ipCtx({ "x-forwarded-for": "5.6.7.8" }));
    const c = clientIpFor(ipCtx({ "x-forwarded-for": "9.9.9.9, 1.1.1.1" }));
    // All three share the sentinel bucket → the quota can't be evaded by
    // spoofing XFF, because XFF is never trusted in production.
    assertEquals(a, NO_TRUSTWORTHY_IP);
    assertEquals(b, NO_TRUSTWORTHY_IP);
    assertEquals(c, NO_TRUSTWORTHY_IP);
  } finally {
    if (prev === undefined) Deno.env.delete("EDGE_ENV");
    else Deno.env.set("EDGE_ENV", prev);
  }
});

Deno.test("US-1883: in production, CF-Connecting-IP IS trusted (CF overwrites it, so it can't be spoofed)", () => {
  const prev = Deno.env.get("EDGE_ENV");
  const prevSecret = Deno.env.get("CF_ORIGIN_SECRET");
  Deno.env.set("EDGE_ENV", "production");
  // No origin-secret configured → the network layer is trusted (secret check inert).
  Deno.env.delete("CF_ORIGIN_SECRET");
  try {
    assertEquals(
      clientIpFor(ipCtx({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4" })),
      "203.0.113.7",
    );
  } finally {
    if (prev === undefined) Deno.env.delete("EDGE_ENV");
    else Deno.env.set("EDGE_ENV", prev);
    if (prevSecret !== undefined) Deno.env.set("CF_ORIGIN_SECRET", prevSecret);
  }
});

Deno.test("US-1883: when CF_ORIGIN_SECRET is set, a spoofed CF-Connecting-IP without the secret gets the sentinel bucket", () => {
  const prev = Deno.env.get("EDGE_ENV");
  const prevSecret = Deno.env.get("CF_ORIGIN_SECRET");
  Deno.env.set("EDGE_ENV", "production");
  Deno.env.set("CF_ORIGIN_SECRET", "s3cret-token");
  try {
    // Direct-to-origin forgery: CF-Connecting-IP present but no matching secret
    // header → not trusted → sentinel (never a spoofed per-IP bucket).
    assertEquals(
      clientIpFor(ipCtx({ "cf-connecting-ip": "203.0.113.7" })),
      NO_TRUSTWORTHY_IP,
    );
    // With the matching secret it transited CF → the IP is trusted.
    assertEquals(
      clientIpFor(ipCtx({ "cf-connecting-ip": "203.0.113.7", "cf-origin-secret": "s3cret-token" })),
      "203.0.113.7",
    );
  } finally {
    if (prev === undefined) Deno.env.delete("EDGE_ENV");
    else Deno.env.set("EDGE_ENV", prev);
    if (prevSecret === undefined) Deno.env.delete("CF_ORIGIN_SECRET");
    else Deno.env.set("CF_ORIGIN_SECRET", prevSecret);
  }
});

// ─── US-1883 AC3: capacity 503 body is machine-readable + non-retryable ──────
// The extension keys off code/retryable to render a NON-retryable "at capacity"
// state distinct from a bad-URL 400 (which invited quota-burning retries).
Deno.test("US-1883 AC3: atCapacityBody() is machine-readable and marked non-retryable", () => {
  const body = atCapacityBody();
  assertEquals(body.code, AT_CAPACITY_CODE);
  assertEquals(AT_CAPACITY_CODE, "at_capacity");
  assertEquals(body.retryable, false);
  assert(typeof body.error === "string" && body.error.length > 0);
  // Distinct from the bad-URL 400 copy so the two never get conflated.
  assert(!/points to a public photo/i.test(body.error));
});

Deno.test("prepareGradeCheckImage: rejects a data URL that isn't a real image (magic-byte sniff)", () => {
  // Looks like an image data URL but the bytes are plain text.
  const fake = `data:image/jpeg;base64,${btoa("this is not an image")}`;
  const r = prepareGradeCheckImage(fake);
  assert(!r.ok);
});

Deno.test("prepareGradeCheckImage: rejects an SVG (validateImageUpload disallows it)", () => {
  const svg = `data:image/svg+xml;base64,${btoa("<svg xmlns='http://www.w3.org/2000/svg'></svg>")}`;
  const r = prepareGradeCheckImage(svg);
  assert(!r.ok);
});

// US-1751: the public value is gated to sufficient-sample ranges only — an
// insufficient (or null) range must surface as value:null, never a false number.
Deno.test("publicValueFromRange: returns a compact aggregate when the range is sufficient", () => {
  const v = publicValueFromRange({
    lowCents: 1500,
    medianCents: 2000,
    highCents: 2600,
    sampleSize: 12,
    confidence: 0.9,
    sufficient: true,
    currency: "USD",
  });
  assertEquals(v, {
    lowCents: 1500,
    medianCents: 2000,
    highCents: 2600,
    sampleSize: 12,
    confidence: 0.9,
    currency: "USD",
    // US-2850: absent in, absent out. A range assembled without a basis must
    // not acquire one on the way to an unauthenticated page.
    basis: undefined,
  });
});

// US-2850: this endpoint is where a stranger meets our numbers for the first
// time, so the provenance line has to survive the mapping into the public
// shape. It is dropped by anything that rebuilds the object field by field,
// which is exactly what this function does.
Deno.test("publicValueFromRange: carries the disclosure through to the public shape", () => {
  const basis = describeValueBasis({
    source: "comp_median",
    sufficient: true,
    sampleSize: 12,
    medianCents: 2000,
  });
  const v = publicValueFromRange({
    lowCents: 1500,
    medianCents: 2000,
    highCents: 2600,
    sampleSize: 12,
    confidence: 0.9,
    sufficient: true,
    currency: "USD",
    basis,
  });
  assertEquals(v?.basis?.source, "comp_median");
  assert(v?.basis?.headline.includes("Unadjusted market median"), v?.basis?.headline);
  assert(
    v?.basis?.detail.includes("asking right now"),
    "the public surface lost the asking-price disclaimer",
  );
});

Deno.test("publicValueFromRange: returns null for an insufficient range", () => {
  assertEquals(
    publicValueFromRange({
      lowCents: null,
      medianCents: null,
      highCents: null,
      sampleSize: 2,
      confidence: 0.2,
      sufficient: false,
      currency: "USD",
    }),
    null,
  );
});

Deno.test("publicValueFromRange: returns null for a null/undefined range", () => {
  assertEquals(publicValueFromRange(null), null);
  assertEquals(publicValueFromRange(undefined), null);
});

Deno.test("gradeCheckRateLimited: allows the first 5 calls per IP per hour, blocks the 6th", () => {
  const ip = "203.0.113.7";
  const t = 1_000_000;
  for (let i = 0; i < 5; i++) {
    assertEquals(gradeCheckRateLimited(ip, t + i), false, `call ${i + 1} should pass`);
  }
  assert(gradeCheckRateLimited(ip, t + 5), "6th call should be limited");
  // A different IP is unaffected.
  assertEquals(gradeCheckRateLimited("198.51.100.9", t + 6), false);
  // After the window elapses, the original IP is allowed again.
  assertEquals(gradeCheckRateLimited(ip, t + 60 * 60 * 1000 + 10), false);
});

// US-1754: the extension grade-from-url endpoint's dual-dimension limiter.
Deno.test("extGradeRateLimited: caps per IP (20/hr) then reports the ip scope", () => {
  const ip = "203.0.113.20";
  const t = 5_000_000;
  for (let i = 0; i < 20; i++) {
    assertEquals(extGradeRateLimited(ip, null, t + i).limited, false, `call ${i + 1}`);
  }
  const over = extGradeRateLimited(ip, null, t + 20);
  assert(over.limited);
  assertEquals(over.scope, "ip");
});

Deno.test("extGradeRateLimited: caps per extension instance (40/hr) independent of IP", () => {
  const inst = "instance-abc";
  const t = 6_000_000;
  // Spread across many IPs so the per-IP cap never trips — only the instance cap.
  for (let i = 0; i < 40; i++) {
    const r = extGradeRateLimited(`198.51.100.${i % 200}`, inst, t + i);
    assertEquals(r.limited, false, `call ${i + 1}`);
  }
  const over = extGradeRateLimited("198.51.100.201", inst, t + 40);
  assert(over.limited);
  assertEquals(over.scope, "instance");
});

Deno.test("parseGradeFromUrlBody: accepts imageUrl, imageUrls, caps at 4, rejects junk", () => {
  const single = parseGradeFromUrlBody({ imageUrl: "https://example.com/a.jpg" });
  assert(single.ok);
  if (single.ok) assertEquals(single.urls, ["https://example.com/a.jpg"]);

  const many = parseGradeFromUrlBody({
    imageUrls: ["https://x/1", "https://x/2", "https://x/3", "https://x/4", "https://x/5"],
  });
  assert(many.ok);
  if (many.ok) assertEquals(many.urls.length, 4); // capped

  assert(!parseGradeFromUrlBody({}).ok);
  assert(!parseGradeFromUrlBody({ imageUrl: "not a url" }).ok);
  assert(!parseGradeFromUrlBody({ imageUrl: "ftp://example.com/a.jpg" }).ok);
  assert(!parseGradeFromUrlBody(null).ok);
});

// ── grade-from-url gallery view typing + coverage-gap gating ─────────────────
Deno.test("assignGalleryImageTypes: first two are front/back, rest detail, never over-emits", () => {
  assertEquals(assignGalleryImageTypes(0), []);
  assertEquals(assignGalleryImageTypes(1), ["front"]);
  assertEquals(assignGalleryImageTypes(2), ["front", "back"]);
  assertEquals(assignGalleryImageTypes(3), ["front", "back", "detail"]);
  assertEquals(assignGalleryImageTypes(4), ["front", "back", "detail", "detail_2"]);
});

Deno.test("shouldRequestCoveragePhotos: only when low-confidence OR too few photos", () => {
  // Confident read of a well-photographed listing → suppress the ask-for-photos list.
  assertEquals(shouldRequestCoveragePhotos(0.85, 4), false);
  assertEquals(shouldRequestCoveragePhotos(0.75, 3), false);
  // Low confidence → surface it even with plenty of photos.
  assert(shouldRequestCoveragePhotos(0.6, 4));
  // Too few photos → surface it even when confident.
  assert(shouldRequestCoveragePhotos(0.9, 2));
});

// ── US-1771: public authenticity-check body parsing + fail-closed gate ───────
Deno.test("parseAuthenticityCheckBody: validates + cleans an images array", () => {
  const r = parseAuthenticityCheckBody({ images: [ONE_PX_PNG, ONE_PX_PNG], brand: "  Gucci  ", title: "bag" });
  assert(r.ok);
  assertEquals(r.dataUris.length, 2);
  assertEquals(r.brand, "Gucci");
  assertEquals(r.title, "bag");
});

Deno.test("parseAuthenticityCheckBody: accepts a single `image`", () => {
  const r = parseAuthenticityCheckBody({ image: ONE_PX_PNG });
  assert(r.ok);
  assertEquals(r.dataUris.length, 1);
});

Deno.test("parseAuthenticityCheckBody: no photo → error", () => {
  const r = parseAuthenticityCheckBody({});
  assert(!r.ok);
});

Deno.test("parseAuthenticityCheckBody: a bad image is rejected", () => {
  const r = parseAuthenticityCheckBody({ images: ["not-a-data-url"] });
  assert(!r.ok);
});

Deno.test("parseAuthenticityCheckBody: caps at 4 images", () => {
  const many = [ONE_PX_PNG, ONE_PX_PNG, ONE_PX_PNG, ONE_PX_PNG, ONE_PX_PNG, ONE_PX_PNG];
  const r = parseAuthenticityCheckBody({ images: many });
  assert(r.ok);
  assertEquals(r.dataUris.length, 4);
});

Deno.test("publicAuthenticityCheckEnabled: fail-closed (default off), on only when explicitly 'true'", () => {
  Deno.env.delete("PUBLIC_AUTHENTICITY_CHECK_ENABLED");
  assertEquals(publicAuthenticityCheckEnabled(), false);
  Deno.env.set("PUBLIC_AUTHENTICITY_CHECK_ENABLED", "1");
  assertEquals(publicAuthenticityCheckEnabled(), false, "only the literal 'true' enables it");
  Deno.env.set("PUBLIC_AUTHENTICITY_CHECK_ENABLED", "true");
  assertEquals(publicAuthenticityCheckEnabled(), true);
  Deno.env.delete("PUBLIC_AUTHENTICITY_CHECK_ENABLED");
});

// ── US-2237: the scan window is SEPARATE from the grading window ───────────
//
// Sharing extGradeRateLimited would let a few scrolls of a search page exhaust
// the 20/hr grade budget — the cheap action starving the expensive one. Pinned
// here, next to the window it must not share.
const { scanRateLimited } = await import("../routes/public-grading.ts");

Deno.test("scanRateLimited: 60/hr per IP, independent of the grade window", () => {
  const ip = "203.0.113.77";
  const t = Date.now();
  for (let i = 0; i < 60; i++) {
    assertEquals(scanRateLimited(ip, null, t + i).limited, false, `call ${i + 1}`);
  }
  const over = scanRateLimited(ip, null, t + 60);
  assertEquals(over.limited, true);
  assertEquals(over.scope, "ip");
  // The SAME ip must still be able to grade: 60 scans burned no grade budget.
  assertEquals(extGradeRateLimited(ip, null, t + 61).limited, false);
});

Deno.test("scanRateLimited: caps per extension instance independent of IP", () => {
  const inst = "scan-instance-1";
  const t = Date.now();
  for (let i = 0; i < 120; i++) {
    assertEquals(scanRateLimited(`198.51.100.${i % 200}`, inst, t + i).limited, false, `call ${i + 1}`);
  }
  const over = scanRateLimited("198.51.100.250", inst, t + 120);
  assertEquals(over.limited, true);
  assertEquals(over.scope, "instance");
});

// The photo-cap cases moved to extension-image-urls_test.ts, which imports the
// pure parser directly and therefore RUNS without hono/supabase resolving.

// US-3051: the quota the popup shows is read off the SAME windows the 429
// comes from, and reading it never records a hit.
Deno.test("extGradeRemaining: reports the tighter window, counts down with real hits, never records one", () => {
  const ip = "203.0.113.51";
  const inst = "install-quota-test";
  const t = 1_800_000_000_000;
  const fresh = extGradeRemaining(ip, inst, t);
  assertEquals(fresh.limit, 20, "a lone shopper's ceiling is the IP window: 20 of 40 would name a limit they cannot reach");
  assertEquals(fresh.remaining, 20);
  assertEquals(fresh.resetsAt, null, "nothing counted, nothing to reset");
  // Ten reads of the quota do not spend anything.
  for (let i = 0; i < 10; i++) extGradeRemaining(ip, inst, t + i);
  assertEquals(extGradeRemaining(ip, inst, t + 11).remaining, 20);
  // Three real reads spend three.
  for (let i = 0; i < 3; i++) assertEquals(extGradeRateLimited(ip, inst, t + 100 + i).limited, false);
  const after = extGradeRemaining(ip, inst, t + 200);
  assertEquals(after.remaining, 17);
  assertEquals(after.resetsAt, new Date(t + 100 + 60 * 60 * 1000).toISOString(), "resets when the oldest hit leaves the window");
  // Past the window they are forgotten.
  assertEquals(extGradeRemaining(ip, inst, t + 102 + 60 * 60 * 1000 + 1).remaining, 20);
  // The instance window shows only once it is the one closer to refusing:
  // 20 hits from a second IP on the same install leave the IP window fresh
  // and the instance window at 17.
  const ip2 = "203.0.113.53";
  for (let i = 0; i < 20; i++) extGradeRateLimited(ip2, inst, t + 5000 + i);
  const inst2 = extGradeRemaining("203.0.113.54", inst, t + 6000);
  assertEquals(inst2.limit, 40);
  assertEquals(inst2.remaining, 17, "40 minus the 3 earlier and 20 later hits on this install");
});

Deno.test("extGradeRemaining: without an install id it is the IP window, and the tighter window wins", () => {
  const ip = "203.0.113.52";
  const t = 1_800_000_000_000;
  const anon = extGradeRemaining(ip, null, t);
  assertEquals(anon.limit, 20);
  assertEquals(anon.remaining, 20);
  // 20 hits from this IP exhaust the IP window; an install id on the same IP
  // still reads 0 remaining even though its own window is untouched.
  for (let i = 0; i < 20; i++) extGradeRateLimited(ip, null, t + i);
  assertEquals(extGradeRemaining(ip, null, t + 30).remaining, 0);
  const shared = extGradeRemaining(ip, "install-on-busy-ip", t + 30);
  assertEquals(shared.remaining, 0, "the IP window refuses first, so it is the number to show");
  assertEquals(shared.limit, 20);
});
