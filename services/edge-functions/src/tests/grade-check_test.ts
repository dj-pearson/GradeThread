// US-1687: the free grade-checker's upload hardening + per-IP rate limit. The
// quickGrade AI call isn't unit-tested (needs Vision); the pure guard logic is.
// Prime env then dynamic-import (the route pulls in supabase.ts via quick-grade).
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key");
Deno.env.set("ANTHROPIC_API_KEY", Deno.env.get("ANTHROPIC_API_KEY") ?? "test-key");

const { prepareGradeCheckImage, gradeCheckRateLimited, publicValueFromRange } = await import(
  "../routes/public-grading.ts"
);

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
  });
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
