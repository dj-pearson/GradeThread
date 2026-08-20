// GradeThread sold-sync — the scheduled poll's safety rules (US-2701).
//
// WHAT THIS FILE IS DEFENDING. The poll is the only part of sold-sync that
// sends traffic the seller did not ask for, to a marketplace that can throttle
// an account it decides is automated. The consent, the interval floor, the
// refusal to share a tab with the engagement runner and the two stop conditions
// are not features that should work — they are the reason it is safe to ship at
// all, and US-2701 requires a build to FAIL if one is removed.
//
// Everything asserted here is a pure function in sync/poll-plan.js. That file
// has no chrome.* precisely so this can hold it to account with no browser.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");

function load(rel, globalName) {
  const src = fs.readFileSync(path.join(dir, rel), "utf8");
  const scope = {};
  return new Function("self", `${src}; return self.${globalName};`)(scope);
}

const P = load("sync/poll-plan.js", "GT_SYNC_POLL");
const NOW = 1_800_000_000_000;
const PLATFORMS = ["poshmark", "mercari"];

const accepted = { acceptedAt: "2026-08-20T00:00:00.000Z", version: P.CLICKWRAP_VERSION };

function ctx(over = {}) {
  return {
    nowMs: NOW,
    platforms: PLATFORMS,
    clickwrap: accepted,
    settings: { enabled: true, intervalMin: 45 },
    channels: {},
    engagementInFlight: false,
    ...over,
  };
}

// ── 1. Consent, and it is its OWN clickwrap ────────────────────────────────

{
  assert.deepStrictEqual(
    P.planPoll(ctx({ clickwrap: null })),
    { poll: [], blocked: "no_consent", skipped: [] },
    "the poll ran with no consent at all",
  );

  // An OLD acceptance stops counting. The seller agreed to a sentence, not to a
  // feature name, so changing the sentence has to re-ask.
  const stale = { acceptedAt: "2026-01-01T00:00:00.000Z", version: "2020-01-01" };
  assert.strictEqual(P.planPoll(ctx({ clickwrap: stale })).blocked, "no_consent");
  assert.strictEqual(P.isClickwrapAccepted(stale), false);
  assert.strictEqual(P.isClickwrapAccepted(accepted), true);

  // Accepting without a date is not accepting.
  assert.strictEqual(
    P.isClickwrapAccepted({ version: P.CLICKWRAP_VERSION, acceptedAt: null }),
    false,
  );
}

// The clickwrap must SAY the thing the seller is agreeing to. A consent that
// loses the sentence about opening a tab is not a consent to opening a tab.
{
  const joined = P.CLICKWRAP_TERMS.join(" ").toLowerCase();
  for (const promise of ["background tab", "your own", "another seller", "human check", "switch this off"]) {
    assert.ok(joined.includes(promise), `the clickwrap no longer states: ${promise}`);
  }
  assert.ok(
    /password|session/.test(joined) && /address/.test(joined),
    "the clickwrap must still state what is never sent",
  );
  assert.ok(P.CLICKWRAP_TERMS.length >= 5, "a clickwrap term was dropped");
}

// ── 2. Checked before EVERY poll, not once per session ─────────────────────
//
// Structural: planPoll takes the clickwrap as an argument and is called per
// tick, so there is nowhere to cache a yes. The guard is that no module-level
// cache exists.
{
  const src = fs.readFileSync(path.join(dir, "sync/poll-plan.js"), "utf8");
  assert.ok(
    !/var\s+consentCache|let\s+consentCache|cachedConsent/.test(src),
    "poll-plan.js caches consent — a run that checked once would sail through a revocation",
  );
}

// ── 3. Never while an engagement run holds the tab ─────────────────────────

assert.deepStrictEqual(
  P.planPoll(ctx({ engagementInFlight: true })),
  { poll: [], blocked: "engagement_running", skipped: [] },
  "the poll ran while an engagement run held a tab — two automations on one closet is share jail",
);

// ── 4. The interval floor cannot be lowered ────────────────────────────────

