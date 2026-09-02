// US-3053: the popup's keyboard and screen-reader contract, as source.
//
// The behavioural half is scripts/extension-a11y.mjs (axe in a browser); this
// is the zero-dep half that CI runs on every push: the ARIA wiring the tablist
// pattern needs, the live regions on the text that changes without a click,
// and the focus hand-off after the queue re-renders. Each is a line that is
// easy to lose in a markup refactor and invisible when lost.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(dir, "popup.html"), "utf8");
const js = fs.readFileSync(path.join(dir, "popup.js"), "utf8");

// ── 1. tablists: roving tabindex, arrows, and panels that can take focus ────
for (const id of ["navSelling", "navSettings", "tabSellers"]) {
  assert.ok(
    new RegExp('id="' + id + '"[^>]*tabindex="-1"').test(html),
    "#" + id + " must start with tabindex=-1 — one tab stop per strip, arrows move inside it",
  );
}
for (const id of ["panelReads", "panelSelling", "panelSettings", "historyPanel"]) {
  assert.ok(
    new RegExp('id="' + id + '"[^>]*tabindex="-1"').test(html),
    "#" + id + " must carry tabindex=-1 so focus can land on the panel",
  );
}
assert.ok(/id="tabReads"[^>]*aria-controls="historyPanel"/.test(html) && /id="tabSellers"[^>]*aria-controls="historyPanel"/.test(html),
  "the history tabs must name their panel");
assert.ok(/<nav class="pop-nav" aria-label="Sections"><div class="pop-nav-list" role="tablist">/.test(html),
  "the tablist role sits INSIDE the <nav>, so the nav keeps its landmark role");
assert.ok(/<h1 class="pop-brand">/.test(html), "the brand is the page's h1");
assert.ok(/function wireTablistKeys\(/.test(js), "popup.js must define wireTablistKeys");
for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
  assert.ok(js.includes('e.key === "' + key + '"'), "wireTablistKeys must handle " + key);
}
assert.strictEqual((js.match(/wireTablistKeys\(/g) || []).length, 3, "both tablists (main + history) are wired, plus the definition");
assert.ok(/btn\.tabIndex = on \? 0 : -1/.test(js), "selectTab must roll the tabindex with the selection");
assert.ok(/tabReads\.tabIndex = onSellers \? -1 : 0/.test(js), "the history switch must roll its tabindex too");

// ── 2. live regions on what changes without a click ─────────────────────────
for (const id of ["queueStatus", "queueRunNote", "syncNote", "engageRunStatus"]) {
  assert.ok(
    new RegExp('id="' + id + '"[^>]*aria-live="polite"').test(html),
    "#" + id + " changes without a click and must be aria-live=polite",
  );
}
// A bulk action announces through queueRunNote: its outcome text is written there.
const bulkStart = js.indexOf("async function bulk(");
assert.ok(bulkStart > -1, "wireQueue must define the bulk helper");
// renderQueue declares its own retryAll earlier in the file, so the end
// marker is searched FROM the helper, not from the top.
const bulk = js.slice(bulkStart, js.indexOf("const retryAll = document.getElementById", bulkStart));
assert.ok(bulk.length > 100, "could not isolate the bulk helper");
assert.ok(/runNote\.textContent = failed/.test(bulk), "a bulk action must write its outcome into the live note");

// ── 3. focus survives a re-render ───────────────────────────────────────────
assert.ok(/function refocusIn\(/.test(js), "popup.js must define refocusIn");
const rowFn = js.slice(js.indexOf("function renderQueueRow("), js.indexOf("function wireQueue("));
assert.strictEqual((rowFn.match(/refocusIn\("queueBlock"\)/g) || []).length, 2, "Retry and Cancel/Dismiss both hand focus back into the queue card");
assert.ok(/refocusIn\("queueBlock"\)/.test(bulk), "a bulk action hands focus back into the queue card");

// ── 4. the scan exists and is documented ────────────────────────────────────
const repo = path.resolve(dir, "..");
assert.ok(fs.existsSync(path.join(repo, "scripts", "extension-a11y.mjs")), "scripts/extension-a11y.mjs must exist");
assert.ok(fs.existsSync(path.join(repo, "scripts", "lib", "extension-stub.mjs")), "scripts/lib/extension-stub.mjs must exist");
const testing = fs.readFileSync(path.join(dir, "TESTING.md"), "utf8");
assert.ok(testing.includes("node scripts/extension-a11y.mjs"), "TESTING.md must document the one command");
const stub = fs.readFileSync(path.join(repo, "scripts", "lib", "extension-stub.mjs"), "utf8");
assert.ok(/throw new Error\("extension-stub: unknown message/.test(stub), "the stub must fail on an unknown message, never answer ok");

console.log("popup-a11y.test.cjs: roving tabindex + arrows on both tablists, live regions, focus hand-off, scan documented");
