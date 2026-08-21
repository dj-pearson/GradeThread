// Every super_admin MUTATION carries a step-up, derived rather than listed.
//
// WHY THIS EXISTS ALONGSIDE two-person-controls_test.ts. That test is correct
// and it is not complete. It checks a hand-written EMAIL_ROUTES list, and
// sabotaging the step-up on POST /deliverability/enforce was NOT caught —
// because that route is not on the list. It flips the newsletter send
// kill-switch, and its own comment says it needs super_admin plus a fresh
// step-up. A list only defends what somebody remembered to add to it.
//
// So this asks the general question of every admin route.
//
// GETs ARE EXCLUDED DELIBERATELY. A read behind super_admin does not need a
// second factor, and demanding one would make this noise nobody reads. The
// first version of the scan did include them and reported eleven read-only ads
// dashboards as findings, which is how a guard earns an allowlist it does not
// need.
//
// KNOWN_GAPS is SHRINK-ONLY, in the shape UNGRANTED_DEBT uses in
// security-definer-grants.test.ts: an entry that gains a step-up fails this test
// until the entry is deleted, so ground gained cannot be given back quietly, and
// a new route cannot join without someone editing this file and reading this.

import { assert } from "@std/assert";

/**
 * Mutating super_admin routes that carry no step-up today.
 *
 * Measured 2026-08-21: 52 mutating super_admin handlers, 42 guarded, these 10
 * not. Nine are in one router, which is the same INCONSISTENCY US-2356 was
 * about — the bar an action clears depends on which file it happens to live in.
 *
 * Two of them change live ad campaigns and therefore spend real money. They are
 * listed rather than fixed here because changing an admin auth requirement is a
 * product decision, not a test's call; US-2772 carries it.
 */
const KNOWN_GAPS: Array<[route: string, why: string]> = [
  ["admin-ads.ts POST /analyze", "spends Google Ads API quota; changes no campaign"],
  ["admin-ads.ts POST /conversions/upload", "uploads conversion data to Google Ads"],
  ["admin-ads.ts POST /recommendations/:id/approve", "records a decision"],
  ["admin-ads.ts POST /recommendations/:id/dismiss", "records a decision"],
  ["admin-ads.ts POST /recommendations/:id/snooze", "records a decision"],
  ["admin-ads.ts POST /recommendations/:id/apply", "CHANGES A LIVE CAMPAIGN — real money"],
  ["admin-ads.ts POST /recommendations/:id/revert", "CHANGES A LIVE CAMPAIGN — real money"],
  ["admin-ads.ts POST /apple/sync", "pulls Apple Search Ads data"],
  ["admin-ads.ts POST /google/sync", "pulls Google Ads data"],
  ["admin-passport-integrity.ts POST /scan", "starts an integrity scan"],
];

const SUPER_ADMIN_CHECK = /adminRole"\)\s*!==\s*"super_admin"/;
const STEP_UP = /requireStepUp\(c\)|requireSensitive\(c\)/;
/**
 * A route declaration at the start of a line.
 *
 * Anchored with ^ and NO leading \s*, which matters: the first draft used
 * /^\s*\w+Routes\./m and \s* consumed the preceding blank line, so every slice
 * started one route early and every reported line number was wrong.
 */
const DECL = /^(\w+Routes)\.(get|post|patch|put|delete)\(\s*"([^"]+)"/gm;

interface Handler {
  key: string;
  mutating: boolean;
  stepUp: boolean;
}

function superAdminHandlers(): Handler[] {
  const dir = new URL("../routes/", import.meta.url);
  const out: Handler[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    const src = Deno.readTextFileSync(new URL(entry.name, dir));
    const starts = [...src.matchAll(DECL)];
    for (let i = 0; i < starts.length; i++) {
      const m = starts[i]!;
      // ONE HANDLER, BOUNDED BY ITS OWN CLOSING BRACE.
      //
      // The obvious bound — "to the next route declaration" — is wrong here and
      // it silently disarmed this whole file. Between
      // POST /deliverability/enforce (line 174) and the next route (line 335)
      // sits the `requireSensitive` helper, whose body contains
      // `return requireStepUp(c)`. Slicing to the next declaration swallowed the
      // helper, so the route read as guarded, and REMOVING ITS ACTUAL STEP-UP
      // still passed. Caught by sabotage, not by reading.
      //
      // `\n});` at column zero is where a handler ends in this codebase, and it
      // cannot appear inside one, because everything inside is indented.
      const rest = src.slice(m.index!);
      const close = rest.indexOf("\n});");
      const nextDecl = starts[i + 1] ? starts[i + 1]!.index! - m.index! : rest.length;
      const body = rest.slice(0, Math.min(close === -1 ? rest.length : close + 4, nextDecl));
      if (!SUPER_ADMIN_CHECK.test(body)) continue;
      const method = m[2]!.toUpperCase();
      out.push({
        key: `${entry.name} ${method} ${m[3]}`,
        mutating: method !== "GET",
        stepUp: STEP_UP.test(body),
      });
    }
  }
  return out;
}

Deno.test("the scanner still finds the routes it is checking", () => {
  // Guard the guard. If the declaration style drifts, every assertion below
  // passes by finding nothing — the vacuous green this repo has shipped before.
  const all = superAdminHandlers();
  assert(
    all.length >= 50,
    `only ${all.length} super_admin handlers found; the route-declaration regex ` +
      `has stopped matching and this file is asserting over an empty set`,
  );
  assert(
    all.filter((h) => h.mutating && h.stepUp).length >= 40,
    "the guarded set collapsed — the step-up pattern is no longer being detected",
  );
  // And at least one read-only super_admin route exists, so the GET exclusion
  // is exercised rather than theoretical.
  assert(all.some((h) => !h.mutating), "no read-only super_admin handler found");
});

Deno.test("no NEW super_admin mutation ships without a step-up", () => {
  const gaps = superAdminHandlers()
    .filter((h) => h.mutating && !h.stepUp)
    .map((h) => h.key);
  const known = new Set(KNOWN_GAPS.map(([k]) => k));

  const novel = gaps.filter((g) => !known.has(g)).sort();
  assert(
    novel.length === 0,
    `these super_admin MUTATIONS carry no step-up:\n  ${novel.join("\n  ")}\n` +
      `Add requireStepUp(c) or requireSensitive(c). If a second factor genuinely ` +
      `does not belong, add an entry to KNOWN_GAPS with a reason.`,
  );
});

Deno.test("the known-gap list is shrink-only", () => {
  const gaps = new Set(
    superAdminHandlers().filter((h) => h.mutating && !h.stepUp).map((h) => h.key),
  );
  const fixed = KNOWN_GAPS.map(([k]) => k).filter((k) => !gaps.has(k)).sort();
  assert(
    fixed.length === 0,
    `these are listed as gaps but now HAVE a step-up: ${fixed.join(", ")}. ` +
      `Delete the entries in the same commit — otherwise the list stops meaning ` +
      `anything and the ground gained can be given back unnoticed.`,
  );
});

Deno.test("the kill-switch route two-person-controls missed is covered here", () => {
  // The specific hole that prompted this file. POST /deliverability/enforce
  // flips newsletter_send_paused, and removing its step-up passed the existing
  // suite because the route is not on its hand-written list.
  const h = superAdminHandlers().find(
    (x) => x.key === "admin-newsletter.ts POST /deliverability/enforce",
  );
  assert(h, "the deliverability enforce route was renamed or removed");
  assert(
    h.stepUp,
    "POST /deliverability/enforce lost its step-up — it mutates the newsletter " +
      "send kill-switch, which is exactly the class US-2356 is about",
  );
});
