// US-1912: the seller Grade Integrity TIER — transitions, tier inputs, and the
// deliberate asymmetry between a promotion and a demotion.
//
// Split from buyer-grade-confirmation_test.ts (which owns the confirm/dispute
// math) because this is a different contract: that file asks "what did buyers
// report", this one asks "what does that make the seller, who is told, and how".
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  integrityTierDirection,
  INTEGRITY_TIER_RANK,
  SELLER_INTEGRITY_TIER_LABELS,
  averageCoveragePct,
  tenureDaysFrom,
  tierDownDriver,
  sellerIntegrityTier,
} = await import("../lib/buyer-grade-confirmation.ts");

const NOW = Date.UTC(2026, 7, 7);
const inDays = (n: number) => new Date(NOW + n * 86_400_000).toISOString();

const LIB_URL = new URL("../lib/buyer-grade-confirmation.ts", import.meta.url);

/**
 * Read a source file with line endings normalized to LF. Git checks this tree
 * out with CRLF on Windows, so a `\n`-bearing needle silently matches NOTHING
 * here while passing in CI — which turns a structural guard into one that
 * either fails locally for the wrong reason or, worse, slices the "function
 * body" as the entire rest of the file and asserts against code it never meant.
 */
function readSource(url: URL): string {
  return Deno.readTextFileSync(url).replace(/\r\n/g, "\n");
}

