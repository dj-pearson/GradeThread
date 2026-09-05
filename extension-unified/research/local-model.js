// US-3066: the on-device pre-read. Chrome's Prompt API (Gemini Nano), in the
// shopper's own browser, before anything is spent.
//
// WHAT THIS IS NOT, and the line is the whole design. This never produces a
// grade. Not a number, not a tier, not a score — a short list of things a model
// thinks it can see, labelled "Quick look (on your device)". The certified read
// is the only thing that carries a grade, and the "Check condition" button is
// still the only way to one. A quick look that showed a 7.5 would be a grade
// with none of the pipeline behind it: no prompt version, no eval gate, no
// human review threshold, no certificate. Sellers and shoppers would treat it
// as one anyway, and they would be right to, because it looks like one.
//
// PROGRESSIVE, NOT REQUIRED. Chrome 138+ exposes LanguageModel to extensions;
// Firefox exposes nothing equivalent. detect() answers for the browser it is
// actually running in, and every caller treats "unavailable" as the ordinary
// case rather than an error state.
//
// NO NETWORK, AND THAT IS ASSERTED. The point of an on-device read is that the
// images never leave the machine. test/local-model.test.cjs scans this file for
// fetch(, XMLHttpRequest and importScripts, because the rule is one autocomplete
// away from being broken by someone being helpful and is invisible at runtime
// when it is.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api; // node
  if (typeof root !== "undefined") root.GT_CC_LOCAL = api; // content-script world
})(typeof self !== "undefined" ? self : this, function () {
  /**
   * Adapters whose images the pre-read may look at.
   *
   * eBay is ABSENT and must stay absent. US-3042 removed DOM reading from the
   * eBay path entirely — the extension sends an item id and the server resolves
   * the photos through the Browse API — so an on-page pre-read there would
   * reintroduce exactly the practice that had to be removed, on the one
   * marketplace whose API licence is explicit about it.
   */
  const PRE_READ_PLATFORMS = ["poshmark", "mercari", "grailed", "vinted", "depop"];

  /** At most this many cards get a pre-read on a scan page (US-2237). */
  const SCAN_CARD_CAP = 6;

  // The quick look's WORDING lives in research/condition-format.js, with the
  // rest of the overlay's copy (US-3066 AC3). This module runs the model; how a
  // shopper reads the result is a copy decision and belongs where the other
  // copy is reviewed. Nothing here should grow a user-facing string.

  const SYSTEM_PROMPT =
    "You look at photos of a second-hand garment and name only what you can " +
    "actually see: stains, holes, pilling, fading, stretched or missing " +
    "hardware, hem or seam damage. Name nothing you are unsure of. Do not " +
    "score, rate or grade the item. Do not guess a condition tier.";

  /**
   * The shape the model is asked for. Deliberately carries no score field: a
   * schema with a number in it is a schema someone will render.
   */
  const OUTPUT_SCHEMA = {
    type: "object",
    properties: {
      defects: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string" },
            where: { type: "string" },
            confidence: { type: "number" },
          },
          required: ["kind"],
        },
      },
      claimed_tier_plausible: { type: "boolean" },
      note: { type: "string" },
    },
    required: ["defects"],
  };

  /** True when this adapter's on-page images may be pre-read. */
  function canPreRead(platform) {
    return PRE_READ_PLATFORMS.indexOf(String(platform || "").toLowerCase()) !== -1;
  }

  /**
   * What the browser can do: "available", "downloadable", or "unavailable".
   *
   * Anything unexpected is "unavailable". A browser without the global, a
   * throwing availability() and an availability string we do not recognise are
   * the same answer to every caller — there is no useful difference between
   * them and pretending otherwise would put three branches in the UI.
   */
  async function detect(globalObj) {
    const g = globalObj || (typeof self !== "undefined" ? self : {});
    const LM = g.LanguageModel;
    if (!LM || typeof LM.availability !== "function") return "unavailable";
    try {
      const state = await LM.availability();
      if (state === "available" || state === "readily") return "available";
      if (state === "downloadable" || state === "after-download") return "downloadable";
      return "unavailable";
    } catch (_e) {
      return "unavailable";
    }
  }

  /**
   * Parse whatever the model returned into the shape the overlay renders.
   *
   * Returns null rather than a partial object. A quick look that renders half a
   * defect list is worse than one that does not appear: the shopper cannot tell
   * "the model saw nothing" from "the model's answer was unreadable", and only
   * one of those means the garment looks clean.
   */
  function parsePreRead(raw) {
    let data = raw;
    if (typeof raw === "string") {
      try {
        data = JSON.parse(raw);
      } catch (_e) {
        return null;
      }
    }
    if (!data || typeof data !== "object") return null;
    if (!Array.isArray(data.defects)) return null;

    const defects = [];
    for (const d of data.defects) {
      if (!d || typeof d !== "object") continue;
      const kind = typeof d.kind === "string" ? d.kind.trim() : "";
      if (!kind) continue;
      const conf = typeof d.confidence === "number" ? d.confidence : null;
      defects.push({
        kind: kind,
        where: typeof d.where === "string" ? d.where.trim() : "",
        confidence: conf === null ? null : Math.max(0, Math.min(1, conf)),
      });
    }

    return {
      defects: defects,
      claimedTierPlausible: typeof data.claimed_tier_plausible === "boolean"
        ? data.claimed_tier_plausible
        : null,
      note: typeof data.note === "string" ? data.note.trim() : "",
    };
  }

  /**
   * Run the pre-read. Resolves to the parsed result, or null.
   *
   * Null on every failure path, deliberately: no model, no images, a session
   * that will not create, a prompt that throws, an unparseable answer. The
   * caller's job is to render nothing, and giving it one falsy answer for all of
   * them is what keeps that simple. Nothing here throws into the overlay.
   */
  async function preRead(images, hints, deps) {
    const d = deps || {};
    const g = d.global || (typeof self !== "undefined" ? self : {});
    const LM = g.LanguageModel;
    if (!LM || typeof LM.create !== "function") return null;
    if (!Array.isArray(images) || images.length === 0) return null;

    let session = null;
    try {
      session = await LM.create({
        initialPrompts: [{ role: "system", content: SYSTEM_PROMPT }],
      });
      if (!session || typeof session.prompt !== "function") return null;

      const content = [];
      for (const img of images) {
        if (img) content.push({ type: "image", value: img });
      }
      // No images survived: the model would be asked to describe nothing and
      // would happily invent something.
      if (content.length === 0) return null;
      const claimed = hints && typeof hints.claimedTier === "string"
        ? ` The seller says the condition is "${hints.claimedTier}".`
        : "";
      content.push({
        type: "text",
        value: "List what you can see wrong with this garment." + claimed,
      });

      const answer = await session.prompt([{ role: "user", content: content }], {
        responseConstraint: OUTPUT_SCHEMA,
      });
      return parsePreRead(answer);
    } catch (_e) {
      return null;
    } finally {
      try {
        if (session && typeof session.destroy === "function") session.destroy();
      } catch (_e2) {
        // A session that will not close is not worth failing the read over.
      }
    }
  }

  /**
   * The cards on a scan page that may be pre-read.
   *
   * Two limits, and the second is the one that matters: only cards whose first
   * image is ALREADY loaded. Pre-reading a card whose image has not loaded would
   * mean fetching it, which turns a free on-device feature into extra network
   * traffic on somebody's search results page.
   */
  function scanCardsToPreRead(cards, cap) {
    if (!Array.isArray(cards)) return [];
    const limit = typeof cap === "number" && cap > 0 ? cap : SCAN_CARD_CAP;
    const out = [];
    for (const c of cards) {
      if (out.length >= limit) break;
      if (!c || c.imageLoaded !== true) continue;
      out.push(c);
    }
    return out;
  }

  return {
    PRE_READ_PLATFORMS: PRE_READ_PLATFORMS,
    SCAN_CARD_CAP: SCAN_CARD_CAP,
    SYSTEM_PROMPT: SYSTEM_PROMPT,
    OUTPUT_SCHEMA: OUTPUT_SCHEMA,
    canPreRead: canPreRead,
    detect: detect,
    parsePreRead: parsePreRead,
    preRead: preRead,
    scanCardsToPreRead: scanCardsToPreRead,
  };
});
