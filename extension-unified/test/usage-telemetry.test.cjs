// GradeThread unified extension — opt-in usage telemetry (US-1757 AC2).
//
// WHAT THIS GUARDS.
//
// A telemetry module is the easiest thing in a codebase to make quietly
// dishonest: the toggle still says "anonymous", the privacy policy still says
// "no identifier", and a field added six months later makes both untrue with
// nothing failing. So this file asserts the PROMISES, not just the plumbing:
//
//   1. the vocabulary is CLOSED — no call site can invent a counter;
//   2. the payload carries totals and NOTHING ELSE — no timestamp, no id, no
//      URL, no free text beyond a charset-capped version string;
//   3. counters saturate, so a runaway loop can't restore the resolution the
//      batching was there to remove;
//   4. a click on somebody else's link is never counted;
//   5. the consent key is SEPARATE from selectorTelemetry, and the popup deletes
//      the open batch on revoke.
//
// (5) is the one worth stating aloud. The two toggles could trivially be merged,
// and merging them would silently widen a consent people already gave for a
// narrower thing. This test is what makes that a decision someone has to change
// on purpose.
//
// Zero-dependency node script: throws on drift.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");

// package.json is `"type": "module"`, so require() of a shipped .js hands back an
// EMPTY namespace — load it the way the browser does, as a classic script.
function loadIntoSelf(rel) {
  const selfObj = {};
  const src = fs.readFileSync(path.join(dir, rel), "utf8");
   
  new Function("self", "module", src)(selfObj, { exports: {} });
  return selfObj;
}

const USAGE = loadIntoSelf("usage-telemetry.js").GT_USAGE;
assert.ok(USAGE, "usage-telemetry.js must publish self.GT_USAGE");
const ATTR = loadIntoSelf("attribution.js").GT_ATTRIBUTION;
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));

// ── 1. the vocabulary is closed ────────────────────────────────────────────
assert.deepStrictEqual(USAGE.EVENTS, ["read", "click_through"], "the event vocabulary is the AC");
assert.deepStrictEqual(USAGE.SURFACES, ["popup", "overlay", "flip", "onboarding"]);

assert.strictEqual(USAGE.counterKey("read"), "read");
assert.strictEqual(USAGE.counterKey("click_through", "overlay"), "click_through:overlay");
// An unknown EVENT is dropped outright — a typo must not mint a counter.
assert.strictEqual(USAGE.counterKey("browsed", "overlay"), "");
// An unknown SURFACE on a known event degrades to the bare event rather than
// being dropped: the read still happened, and losing it would undercount the
// funnel to protect a field that carries no information anyway.
assert.strictEqual(USAGE.counterKey("read", "nope"), "read");

// record() honours the same rule, and never mutates its input.
{
  const start = USAGE.emptyBatch(1000);
  const one = USAGE.record(start, "read", null, 1000);
  assert.deepStrictEqual(start.counts, {}, "record() must not mutate the batch it was given");
  assert.deepStrictEqual(one.counts, { read: 1 });
  const two = USAGE.record(one, "read", null, 1000);
  assert.deepStrictEqual(two.counts, { read: 2 });
  const junk = USAGE.record(two, "exfiltrate", "everything", 1000);
  assert.deepStrictEqual(junk.counts, { read: 2 }, "an unknown event must add no counter at all");
}

// ── 2. the payload is totals and nothing else ──────────────────────────────
{
  const batch = USAGE.record(
    USAGE.record(USAGE.emptyBatch(1000), "read", null, 1000),
    "click_through",
    "popup",
    2000,
  );
  const body = USAGE.payloadFor(batch, "0.8.0", 9999);
  assert.deepStrictEqual(
    Object.keys(body).sort(),
    ["counts", "extVersion"],
    "the wire body must carry ONLY counts + extVersion. Anything else — a " +
      "timestamp, a window length, an install id, a locale — is a field that " +
      "narrows an anonymous tally toward one person, and the whole shape of this " +
      "module (tally on device, send totals hours later) exists to prevent that.",
  );
  assert.deepStrictEqual(body.counts, { read: 1, "click_through:popup": 1 });
  assert.strictEqual(body.extVersion, "0.8.0");

  // startedAt is bookkeeping for the flush schedule and must stay on the device.
  const serialized = JSON.stringify(body);
  assert.ok(!/startedAt/.test(serialized), "startedAt must never reach the wire");
  assert.ok(!/\b1000\b|\b2000\b|\b9999\b/.test(serialized), "no timestamp may reach the wire");
}

