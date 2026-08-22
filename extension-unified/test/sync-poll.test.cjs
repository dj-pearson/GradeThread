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

function readSrc(rel) {
  return fs.readFileSync(path.join(dir, rel), "utf8");
}
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
    // Normalise CRLF first, the same way sync-manifest and sync-observe already
    // do. This copy was the one that missed it. In JS a `.` never matches `\r`
    // — it is a line terminator — so on a CRLF checkout `//.*$` stops short of
    // the line end and matches nothing, and every line comment survives the
    // strip. poll-plan.js's own header says "with no chrome.*", so the guard
    // failed on its own documentation: green on Linux CI, red on a Windows dev
    // box, which is the worst place for a difference to live.
    .replace(/\r\n/g, "\n")
    .replace(/\r\n?/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "")
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

// ── 11. The DRIVER, which is the half that can actually do damage ──────────
//
// background.js opens the tab. These are source guards rather than behaviour
// tests because the alternative is a browser, and the properties worth pinning
// are structural: what it opens, how, and what it checks first.

{
  const bg = readSrc("background.js");

  // Scope every check below to the poll's own function body. The first version
  // matched `tabs.create({ url: url, ... })` across the whole file and failed on
  // the LISTER's create, which focuses its tab deliberately: the seller asked
  // for it and has to finish the form in it. Two features with opposite correct
  // answers, so a file-wide guard was asserting the wrong rule on both.
  const tick = bg.slice(
    bg.indexOf("async function runSyncPollTick"),
    bg.indexOf("async function reapSyncPollTab"),
  );
  assert.ok(tick.length > 200, "could not isolate runSyncPollTick");

  // The tab is opened UNFOCUSED. A poll that stole focus while the seller was
  // typing would be uninstalled within a day, whatever it did for them.
  const pollCreate = tick.match(/tabs\.create\(\{[^}]*\}\)/g) || [];
  assert.ok(pollCreate.length >= 1, "the poll driver no longer opens a tab");
  for (const c of pollCreate) {
    assert.ok(
      /active:\s*false/.test(c),
      `the poll opens a FOCUSED tab: ${c}`,
    );
  }

  // The URL comes from pollUrlFor and nowhere else.
  assert.ok(
    /const url = PLAN\.pollUrlFor\(SELECTORS, platform\)/.test(bg),
    "the poll driver no longer resolves its URL through pollUrlFor",
  );
  // Scoped to `tick`, not the file: `if (!url) return;` appears in other
  // handlers too, so a file-wide match stayed green while the poll's own bail
  // was deleted.
  assert.ok(
    /if \(!url\) return;/.test(tick),
    "the poll driver does not bail when pollUrlFor refuses",
  );
  // And it must not build one from a message.
  assert.ok(
    !/msg\b/.test(tick),
    "runSyncPollTick references a message. The polled URL and platform must come " +
      "from the bundled config, never from something a page could send.",
  );

  // It asks the planner rather than deciding for itself.
  assert.ok(/PLAN\.planPoll\(/.test(bg), "the driver no longer consults planPoll");
  assert.ok(
    /if \(!plan\.poll\.length\) return;/.test(bg),
    "the driver does not honour an empty plan",
  );
  assert.ok(
    /await sellerAllowed\(\)/.test(tick),
    "the poll runs without re-checking the seller entitlement",
  );

  // An alarm, not a timer: a service worker is torn down and setTimeout dies
  // with it, which would make the poll work only while something else kept the
  // worker alive.
  assert.ok(/alarms\.create\(SYNC_POLL_ALARM/.test(bg), "the poll has no alarm");
  assert.ok(
    !/setInterval\s*\(/.test(bg.slice(bg.indexOf("SYNC_POLL_ALARM"))),
    "the poll driver uses setInterval, which dies with the service worker",
  );

  // Engagement liveness FAILS CLOSED.
  const eng = bg.slice(bg.indexOf("async function engagementInFlight"), bg.indexOf("async function runSyncPollTick"));
  assert.ok(
    /catch \(_e\) \{[\s\S]*return true;/.test(eng),
    "engagementInFlight fails OPEN. If we cannot tell whether a share run is " +
      "live, polling anyway risks two automations on one closet, which is what " +
      "costs a seller their account; a skipped poll costs them forty minutes.",
  );

  // A polled tab is always cleaned up, even if it never reports.
  //
  // The name is matched with a boundary, not as a substring: renaming the
  // constant to SYNC_POLL_TAB_TTL_MSX left the old check green, because one
  // contains the other. And naming a constant proves nothing on its own, so the
  // reaper is asserted to actually COMPARE against it and then close the tab.
  const reap = bg.slice(
    bg.indexOf("async function reapSyncPollTab"),
    bg.indexOf("async function notePollResult"),
  );
  assert.ok(reap.length > 100, "could not isolate reapSyncPollTab");
  assert.ok(
    /\bSYNC_POLL_TAB_TTL_MS\b/.test(bg),
    "a polled tab has no time-to-live constant",
  );
  assert.ok(
    /<\s*SYNC_POLL_TAB_TTL_MS\b/.test(reap),
    "the reaper never compares a tab's age against the time-to-live, so a tab " +
      "that never reports is left open on the seller's marketplace forever",
  );
  assert.ok(/tabs\.remove\(/.test(reap), "the reaper never closes the tab");
  assert.ok(
    /tabs\.remove\(/.test(bg.slice(bg.indexOf("async function notePollResult"))),
    "a reporting poll never closes its own tab",
  );
}

// ── 12. The consent UI cannot quietly degrade ──────────────────────────────
//
// A clickwrap is only worth the sentences the seller actually saw. Three ways
// that decays, all guarded here: the terms getting copied into markup where one
// can go missing, the switch appearing before the sentences, and revoking
// leaving a stale acceptance on disk so flipping it back on never re-asks.

{
  const html = readSrc("popup.html");
  const js = readSrc("popup.js");
  const bg = readSrc("background.js");

  // The markup holds a LIST to render into, not the sentences themselves.
  assert.ok(/id="pollTerms"/.test(html), "popup.html has no poll terms list");
  for (const term of P.CLICKWRAP_TERMS) {
    const fragment = term.slice(0, 40);
    assert.ok(
      !html.includes(fragment),
      `popup.html hard-codes a clickwrap sentence ("${fragment}..."). The terms must ` +
        `render from sync/poll-plan.js, or one copy loses a sentence and nothing notices.`,
    );
  }
  // Scoped to renderPollConsent. The ENGAGEMENT renderer also iterates
  // state.terms, so a file-wide check stayed green while the poll's own loop was
  // emptied — the same read-more-of-the-file-than-you-meant mistake as the
  // cadence scrape above.
  const renderPoll = js.slice(
    js.indexOf("async function renderPollConsent"),
    js.indexOf("async function renderSyncStatus"),
  );
  assert.ok(renderPoll.length > 200, "could not isolate renderPollConsent");
  assert.ok(
    /for \(const term of state\.terms/.test(renderPoll),
    "renderPollConsent no longer renders the poll terms from the background's copy",
  );
  assert.ok(
    /terms\.appendChild/.test(renderPoll),
    "renderPollConsent builds no term elements, so the seller sees an empty clickwrap",
  );

  // Accept is disabled until the box is ticked.
  assert.ok(
    /id="pollAccept"[^>]*disabled/.test(html),
    "the poll Accept button does not start disabled",
  );
  assert.ok(
    /_pollAccept\.disabled = !_pollCheck\.checked/.test(js),
    "ticking the box no longer gates the poll Accept button",
  );

  // The cadence control exists only after acceptance, so the first thing a
  // seller meets is the sentences and never the switch.
  assert.ok(/id="pollControls" hidden/.test(html), "the poll controls do not start hidden");
  assert.ok(
    /controls\.hidden = true;/.test(js) && /consent\.hidden = false;/.test(js),
    "popup.js does not hide the cadence control while consent is outstanding",
  );

  // Revoking clears the ACCEPTANCE, not just the switch.
  const revoke = bg.slice(
    bg.indexOf("async function revokePollClickwrap"),
    bg.indexOf("async function setPollInterval"),
  );
  assert.ok(revoke.length > 60, "could not isolate revokePollClickwrap");
  assert.ok(
    /remove\("syncPollClickwrap"\)/.test(revoke),
    "revoking leaves the acceptance on disk, so switching the poll back on would " +
      "never re-ask — and the seller who turned it off did so about the thing they agreed to",
  );

  // The cadences the popup offers must all be values the planner accepts.
  //
  // Scoped to the poll's own <select>. A file-wide scrape picked up the
  // engagement runner's 1400ms pacing option and asserted the planner should
  // accept a 1400-MINUTE cadence — the third guard in this feature to fail by
  // reading more of a file than it was about.
  const selectStart = html.indexOf('<select id="pollInterval">');
  assert.ok(selectStart !== -1, "popup.html has no poll cadence control");
  const selectHtml = html.slice(selectStart, html.indexOf("</select>", selectStart));
  const pollOptions = [...selectHtml.matchAll(/<option value="(\d+)">/g)].map((m) => Number(m[1]));
  assert.ok(pollOptions.length >= 3, "the poll cadence control offers fewer than three choices");
  for (const n of pollOptions) {
    assert.strictEqual(
      P.normalizeIntervalMin(n),
      n,
      `the popup offers a ${n}-minute cadence the planner would clamp — the seller ` +
        `would pick one thing and get another`,
    );
  }
}

// ── 13. A web page can turn the poll OFF, and can never turn it ON ─────────
//
// The clickwrap's guarantee is that the sentences the seller accepted came from
// the extension's own copy. A page able to grant that consent would be granting
// it to terms the page itself rendered, which is the substitution the one-copy
// rule exists to prevent. Off and slower need no such care: both are strictly
// safer than the state they replace.

{
  const bg = readSrc("background.js");
  const externalBlock = bg.slice(
    bg.indexOf("const EXTERNAL_TYPES = new Set(["),
    bg.indexOf("function handleExternalMessage"),
  );
  assert.ok(externalBlock.length > 100, "could not isolate EXTERNAL_TYPES");

  for (const allowed of ["GT_WEB_POLL_STATE", "GT_WEB_POLL_REVOKE", "GT_WEB_POLL_INTERVAL"]) {
    assert.ok(
      externalBlock.includes(`"${allowed}"`),
      `${allowed} is not externally reachable, so the Marketplaces page cannot show or stop the poll`,
    );
  }
  for (const forbidden of ["GT_POLL_ACCEPT", "GT_WEB_POLL_ACCEPT"]) {
    assert.ok(
      !externalBlock.includes(`"${forbidden}"`),
      `${forbidden} is externally reachable. A web page must never be able to ` +
        `accept the poll clickwrap — it would be consenting to terms it rendered itself.`,
    );
  }

  // And the popup's own message names must NOT be in the external set, or the
  // origin check would reject the popup: its origin is chrome-extension://,
  // not gradethread.com. This bit me while writing it.
  for (const internal of ["GT_POLL_STATE", "GT_POLL_REVOKE", "GT_POLL_INTERVAL"]) {
    assert.ok(
      !new RegExp(`"${internal}"`).test(externalBlock),
      `${internal} is in EXTERNAL_TYPES, which routes it through the ` +
        `gradethread.com origin check and rejects the popup's own calls.`,
    );
  }

  // The external handler must never call the accept function.
  const extHandler = bg.slice(
    bg.indexOf("function handleExternalMessage"),
    bg.indexOf("if (ext.runtime.onMessageExternal)"),
  );
  assert.ok(extHandler.length > 200, "could not isolate handleExternalMessage");
  assert.ok(
    !/acceptPollClickwrap/.test(extHandler),
    "handleExternalMessage can accept the poll clickwrap on a web page's say-so",
  );
  // It must still verify the origin before doing any of it.
  assert.ok(
    /isOriginAllowed\(sender\)/.test(extHandler),
    "handleExternalMessage no longer checks the sender origin",
  );
}

console.log(
  "sync-poll.test.cjs: consent is versioned and re-checked, the interval floor holds, " +
    "engagement blocks the poll, signed-out backs off, a human check stops the channel, " +
    "the polled URL can only ever come from the bundled config, and the driver " +
    "opens an unfocused tab on an alarm and fails closed on engagement, and the " +
    "consent UI renders its terms from one place and cannot precede them with a switch",
);
