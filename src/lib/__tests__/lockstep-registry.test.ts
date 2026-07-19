// US-2019 AC1 — every declared cross-project mirror must be CLASSIFIED.
//
// The audit that opened this story found 50+ places whose comments assert a
// lockstep relationship ("client mirror of…", "keep the two in lockstep") and
// exactly ONE with an automated guard. Five high-risk mirrors have since been
// pinned with shared fixtures — and two of those five had ALREADY DRIFTED in
// production when the fixture was added:
//
//   • the weighted-grade rounding (0.5 on one admin page vs 0.1 everywhere
//     else) — a number an operator saw differed from what was stored
//   • the credit-pack price ($25 on landing vs $24.99 on /pricing)
//
// So "the comment says keep in lockstep" has a demonstrated ~40% failure rate
// in this codebase on the cases anyone bothered to check.
//
// Fixing the remaining ~45 one at a time would be ~45 commits and would still
// leave the NEXT mirror unguarded. This test does the durable thing instead:
// it DISCOVERS the markers and forces each to be classified as either PINNED
// (a named fixture/test asserts both copies) or EXEMPT (with a stated reason).
// A new mirror fails the build until a human decides which it is — the same
// shape as SERVICE_ROLE_ONLY in rls-guard_test.ts.
//
// See vault/70-agent/guards-that-cannot-fail.md.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "services/edge-functions/src"];

/** Comment phrasings that ASSERT a cross-copy relationship. */
const MARKER =
  /keep (?:the two |them )?in lockstep|must stay in lockstep|client mirror of|web mirror MUST stay in lockstep/i;

/**
 * PINNED — a shared fixture or paired test asserts BOTH copies.
 * The value names the mechanism so a reader can find it without grepping.
 */
const PINNED: Record<string, string> = {
  "src/lib/best-offer-thresholds.ts":
    "src/test/fixtures/best-offer-threshold-cases.json — asserted by both suites",
  "src/lib/constants.ts":
    "grading-readiness + weighted-grade fixtures, and legal-versions-lockstep.test.ts",
  "src/lib/photo-standards.ts":
    "src/lib/photo-standards.test.ts asserts the edge preflight's thresholds",
  "src/lib/__tests__/weighted-grade.test.ts":
    "the guard itself (paired with weighted-grade-parity_test.ts)",
  "src/lib/photo-standards.test.ts": "the guard itself",
  "src/lib/password-policy.test.ts":
    "the guard itself — mirrors the GoTrue policy",
  "src/lib/__tests__/signed-url-ttl.test.ts":
    "the guard itself — enforces the <=900s private-bucket signed-URL rule that " +
    "CLAUDE.md states and four edge modules each restate. It matches the marker " +
    "only because its rationale QUOTES the lockstep-comment failure mode.",
  "src/lib/__tests__/signup-source.test.ts":
    "the guard itself — pins the 00379 trigger whitelist",
  "services/edge-functions/src/tests/weighted-grade-parity_test.ts":
    "the guard itself (edge half)",
  "src/lib/ebay-prefill.ts":
    "src/lib/ebay-aspect-registry.json is GENERATED from the edge registry via " +
    "`npm run sync:aspects`, with a CI drift guard — the strongest form here, " +
    "since the data cannot be hand-edited out of sync at all. Logic covered by " +
    "src/lib/__tests__/ebay-prefill.test.ts.",
};

/**
 * EXEMPT — a marker that is NOT a cross-project value contract. Each entry
 * states WHY, because "it's fine" is how an unguarded mirror gets waved through.
 */
const EXEMPT: Record<string, string> = {
  "src/hooks/use-buyer-entitlements.ts":
    "Mirrors ACTIVE_STATUSES (subscription states). A drift degrades to a wrong " +
    "entitlement READ, which the server re-checks on every gated action — the " +
    "client is not authoritative. Worth pinning eventually; not money-or-grade critical.",
  "src/lib/autolister-verify-windows.ts":
    "Mirrors a sample-photo BUDGET (how many photos an AI verify pass looks at). " +
    "A drift changes cost/latency, not correctness — the server enforces its own cap.",
  "src/lib/photo-profiles.ts":
    "Mirrors server-authoritative photo PROFILES used for client-side hints. The " +
    "server re-derives them; a stale client profile shows a suboptimal hint, not a wrong result.",
  "src/lib/verified.ts":
    "Mirrors a handle-format rule also enforced by a DB CHECK (migration 00057). " +
    "The database is the real guard — a client drift produces a rejected write, not bad data.",
  "src/pages/signup.tsx":
    "Client-side password policy mirror. The comment itself says the server is " +
    "authoritative; a drift shows the user a wrong hint and the signup still fails correctly. " +
    "The policy itself IS pinned by password-policy.test.ts.",
  "src/pages/flipdesk/autolister.tsx":
    "A CSS gap value kept in lockstep with row-height math in the same file — " +
    "intra-file layout, not a cross-project contract.",
  "services/edge-functions/src/lib/publish-preflight.ts":
    "Mirrors mapGradeToApparelCondition WITHIN the edge project, so a normal " +
    "import/unit test can cover it — no cross-project fixture needed.",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("US-2019: declared lockstep mirrors are classified", () => {
  it("every file asserting a mirror is either PINNED or EXEMPT", () => {
    const files: string[] = [];
    for (const d of SCAN_DIRS) files.push(...walk(resolve(ROOT, d)));

    const declared: string[] = [];
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(f, "utf8");
      } catch {
        continue; // unreadable/binary — nothing to classify
      }
      const rel = relative(ROOT, f).split("\\").join("/");
      // This file documents the marker phrases in order to search for them, so
      // it always matches itself. Excluding it is not a loophole — the registry
      // cannot meaningfully pin or exempt its own prose.
      if (rel === "src/lib/__tests__/lockstep-registry.test.ts") continue;
      if (MARKER.test(text)) declared.push(rel);
    }

    // Sanity: if this collapses to nothing the scan broke and the guard would
    // pass forever without checking anything.
    expect(
      declared.length,
      "no lockstep markers found at all — the scan or the regex broke",
    ).toBeGreaterThan(5);

    const unclassified = declared.filter(
      (f) => !(f in PINNED) && !(f in EXEMPT),
    );

    expect(
      unclassified,
      "These files declare a cross-copy lockstep relationship but are neither " +
        "PINNED (a shared fixture asserts both copies) nor EXEMPT (with a stated " +
        "reason):\n  " +
        unclassified.join("\n  ") +
        "\n\nA comment saying 'keep in lockstep' is not a mechanism — two of the " +
        "five mirrors checked so far had already drifted in production. Add a " +
        "shared fixture, or classify it as EXEMPT and say why.",
    ).toEqual([]);
  });

  it("the registry has no stale entries", () => {
    // A registry naming files that no longer declare a mirror rots into noise,
    // and a reader can no longer tell which entries are load-bearing.
    const stale: string[] = [];
    for (const f of [...Object.keys(PINNED), ...Object.keys(EXEMPT)]) {
      let text = "";
      try {
        text = readFileSync(resolve(ROOT, f), "utf8");
      } catch {
        stale.push(`${f} (file no longer exists)`);
        continue;
      }
      if (!MARKER.test(text)) stale.push(`${f} (no longer declares a mirror)`);
    }
    expect(
      stale,
      "Registry entries that no longer apply — remove them:\n  " + stale.join("\n  "),
    ).toEqual([]);
  });

  it("every EXEMPT entry states a reason", () => {
    for (const [file, reason] of Object.entries(EXEMPT)) {
      expect(reason.length, `${file} needs a real justification`).toBeGreaterThan(60);
    }
  });
});
