// GradeThread unified extension — the push wake (US-3142).
//
// Zero-dependency node script: throws on drift.
//
// The wake makes a sale reach the browser in seconds instead of within five
// minutes. Everything it touches is a place where being slightly wrong is
// invisible, so each block below pins one property that has a specific, quiet
// failure behind it:
//
//   1. The permission is OPTIONAL. In `permissions` it would show an install
//      warning and disable the extension for every existing user until they
//      re-approved — for a feature whose whole benefit is "sooner".
//   2. The push handler acts on ONE payload type and takes nothing else from
//      it. The endpoint is a bearer capability: whoever holds it can send this
//      worker anything, and the only safe answer is to treat a push as a
//      doorbell and re-read our own queue.
//   3. It goes through drainQueue(), so the seller gate, the terms gate and the
//      re-entrancy guard all still apply. A wake is a trigger, not a bypass.
//   4. The alarm survives. Firefox has no Push API for a WebExtension
//      background at all, and a Chrome seller can decline the permission — for
//      both of them the alarm IS the feature.
//   5. Subscribing is re-run at startup. A push service may rotate an endpoint
//      while the browser is closed, and a dead endpoint fails silently forever.
//   6. Nothing here shows a notification. The permission is a gate on
//      pushManager, not a licence to interrupt (see sourcing-adapters.test.cjs,
//      which enforces that across every shipped file).

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");
const BG = fs.readFileSync(path.join(dir, "background.js"), "utf8");
const POPUP_JS = fs.readFileSync(path.join(dir, "popup.js"), "utf8");
const POPUP_HTML = fs.readFileSync(path.join(dir, "popup.html"), "utf8");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));

function at(hay, needle, what) {
  const i = hay.indexOf(needle);
  assert.ok(i > -1, `could not find ${what}`);
  return i;
}

// ── 1. The permission is optional, and only that one ───────────────────────
{
  assert.deepStrictEqual(
    MANIFEST.optional_permissions,
    ["notifications"],
    "optional_permissions must be exactly ['notifications'] — anything else " +
      "here is a permission nobody reviewed",
  );
  assert.ok(
    !MANIFEST.permissions.includes("notifications"),
    "notifications moved into `permissions`. That shows an install warning and " +
      "DISABLES the extension for every existing user until they re-approve it, " +
      "which is not a price a 5-minute speed-up gets to charge.",
  );
}