{
  assert.strictEqual(P.normalizeIntervalMin(1), P.MIN_INTERVAL_MIN, "a 1-minute interval was accepted");
  assert.strictEqual(P.normalizeIntervalMin(0), P.DEFAULT_INTERVAL_MIN);
  assert.strictEqual(P.normalizeIntervalMin(-5), P.DEFAULT_INTERVAL_MIN);
  assert.strictEqual(P.normalizeIntervalMin("nonsense"), P.DEFAULT_INTERVAL_MIN);
  assert.strictEqual(P.normalizeIntervalMin(45), 45);
  // Raising it is always allowed; that is the seller being more cautious.
  assert.strictEqual(P.normalizeIntervalMin(120), 120);
  assert.strictEqual(P.normalizeIntervalMin(99999), P.MAX_INTERVAL_MIN);
  assert.ok(P.MIN_INTERVAL_MIN >= 30, "the interval floor dropped below 30 minutes");
  assert.ok(
    P.DEFAULT_INTERVAL_MIN >= 30 && P.DEFAULT_INTERVAL_MIN <= 60,
    "the default interval left the 30-60 minute band US-2701 specifies",
  );
}

// A channel polled recently is not due again.
{
  const recent = { enabled: true, lastPolledMs: NOW - 5 * 60 * 1000 };
  assert.strictEqual(P.channelDue(recent, NOW, 45).due, false);
  assert.strictEqual(P.channelDue(recent, NOW, 45).reason, "too_soon");

  const old = { enabled: true, lastPolledMs: NOW - 60 * 60 * 1000 };
  assert.strictEqual(P.channelDue(old, NOW, 45).due, true);
}

// ── 5. Not signed in backs OFF, it does not retry ──────────────────────────

{
  const next = P.applyPollResult({ enabled: true }, { signedIn: false }, NOW);
  assert.ok(next.backoffUntilMs > NOW, "a signed-out channel was not backed off");
  const hours = (next.backoffUntilMs - NOW) / 3_600_000;
  assert.ok(hours >= 1, `backoff is only ${hours}h — reopening a login wall hourly is the most automated-looking thing here`);

  // And it is genuinely skipped while the backoff stands.
  const verdict = P.channelDue(
    { enabled: true, lastPolledMs: 0, backoffUntilMs: NOW + 60_000 },
    NOW,
    45,
  );
  assert.strictEqual(verdict.due, false);
  assert.strictEqual(verdict.reason, "backoff");
}

// ── 6. A human check STOPS the channel; it is never retried around ─────────

{
  const next = P.applyPollResult({ enabled: true }, { humanCheck: true }, NOW);
  assert.strictEqual(next.stoppedForHumanCheck, true);

  // Stopped means stopped: no amount of elapsed time makes it due again.
  const farFuture = NOW + 365 * 24 * 3_600_000;
  const verdict = P.channelDue(
    { enabled: true, lastPolledMs: 0, stoppedForHumanCheck: true },
    farFuture,
    45,
  );
  assert.strictEqual(verdict.due, false);
  assert.strictEqual(
    verdict.reason,
    "human_check",
    "a channel stopped by a human check became due again on its own — GradeThread never answers one and never waits one out",
  );
}

// ── 7. Off switches actually switch it off ─────────────────────────────────

assert.strictEqual(P.planPoll(ctx({ settings: { enabled: false } })).blocked, "disabled");
assert.strictEqual(
  P.channelDue({ enabled: false, lastPolledMs: 0 }, NOW, 45).reason,
  "off",
);

// ── 8. One channel per tick, and refusals carry a reason ───────────────────

{
  const plan = P.planPoll(
    ctx({
      channels: {
        poshmark: { enabled: true, lastPolledMs: 0 },
        mercari: { enabled: true, lastPolledMs: 0 },
      },
    }),
  );
  assert.strictEqual(plan.poll.length, 1, "the poll opened more than one background tab in a tick");

  const offPlan = P.planPoll(
    ctx({
      channels: {
        poshmark: { enabled: false },
        mercari: { enabled: true, lastPolledMs: NOW - 60 * 60 * 1000 },
      },
    }),
  );
  assert.deepStrictEqual(offPlan.poll, ["mercari"]);
  assert.deepStrictEqual(
    offPlan.skipped.find((s) => s.platform === "poshmark"),
    { platform: "poshmark", reason: "off" },
    "a skipped channel must carry WHY, so the popup can say it rather than shrug",
  );
}