// A version string is the only free-ish text, so it is charset-capped. Anything
// else — a URL, an id, an over-long string — becomes null rather than travelling.
for (const bad of [
  "https://evil.test/?id=abc",
  "x".repeat(33),
  "0.8.0 (install 7f3c-aa12)",
  "",
  null,
  42,
]) {
  const body = USAGE.payloadFor(USAGE.record(USAGE.emptyBatch(0), "read", null, 0), bad, 0);
  assert.strictEqual(
    body.extVersion,
    null,
    `extVersion must reject ${JSON.stringify(bad)} — it is the only free-ish field ` +
      "on the wire and therefore the only place an identifier could ride along",
  );
}

// An EMPTY batch produces no payload and never flushes. A send that carries
// nothing still says "this install exists and ran today" — a heartbeat, which is
// not what anyone consented to.
assert.strictEqual(USAGE.payloadFor(USAGE.emptyBatch(0), "0.8.0", 0), null);
assert.strictEqual(USAGE.shouldFlush(USAGE.emptyBatch(0), USAGE.FLUSH_AFTER_MS * 10), false);

// ── 3. counters saturate ───────────────────────────────────────────────────
{
  let batch = USAGE.emptyBatch(0);
  for (let i = 0; i < USAGE.MAX_COUNT + 25; i++) batch = USAGE.record(batch, "read", null, 0);
  assert.strictEqual(
    batch.counts.read,
    USAGE.MAX_COUNT,
    "counters must saturate — an unbounded tally is a high-resolution signal, " +
      "which is the resolution the hours-long batching window exists to remove",
  );
}

// The flush bounds. Both matter: the interval is what strips timing out of the
// payload, and the count cap keeps a heavy day from sitting unsent forever.
{
  const one = USAGE.record(USAGE.emptyBatch(0), "read", null, 0);
  assert.strictEqual(USAGE.shouldFlush(one, USAGE.FLUSH_AFTER_MS - 1), false);
  assert.strictEqual(USAGE.shouldFlush(one, USAGE.FLUSH_AFTER_MS), true);
  assert.ok(USAGE.FLUSH_AFTER_MS >= 60 * 60 * 1000, "the window must be hours, not minutes");

  let many = USAGE.emptyBatch(0);
  for (let i = 0; i < USAGE.FLUSH_AT_COUNT; i++) many = USAGE.record(many, "read", null, 0);
  assert.strictEqual(USAGE.shouldFlush(many, 1), true, "the count cap must flush early");
}

// A batch left by an older build must degrade to "start over", not throw inside a
// path a shopper's read runs through — and must not forward a counter this build
// no longer knows how to name.
{
  const stale = { startedAt: "nope", counts: { read: 3, legacy_event: 9, "read:popup:x": 4 } };
  const fixed = USAGE.normalizeBatch(stale, 500);
  assert.deepStrictEqual(fixed.counts, { read: 3 });
  assert.strictEqual(fixed.startedAt, 500);
  for (const junk of [null, undefined, 7, "batch", { counts: null }, []]) {
    assert.deepStrictEqual(USAGE.normalizeBatch(junk, 1).counts, {});
  }
}

// The structural bound on a batch: one key per event × surface, plus the bare
// form. Widening the vocabulary must be a visible decision, not a payload that
// quietly grows.
assert.strictEqual(USAGE.MAX_KEYS, 2 * (4 + 1));

// ── 4. somebody else's link is never counted ───────────────────────────────
{
  const isSite = ATTR.isSiteUrl;
  // Ours, tagged by attribution.js: the surface is READ OFF THE LINK, so the
  // click and the signup it produces are filed under the same word.
  assert.strictEqual(
    USAGE.clickSurface(ATTR.siteUrl("/pricing", "overlay"), "popup", isSite),
    "overlay",
  );
  // Ours, but with a medium outside the surface vocabulary — fall back rather
  // than invent.
  assert.strictEqual(
    USAGE.clickSurface("https://gradethread.com/x?utm_medium=carrier-pigeon", "popup", isSite),
    "popup",
  );
  // NOT ours. null means "do not count": the overlay renders marketplace links
  // through the same DOM, and counting one would make this a record of outbound
  // browsing — the exact thing the privacy copy rules out.
  for (const foreign of [
    "https://www.ebay.com/itm/123",
    "https://gradethread.com.evil.test/x",
    "http://gradethread.com/x",
    "javascript:alert(1)",
    "",
  ]) {
    assert.strictEqual(
      USAGE.clickSurface(foreign, "overlay", isSite),
      null,
      `clickSurface must refuse to count ${JSON.stringify(foreign)}`,
    );
  }
}

