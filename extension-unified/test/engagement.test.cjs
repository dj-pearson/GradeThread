// GradeThread unified extension — Poshmark engagement safety guards (US-2482).
//
// WHAT THIS FILE IS DEFENDING. Engagement automation is the only thing in this
// product that can cost a seller their closet. Poshmark throttles or stops
// shares from a closet it decides is automated — "share jail" — and the seller
// finds out because their sales stop, not because anything tells them. So the
// caps, the pacing floor, the consent gate and the refusal to answer a human
// check are not "features that should work". They are the reason it is safe to
// ship this at all, and US-2482 AC6 requires a build to FAIL if any of them is
// removed rather than to ship quietly without them.
//
// Everything asserted here is a pure function in lister/engagement.js. That file
// has no chrome.* and no DOM precisely so this can hold it to account with zero
// dependencies and no browser.

const assert = require("node:assert");

// ── US-2487: the share menu is mostly exits ────────────────────────────────
//
// Watching a real share showed the first modal is a share MENU whose options
// are largely OUTBOUND — share_facebook, share_pinterest, share_email,
// share_copy, and a people_search box that DMs the listing to a named person.
// Only `share_poshmark` stays inside Poshmark, and it opens the second modal
// where "To My Followers" lives.
//
// So the intermediate step is a guard, not politeness: without it a selector
// drift in the second modal could resolve against the FIRST one, and the
// failure would not be a missed share — it would be the seller's listing posted
// to their Facebook, or sent to a stranger, a few thousand times.
{
  const fs2 = require("node:fs");
  const path2 = require("node:path");
  const dir2 = path2.resolve(__dirname, "..");
  const engage = fs2.readFileSync(path2.join(dir2, "lister", "poshmark-engage.js"), "utf8");
  const src2 = fs2.readFileSync(path2.join(dir2, "lister", "selectors.js"), "utf8");
  const scope2 = {};
  // eslint-disable-next-line no-new-func
  const SEL2 = new Function("self", `${src2}; return self.GT_LISTER_SELECTORS;`)(scope2);

  assert.ok(
    SEL2.poshmark.engage.shareInternal,
    "poshmark.engage must declare shareInternal — the one option in the share " +
      "menu that does not leave Poshmark",
  );

  const shareOne = engage.slice(engage.indexOf("async function shareOne("));
  const body2 = shareOne.slice(0, shareOne.indexOf("\n  }"));
  const internalAt = body2.indexOf("cfg.shareInternal");
  const followersAt = body2.indexOf("cfg.shareToFollowers");
  assert.ok(internalAt !== -1, "shareOne must step through shareInternal");
  assert.ok(
    internalAt < followersAt,
    "shareOne looks for shareToFollowers BEFORE stepping into the internal " +
      "share modal. In the first modal the neighbouring controls are Facebook, " +
      "Pinterest, email and a DM box.",
  );
  assert.ok(
    /if \(!internal\) return false;/.test(body2),
    "a missing internal-share step must ABORT. Falling through would leave the " +
      "next click landing in the outbound-share menu.",
  );

  // ── The second signal, and the rule that keeps it honest ────────────────
  //
  // Four watcher runs failed to record Poshmark's success toast: it is gone in
  // about two seconds and may not be a DOM insertion at all. So the modal
  // CLOSING counts as proof too — the same evidence delist has used since
  // US-1875 — but ONLY as a present-then-absent transition.
  //
  // Without that rule a selector matching nothing reads as "absent" on the
  // first tick and rubber-stamps every action, which is the false-success bug
  // the confirmation exists to prevent, rebuilt inside the confirmation.
  const conf = engage.slice(engage.indexOf("async function confirmed("));
  const confBody = conf.slice(0, conf.indexOf("\n  }"));
  assert.ok(/goneWasPresent/.test(confBody),
    "confirmed() must capture whether the witness was present BEFORE the click");
  assert.ok(
    confBody.indexOf("goneWasPresent =") < confBody.indexOf("while ("),
    "the presence snapshot must be taken before the polling loop, not inside it",
  );
  assert.ok(
    /goneWasPresent && !document\.querySelector\(cfg\.confirmGone\)/.test(confBody),
    "absence alone must never confirm an action — only present-then-absent",
  );
  assert.ok(SEL2.poshmark.engage.confirmGone, "poshmark.engage must declare confirmGone");
  assert.ok(
    SEL2.poshmark.engage.actionConfirmed,
    "the toast selector stays: it is the STRONGER signal and is checked first",
  );
  assert.ok(
    confBody.indexOf("cfg.actionConfirmed") < confBody.indexOf("goneWasPresent &&"),
    "the toast must be checked before the weaker gone-witness",
  );
}
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");