// ── 2. The push handler takes one type and nothing else ────────────────────
{
  const start = at(BG, 'self.addEventListener("push"', "the push listener");
  const body = BG.slice(start, BG.indexOf("\n  });", start));

  assert.ok(
    /PUSH_WAKE_TYPE/.test(body) && /if \(type !== PUSH_WAKE_TYPE\) return;/.test(body),
    "the push handler no longer refuses payloads that are not the wake type",
  );
  assert.match(
    BG,
    /const PUSH_WAKE_TYPE = "gt-drain";/,
    "the wake type changed or vanished — it must match EXTENSION_WAKE_PAYLOAD " +
      "in the edge's lib/notify.ts",
  );

  // Everything read off the push, which must be the type and only the type.
  const reads = body.match(/\.json\(\)\.[A-Za-z_$][\w$]*/g) || [];
  assert.deepStrictEqual(
    reads,
    [".json().type"],
    "the push handler reads " + reads.join(", ") + " from the payload. A push " +
      "endpoint is a bearer capability: it must carry a signal, never an " +
      "instruction, a listing or a URL.",
  );

  // A body that is absent or is not our JSON must not throw the handler.
  assert.ok(/try \{/.test(body) && /catch \(_e\)/.test(body), "the payload read is not guarded");

  // The drain outlives the event: it awaits a claim and opens tabs.
  assert.ok(
    /event\.waitUntil\(drainQueue\(\)\)/.test(body),
    "the drain is not held open with waitUntil, so Chrome may suspend the " +
      "worker halfway through it",
  );
}

// ── 3. It goes through drainQueue, gates and all ───────────────────────────
{
  const start = at(BG, 'self.addEventListener("push"', "the push listener");
  const body = BG.slice(start, BG.indexOf("\n  });", start));
  for (const f of ["startJob(", "tabs.create(", '"/claim"']) {
    assert.ok(
      !body.includes(f),
      `the push handler calls ${f} directly instead of going through drainQueue()`,
    );
  }
  // And drainQueue still owns the gates (drain-nudge.test.cjs asserts the
  // ordering in detail; this is the wake's own stake in it).
  assert.ok(
    /if \(!\(await sellerAllowed\(\)\)\) return "not-allowed";/.test(BG) &&
      /if \(!\(await tosAccepted\(\)\)\) return "needs-consent";/.test(BG),
    "drainQueue lost a gate, so a push now runs cross-listing automation for " +
      "an account that never accepted the terms",
  );
}

// ── 4. The alarm survives ──────────────────────────────────────────────────
{
  assert.ok(
    /alarms\.create\(SWEEP_ALARM, \{ periodInMinutes: 5 \}\)/.test(BG),
    "the 5-minute sweep is gone. Firefox has no Push API for an extension " +
      "background and a Chrome seller may decline the permission — for both of " +
      "them the alarm is the entire feature.",
  );
  const sweep = BG.slice(at(BG, "if (name === SWEEP_ALARM) {", "the sweep branch"));
  assert.ok(
    /void drainQueue\(\);/.test(sweep.slice(0, 1200)),
    "the sweep no longer drains the queue",
  );
}

// ── 5. Subscribing is idempotent and re-run at startup ─────────────────────
{
  assert.ok(
    /onStartup[\s\S]{0,200}void subscribeToWake\(\)/.test(BG),
    "the startup re-subscribe is gone. A push service can rotate an endpoint " +
      "while the browser is closed, and a rotated endpoint fails silently.",
  );
  const start = at(BG, "async function subscribeToWake()", "subscribeToWake");
  const body = BG.slice(start, at(BG, "async function unsubscribeFromWake()", "unsubscribeFromWake"));

  assert.ok(
    /await pushPermissionGranted\(\)/.test(body),
    "subscribeToWake no longer checks the optional permission first, so it " +
      "will throw on a browser that never granted it",
  );
  assert.ok(
    /userVisibleOnly: false/.test(body),
    "the subscription is no longer silent. userVisibleOnly:true makes Chrome " +
      "demand a notification per push — one interruption per item the seller sells.",
  );
  assert.ok(
    /getSubscription\(\)/.test(body),
    "subscribeToWake no longer reuses an existing subscription, so every " +
      "startup mints a new endpoint and abandons the old one",
  );
  assert.ok(
    /if \(!key\) return \{ ok: false, reason: "unprovisioned" \};/.test(body),
    "a deploy with no VAPID key no longer degrades cleanly",
  );
  // The key comes from the server, never from a constant in a shipped build:
  // baking it in means a key rotation needs a store review.
  assert.ok(
    /queueFetch\("\/push-key"\)/.test(body),
    "the VAPID key is no longer fetched — a hardcoded key cannot be rotated " +
      "without a store review",
  );
}

// ── 6. The switch is the extension's own, and honest about Firefox ─────────
{
  assert.ok(
    /"GT_WAKE_STATE"|GT_WAKE_STATE/.test(BG),
    "the popup's state message is gone",
  );
  const external = BG.slice(
    at(BG, "const EXTERNAL_TYPES = new Set([", "EXTERNAL_TYPES"),
    BG.indexOf("]);", at(BG, "const EXTERNAL_TYPES = new Set([", "EXTERNAL_TYPES")),
  );
  for (const t of ["GT_WAKE_ENABLE", "GT_WAKE_DISABLE", "GT_WAKE_STATE"]) {
    assert.ok(
      !external.includes(t),
      `${t} is reachable from the web. A permission the seller grants must be ` +
        "granted to the extension's own words in its own surface, never to a " +
        "sentence gradethread.com rendered.",
    );
  }

  // The prompt goes through the one file allowed to make a permissions
  // request (host-permissions.test.cjs section 7 enforces that), and it is
  // reached from the button's own click: an await BEFORE it would end the user
  // gesture and Chrome would refuse the prompt.
  const enableHandler = POPUP_JS.slice(
    at(POPUP_JS, '_wakeEnable.addEventListener("click"', "the enable handler"),
    at(POPUP_JS, '_wakeDisable.addEventListener("click"', "the disable handler"),
  );
  const CALL = 'PERMS.requestApiPermission(ext, "notifications")';
  const requestAt = enableHandler.indexOf(CALL);
  assert.ok(
    requestAt > -1,
    "the enable button no longer requests the permission through the PERMS helper",
  );
  // Count the awaits that occur BEFORE the request. Exactly one is allowed —
  // the request's own — because the async body runs synchronously up to its
  // first await, so the call still happens inside the gesture. A second one
  // ahead of it means the gesture is gone by the time Chrome is asked.
  const before = enableHandler.slice(0, requestAt + CALL.length);
  assert.strictEqual(
    (before.match(/\bawait\b/g) || []).length,
    1,
    "something else is awaited before the permission request, which ends the " +
      "user gesture and makes Chrome refuse the prompt",
  );
  assert.ok(
    /PERMS\.removeApiPermission\(ext, "notifications"\)/.test(POPUP_JS),
    "turning the switch off no longer hands the permission back",
  );

  // Firefox must be told, not shown a dead switch.
  assert.ok(
    /if \(!state\.supported\)/.test(POPUP_JS),
    "the unsupported-browser branch is gone, so Firefox gets a switch that " +
      "silently does nothing",
  );
  const unsupported = POPUP_JS.slice(
    at(POPUP_JS, "if (!state.supported) {", "the unsupported branch"),
    at(POPUP_JS, "const on = state.granted", "the on/off branch"),
  );
  assert.ok(
    /5-minute check/.test(unsupported),
    "the unsupported message no longer says what still happens. 'Not " +
      "available' on its own reads as 'your delists do not work here'.",
  );

  assert.ok(
    POPUP_HTML.includes('id="wakeBlock"') && POPUP_HTML.includes('id="wakeEnable"'),
    "the popup markup for the switch is missing",
  );
}

console.log("push-wake.test.cjs: ok");
