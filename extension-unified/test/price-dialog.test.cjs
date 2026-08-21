// US-2735: the price dialog fills, and never commits.
//
// Poshmark keeps both amounts in listing-price-suggestion-modal rather than on
// the create form, so every price selector missed and the seller was told "the
// price was NOT filled in" on every single cross-post.
//
// TWO PROPERTIES ARE WORTH A TEST HERE, and neither is "does it fill".
//
// AC4 - IT NEVER SUBMITS. The only elements it may touch are the opener and the
// two inputs. Poshmark commits through its own Apply control, and clicking that
// for the seller would be GradeThread deciding the price is right. The dialog is
// left OPEN on purpose, with the number in front of them.
//
// The already-open guard. A dialog renders over a backdrop that swallows
// clicks, so clicking the opener while one is up either does nothing or lands on
// the backdrop and DISMISSES the dialog we were about to fill. Checking for the
// input first is the only version that cannot close a dialog the seller opened
// themselves - and it is the kind of ordering that looks like a micro-
// optimisation and gets "simplified" away.
//
// Zero dependencies, discovered by scripts/test-extensions.mjs.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "lister", "common.js");

const CFG = {
  open: "input.ff--no-increment-input:not([id^=listing-price-modal])",
  price: "#listing-price-modal-listing-price-input",
  originalPrice: "#listing-price-modal-original-price-input",
};

/**
 * A page with a price dialog.
 *
 * `dialogOpen` starts with the modal inputs already present. Otherwise they
 * appear only after the opener is clicked, and only if `opensOnClick`.
 */
function loadGT({ dialogOpen = false, opensOnClick = true, hasOpener = true } = {}) {
  const src = fs.readFileSync(SRC, "utf8");
  const clicked = [];

  class HTMLTextAreaElement {}
  class HTMLInputElement {
    constructor(id) { this.id = id; this._value = ""; }
    get value() { return this._value; }
    set value(v) { this._value = v; }
    dispatchEvent() { return true; }
    click() { clicked.push(this.id); if (opensOnClick) present = true; }
  }
  // Anything the code might click that it must NOT: the Apply/submit control.
  const apply = new HTMLInputElement("apply-button");

  let present = dialogOpen;
  const priceInput = new HTMLInputElement("listing-price-modal-listing-price-input");
  const origInput = new HTMLInputElement("listing-price-modal-original-price-input");
  const opener = new HTMLInputElement("create-page-price");

  const document = {
    querySelector(sel) {
      if (sel === CFG.price) return present ? priceInput : null;
      if (sel === CFG.originalPrice) return present ? origInput : null;
      if (sel === CFG.open) return hasOpener ? opener : null;
      // Anything else on the page, including the Apply control.
      if (/apply|submit|done/i.test(sel)) return apply;
      return null;
    },
  };

  const fn = new Function(
    "self", "document", "Event", "KeyboardEvent", "HTMLInputElement",
    "HTMLTextAreaElement", "setTimeout", "clearTimeout", "console", "globalThis",
    src + "; return self.GTLister;",
  );
  const GT = fn(
    {}, document,
    class Event { constructor(t) { this.type = t; } },
    class KeyboardEvent { constructor(t, o) { Object.assign(this, o); this.type = t; } },
    HTMLInputElement, HTMLTextAreaElement,
    (f) => setTimeout(f, 0), clearTimeout,
    { log: () => {}, warn: () => {}, error: () => {}, debug: () => {}, info: () => {} },
    { chrome: undefined, browser: undefined },
  );
  return { GT, clicked, priceInput, origInput, isOpen: () => present };
}