function load(rel, globalName) {
  const src = fs.readFileSync(path.join(dir, rel), "utf8");
  const scope = {};
  // eslint-disable-next-line no-new-func
  return new Function("self", `${src}; return self.${globalName};`)(scope);
}

const E = load("lister/engagement.js", "GT_ENGAGE");
const SELECTORS = load("lister/selectors.js", "GT_LISTER_SELECTORS");

// ── 1. The absolute ceiling cannot be raised ───────────────────────────────
//
// AC3: a hard daily ceiling defaulting to 5000 shares, with an absolute cap
// below 9500 the seller CANNOT raise. The absolute sits below the point sellers
// report as the edge of Poshmark's tolerance, and the gap is the margin — a cap
// the seller can push to the exact edge is not a safety limit.
assert.strictEqual(E.LIMITS.share.default, 5000, "the default share cap must be 5000 (AC3)");
assert.ok(
  E.LIMITS.share.absolute < 9500,
  `the absolute share cap is ${E.LIMITS.share.absolute}; it must sit BELOW 9500 — ` +
    "at the reported edge of Poshmark's tolerance there is no margin left (AC3)",
);
assert.ok(E.LIMITS.share.absolute >= E.LIMITS.share.default, "absolute must not be below the default");

for (const attempt of [50000, 9499, 9500, Number.MAX_SAFE_INTEGER, Infinity]) {
  const clamped = E.clampSettings({ shareCap: attempt });
  assert.ok(
    clamped.shareCap <= E.LIMITS.share.absolute,
    `clampSettings let shareCap through at ${clamped.shareCap} from a requested ${attempt} — ` +
      "the ceiling must not be raisable, in the UI or by editing storage",
  );
}

// The same for the other two actions: a follow or offer spree gets an account
// limited just as fast, and only the numbers differ.
for (const action of ["follow", "offer"]) {
  const key = action + "Cap";
  const clamped = E.clampSettings({ [key]: 999999 });
  assert.strictEqual(
    clamped[key],
    E.LIMITS[action].absolute,
    `${key} must clamp to its absolute (${E.LIMITS[action].absolute})`,
  );
}

// Garbage must fall back to the default, never to "no limit". A NaN cap that
// became Infinity would be the same bug wearing a type error.
for (const junk of [undefined, null, "9999999", NaN, -1, {}, []]) {
  const clamped = E.clampSettings({ shareCap: junk });
  assert.ok(
    Number.isFinite(clamped.shareCap) && clamped.shareCap <= E.LIMITS.share.absolute,
    `a shareCap of ${JSON.stringify(junk)} produced ${clamped.shareCap}`,
  );
}

// ── 2. Pacing is randomized, and the floor cannot be lowered ───────────────
//
// AC3: randomized pacing with a configurable floor. A fixed interval is the most
// legible automation signal there is — a human does not click every 1.000s.
{
  const s = E.clampSettings({ pacingFloorMs: 0 });
  assert.strictEqual(
    s.pacingFloorMs,
    E.PACING_FLOOR_MIN_MS,
    "the pacing floor must clamp UP to the minimum — a zero floor is a click storm",
  );

  // Raising it is allowed: someone running slower is being careful.
  assert.strictEqual(E.clampSettings({ pacingFloorMs: 5000 }).pacingFloorMs, 5000);

  const settings = E.clampSettings({ pacingFloorMs: 1000, pacingJitterMs: 1000 });
  const lo = E.nextDelayMs(settings, () => 0);
  const hi = E.nextDelayMs(settings, () => 0.999999);
  assert.strictEqual(lo, 1000, "the low end of the range must be exactly the floor");
  assert.ok(hi > lo, "the delay must actually vary — a constant delay is not pacing");
  assert.ok(hi < 2000, "the high end must stay within floor + jitter");

  // And it must never return something below the floor for any input in range,
  // including the hostile ones a broken rand source could produce.
  for (const r of [-1, 0, 0.5, 1, 2, NaN]) {
    const d = E.nextDelayMs(settings, () => r);
    assert.ok(
      d >= settings.pacingFloorMs,
      `nextDelayMs returned ${d} for rand=${r}, below the floor`,
    );
  }
}

