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
 * Mutating super_admin routes that carry no step-up, and WHY each is allowed to.
 *
 * Measured 2026-08-21: 52 mutating super_admin handlers, 42 guarded, 10 not.
 * US-2772 decided them ONE AT A TIME rather than in bulk, and the decision was
 * a split rather than a sweep.
 *
 * THE TWO THAT MOVE MONEY NOW STEP UP and have left this list: /apply (when
 * dryRun is false) and /revert both call requireFreshStepUp — the short-window
 * tier, beside refunds and kill switches. Those two change bids and budgets in
 * the live Google/Apple accounts, and a borrowed super_admin session must not be
 * able to do that unchallenged.
 *
 * THE OTHER EIGHT STAY, DELIBERATELY. A step-up on every one of them would make
 * the Ads Command Center's normal loop a TOTP prompt per click, and a second
 * factor people work around is worse than one they never had. The line drawn is
 * "does this change an external system's live spend": nothing below does. Each
 * reason states what the route actually does, so a later reader can disagree
 * with the judgement rather than guess at it.
 */
const KNOWN_GAPS: Array<[route: string, why: string]> = [
  // Reads Google's API and writes an analysis row. Spends quota, not budget,
  // and quota exhaustion is visible and self-correcting.
  ["admin-ads.ts POST /analyze", "spends Google Ads API quota; changes no campaign"],
  // The one genuine judgement call of the eight: it does send data OUTWARD to
  // Google. It sends conversions we already own, and it cannot change a bid, a
  // budget or a campaign — the worst case is reporting noise, correctable by
  // uploading again. Revisit if it ever gains the ability to write anything but
  // conversions.
  ["admin-ads.ts POST /conversions/upload", "uploads conversion data to Google Ads; cannot change spend"],
  // These three write a row in our own database saying what an admin thought of
  // a recommendation. Nothing reaches Google, and /apply is still the gate
  // between an approval and any live change.
  ["admin-ads.ts POST /recommendations/:id/approve", "records a decision locally; /apply is still the gate"],
  ["admin-ads.ts POST /recommendations/:id/dismiss", "records a decision locally"],
  ["admin-ads.ts POST /recommendations/:id/snooze", "records a decision locally"],
  // Inbound pulls. They overwrite our copy of the ad platforms' own numbers,
  // which the next sync restores.
  ["admin-ads.ts POST /apple/sync", "pulls Apple Search Ads data inward"],
  ["admin-ads.ts POST /google/sync", "pulls Google Ads data inward"],
  // Reads passports and writes findings. Destroys nothing and spends nothing.
  ["admin-passport-integrity.ts POST /scan", "starts a read-only integrity scan"],
];

const SUPER_ADMIN_CHECK = /adminRole"\)\s*!==\s*"super_admin"/;
/**
 * Any of the three step-up helpers counts as guarded.
 *
 * requireFreshStepUp WAS MISSING and that is a hole rather than an omission:
 * it is the STRICTER helper (STEP_UP_FRESH_SEC, the short window used for
 * refunds and kill switches), so a route defended with the strongest available
 * check read to this scan as defended with nothing. US-2772 hit it head-on -
 * adding requireFreshStepUp to the two ad routes that move live spend left them
 * still reported as gaps, which would have pushed the next person toward the
 * weaker helper to make the suite go green.
 *
 * `requireFreshStepUp` is listed FIRST, and alternation order is why: a regex
 * that tried `requireStepUp` first would still match inside the longer name
 * were it not for the leading `require`, and depending on that is the kind of
 * accident that survives until it does not.
 */
const STEP_UP = /requireFreshStepUp\(c\)|requireStepUp\(c\)|requireSensitive\(c\)/;
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

// ── US-2772: the two routes that move live ad spend ────────────────────────
//
// /apply and /revert change bids and budgets in the real Google/Apple accounts.
// They were the two named gaps of the ten and are now the only two of the ten
// that gained a second factor, because they are the only two that spend money.
//
// These name the routes explicitly rather than relying on the derived scan
// above. The scan proves nothing NEW ships unguarded; it cannot notice a
// specific route quietly moving back into KNOWN_GAPS with a plausible reason
// attached, and these two are the ones where that would matter.

Deno.test("US-2772: applying an ads recommendation steps up", () => {
  const h = superAdminHandlers().find(
    (x) => x.key === "admin-ads.ts POST /recommendations/:id/apply",
  );
  assert(h, "the ads apply route was renamed or removed");
  assert(
    h.stepUp,
    "POST /recommendations/:id/apply lost its step-up — it changes bids and " +
      "budgets in the LIVE ad accounts, which is real money leaving the account",
  );
});

Deno.test("US-2772: reverting an ads recommendation steps up", () => {
  const h = superAdminHandlers().find(
    (x) => x.key === "admin-ads.ts POST /recommendations/:id/revert",
  );
  assert(h, "the ads revert route was renamed or removed");
  assert(
    h.stepUp,
    "POST /recommendations/:id/revert lost its step-up — the direction differs " +
      "from an apply, the blast radius does not",
  );
});

Deno.test("US-2772: the ads money routes use the SHORT window, not the working-day one", () => {
  // requireStepUp's default window is a working day, which is right for
  // ordinary sensitive actions and wrong here: "you verified this morning" is
  // not evidence that you are at the keyboard now. Swapping requireFreshStepUp
  // for requireStepUp would keep the derived scan above green while quietly
  // widening the window on the only two routes that spend money.
  const src = Deno.readTextFileSync(
    new URL("../routes/admin-ads.ts", import.meta.url),
  );
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
  const applyStart = code.indexOf('adminAdsRoutes.post("/recommendations/:id/apply"');
  const revertStart = code.indexOf('adminAdsRoutes.post("/recommendations/:id/revert"');
  assert(applyStart > -1 && revertStart > -1, "one of the two routes was renamed");

  const applyBody = code.slice(applyStart, revertStart);
  const revertBody = code.slice(revertStart, revertStart + 2000);
  for (const [name, body] of [["apply", applyBody], ["revert", revertBody]] as const) {
    assert(
      body.includes("requireFreshStepUp(c)"),
      `${name} no longer uses requireFreshStepUp — the short window is the ` +
        `point, and requireStepUp would satisfy the derived scan while widening it`,
    );
  }
});

Deno.test("US-2772: a DRY RUN does not demand a second factor", () => {
  // The reason /apply's step-up is conditional. dryRun defaults to true and a
  // dry run changes nothing anywhere; prompting for TOTP on every preview would
  // make the Ads Command Center's loop a prompt per click, and a second factor
  // people work around is worse than one they never had.
  //
  // Pinned on the SHAPE of the guard rather than by calling the handler, which
  // would need a signed AAL2 token: the check must sit inside `if (!dryRun)`,
  // after the body parse.
  const src = Deno.readTextFileSync(
    new URL("../routes/admin-ads.ts", import.meta.url),
  );
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
  const start = code.indexOf('adminAdsRoutes.post("/recommendations/:id/apply"');
  const body = code.slice(start, code.indexOf('adminAdsRoutes.post("/recommendations/:id/revert"'));
  const gate = body.indexOf("if (!dryRun)");
  const check = body.indexOf("requireFreshStepUp(c)");
  assert(gate > -1, "apply's step-up is no longer gated on dryRun");
  assert(
    check > gate && check - gate < 200,
    "apply's requireFreshStepUp is no longer inside the `if (!dryRun)` block — " +
      "either every preview now prompts, or the live call no longer does",
  );
});