/** Source with comments stripped — a scan must not match its own post-mortem. */
function libCode(): string {
  return readSource(LIB_URL)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

// ─── Direction ──────────────────────────────────────────────────────────────

Deno.test("direction: earning a FIRST tier is a promotion", () => {
  // The stored default is 'building', so crossing the floor moves
  // building → verified. If that read as "none", the one tier that actually
  // took ten confirmed buyers would be the only one never celebrated or paid.
  assertEquals(integrityTierDirection("building", "verified"), "up");
  assertEquals(integrityTierDirection(null, "verified"), "up");
  assertEquals(integrityTierDirection(undefined, "elite"), "up");
});

Deno.test("direction: a demotion is 'down', never 'up'", () => {
  assertEquals(integrityTierDirection("elite", "trusted"), "down");
  assertEquals(integrityTierDirection("trusted", "building"), "down");
  assertEquals(integrityTierDirection("verified", "building"), "down");
});

Deno.test("direction: an unchanged tier fires nothing (AC5 idempotence)", () => {
  // This is what makes the recompute safe to run on every buyer outcome: a
  // second run of an unchanged standing must not re-grant, re-notify, or bump
  // tier_changed_at.
  for (const tier of Object.keys(INTEGRITY_TIER_RANK) as Array<
    keyof typeof INTEGRITY_TIER_RANK
  >) {
    assertEquals(integrityTierDirection(tier, tier), "none");
  }
});

Deno.test("direction: the ladder ranks strictly, worst to best", () => {
  // Two tiers sharing a rank would make a real move read as "none" — silently,
  // since nothing else compares them.
  const ranks = Object.values(INTEGRITY_TIER_RANK);
  assertEquals(new Set(ranks).size, ranks.length);
  assertEquals(INTEGRITY_TIER_RANK.building, 0);
  assert(
    INTEGRITY_TIER_RANK.verified < INTEGRITY_TIER_RANK.reliable &&
      INTEGRITY_TIER_RANK.reliable < INTEGRITY_TIER_RANK.trusted &&
      INTEGRITY_TIER_RANK.trusted < INTEGRITY_TIER_RANK.elite,
    "the ladder is out of order, so a promotion could read as a demotion",
  );
});

Deno.test("every tier has a label, so a stored tier never renders as a slug", () => {
  for (const tier of Object.keys(INTEGRITY_TIER_RANK)) {
    assert(
      (SELLER_INTEGRITY_TIER_LABELS as Record<string, string>)[tier],
      `no label for tier '${tier}'`,
    );
  }
});

// ─── Tier inputs ────────────────────────────────────────────────────────────

Deno.test("coverage: averages the reports that carry a record", () => {
  assertEquals(
    averageCoveragePct([
      { coverage: { coverage_pct: 80 } },
      { coverage: { coverage_pct: 90 } },
    ]),
    85,
  );
});

Deno.test("coverage: no record anywhere reads as UNKNOWN, not zero", () => {
  // Reports graded before 00308 carry no coverage. Returning 0 would gate an
  // established seller out of the top tiers over data that did not exist when
  // they graded; null is never gated on.
  assertEquals(averageCoveragePct([]), null);
  assertEquals(averageCoveragePct([{ coverage: null }, { coverage: {} }]), null);
});

Deno.test("coverage: an unreadable value is dropped, not counted as good", () => {
  // A malformed blob must not decide a public tier. Dropping the bad entries
  // leaves the average of the ones we could actually read.
  assertEquals(
    averageCoveragePct([
      { coverage: { coverage_pct: "not a number" } },
      { coverage: { coverage_pct: 140 } },
      { coverage: { coverage_pct: -5 } },
      { coverage: { coverage_pct: 60 } },
    ]),
    60,
  );
});

Deno.test("tenure: an unknown creation date stays null, not zero", () => {
  assertEquals(tenureDaysFrom(null, NOW), null);
  assertEquals(tenureDaysFrom("not a date", NOW), null);
  assertEquals(tenureDaysFrom(inDays(-90), NOW), 90);
  // Clock skew must not produce a negative tenure.
  assertEquals(tenureDaysFrom(inDays(5), NOW), 0);
});

Deno.test("an unknown input never blocks a tier the rest of the record earned", () => {
  // The whole point of null-means-unknown: this seller clears elite on every
  // input we HAVE, and has no coverage or tenure record at all.
  const result = sellerIntegrityTier({
    integrityScore: 99,
    confirmedCount: 60,
    avgCoveragePct: null,
    tenureDays: null,
    gradedVolume: 150,
  });
  assertEquals(result.tier, "elite");
});

// ─── The demotion notice ────────────────────────────────────────────────────

Deno.test("tier-down driver names what would restore the lost tier", () => {
  const result = sellerIntegrityTier({
    integrityScore: 91,
    confirmedCount: 30,
    avgCoveragePct: 80,
    tenureDays: 400,
    gradedVolume: 200,
  });
  // Dropped out of 'trusted' (which needs score 95) back to 'reliable'.
  assertEquals(result.tier, "reliable");
  const message = tierDownDriver("trusted", result);
  assert(message.includes("trusted"), "the notice does not say what was lost");
  assert(message.includes("reliable"), "the notice does not say where they are");
  assert(
    message.includes("integrity ≥ 95"),
    "the notice does not name the specific driver — a reputation drop a seller " +
      "cannot account for is one they cannot act on",
  );
});

Deno.test("tier-down driver still says something when the drop skips a rung", () => {
  // A multi-rung demotion leaves nextTier != the lost tier, so there are no
  // gaps toward it. The notice must not come out as a bare sentence fragment.
  const result = sellerIntegrityTier({ integrityScore: 40, confirmedCount: 12 });
  const message = tierDownDriver("elite", result);
  assert(message.includes("elite"));
  assert(message.length > 40, "the demotion notice degraded to nothing useful");
});

// ─── The asymmetry (AC4) ────────────────────────────────────────────────────

Deno.test("AC4: a tier-DOWN has no reputation event type to ride", () => {
  // The asymmetry IS the requirement. reputation_events feeds public surfaces,
  // so the mere existence of an `integrity_tier_down` type would be the public
  // announcement this AC forbids — however it were rendered.
  const engine = readSource(
    new URL("../lib/rewards-engine.ts", import.meta.url),
  );
  assert(
    engine.includes('"integrity_tier_up"'),
    "the tier-up reward event type is gone, so a promotion pays nothing",
  );
  assert(
    !engine.includes("integrity_tier_down"),
    "a tier-DOWN reward event type exists — a demotion must never reach the " +
      "public reputation ledger",
  );
});

Deno.test("AC4: the promotion path grants, the demotion path notifies", () => {
  const code = libCode();
  const start = code.indexOf("async function announceIntegrityTierChange");
  assert(start > -1, "the tier-change announcer is gone");
  const body = code.slice(start, start + 2000);
  const upIdx = body.indexOf('direction === "up"');
  const grantIdx = body.indexOf("grantReward(");
  const notifyIdx = body.indexOf("notifyUser(");
  assert(upIdx > -1, "the promotion branch is gone");
  assert(grantIdx > upIdx, "a promotion no longer grants a reward");
  assert(
    notifyIdx > grantIdx,
    "the demotion no longer notifies the seller privately, or it now runs " +
      "before the promotion branch — which would notify on a promotion too",
  );
  assert(
    body.slice(upIdx, notifyIdx).includes("return;"),
    "the promotion branch falls through into the demotion notice, so a seller " +
      "would be told their standing dropped in the same breath as being promoted",
  );
});

Deno.test("AC4: the tier-up grant is deduped on the tier REACHED", () => {
  // Re-climbing to a tier after a demotion must not pay a second time. The
  // dedupe key is the reference id, so it has to carry the tier — a per-event
  // or per-timestamp key would make the ladder farmable by oscillating.
  const code = libCode();
  assert(
    /referenceId:\s*`integrity_tier:\$\{result\.tier\}`/.test(code),
    "the tier-up grant is not deduped on the tier reached, so a seller who " +
      "loses and regains a tier is paid for it twice",
  );
});

// ─── Storage + idempotence (AC5) ────────────────────────────────────────────

Deno.test("AC5: the transition is decided against the STORED tier", () => {
  // Idempotence is not a property of the pure functions — it comes from reading
  // the stored tier BEFORE writing. A recompute deciding the direction from
  // anything else (a timestamp, or the previous_tier column it is about to
  // write) would re-fire the grant and the notice on every buyer outcome.
  const code = libCode();
  const readIdx = code.indexOf('.select("tier")');
  const upsertIdx = code.indexOf("tier_displayable: tierResult.displayable");
  assert(readIdx > -1, "the stored tier is no longer read before the write");
  assert(upsertIdx > -1, "the tier is no longer stored");
  assert(
    readIdx < upsertIdx,
    "the stored tier is read AFTER the write, so it would always match and no " +
      "tier change could ever be detected",
  );
  assert(
    code.includes("integrityTierDirection(previousTier, tierResult.tier)"),
    "the direction is no longer computed from the stored tier",
  );
});

Deno.test("AC5: an unchanged tier leaves the transition bookkeeping alone", () => {
  const code = libCode();
  assert(
    /direction === "none"\s*\n?\s*\?\s*\{\}/.test(code),
    "an unchanged tier still rewrites previous_tier/tier_changed_at, so " +
      "'when did this last move' becomes 'when did we last recompute'",
  );
});

Deno.test("AC2: the recompute stores the tier inputs, not just the tier", () => {
  // Without the inputs the seller's explanation has to re-read live data, which
  // can disagree with the tier it is explaining.
  const code = libCode();
  for (const column of ["avg_coverage_pct:", "graded_volume:", "tenure_days:"]) {
    assert(code.includes(column), `the recompute no longer stores ${column}`);
  }
});

Deno.test("AC3: the public projection sends a tier name and nothing else", () => {
  const lib = readSource(LIB_URL);
  const fn = lib.slice(lib.indexOf("export async function loadPublicSellerIntegrity"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  // The floor is enforced at the READ, so no caller can forget it.
  assert(
    body.includes('.eq("tier_displayable", true)'),
    "the public read no longer filters on the display floor — a seller below " +
      "the anti-gaming minimum would get a public rank",
  );
  assert(
    body.includes('tier === "building"'),
    "a 'building' tier can escape to a public surface, rendering the pre-floor " +
      "state as a rank",
  );
  // Counts, scores and dispute numbers belong to the seller.
  for (const leak of ["confirmed_count", "disputed_count", "integrity_score"]) {
    assert(
      !body.includes(leak),
      `the public projection carries ${leak}, which is the seller's business`,
    );
  }
});

Deno.test("AC3: an unreadable public standing shows NO badge", () => {
  // Fail closed. A missing badge on a certificate is invisible; a badge we could
  // not verify is a trust claim, on the surface buyers act on.
  const code = libCode();
  const start = code.indexOf("export async function loadPublicSellerIntegrity");
  const body = code.slice(start, start + 1400);
  const catchIdx = body.indexOf("catch");
  assert(catchIdx > -1, "the public read no longer handles a failure");
  assert(
    /catch[\s\S]{0,400}return null;/.test(body),
    "a failed public integrity read no longer degrades to no badge",
  );
});

Deno.test("the tier is not a quest metric", () => {
  // Adding an entry to REWARD_XP_CATALOG silently widens QUEST_METRICS, and the
  // allowed metrics are ALSO a CHECK in 00540 that this value is not in — so an
  // admin would get a validator that passes and an insert that 23514s. Worse,
  // a quest counting a standing is one nobody can work toward: it moves at most
  // four times in a seller's life, and BUYERS decide when.
  const quests = readSource(
    new URL("../lib/rewards-quests.ts", import.meta.url),
  );
  assert(
    quests.includes('t !== "integrity_tier_up"'),
    "integrity_tier_up is offerable as a quest metric",
  );
});