// ── 3. The dedicated clickwrap, and that it is not the Lister one ──────────
//
// AC5. The Lister consent covers "the extension fills in my own listing form".
// Sharing five thousand times a day is a different thing to agree to, and
// reusing the listing consent would opt sellers into this with a checkbox they
// ticked for cross-listing.
{
  const gateCtx = {
    action: "share",
    sellerAllowed: true,
    settings: E.defaultSettings(),
    counters: E.emptyCounters("2026-08-10"),
    now: Date.parse("2026-08-10T12:00:00Z"),
  };

  // No consent at all.
  let d = E.gate(Object.assign({}, gateCtx, { clickwrap: null }));
  assert.strictEqual(d.ok, false);
  assert.strictEqual(d.reason, "needs_consent");

  // A LISTER consent is not this consent. This is the substitution the AC is
  // about, asserted directly.
  d = E.gate(Object.assign({}, gateCtx, {
    clickwrap: { acceptedAt: "2026-07-13T00:00:00Z", version: "2026-07-13" },
  }));
  assert.strictEqual(
    d.reason,
    "needs_consent",
    "a consent carrying the LISTER version must not satisfy the engagement gate",
  );

  // An outdated engagement consent stops counting, so changed wording is re-read.
  d = E.gate(Object.assign({}, gateCtx, {
    clickwrap: { acceptedAt: "2020-01-01T00:00:00Z", version: "1999-01-01" },
  }));
  assert.strictEqual(d.reason, "needs_consent");

  // The current one passes.
  d = E.gate(Object.assign({}, gateCtx, { clickwrap: E.acceptClickwrap("2026-08-10T00:00:00Z") }));
  assert.strictEqual(d.ok, true, "a current acceptance must open the gate");
}

// The four statements the seller accepts. Asserted by meaning, so the wording
// can improve and none of the four can quietly disappear.
{
  const blob = E.CLICKWRAP_TERMS.join(" ");
  const REQUIRED = [
    [/terms restrict third-party automation/i, "that Poshmark's terms restrict third-party automation"],
    [/responsible for my Poshmark account/i, "that the seller is responsible for the account"],
    [/run on my machine/i, "that the actions run on the seller's own machine"],
    [/never see my password or session cookie/i, "that GradeThread never sees the password or cookie"],
  ];
  for (const [re, what] of REQUIRED) {
    assert.ok(re.test(blob), `the clickwrap no longer states ${what} (AC5)`);
  }
  assert.ok(E.CLICKWRAP_TERMS.length >= 4, "the clickwrap must carry at least the four required statements");
}

// ── 4. The daily cap actually stops a run ──────────────────────────────────
{
  const accepted = E.acceptClickwrap("2026-08-10T00:00:00Z");
  const settings = E.clampSettings({ shareCap: 10 });
  const counters = { day: "2026-08-10", share: 10, follow: 0, offer: 0 };
  const d = E.gate({
    action: "share",
    sellerAllowed: true,
    clickwrap: accepted,
    settings,
    counters,
    now: Date.parse("2026-08-10T12:00:00Z"),
  });
  assert.strictEqual(d.ok, false);
  assert.strictEqual(d.reason, "daily_cap");
  assert.ok(/share jail/i.test(d.message), "the cap message must NAME share jail (AC4)");

  // planRun trims to what is left AND reports that it trimmed — a run that
  // silently does 3 of a requested 50 is a run the seller thinks completed.
  const plan = E.planRun(50, { day: "2026-08-10", share: 7 }, settings, "share");
  assert.strictEqual(plan.count, 3);
  assert.strictEqual(plan.trimmed, true);
}

// ── 5. A human check pauses, and is never answered ─────────────────────────
//
// AC2. This is a bright line from the US-2476 ADR and it holds even though the
// run is in the seller's own browser: a CAPTCHA is the site explicitly asking
// whether a human is present, and answering it programmatically is circumventing
// an access control rather than disagreeing about automation policy.
{
  const d = E.gate({
    action: "share",
    sellerAllowed: true,
    clickwrap: E.acceptClickwrap("2026-08-10T00:00:00Z"),
    settings: E.defaultSettings(),
    counters: E.emptyCounters("2026-08-10"),
    now: Date.parse("2026-08-10T12:00:00Z"),
    humanCheck: true,
  });
  assert.strictEqual(d.ok, false);
  assert.strictEqual(d.reason, "human_check");
  assert.strictEqual(d.paused, true, "a human check PAUSES the run rather than failing it");
  assert.ok(/finish it/i.test(d.message), "the message must tell the seller to finish it themselves");
}

