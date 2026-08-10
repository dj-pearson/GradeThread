// US-2117 AC1: which disclosure a subscriber was shown, on the agreement row.
//
// The rule this file defends: an UNKNOWN version is refused, not stored. A
// version id we cannot resolve is a pointer to nothing sitting on an immutable
// compliance record — it reads as provenance and carries none, which is worse
// than the empty column it replaced, because an empty column at least says "we
// did not capture this". Same rule extractAgreedTerms already applies to a
// guessed amount.
//
//   deno test --allow-env src/tests/disclosure-versions_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  KNOWN_DISCLOSURE_VERSIONS,
  normalizeDisclosureVersion,
  sanitizeReportedDisclosureVersion,
} from "../lib/disclosure-versions.ts";

const KNOWN = [...KNOWN_DISCLOSURE_VERSIONS][0];

Deno.test("there is at least one resolvable version", () => {
  // An empty set would make every branch below pass while the feature recorded
  // nothing at all, forever.
  assert(KNOWN_DISCLOSURE_VERSIONS.size > 0);
  assert(typeof KNOWN === "string" && KNOWN.length > 0);
});

Deno.test("a known version is accepted", () => {
  assertEquals(normalizeDisclosureVersion(KNOWN), { version: KNOWN, rejected: null });
  assertEquals(normalizeDisclosureVersion(`  ${KNOWN}  `), {
    version: KNOWN,
    rejected: null,
  });
});

Deno.test("an UNKNOWN version is refused and reported, never stored", () => {
  const out = normalizeDisclosureVersion("1999-01-01");
  assertEquals(out.version, null, "an unresolvable pointer must not reach the record");
  assertEquals(out.rejected, "1999-01-01", "but it must be visible, not silently dropped");
});

// Absence is the normal case for a legacy subscription and for every renewal
// event after the first. It is NOT an anomaly and must not page anyone.
Deno.test("an absent version is neither accepted nor reported", () => {
  for (const raw of [undefined, null, "", "   ", 42, {}, []]) {
    const out = normalizeDisclosureVersion(raw);
    assertEquals(out.version, null, String(raw));
    assertEquals(out.rejected, null, `absence must not be reported: ${String(raw)}`);
  }
});

Deno.test("a reported unknown version is capped before it reaches a log line", () => {
  const out = normalizeDisclosureVersion("x".repeat(500));
  assertEquals(out.version, null);
  assertEquals(out.rejected?.length, 64);
});

// ── the pass-through bound applied before Stripe stores it ──────────

Deno.test("sanitize bounds length and charset but does NOT validate", () => {
  // Deliberately permissive: validation happens once, at the write site. If this
  // rejected unknown ids too, the write site's refusal branch could not be
  // reached through the normal path — and a guard nothing can reach is a guard
  // nothing proves.
  assertEquals(sanitizeReportedDisclosureVersion("2099-12-31"), "2099-12-31");
  assertEquals(sanitizeReportedDisclosureVersion(KNOWN), KNOWN);
});

Deno.test("sanitize drops anything that is not a plain version token", () => {
  // NOTE "v1\n" is absent on purpose: it trims to a valid "v1". Surrounding
  // whitespace is trimmed, not treated as corruption — only INTERNAL whitespace
  // and out-of-charset bytes are rejected.
  for (const raw of ["a b", "v1\nv2", "<script>", "a;b", "é", "a\"b", undefined, null, 7, ""]) {
    assertEquals(
      sanitizeReportedDisclosureVersion(raw),
      null,
      `${JSON.stringify(raw)} must not reach Stripe metadata`,
    );
  }
  assertEquals(sanitizeReportedDisclosureVersion("x".repeat(200)), "x".repeat(64));
});

// ── the mirror stays a mirror ───────────────────────────────────────

Deno.test("the edge holds version ids ONLY, never the wording", () => {
  // The web archive is the single home for the sentences (US-2115). Duplicating
  // them here would recreate the US-1995 failure: two copies, two green suites,
  // silently disagreeing. The web-side test asserts the reverse direction.
  const src = Deno.readTextFileSync(
    new URL("../lib/disclosure-versions.ts", import.meta.url),
  );
  const body = src.slice(src.indexOf("export const KNOWN_DISCLOSURE_VERSIONS"));
  assert(
    !/until you cancel|Cancel any time|Billing starts/i.test(body),
    "disclosure wording has leaked into the edge mirror",
  );
});