// ── 9. The decider stays free of the browser ───────────────────────────────
//
// If this file could open a tab it would be in sync/, which test/
// sync-manifest.test.cjs holds to passivity. Keeping the decisions pure is what
// lets the poll exist without eroding that promise.
{
  const src = fs.readFileSync(path.join(dir, "sync/poll-plan.js"), "utf8");
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
  for (const banned of ["chrome.", "browser.", "document", "fetch(", "Date.now("]) {
    assert.ok(
      !code.includes(banned),
      `sync/poll-plan.js references ${banned}. It decides; background.js acts.`,
    );
  }
}

// ── 10. The polled URL always comes from the config ────────────────────────
//
// The single most important rule in the driver, and the one an attacker would
// aim at: if a message could name the URL, a compromised page could point the
// poll anywhere and the extension would open it with the seller's cookies.
// pollUrlFor has no parameter for one, and re-validates the config value anyway.

{
  const SEL = load("sync/selectors.js", "GT_SYNC_SELECTORS");

  for (const platform of Object.keys(SEL)) {
    const url = P.pollUrlFor(SEL, platform);
    assert.ok(url, `${platform} has no usable pollUrl`);
    assert.ok(url.startsWith("https://"), `${platform} pollUrl is not https`);
    // It must be a page the adapter has selectors for.
    assert.ok(
      new RegExp(SEL[platform].sold.urlPattern, "i").test(url),
      `${platform} pollUrl does not match its own sold urlPattern`,
    );
  }

  assert.strictEqual(P.pollUrlFor(SEL, "nope"), null, "an unknown platform resolved a URL");
  assert.strictEqual(P.pollUrlFor(null, "poshmark"), null);

  // A config edit pointing somewhere else resolves to NULL rather than opening.
  const offDomain = JSON.parse(JSON.stringify(SEL));
  offDomain.poshmark.sold.pollUrl = "https://evil.example.com/order/sales";
  assert.strictEqual(
    P.pollUrlFor(offDomain, "poshmark"),
    null,
    "a pollUrl on a domain the adapter does not declare was accepted",
  );

  const httpOnly = JSON.parse(JSON.stringify(SEL));
  httpOnly.poshmark.sold.pollUrl = "http://poshmark.com/order/sales";
  assert.strictEqual(P.pollUrlFor(httpOnly, "poshmark"), null, "a non-https pollUrl was accepted");

  // A lookalike host must not pass the suffix check.
  const lookalike = JSON.parse(JSON.stringify(SEL));
  lookalike.poshmark.sold.pollUrl = "https://notposhmark.com/order/sales";
  assert.strictEqual(
    P.pollUrlFor(lookalike, "poshmark"),
    null,
    "a lookalike host passed the suffix check",
  );

  // Right host, wrong page: the adapter has no selectors for it, so refusing is
  // the difference between a poll and a crawl.
  const wrongPage = JSON.parse(JSON.stringify(SEL));
  wrongPage.poshmark.sold.pollUrl = "https://poshmark.com/feed";
  assert.strictEqual(
    P.pollUrlFor(wrongPage, "poshmark"),
    null,
    "a pollUrl aimed at a page the adapter cannot read was accepted",
  );
}

// And the function must not accept a URL as an argument at all.
{
  const src = fs.readFileSync(path.join(dir, "sync/poll-plan.js"), "utf8");
  const sig = src.match(/function pollUrlFor\(([^)]*)\)/);
  assert.ok(sig, "pollUrlFor not found");
  const params = sig[1].split(",").map((x) => x.trim()).filter(Boolean);
  assert.deepStrictEqual(
    params,
    ["selectors", "platform"],
    "pollUrlFor takes a parameter beyond (selectors, platform) — a URL must never be passed in",
  );
}

console.log(
  "sync-poll.test.cjs: consent is versioned and re-checked, the interval floor holds, " +
    "engagement blocks the poll, signed-out backs off, a human check stops the channel, " +
    "and the polled URL can only ever come from the bundled config",
);
