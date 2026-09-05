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

  // ── THE LINE: no grade, anywhere in the copy ──────────────────────────────
  const copy = [
    LOCAL.QUICK_LOOK_LABEL,
    LOCAL.QUICK_LOOK_NOTE,
    LOCAL.QUICK_LOOK_EMPTY,
  ].join(" ");
  assert.ok(
    !/\d+\.\d/.test(copy),
    `quick-look copy contains a decimal number, which reads as a grade: ${copy}`,
  );
  assert.ok(
    !/\bgrades?\b/i.test(copy.replace(/is not a condition grade/i, "")),
    "quick-look copy may say what it is NOT, and must not otherwise use the " +
      "word grade",
  );
  assert.ok(
    /not a condition grade/i.test(LOCAL.QUICK_LOOK_NOTE),
    "the note must say plainly that this is not a grade",
  );
  assert.ok(
    /on your device/i.test(LOCAL.QUICK_LOOK_LABEL),
    "the label must say where it ran",
  );

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
