// GradeThread unified extension — page↔background bridge (US-1882).
//
// This EXECUTES gt-bridge.js against a stubbed window/document rather than
// grepping its source, so the assertions are about behaviour: what the bridge
// installs, what it forwards, and — the security-relevant part — what it
// refuses to do inside a frame.
//
// Zero-dependency node script: throws on failure.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.resolve(__dirname, "..", "gt-bridge.js"), "utf8");

// Build a fake page environment. `framed` decides whether window.top is this
// same window (top-level) or a different object (embedded in an iframe).
function makeEnv({ framed = false, crossOriginTop = false, hasRuntime = true } = {}) {
  const listeners = [];
  const posted = [];
  const attrs = {};
  const sent = [];

  const win = {
    location: { origin: "https://gradethread.com" },
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    postMessage: (data, origin) => posted.push({ data, origin }),
  };
  // Reading a property off a cross-origin `top` throws in a real browser; model
  // that so the try/catch path is genuinely exercised.
  if (crossOriginTop) {
    Object.defineProperty(win, "top", {
      get() {
        throw new Error("Blocked a frame with origin ... from accessing a cross-origin frame.");
      },
    });
  } else {
    win.top = framed ? { __other: true } : win;
  }

  const runtimeListeners = [];
  const api = hasRuntime
    ? {
      runtime: {
        sendMessage: (msg, cb) => {
          sent.push(msg);
          if (cb) cb({ ok: true, echoed: msg.type });
          return undefined; // Chrome-style: callback, no promise
        },
        onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
        lastError: null,
      },
    }
    : {};

  const doc = {
    documentElement: {
      setAttribute: (k, v) => {
        attrs[k] = v;
      },
    },
  };

  return { win, doc, api, listeners, posted, attrs, sent, runtimeListeners };
}

function run(env) {
  // gt-bridge.js reads bare `window`, `document`, and `globalThis.chrome`.
  const fn = new Function("window", "document", "globalThis", SRC);
  fn(env.win, env.doc, { chrome: env.api });
  return env;
}

// ── top-level: the bridge installs normally ────────────────────────────────
{
  const env = run(makeEnv());
  assert.strictEqual(
    env.attrs["data-gt-ext-bridge"],
    "1",
    "top-level page must get the synchronous install marker — isListerAvailable() reads it",
  );
  assert.ok(
    env.listeners.some((l) => l.type === "message"),
    "top-level page must install the postMessage relay listener",
  );
}

// ── framed: the bridge must not exist at all (US-1882 AC3) ─────────────────
//
// Not just "does not forward" — it must not even advertise itself. A marker set
// inside a frame would make the page offer the Lister UI in a context we refuse
// to serve, which is a worse failure than being absent.
{
  const env = run(makeEnv({ framed: true }));
  assert.strictEqual(
    env.attrs["data-gt-ext-bridge"],
    undefined,
    "a FRAMED page must not get the install marker — the page would offer seller UI " +
      "inside a frame the extension refuses to act in",
  );
  assert.strictEqual(
    env.listeners.length,
    0,
    "a FRAMED page must install no listeners: clickjacking is the threat — the page's " +
      "own 'Send to extension' control clicked through by a victim who cannot see it",
  );
}

// ── cross-origin top: reading window.top throws → still must stay out ──────
{
  const env = run(makeEnv({ crossOriginTop: true }));
  assert.strictEqual(
    env.attrs["data-gt-ext-bridge"],
    undefined,
    "when reading window.top THROWS (cross-origin frame) the bridge must fail CLOSED",
  );
  assert.strictEqual(env.listeners.length, 0, "cross-origin framed page must install no listeners");
}

// ── relay behaviour on a top-level page ────────────────────────────────────
{
  const env = run(makeEnv());
  const onMessage = env.listeners.find((l) => l.type === "message").fn;

  // A well-formed envelope from THIS window is forwarded and answered.
  onMessage({
    source: env.win,
    origin: "https://gradethread.com",
    data: { __gtExtReq: true, id: "req-1", message: { type: "GT_LISTER_JOB" } },
  });
  assert.deepStrictEqual(
    env.sent.map((m) => m.type),
    ["GT_LISTER_JOB"],
    "a valid envelope must be relayed to the background",
  );
  const res = env.posted.find((p) => p.data && p.data.__gtExtRes);
  assert.ok(res, "the background's response must be relayed back to the page");
  assert.strictEqual(res.data.id, "req-1", "the response must carry the request's correlation id");
  assert.strictEqual(
    res.origin,
    "https://gradethread.com",
    "the response must be posted with an explicit target origin, never '*'",
  );
}

// ── envelopes that must be ignored ─────────────────────────────────────────
{
  const env = run(makeEnv());
  const onMessage = env.listeners.find((l) => l.type === "message").fn;
  const other = { __different_window: true };

  const ignored = [
    ["another window", { source: other, origin: "https://evil.example", data: { __gtExtReq: true, id: "x", message: { type: "T" } } }],
    ["missing envelope flag", { source: env.win, origin: "https://gradethread.com", data: { id: "x", message: { type: "T" } } }],
    ["non-string id", { source: env.win, origin: "https://gradethread.com", data: { __gtExtReq: true, id: 7, message: { type: "T" } } }],
    ["absent message", { source: env.win, origin: "https://gradethread.com", data: { __gtExtReq: true, id: "x" } }],
    ["null data", { source: env.win, origin: "https://gradethread.com", data: null }],
  ];
  for (const [label, event] of ignored) {
    onMessage(event);
    assert.strictEqual(env.sent.length, 0, `must NOT relay: ${label}`);
  }
}

// ── background→page push relay forwards ONLY the known types ───────────────
{
  const env = run(makeEnv());
  const push = env.runtimeListeners[0];
  assert.ok(push, "the background→page push relay must be registered");

  push({ type: "GT_LISTER_JOB_UPDATE", jobId: "j1", result: { ok: true } });
  push({ type: "GT_LISTER_LISTED", platform: "poshmark", listingUrl: "https://poshmark.com/x" });
  push({ type: "GT_SOMETHING_INTERNAL", secret: "must-not-reach-the-page" });

  const types = env.posted.filter((p) => p.data && p.data.__gtExtPush).map((p) => p.data.type);
  assert.deepStrictEqual(
    types,
    ["GT_LISTER_JOB_UPDATE", "GT_LISTER_LISTED"],
    "only the two known push types may reach the page — never arbitrary background traffic",
  );
  assert.ok(
    !JSON.stringify(env.posted).includes("must-not-reach-the-page"),
    "an unknown background message must not leak into the page",
  );
}

console.log(
  "gt-bridge.test.cjs: top-frame-only guard (framed + cross-origin-top fail closed), " +
    "correlation-id relay with explicit target origin, envelope validation, push-type allowlist",
);
