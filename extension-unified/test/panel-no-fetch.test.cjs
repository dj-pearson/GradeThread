// US-3062 AC5: the panel holds no token and makes no fetch of its own.
//
// Every network call goes through a background message type that already
// exists (GT_QUEUE_*, GT_LISTER_*, GT_PANEL_*). The background script is the
// only place the sign-in token lives, and that is the property this protects:
// a panel that fetched directly would need the token, and a token in a page
// that renders marketplace-adjacent content is a token one XSS away from being
// somebody else's.
//
// A SOURCE SCAN IS RIGHT HERE, and it is worth saying why, because a scan is
// the wrong instrument for most things (see US-2719). This is a WIRING rule,
// not a logic rule: the question is "does this file contain a call at all",
// which has no runtime state and no branches. Same shape and same reasoning as
// ebay-no-scrape.test.cjs.
//
// The scan strips comments FIRST. This file's own prose says `fetch(` several
// times, and so does panel.js's header explaining the rule — a guard that
// cannot tell documentation from code reddens on its own explanation, which
// has happened three times in this repo already.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const PANEL_DIR = path.resolve(__dirname, "..", "panel");

/** Source with block and line comments removed, so prose is not scanned. */
function codeOf(file) {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

const files = fs
  .readdirSync(PANEL_DIR)
  .filter((f) => f.endsWith(".js"))
  .map((f) => path.join(PANEL_DIR, f));

// Without this the whole file passes vacuously the day the directory is renamed.
assert.ok(files.length >= 2, `expected panel/*.js to exist, found ${files.length}`);

const BANNED = [
  [/\bfetch\s*\(/, "fetch("],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bnew\s+WebSocket\b/, "WebSocket"],
  [/\bnavigator\s*\.\s*sendBeacon\b/, "navigator.sendBeacon"],
  [/\bimportScripts\s*\(/, "importScripts("],
];

for (const file of files) {
  const code = codeOf(file);
  const rel = "panel/" + path.basename(file);
  for (const [re, name] of BANNED) {
    assert.ok(
      !re.test(code),
      `${rel} contains ${name}. The panel must call the background instead: ` +
        `it holds no token, and every network call has a message type already ` +
        `(GT_QUEUE_*, GT_LISTER_*, GT_PANEL_*).`,
    );
  }
}

// The other half of the claim: it really does talk to the background. A file
// with no fetch AND no message send is not compliant, it is inert — which is
// exactly what a scan for absence alone would call a pass.
const wiring = files.map(codeOf).join("\n");
assert.ok(
  /runtime\s*\.\s*sendMessage\s*\(/.test(wiring),
  "no panel/*.js sends a runtime message. A panel that fetches nothing and " +
    "messages nothing is not safe, it is disconnected.",
);
assert.ok(
  /GT_QUEUE_STATE/.test(wiring),
  "the panel does not ask for the queue. AC3 requires it to render the same " +
    "queue the popup does, through the same message.",
);

// The token, named. Nothing in panel/ should read storage directly either:
// that is where the background keeps the session.
assert.ok(
  !/storage\s*\.\s*(local|sync)\s*\.\s*get\s*\([^)]*token/i.test(wiring),
  "panel/*.js reads a token out of storage. The background owns the session.",
);

console.log(`✓ panel-no-fetch: ${files.length} panel file(s), no direct network`);
