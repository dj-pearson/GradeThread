// US-3066 AC7: the on-device pre-read, with a stubbed LanguageModel.
//
// THE LINE THIS PROTECTS. The pre-read never produces a grade. Not a number,
// not a tier, not a score. A quick look showing "7.5" would be a grade with
// none of the pipeline behind it — no prompt version, no eval gate, no review
// threshold, no certificate — and a shopper would treat it as one anyway,
// because it would look like one. Several cases below exist only to hold that
// line, and they are the ones not to relax.
//
// Everything here runs with a fake global, so no browser and no model download.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const MODULE_PATH = path.resolve(__dirname, "..", "research", "local-model.js");

// local-model.js is a UMD content script and must stay `.js` — Chrome rejects a
// `.cjs` content script. The repo is type:module, so require() of a .js returns
// an empty object rather than throwing, which is the quiet version of this
// mistake: every assertion below would fail with "not a function" and look like
// a broken module. Load it the way the other content-script guards do — run the
// source with an injected `self` and read the global it assigns.
function loadLocalModel() {
  const src = fs.readFileSync(MODULE_PATH, "utf8");
  const selfObj = {};
  new Function("self", src)(selfObj);
  assert.ok(selfObj.GT_CC_LOCAL, "local-model.js must assign self.GT_CC_LOCAL");
  return selfObj.GT_CC_LOCAL;
}

const LOCAL = loadLocalModel();

