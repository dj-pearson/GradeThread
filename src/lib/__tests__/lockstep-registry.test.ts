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
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { sourceTexts, SCAN_TIMEOUT_MS } from "./_source-scan";

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "services/edge-functions/src"];

/** Comment phrasings that ASSERT a cross-copy relationship. */
// US-2306: the object between "keep" and "in lockstep" is now anything short,
// not just "the two" or "them".
//
// The old alternation missed "keep THIS in lockstep", which is how
// ai-grading.ts's FACTOR_WEIGHTS — a copy of the grading weight table — stayed
// invisible to this guard while carrying a comment that says to keep it in
// lockstep. It was not one unlucky phrasing: measured across all 2,374 .ts/.tsx
// files under src, services/edge-functions/src and functions, the old regex
// matched 18 declared mirrors and this one matches 29. The guard was blind to
// 38% of the things it exists to police.
//
// Bounded to 40 characters and stopped at a period or newline so it matches a
// phrase, not a paragraph.
const MARKER =
  /keep [^.\n]{0,40}in lockstep|must stay in lockstep|client mirror of|web mirror MUST stay in lockstep/i;

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

  // ── US-2387: the paged-read contract, both halves ────────────────────────
  "services/edge-functions/src/lib/paged-read.ts":
    "services/edge-functions/src/tests/paged-read-parity_test.ts asserts the " +
    "three constants against the WEB file's source, and asserts that the web " +
    "half still stops on an EMPTY page and advances by rows RECEIVED — the two " +
    "lines that carry the contract. Behaviour cannot be imported across " +
    "projects, so the guard reads the other side's text.",
  "services/edge-functions/src/tests/paged-read-parity_test.ts":
    "the guard itself (edge half of the paged-read mirror)",

  // ── US-2306: surfaced by the widened marker ──────────────────────────────
  "src/lib/title-sync.ts":
    "src/lib/__tests__/title-sync.test.ts asserts against the edge copy " +
    "(services/edge-functions/src/lib/title-sync.ts) — the web composer saves " +
    "direct to supabase with no edge round-trip, so the logic necessarily " +
    "exists twice.",
  // US-1995: only the EDGE half carries the marker; src/lib/title-sync-patch.ts
  // has no lockstep comment, so registering it would be a stale entry.
  "services/edge-functions/src/lib/title-sync-patch.ts":
    "src/test/fixtures/title-sync-patch-cases.json — read by BOTH suites, " +
    "services/edge-functions/src/tests/title-sync-patch_test.ts and " +
    "src/lib/__tests__/title-sync-patch.test.ts. The fixture landed WITH the " +
    "second copy rather than after it, so this pair has never been unguarded.",
  // Only the EDGE half carries the marker here — the web copy
  // (src/lib/reputation-perks.ts) has no lockstep comment, so registering it
  // would be a stale entry by this guard's own rule. Caught by that rule.
  "services/edge-functions/src/lib/buyer-reputation-perks.ts":
    "src/lib/__tests__/reputation-perks.test.ts asserts this perk matrix against " +
    "the web copy (src/lib/reputation-perks.ts).",
  "services/edge-functions/src/lib/ai-grading.ts":
    "US-2306: FACTOR_WEIGHTS is now exported and asserted against " +
    "human-review's table, factor for factor, by " +
    "services/edge-functions/src/tests/weighted-grade-parity_test.ts. NOT " +
    "de-duplicated, and deliberately so — human-review keys by DB COLUMN names " +
    "(…_score) and ai-grading by the AI RESPONSE field names, so the two are a " +
    "translation rather than a copy. The guard pins them through that key map, " +
    "and a sixth factor on either side fails a companion test rather than " +
    "passing vacuously.",
  "src/lib/aspect-provenance.ts":
    "US-2389: requiredMissingAspectNames mirrors the edge requiredMissingAspects. " +
    "Both assert src/test/fixtures/required-aspects-cases.json — this side in " +
    "src/lib/__tests__/aspect-provenance.test.ts, the edge in " +
    "services/edge-functions/src/tests/aspect-provenance_test.ts. Registered " +
    "because they had ALREADY drifted: this copy threw on an aspect spec with " +
    "no aspectConstraint (the type said it was always present; eBay's Taxonomy " +
    "payload is not bound by the type) while the edge copy returned safely.",
  "services/edge-functions/src/lib/aspect-provenance.ts":
    "US-2389: the edge half of the pair above — the publish BLOCKER to the web " +
    "copy's pre-publish checklist. Same shared fixture, both suites.",
  "services/edge-functions/src/lib/human-review.ts":
    "US-2386: computeWeightedOverall AND its requireFactor guard mirror " +
    "src/lib/weighted-grade.ts. Both are asserted against the shared fixture " +
    "src/test/fixtures/weighted-grade-cases.json — `cases` for the arithmetic, " +
    "`refusal_cases` for an incomplete factor set — by " +
    "src/lib/__tests__/weighted-grade.test.ts and " +
    "services/edge-functions/src/tests/weighted-grade-parity_test.ts. The " +
    "refusal half is the newer one and is the reason this entry exists: the " +
    "two copies had ALREADY drifted on a missing factor (web coalesced to 0, " +
    "edge fell out as NaN) and neither suite covered it, so the mirror looked " +
    "pinned while its most dangerous input was not.",
  // MOVED FILE, SAME MIRROR. AI_ACTION_LIMITS lived in routes/flipdesk-ai.ts
  // until fd25954a2 lifted it into lib/ai-quota.ts, and the registry kept
  // pointing at the old path — which failed BOTH ways at once: the new file
  // looked unclassified and the old entry looked stale. Re-pointed rather than
  // re-argued; the guard underneath it never changed.
  "services/edge-functions/src/lib/ai-quota.ts":
    "AI_ACTION_LIMITS is asserted against PLAN_MATRIX.aiActionsPerMonth by " +
    "services/edge-functions/src/tests/ai-quota_test.ts. NOTE the source " +
    "comment says the test asserts it against FALLBACK_MATRIX; the test " +
    "actually reads PLAN_MATRIX. Same table, different name — the guard is real.",
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

  // ── US-2306: surfaced by the widened marker ──────────────────────────────
  //
  // Three of these are not mirrors at all — they use "in lockstep" to describe
  // keeping two pieces of RUNTIME STATE in step, which is a different thing
  // from two copies of a VALUE. They are listed rather than excluded by a
  // cleverer regex, because a regex that tries to tell those apart is a regex
  // that will one day exclude a real mirror.
  "src/components/flipdesk/ebay-category-picker.tsx":
    "Not a value mirror: keeps the parent's lifted aspect STATE in step with " +
    "each edit, inside one component tree. Nothing is duplicated across projects.",
  "src/components/marketing/scroll-experience/lenis-engine.ts":
    "Not a value mirror: keeps ScrollTrigger's scroll cache in step with " +
    "Lenis's virtual scroll position at runtime. Two libraries, one frame.",
  // US-2173 AC2 moved the mutation handlers — and this comment with them —
  // into listings-actions.ts. The path is restated rather than loosened,
  // because the point of the registry is that a mirror is claimed per file.
  "src/pages/flipdesk/listings-actions.ts":
    "Not a value mirror: keeps a react-query listing row in step with an item " +
    "row after a status write, so a re-drafted item stops showing its old " +
    "listing. Intra-page cache coherence.",

  "services/edge-functions/src/lib/shopify-graphql.ts":
    "Mirrors the four subscribed webhook topics against the inbound receiver's " +
    "switch — both WITHIN the edge project, so a normal import/unit test can " +
    "cover it (same reasoning as publish-preflight above).",

  "src/lib/title-quality.ts":
    "A REAL cross-project mirror (edge title-lint.ts) that is NOT yet pinned: " +
    "src/lib/__tests__/title-quality.test.ts does not reference the edge copy, " +
    "so nothing asserts both. Exempt rather than pinned because saying it is " +
    "pinned would be false. A drift shows the composer a warning that does not " +
    "match what publish blocks on — misleading, not incorrect, since the edge " +
    "preflight remains authoritative at publish time. Worth pinning with a " +
    "shared fixture; tracked on US-2306.",
  "src/lib/buyer-features.ts":
    "Its comment claims lockstep with the /buyer/* route table, and " +
    "src/lib/buyer-features.test.ts does NOT assert that — it pins the registry " +
    "against BuyerGateFlags, a different relationship. So the claimed mirror is " +
    "unguarded. A drift sells a feature whose route still renders a placeholder; " +
    "the pricing render test catches the visible half. Worth pinning; tracked on " +
    "US-2306.",
};

// US-2129: shared + memoized scan. This guard reads the whole tree (2,235
// files, 21.6 MB) and was timing out at vitest's default 5000ms under parallel
// worker load, failing at random.

describe("US-2019: declared lockstep mirrors are classified", () => {
  it("every file asserting a mirror is either PINNED or EXEMPT", () => {
    const entries = sourceTexts(SCAN_DIRS, ROOT).filter((e) =>
      /\.(ts|tsx)$/.test(e.file),
    );

    const declared: string[] = [];
    for (const { file: f, text } of entries) {
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
  }, SCAN_TIMEOUT_MS);

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