// The delegated listener: one wiring, catches a link added later, and reports the
// link's own surface. Modelled on the DOM contract it actually uses.
{
  const sent = [];
  const listeners = [];
  const anchor = {
    href: ATTR.siteUrl("/pricing", "flip"),
    closest: (sel) => (sel === "a[href]" ? anchor : null),
  };
  const root = {
    addEventListener: (t, fn) => listeners.push([t, fn]),
    removeEventListener: (t, fn) => {
      const i = listeners.findIndex((l) => l[0] === t && l[1] === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  const detach = USAGE.trackSiteClicks(root, "overlay", {
    isSiteUrl: ATTR.isSiteUrl,
    send: (event, surface) => sent.push([event, surface]),
  });
  assert.strictEqual(listeners.length, 1, "exactly ONE delegated listener, not one per anchor");
  listeners[0][1]({ target: anchor });
  assert.deepStrictEqual(sent, [["click_through", "flip"]]);

  // A click on nothing clickable, and a send that throws, must both be silent —
  // a counter may never break a navigation.
  listeners[0][1]({ target: { closest: () => null } });
  assert.strictEqual(sent.length, 1);
  const boom = USAGE.trackSiteClicks(root, "popup", {
    isSiteUrl: ATTR.isSiteUrl,
    send: () => { throw new Error("network down"); },
  });
  listeners[1][1]({ target: anchor });
  boom();
  detach();
  assert.strictEqual(listeners.length, 0, "detach must remove the listener it added");

  // A root that isn't one degrades to a no-op instead of throwing at load.
  assert.strictEqual(typeof USAGE.trackSiteClicks(null, "popup", {}), "function");
}

// ── 5. consent: separate key, off by default, revoke deletes the batch ─────
assert.strictEqual(USAGE.CONSENT_KEY, "usageTelemetry");
assert.notStrictEqual(
  USAGE.CONSENT_KEY,
  "selectorTelemetry",
  "usage counts must NOT ride the selector-health consent. That toggle's copy " +
    "promises it sends 'only the marketplace name and which part failed'; folding " +
    "usage under it retroactively widens a consent people already gave for " +
    "something narrower. Two toggles is the price of that copy staying true.",
);

const popupHtml = fs.readFileSync(path.join(dir, "popup.html"), "utf8");
const popupJs = fs.readFileSync(path.join(dir, "popup.js"), "utf8");

assert.ok(
  /id="usageTelemetry"/.test(popupHtml),
  "popup.html must carry the usage-telemetry checkbox — AC2 requires a CLEAR TOGGLE, " +
    "and telemetry with no visible switch is not opt-in however the code is written",
);
// The copy has to name what is sent. A vague "help us improve" prompt is how a
// telemetry toggle becomes a thing people feel tricked by later.
for (const phrase of ["condition reads", "gradethread.com", "Off by default"]) {
  assert.ok(
    popupHtml.includes(phrase),
    `the usage toggle's copy must say "${phrase}" — it is what makes the consent informed`,
  );
}
assert.ok(
  /never when/i.test(popupHtml),
  "the copy must say the timing is not sent — that is the specific promise the " +
    "tally-and-batch design makes, and the one a reader cannot verify themselves",
);

// Default OFF: the box is only checked when the key is explicitly present, and
// unchecking REMOVES the key rather than storing false, so a revoke leaves
// nothing behind to be misread.
assert.ok(
  /usageEl\.checked = Boolean\(/.test(popupJs),
  "the toggle must read as OFF unless the consent key is truthy (absent ⇒ off)",
);
assert.ok(
  /storage\.local\.remove\(\[USAGE\.CONSENT_KEY, USAGE\.BATCH_KEY\]\)/.test(popupJs),
  "revoking consent must delete the OPEN BATCH as well as the key. Leaving a " +
    "half-finished tally on disk lets a later opt-in send activity from the very " +
    "period the user said no to — an off switch that is still dishonest.",
);

// ── 6. the module reaches every world that produces an event ───────────────
//
// usage-telemetry.js is a classic script, so it exists only where it is loaded.
// Miss one and self.GT_USAGE is undefined at the call site — a TypeError that
// takes the whole popup or overlay down, not a missing counter.
const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8");
const importScriptsCall = /importScripts\(([^)]*)\)/s.exec(bg);
assert.ok(
  importScriptsCall && /"usage-telemetry\.js"/.test(importScriptsCall[1]),
  "background.js must importScripts usage-telemetry.js (the Chrome service-worker path)",
);
assert.ok(
  (manifest.background.scripts || []).includes("usage-telemetry.js"),
  "manifest background.scripts must list usage-telemetry.js — Firefox has no importScripts",
);

const research = (manifest.content_scripts || []).find(
  (c) => Array.isArray(c.js) && c.js.includes("research/marketplace.js"),
);
assert.ok(
  research.js.indexOf("usage-telemetry.js") >= 0 &&
    research.js.indexOf("usage-telemetry.js") < research.js.indexOf("research/marketplace.js"),
  "usage-telemetry.js must load BEFORE research/marketplace.js in the content script — " +
    "marketplace.js reads self.GT_USAGE, and a classic script that runs later is too late",
);
for (const page of ["popup.html", "onboarding.html"]) {
  const html = fs.readFileSync(path.join(dir, page), "utf8");
  assert.ok(
    /<script src="usage-telemetry\.js"><\/script>/.test(html),
    `${page} counts click-throughs, so it must load usage-telemetry.js`,
  );
}

// ── 7. consent is checked on the SEND path, every time ─────────────────────
//
// The one structural promise the popup cannot make on its own. If the worker
// cached the answer, revoking would take effect at the next service-worker
// restart rather than at the next event — an off switch with a delay nobody
// documents. The counter must also be gated at the SAME chokepoint the read
// already goes through, so a new read surface can't bypass it.
assert.ok(
  /async function usageTelemetryEnabled\(\)[\s\S]{0,400}storage\.local\.get\(self\.GT_USAGE\.CONSENT_KEY\)/
    .test(bg),
  "background.js must re-read the consent key from storage on every send, not cache it",
);
assert.ok(
  /if \(!\(await usageTelemetryEnabled\(\)\)\)[\s\S]{0,400}storage\.local\.remove\(KEY\)/.test(bg),
  "recordUsage must DROP the open batch when consent is off — the worker's half of " +
    "the same promise the popup's revoke makes",
);
assert.ok(
  /case "GT_CC_SAVE_READ":[\s\S]{0,600}recordUsage\("read"\)/.test(bg),
  'the read counter must hang off GT_CC_SAVE_READ — the one message every completed ' +
    "read already goes through. A separate call site drifts the moment a new read " +
    "surface is added.",
);
assert.ok(
  /case "GT_CC_USAGE":[\s\S]{0,400}recordUsage\(msg\.event, msg\.surface\)/.test(bg),
  "background.js must route GT_CC_USAGE into recordUsage (which validates the " +
    "vocabulary, so a message cannot invent a counter)",
);
// No instance id on this request. It is the per-install quota key, and attaching
// it would make an otherwise anonymous tally linkable — the exact line
// selector-health draws, drawn again here because the next reader will be
// tempted for exactly the same reason (it is right there).
const usageBlock = /async function flushUsage\([\s\S]*?\n}/.exec(bg);
assert.ok(usageBlock, "flushUsage must exist in background.js");
assert.ok(
  !/instanceId/.test(usageBlock[0]),
  "flushUsage must NOT attach the per-install instance id — it is a stable " +
    "identifier, and one header turns a tally into a per-person usage record",
);

console.log(
  `usage-telemetry.test.cjs: vocabulary closed (${USAGE.EVENTS.length} events × ` +
    `${USAGE.SURFACES.length} surfaces), payload is totals only, counters saturate at ` +
    `${USAGE.MAX_COUNT}, consent separate from selectorTelemetry and re-read per send`,
);
