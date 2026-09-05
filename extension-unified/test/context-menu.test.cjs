// US-3113: the context menu registers once, quietly.
//
// THE BUG THIS PINS. chrome.contextMenus.create() does not THROW on a duplicate
// id under MV3 — it reports through chrome.runtime.lastError in its callback.
// The original code wrapped create() in try/catch and commented that a
// duplicate "throws and is swallowed above", which was simply not true, so
// every startup after an install logged:
//
//   Unchecked runtime.lastError: Cannot create item with duplicate id
//   gt-grade-image
//
// The effect was harmless and the appearance was not: a red console line in an
// extension that runs inside other people's marketplaces. It was reported as a
// bug more than once before anyone read the callback contract.
//
// Asserted by EXECUTING the registration against a fake chrome namespace rather
// than by grepping for removeAll, because the property that matters is
// behavioural: register twice, get one menu item and no unchecked error.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const src = read("background.js");

// ── the source contract ──────────────────────────────────────────────────────

assert.ok(
  /ext\.contextMenus\.removeAll/.test(src),
  "the menu registration must removeAll before create, or a re-register duplicates",
);
assert.ok(
  /void ext\.runtime\.lastError/.test(src),
  "create() must pass a callback that READS runtime.lastError — the read is what " +
    "marks it checked, and without it Chrome logs the warning anyway",
);
assert.ok(
  !/A duplicate-id create throws/.test(src),
  "the comment claiming create() throws on a duplicate is wrong and was the " +
    "reason the bug survived review; it must not come back",
);

// ── the behaviour ────────────────────────────────────────────────────────────
//
// Extract just the registration block and run it against a fake namespace. This
// is the part a source grep cannot prove: that firing onInstalled AND onStartup
// leaves exactly one menu item and never an unchecked error.

const start = src.indexOf('const CONTEXT_MENU_ID = "gt-grade-image";');
assert.ok(start !== -1, "CONTEXT_MENU_ID has been renamed or removed");
const blockStart = src.indexOf("if (ext.contextMenus && ext.contextMenus.create) {", start);
assert.ok(blockStart !== -1, "the contextMenus registration block has moved");

// Brace-match the block so the test follows the code rather than a line number.
let depth = 0;
let end = blockStart;
for (; end < src.length; end++) {
  if (src[end] === "{") depth++;
  else if (src[end] === "}") {
    depth--;
    if (depth === 0) break;
  }
}
const block = src.slice(start, end + 1);

const menus = new Map();
let uncheckedErrors = 0;
let duplicateAttempts = 0;
let pendingError = null;

const listeners = { installed: [], startup: [] };
const ext = {
  runtime: {
    // Getter, so "did the code actually read it" is observable. That read is the
    // whole mechanism; a callback that ignores lastError fixes nothing.
    get lastError() {
      const e = pendingError;
      pendingError = null;
      return e;
    },
    onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
    onStartup: { addListener: (fn) => listeners.startup.push(fn) },
  },
  contextMenus: {
    create(props, cb) {
      if (menus.has(props.id)) {
        // US-3070: counted as well as reported. Reading lastError is what makes
        // the warning go away, and our callbacks read it — so `uncheckedErrors`
        // alone cannot see a duplicate ATTEMPT, only an unreported one. Dropping
        // removeAll left this test green, which is the half of US-3113's fix it
        // was not proving.
        duplicateAttempts++;
        pendingError = { message: `Cannot create item with duplicate id ${props.id}` };
      } else {
        menus.set(props.id, props);
      }
      if (cb) cb();
      // Chrome logs the warning when the error was never read. Our getter clears
      // it on read, so anything still sitting here went unchecked.
      if (pendingError) { uncheckedErrors++; pendingError = null; }
      return props.id;
    },
    removeAll(cb) {
      menus.clear();
      if (cb) cb();
    },
    onClicked: { addListener: () => {} },
  },
  commands: { onCommand: { addListener: () => {} } },
  tabs: { query: async () => [], sendMessage: async () => {} },
};

new Function("ext", block)(ext);

assert.strictEqual(listeners.installed.length, 1, "registers on onInstalled");
assert.strictEqual(listeners.startup.length, 1, "and on onStartup");

// US-3070 added a second item, so the count is no longer 1 — and pinning a
// LITERAL count was the wrong assertion anyway. The property US-3113 is about is
// IDEMPOTENCE: registering twice must not duplicate an id or leave an unchecked
// error. A hardcoded number fires on intended growth and says nothing about the
// failure it exists to catch, so what is pinned now is that the count does not
// CHANGE across restarts, and that both ids are the ones we meant.
listeners.installed[0]();
const afterInstall = menus.size;
assert.ok(afterInstall >= 1, "no menu item after install");
assert.deepStrictEqual(
  [...menus.keys()].sort(),
  ["gt-grade-image", "gt-read-label"],
  "the registered menu ids changed",
);
assert.strictEqual(uncheckedErrors, 0, "install must not leave an unchecked error");

listeners.startup[0]();
assert.strictEqual(menus.size, afterInstall, "a restart duplicated a menu item");
assert.strictEqual(
  uncheckedErrors,
  0,
  "a restart after install must not log 'Cannot create item with duplicate id'",
);

// Third time, because a worker can restart repeatedly in one browser session.
listeners.startup[0]();
assert.strictEqual(menus.size, afterInstall, "repeated restarts grew the menu");
assert.strictEqual(uncheckedErrors, 0, "and never log an unchecked error");

// ⚠ AND NO DUPLICATE WAS EVER ATTEMPTED. This is the assertion that fails when
// removeAll is dropped; the two above do not, because our create callbacks read
// lastError and a read is what clears it.
assert.strictEqual(
  duplicateAttempts,
  0,
  "a menu id was created twice — removeAll is missing from the registration",
);

assert.deepStrictEqual(
  [...menus.keys()].sort(),
  ["gt-grade-image", "gt-read-label"],
  "a menu id changed — onClicked filters on both of them",
);

console.log(
  "context-menu.test.cjs: removeAll+create with a lastError read; install then " +
    "two restarts leave one menu item and zero unchecked runtime errors",
);