// ── no network, asserted from the source ────────────────────────────────────
//
// The whole promise of an on-device read is that the images never leave the
// machine. Comments are stripped first: this file's own prose names `fetch(`,
// and so does local-model.js's header explaining the rule.
{
  const code = fs
    .readFileSync(MODULE_PATH, "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  for (const [re, name] of [
    [/\bfetch\s*\(/, "fetch("],
    [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
    [/\bimportScripts\s*\(/, "importScripts("],
    [/\bnavigator\s*\.\s*sendBeacon\b/, "sendBeacon"],
  ]) {
    assert.ok(
      !re.test(code),
      `local-model.js contains ${name}. An on-device pre-read that reaches the ` +
        `network is not an on-device pre-read.`,
    );
  }
}

// ── detect() ────────────────────────────────────────────────────────────────

(async () => {
  // Firefox, and any browser without the global.
  assert.strictEqual(await LOCAL.detect({}), "unavailable");
  assert.strictEqual(await LOCAL.detect({ LanguageModel: {} }), "unavailable");

  assert.strictEqual(
    await LOCAL.detect({ LanguageModel: { availability: async () => "available" } }),
    "available",
  );
  assert.strictEqual(
    await LOCAL.detect({ LanguageModel: { availability: async () => "downloadable" } }),
    "downloadable",
  );
  // Older spellings Chrome shipped during the origin trial.
  assert.strictEqual(
    await LOCAL.detect({ LanguageModel: { availability: async () => "readily" } }),
    "available",
  );
  assert.strictEqual(
    await LOCAL.detect({
      LanguageModel: { availability: async () => "after-download" },
    }),
    "downloadable",
  );
  // An availability string we do not recognise, and a throwing one, are both
  // "unavailable": there is no useful difference to show a shopper.
  assert.strictEqual(
    await LOCAL.detect({ LanguageModel: { availability: async () => "who knows" } }),
    "unavailable",
  );
  assert.strictEqual(
    await LOCAL.detect({
      LanguageModel: {
        availability: async () => {
          throw new Error("boom");
        },
      },
    }),
    "unavailable",
  );

  // ── eBay is excluded, and stays excluded ──────────────────────────────────
  for (const p of ["poshmark", "mercari", "grailed", "vinted", "depop"]) {
    assert.ok(LOCAL.canPreRead(p), `${p} should be pre-readable`);
  }
  assert.ok(
    !LOCAL.canPreRead("ebay"),
    "eBay must NOT be pre-read on-page. US-3042 removed DOM reading from that " +
      "path; an on-page pre-read reintroduces it on the one marketplace whose " +
      "API licence is explicit about it.",
  );
  assert.ok(!LOCAL.canPreRead(""));
  assert.ok(!LOCAL.canPreRead(null));
  assert.ok(LOCAL.canPreRead("Poshmark"), "platform match is case-insensitive");

  // ── parsePreRead: null, never a partial ───────────────────────────────────
  assert.strictEqual(LOCAL.parsePreRead("not json"), null);
  assert.strictEqual(LOCAL.parsePreRead(null), null);
  assert.strictEqual(LOCAL.parsePreRead(42), null);
  assert.strictEqual(
    LOCAL.parsePreRead({ note: "looks fine" }),
    null,
    "no defects array is an unreadable answer, not an empty one — a shopper " +
      "cannot tell 'saw nothing' from 'could not read the reply', and only one " +
      "of those means the garment looks clean",
  );

  const parsed = LOCAL.parsePreRead(
    JSON.stringify({
      defects: [
        { kind: "pilling", where: "left cuff", confidence: 0.8 },
        { kind: "  ", where: "x" },
        { kind: "small stain", confidence: 5 },
      ],
      claimed_tier_plausible: false,
      note: "  hem looks intact  ",
    }),
  );
  assert.strictEqual(parsed.defects.length, 2, "a nameless defect is dropped");
  assert.strictEqual(parsed.defects[0].kind, "pilling");
  assert.strictEqual(parsed.defects[0].where, "left cuff");
  assert.strictEqual(
    parsed.defects[1].confidence,
    1,
    "confidence is clamped to 0..1 rather than rendered as 5",
  );
  assert.strictEqual(parsed.defects[1].where, "");
  assert.strictEqual(parsed.claimedTierPlausible, false);
  assert.strictEqual(parsed.note, "hem looks intact");

  // An empty defects list IS an answer and survives as one.
  const empty = LOCAL.parsePreRead({ defects: [] });
  assert.deepStrictEqual(empty.defects, []);
  assert.strictEqual(empty.claimedTierPlausible, null, "absent boolean stays null");

  // ── preRead: null on every failure path ───────────────────────────────────
  assert.strictEqual(await LOCAL.preRead(["a"], {}, { global: {} }), null);
  assert.strictEqual(
    await LOCAL.preRead([], {}, { global: { LanguageModel: { create: async () => ({}) } } }),
    null,
    "no images means nothing to look at",
  );
  assert.strictEqual(
    await LOCAL.preRead(["a"], {}, {
      global: {
        LanguageModel: {
          create: async () => {
            throw new Error("model busy");
          },
        },
      },
    }),
    null,
  );
  assert.strictEqual(
    await LOCAL.preRead(["a"], {}, {
      global: {
        LanguageModel: {
          create: async () => ({
            prompt: async () => {
              throw new Error("inference failed");
            },
            destroy() {},
          }),
        },
      },
    }),
    null,
  );
  assert.strictEqual(
    await LOCAL.preRead(["a"], {}, {
      global: {
        LanguageModel: {
          create: async () => ({ prompt: async () => "{{{", destroy() {} }),
        },
      },
    }),
    null,
    "an unparseable answer is null, not a partial render",
  );

  // The happy path, and the session is closed afterwards.
  let destroyed = false;
  const ok = await LOCAL.preRead(["img1", "img2"], { claimedTier: "Very Good" }, {
    global: {
      LanguageModel: {
        create: async () => ({
          prompt: async (messages, opts) => {
            // The schema is passed, so the model is constrained rather than
            // asked politely.
            assert.ok(opts && opts.responseConstraint, "a schema is passed");
            const content = messages[0].content;
            const images = content.filter((c) => c.type === "image");
            assert.strictEqual(images.length, 2, "both images are sent");
            const text = content.find((c) => c.type === "text").value;
            assert.ok(
              text.includes("Very Good"),
              "the seller's claimed tier is given as context",
            );
            return JSON.stringify({ defects: [{ kind: "fading" }] });
          },
          destroy() {
            destroyed = true;
          },
        }),
      },
    },
  });
  assert.strictEqual(ok.defects[0].kind, "fading");
  assert.ok(destroyed, "the session is destroyed after the read");

  // ── the scan cap, and the reason for it ───────────────────────────────────
  const cards = Array.from({ length: 20 }, (_, i) => ({ id: i, imageLoaded: true }));
  assert.strictEqual(LOCAL.scanCardsToPreRead(cards).length, 6);
  assert.strictEqual(LOCAL.SCAN_CARD_CAP, 6);
  assert.strictEqual(
    LOCAL.scanCardsToPreRead([
      { id: 1, imageLoaded: false },
      { id: 2, imageLoaded: true },
      { id: 3 },
    ]).length,
    1,
    "a card whose image has not loaded is skipped — pre-reading it would mean " +
      "FETCHING it, which turns a free on-device feature into extra network " +
      "traffic on someone's search page",
  );
  assert.deepStrictEqual(LOCAL.scanCardsToPreRead(null), []);

  // ── THE LINE: this module owns no user-facing copy ────────────────────────
  //
  // The wording lives in research/condition-format.js and is asserted there
  // (condition-format.test.cjs). What is asserted HERE is that it did not come
  // back: a second copy of a string whose whole job is to not say "grade" is
  // two places to get that wrong, and only one of them would be reviewed.
  for (const key of Object.keys(LOCAL)) {
    if (key === "SYSTEM_PROMPT") continue; // model instruction, not shown to anyone
    const v = LOCAL[key];
    if (typeof v !== "string") continue;
    assert.ok(
      !/quick look/i.test(v),
      `local-model.js exports user-facing copy (${key}). Quick-look wording ` +
        `belongs in condition-format.js with the rest of the overlay's copy.`,
    );
  }

  // The prompt itself forbids scoring, so the model is not merely asked not to
  // be rendered as a grade — it is asked not to produce one.
  assert.ok(
    /Do not score, rate or grade/i.test(LOCAL.SYSTEM_PROMPT),
    "the system prompt must forbid scoring",
  );
  // And the schema has nowhere to put a score. A number in the schema is a
  // number somebody renders.
  const props = LOCAL.OUTPUT_SCHEMA.properties;
  assert.ok(!("score" in props) && !("grade" in props) && !("tier" in props));

  console.log("✓ local-model: on-device, no network, and never a grade");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

// ── US-3066 AC5: the options page ───────────────────────────────────────────
//
// Three rules, and each has a specific failure it prevents.
(function optionsPageWiring() {
  const html = fs.readFileSync(path.resolve(__dirname, "..", "options.html"), "utf8");
  const js = fs.readFileSync(path.resolve(__dirname, "..", "options.js"), "utf8");

  // 1. LOAD ORDER. options.js reads self.GT_CC_LOCAL to decide whether the row
  //    exists at all. A classic script loaded AFTER its consumer leaves the
  //    global undefined and the row silently never appears — which looks
  //    exactly like a browser that has no on-device model.
  const localAt = html.indexOf('src="research/local-model.js"');
  const optionsAt = html.indexOf('src="options.js"');
  assert.ok(localAt !== -1, "options.html must load research/local-model.js");
  assert.ok(
    localAt < optionsAt,
    "local-model.js must load BEFORE options.js, or GT_CC_LOCAL is undefined " +
      "when the quick-look row is decided and the row never renders",
  );

  // 2. HIDDEN, NOT DISABLED, where the browser cannot do it. A greyed-out
  //    control on Firefox invites a support question with no answer.
  assert.ok(
    /<div id="quickLookRow" hidden>/.test(html),
    "the quick-look row starts hidden and is unhidden only when detect() says " +
      "the model is available or downloadable",
  );
  assert.ok(
    /row\.hidden = false/.test(js),
    "options.js must unhide the row rather than enabling a disabled control",
  );
  assert.ok(
    !/quickLook[^\n]*\.disabled = true/.test(js),
    "the TOGGLE is never disabled — an unavailable browser hides the row",
  );

  // 3. THE DOWNLOAD IS NEVER SILENT. LanguageModel.create() on a downloadable
  //    model pulls a multi-gigabyte file. Starting that on page load, on
  //    somebody's mobile tether, because they opened a listing, is not a
  //    decision the extension gets to make — so it happens on a click, on this
  //    page, and nowhere else.
  assert.ok(
    /dl\.addEventListener\("click"/.test(js),
    "the model download must be behind a click",
  );
  assert.ok(
    /monitor\s*\(/.test(js) && /downloadprogress/.test(js),
    "the download must report progress — a multi-gigabyte silent wait reads " +
      "as a hang",
  );
  for (const f of ["research/local-model.js", "popup.js"]) {
    const src = fs.readFileSync(path.resolve(__dirname, "..", f), "utf8");
    assert.ok(
      !/LanguageModel\s*\.\s*create/.test(src),
      `${f} calls LanguageModel.create. Only the options page may start the ` +
        `model DOWNLOAD, and only on a click.`,
    );
  }

  // The stored-state rule, matching scanMode: default ON, and turning it back
  // on REMOVES the key so "default" and "explicitly on" are one state.
  assert.ok(
    /storage\.local\.remove\("quickLook"\)/.test(js),
    "turning the quick look back on must remove the key, not store true",
  );
})();

console.log("✓ local-model: the options row is hidden, not disabled, and the download is a click");