(async () => {
  // ── 1. It fills, and clicks ONLY the opener ────────────────────────────────
  {
    const { GT, clicked, priceInput, origInput } = loadGT();
    const ok = await GT.fillPriceDialog(CFG, { price: 32, originalPrice: 60, platform: "poshmark" });
    assert.strictEqual(ok, true, "the dialog should have filled");
    assert.strictEqual(priceInput.value, "32", "the listing price should be set");
    assert.strictEqual(origInput.value, "60", "the original price should be set");
    assert.deepStrictEqual(
      clicked,
      ["create-page-price"],
      `it clicked ${JSON.stringify(clicked)} — the ONLY element it may click is the ` +
        `opener. Clicking Apply would be GradeThread deciding the price is right ` +
        `(US-2735 AC4).`,
    );
  }

  // ── 2. AC4: the dialog is left OPEN ────────────────────────────────────────
  {
    const { GT, isOpen } = loadGT();
    await GT.fillPriceDialog(CFG, { price: 32, platform: "poshmark" });
    assert.strictEqual(
      isOpen(),
      true,
      "the dialog was closed — it is left open on purpose so the number is in " +
        "front of the seller and THEY commit it",
    );
  }

  // ── 3. Already open: do not click anything ─────────────────────────────────
  {
    // Clicking the opener with a dialog up lands on the backdrop and dismisses
    // the dialog we were about to fill.
    const { GT, clicked, priceInput } = loadGT({ dialogOpen: true });
    const ok = await GT.fillPriceDialog(CFG, { price: 19, platform: "poshmark" });
    assert.strictEqual(ok, true);
    assert.strictEqual(priceInput.value, "19");
    assert.deepStrictEqual(
      clicked,
      [],
      "it clicked the opener while a dialog was ALREADY OPEN — that lands on the " +
        "backdrop and dismisses the dialog it was about to fill",
    );
  }

  // ── 4. AC5: every failure is non-fatal and reports unfilled ────────────────
  {
    const noOpener = loadGT({ hasOpener: false });
    assert.strictEqual(
      await noOpener.GT.fillPriceDialog(CFG, { price: 32, platform: "poshmark" }),
      false,
      "no opener must report unfilled, not throw",
    );

    const neverOpens = loadGT({ opensOnClick: false });
    assert.strictEqual(
      await neverOpens.GT.fillPriceDialog(CFG, { price: 32, platform: "poshmark" }),
      false,
      "a dialog that never renders must report unfilled",
    );

    const { GT } = loadGT();
    assert.strictEqual(
      await GT.fillPriceDialog(null, { price: 32, platform: "poshmark" }),
      false,
      "a channel with no priceDialog config must report unfilled",
    );
    assert.strictEqual(
      await GT.fillPriceDialog({ open: CFG.open }, { price: 32, platform: "poshmark" }),
      false,
      "a config with no price selector must report unfilled",
    );
  }

  // ── 5. The original price is optional ──────────────────────────────────────
  {
    const { GT, priceInput, origInput } = loadGT();
    const ok = await GT.fillPriceDialog(CFG, { price: 25, platform: "poshmark" });
    assert.strictEqual(ok, true);
    assert.strictEqual(priceInput.value, "25");
    assert.strictEqual(origInput.value, "", "no original price offered, so none set");
  }

  // ── 6. AC6: the opener selector cannot match the modal's own inputs ────────
  {
    // The one inferred selector in the whole story. The :not() is what keeps a
    // wrong inference harmless: it opens nothing, rather than typing the price
    // into the very modal input it was supposed to click open.
    //
    // NO REGEX HERE, deliberately. Three attempts at one produced, in order: a
    // character class that truncated at the first inner quote (the value is
    // single quoted and contains double quotes inside [id^="listing-price-modal"]),
    // a backreference that arrived as a literal U+0001 control byte, and a
    // broken string literal. A line scan needs no escapes and cannot rot that
    // way.
    const cfgSrc = fs.readFileSync(
      path.join(__dirname, "..", "lister", "selectors.js"),
      "utf8",
    );
    const openLine = cfgSrc
      .split("\n")
      // BOTH tokens: a comment above the config mentions ff--no-increment-input,
      // and .find takes the first match - so scanning for the selector alone
      // grabbed the prose. The assertion message is what showed that.
      .find((l) => l.includes("ff--no-increment") && l.includes("open:"));
    assert.ok(openLine, "the poshmark price-dialog opener selector is gone");

    const openSel = openLine.slice(openLine.indexOf(":") + 1).trim();
    // Self-check: if the scan ever truncates, the guard below would pass on a
    // fragment. The real selector is ~60 characters.
    assert.ok(
      openSel.length > 20,
      "the opener selector captured only [" + openSel + "] - the scan truncated",
    );
    assert.ok(
      openSel.includes(":not(") && openSel.includes("listing-price-modal"),
      "the opener selector lost its :not([id^=listing-price-modal]) guard, so a " +
        "wrong inference can now match the modal's own inputs: " + openSel,
    );

    assert.ok(
      fs.readFileSync(SRC, "utf8").includes("GT.fillPriceDialog"),
      "fillPriceDialog is gone",
    );
  }

  console.log("price-dialog.test.cjs: fills, clicks only the opener, leaves the dialog open, and never submits");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