// No solver service, anywhere. Asserted against the source of every engagement
// file, because "we would never" is not a control — a dependency added in a
// hurry is exactly how this line gets crossed.
{
  const SOLVER_NAMES = /2captcha|anti-?captcha|capsolver|deathbycaptcha|capmonster|solveRecaptcha|captcha[-_]?solver/i;
  for (const rel of [
    "lister/engagement.js",
    "lister/poshmark-engage.js",
    "lister/selectors.js",
    "background.js",
  ]) {
    const src = fs.readFileSync(path.join(dir, rel), "utf8");
    assert.ok(
      !SOLVER_NAMES.test(src),
      `${rel} references a CAPTCHA-solving service. GradeThread never solves, ` +
        "bypasses or outsources a human check (US-2482 AC2, and the bright line in " +
        "vault/60-decisions/adr-no-server-side-marketplace-automation.md §3.2).",
    );
  }
  // And the detector itself has to exist, or "we pause on a human check" is a
  // claim with nothing behind it.
  assert.ok(
    SELECTORS.poshmark.engage && SELECTORS.poshmark.engage.humanCheck,
    "poshmark.engage must declare a `humanCheck` selector — without one the run " +
      "keeps clicking into a wall, which is the behaviour most likely to get a " +
      "closet flagged",
  );
}

// ── 6. Counters roll at the seller's midnight and never carry over ─────────
{
  const noon = Date.parse("2026-08-10T18:00:00Z");
  const utc = E.dayKey(noon, 0);
  assert.strictEqual(utc, "2026-08-10");
  // A seller in UTC+8 is already on the 11th at 18:00Z. The meter has to agree
  // with the day they are looking at, or the cap resets at a time that means
  // nothing to them.
  assert.strictEqual(E.dayKey(noon, -480), "2026-08-11");

  const stale = { day: "2026-08-09", share: 4999, follow: 12, offer: 3 };
  const rolled = E.rollCounters(stale, noon, 0);
  assert.strictEqual(rolled.day, "2026-08-10");
  assert.strictEqual(rolled.share, 0, "yesterday's count must NOT carry into today");

  const same = E.rollCounters({ day: "2026-08-10", share: 40 }, noon, 0);
  assert.strictEqual(same.share, 40, "today's count must survive a reload");

  // A negative or junk stored count must not create headroom.
  assert.strictEqual(E.rollCounters({ day: "2026-08-10", share: -500 }, noon, 0).share, 0);
}

// ── 7. Fail-safe: an unknown entitlement is locked, not open ───────────────
for (const sellerAllowed of [undefined, null, false, "true", 1]) {
  const d = E.gate({
    action: "share",
    sellerAllowed,
    clickwrap: E.acceptClickwrap("2026-08-10T00:00:00Z"),
    settings: E.defaultSettings(),
    counters: E.emptyCounters("2026-08-10"),
    now: 0,
  });
  assert.strictEqual(
    d.ok,
    false,
    `sellerAllowed=${JSON.stringify(sellerAllowed)} opened the gate — only a literal true may`,
  );
}

// ── 8. The meter says what happens at the cap ──────────────────────────────
{
  const settings = E.clampSettings({ shareCap: 100 });
  const low = E.meter({ day: "d", share: 10 }, settings, "share");
  assert.strictEqual(low.pct, 10);
  assert.ok(/10 of 100 shares today/.test(low.label));
  assert.ok(/share jail/i.test(low.note), "AC4: share jail is named, not implied");

  const near = E.meter({ day: "d", share: 85 }, settings, "share");
  assert.ok(/share jail/i.test(near.note));

  const full = E.meter({ day: "d", share: 100 }, settings, "share");
  assert.strictEqual(full.atCap, true);
  assert.strictEqual(full.pct, 100);
  assert.ok(/share jail/i.test(full.note));
}

// ── 9. Nothing here reaches the network ────────────────────────────────────
//
// AC8: counters and settings live in chrome.storage.local only, and
// GradeThread's servers receive run COUNTS at most — never Poshmark content or
// credentials. The state machine is the place that would be tempted to phone
// home with a "run summary", so it is asserted to have no network primitive at
// all rather than to use one carefully.
{
  const raw = fs.readFileSync(path.join(dir, "lister/engagement.js"), "utf8");
  // Comments stripped first. This file explains WHY it never touches chrome.* or
  // the network, and a scan that matched its own explanation would be a guard
  // that fails on being documented — which is how a guard gets deleted.
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  for (const forbidden of [
    "fetch(",
    "XMLHttpRequest",
    "sendBeacon",
    "WebSocket",
    "chrome.",
    "browser.",
    "document.",
  ]) {
    assert.ok(
      !code.includes(forbidden),
      `lister/engagement.js uses ${forbidden}. The engagement state machine must stay ` +
        "pure — no network, no chrome.*, no DOM. Counters and settings live in " +
        "chrome.storage.local and are read by the BACKGROUND; this file only decides " +
        "(AC8).",
    );
  }
}

console.log(
  "✓ engagement: caps unraisable (share " + E.LIMITS.share.default + "/" +
    E.LIMITS.share.absolute + "), pacing floored + randomized, dedicated clickwrap " +
    "enforced per action, human checks pause and are never solved, counters roll " +
    "at the seller's midnight",
);
