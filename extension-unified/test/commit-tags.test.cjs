// US-2737 AC4: a tag that does not commit STOPS the loop.
//
// A tag box is not a text box. Setting its value types the word and stops there;
// the tag only exists once Enter turns it into a chip. So the fill has to check
// that it landed, and the check is the input CLEARING - the site confirming it
// accepted the entry, rather than us assuming it did.
//
// THE FAILURE THIS GUARDS IS NOT A MISSING TAG. If an entry sticks and the loop
// carries on, the next word is typed ON TOP of the uncommitted text and the two
// concatenate into one nonsense tag. The seller ends up with "vintagedenim" on
// a live listing. Stopping leaves them with fewer tags, which is recoverable and
// honest.
//
// AC4 says this was "verified against three cases: all commit, the second
// sticks, the first sticks". This is those three cases, run every time.
//
// Zero dependencies, discovered by scripts/test-extensions.mjs.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "lister", "common.js");

/**
 * Load common.js against a fake tag input.
 *
 * `sticksAt` is the 0-based entry that refuses to clear - the site rejecting it.
 * Everything before clears normally, which is what makes the stop observable.
 */
function loadGT({ sticksAt = -1 } = {}) {
  const src = fs.readFileSync(SRC, "utf8");

  // Real classes, because GT.setValue walks HTMLInputElement.prototype to find
  // the native value setter and calls it directly - the React-safe way to set a
  // controlled input. Stubbing the element as a plain object would skip that
  // path entirely and test something the extension never does.
  class HTMLTextAreaElement {}
  class HTMLInputElement {
    constructor() { this._value = ""; this._ordinal = -1; }
    get value() { return this._value; }
    set value(v) {
      // A non-empty write is a new tag being typed. Counting SETS rather than
      // Enter events matters: commitTags dispatches keydown, keypress AND keyup
      // per tag, so an event counter made "the second tag sticks" mean "the
      // second keystroke of the first tag sticks" - and the third keystroke
      // cleared it anyway, so every case passed. The harness was modelling the
      // DOM wrong and would have given a false pass on all three cases.
      if (v !== "") this._ordinal += 1;
      this._value = v;
    }
    dispatchEvent(ev) {
      if (ev && ev.key === "Enter" && this._ordinal !== sticksAt) {
        // The framework turns the text into a chip and clears the box.
        this._value = "";
      }
      return true;
    }
  }

  const input = new HTMLInputElement();
  const document = { querySelector: () => input };

  const fn = new Function(
    "self", "document", "KeyboardEvent", "Event", "HTMLInputElement",
    "HTMLTextAreaElement", "setTimeout", "clearTimeout", "console", "globalThis",
    src + "; return self.GTLister;",
  );
  const GT = fn(
    {},
    document,
    class KeyboardEvent { constructor(t, o) { Object.assign(this, o); this.type = t; } },
    class Event { constructor(t) { this.type = t; } },
    HTMLInputElement,
    HTMLTextAreaElement,
    (f) => setTimeout(f, 0), // collapse the 150ms settle wait
    clearTimeout,
    { log: () => {}, warn: () => {}, error: () => {}, debug: () => {}, info: () => {} },
    { chrome: undefined, browser: undefined },
  );
  return { GT, input };
}

(async () => {
  // ── 1. All three commit ────────────────────────────────────────────────────
  {
    const { GT } = loadGT();
    const res = await GT.commitTags("input", ["vintage", "denim", "levis"], 3);
    assert.strictEqual(res.total, 3, "all three were offered");
    assert.strictEqual(res.committed, 3, "all three cleared, so all three committed");
  }

  // ── 2. The SECOND sticks: one committed, then stop ─────────────────────────
  {
    const { GT } = loadGT({ sticksAt: 1 });
    const res = await GT.commitTags("input", ["vintage", "denim", "levis"], 3);
    assert.strictEqual(res.total, 3, "total is what was offered, not what landed");
    assert.strictEqual(
      res.committed,
      1,
      "the loop continued past an entry that never became a chip — the next " +
        "word is typed on top of it and the two concatenate into one nonsense tag",
    );
  }

  // ── 3. The FIRST sticks: nothing committed, and nothing typed after it ─────
  {
    const { GT, input } = loadGT({ sticksAt: 0 });
    const res = await GT.commitTags("input", ["vintage", "denim", "levis"], 3);
    assert.strictEqual(res.committed, 0, "nothing became a chip");
    assert.strictEqual(res.total, 3);
    // The box still holds the first word, uncommitted. What must NOT have
    // happened is a second word landing on top of it.
    assert.strictEqual(
      input.value,
      "vintage",
      `the box holds "${input.value}" — a second word was typed over the first`,
    );
  }

  // ── 4. The marketplace's cap bounds what is attempted ──────────────────────
  {
    const { GT } = loadGT();
    const res = await GT.commitTags("input", ["a", "b", "c", "d", "e"], 3);
    assert.strictEqual(res.total, 3, "Poshmark says 'Add up to 3 tags' — a fourth is never attempted");
    assert.strictEqual(res.committed, 3);
  }

  // ── 5. Nothing to do is not a failure ──────────────────────────────────────
  {
    const { GT } = loadGT();
    for (const empty of [[], ["", "   "], null]) {
      const res = await GT.commitTags("input", empty, 3);
      assert.strictEqual(res.total, 0, `${JSON.stringify(empty)} should offer nothing`);
      assert.strictEqual(res.committed, 0);
    }
  }

  // ── 6. No selector, no input: report nothing rather than guess ─────────────
  {
    const { GT } = loadGT();
    const res = await GT.commitTags("", ["vintage"], 3);
    assert.strictEqual(res.total, 0, "a channel with no tag field must not report a shortfall");
  }

  console.log("commit-tags.test.cjs: a tag that does not clear stops the loop, and nothing is typed on top of it");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
