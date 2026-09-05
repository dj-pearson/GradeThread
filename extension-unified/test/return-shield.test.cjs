// research/return-shield.js — the evidence pack on an eBay dispute page (US-3068).
//
// Three rules, and every case here belongs to one of them:
//
//   1. IT READS ONE THING OFF THE PAGE, and that thing is the URL. US-3042's
//      rule holds on this surface too.
//   2. IT NEVER SUBMITS. No form filled, no eBay button clicked, no file
//      attached. Sending stays on the FlipDesk post-sale surface behind a
//      seller's own deliberate click.
//   3. IT NEVER PROMISES AN OUTCOME. Evidence is evidence, and a seller who
//      reads "this will win" and then loses was told something we had no
//      business saying.
//
// Zero-dependency node script: throws on drift.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function load(rel, global) {
  const src = fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");
  const selfObj = {};
  new Function("self", src)(selfObj);
  assert.ok(selfObj[global], `${rel} must assign self.${global}`);
  return selfObj[global];
}

const SHIELD = load("research/return-shield.js", "GT_RETURN_SHIELD");
const FMT = load("research/condition-format.js", "GT_CC_FMT");
const S = FMT.STRINGS;

// ── 1. the url is the only thing read ──────────────────────────────────────

(function returnIdComesFromTheUrl() {
  assert.strictEqual(
    SHIELD.returnIdFromUrl("https://www.ebay.com/sh/rtn/5012345678"),
    "5012345678",
  );
  assert.strictEqual(
    SHIELD.returnIdFromUrl("https://www.ebay.co.uk/sh/cases/CASE-abc_1/details"),
    "CASE-abc_1",
  );
  assert.strictEqual(
    SHIELD.returnIdFromUrl("https://www.ebay.com/sh/returns/RET-9/"),
    "RET-9",
  );
})();

(function everythingElseIsNotAReturnPage() {
  // A LIST has no single return to answer about, and guessing one would put a
  // verdict about item A on a row for item B.
  for (const url of [
    "https://www.ebay.com/sh/rtn",
    "https://www.ebay.com/sh/rtn/",
    "https://www.ebay.com/sh/ovw",
    "https://www.ebay.com/itm/123456789012",
    "https://www.ebay.com/sh/lst/active",
    "https://not-ebay.example/sh/rtn/5012345678",
    "https://ebay.evil.example/sh/rtn/5012345678",
    "",
    null,
    42,
  ]) {
    assert.strictEqual(
      SHIELD.returnIdFromUrl(url),
      null,
      `${String(url)} was read as a return page`,
    );
    assert.strictEqual(SHIELD.isReturnPage(url), false, String(url));
  }
})();

(function idsAreBoundedBeforeTheyTravel() {
  // An unbounded id off a URL is a thing to say no to on sight, and the server
  // applies the same rule again.
  assert.strictEqual(
    SHIELD.returnIdFromUrl("https://www.ebay.com/sh/rtn/" + "a".repeat(65)),
    null,
  );
  assert.strictEqual(
    SHIELD.returnIdFromUrl("https://www.ebay.com/sh/rtn/has%20space"),
    null,
  );
})();

// ── the answer, and what it refuses to render ──────────────────────────────

const ASSEMBLE = {
  verdict: "assemble",
  certificateNumber: "GT-1234",
  gradedAt: "2026-08-01T00:00:00.000Z",
  defectCount: 3,
  hasPublicationSnapshot: true,
  citations: [
    {
      defectIndex: 0,
      defectType: "pilling",
      location: "underarm",
      severity: "minor",
      reportText: "Light pilling under both arms.",
      disclosedIn: "description",
      disclosureQuote: "Light pilling under the arms.",
    },
  ],
};

(function aSupportedPackIsRenderable() {
  const out = SHIELD.readAnswer(ASSEMBLE);
  assert.ok(out);
  assert.strictEqual(out.verdict, "assemble");
  assert.strictEqual(out.certificateNumber, "GT-1234");
  assert.strictEqual(out.citations.length, 1);
  assert.strictEqual(SHIELD.gradedOn(out), "2026-08-01");
})();

(function noReportRendersNOTHING() {
  // Absence is not a claim. A GradeThread panel on a return that says nothing
  // useful would read as us having checked and found against the seller.
  assert.strictEqual(SHIELD.readAnswer({ verdict: "no-report" }), null);
})();

(function everyFailureRendersNothing() {
  for (const body of [
    null,
    undefined,
    "",
    "not json",
    42,
    {},
    { verdict: "" },
    { verdict: "unknown" },
    { verdict: "won" },
    { citations: [] },
  ]) {
    assert.strictEqual(
      SHIELD.readAnswer(body),
      null,
      `${JSON.stringify(body)} produced something to render`,
    );
  }
})();

(function aRefusalCarriesNOTHINGToPaste() {
  // THE ONE THAT MATTERS. A refusal that arrived with citations would hand the
  // seller a Copy button for text arguing that the buyer is right. Stripped
  // here regardless of what the server sent, because the server is not the only
  // thing that has to be right about this.
  const out = SHIELD.readAnswer({
    ...ASSEMBLE,
    verdict: "refuse-undisclosed",
  });
  assert.ok(out);
  assert.strictEqual(out.verdict, "refuse-undisclosed");
  assert.deepStrictEqual(out.citations, []);
  assert.strictEqual(
    SHIELD.draftParagraph(out, S),
    "",
    "a refusal produced a paragraph to copy",
  );
})();

// ── the draft ──────────────────────────────────────────────────────────────

(function theDraftStatesTheRecordAndClaimsNothing() {
  const out = SHIELD.readAnswer(ASSEMBLE);
  const text = SHIELD.draftParagraph(out, S);
  assert.ok(text.includes("Light pilling under both arms."), text);
  assert.ok(text.includes("Light pilling under the arms."), text);
  assert.ok(text.includes("GT-1234"), text);
  // And it promises nothing about the outcome.
  assert.ok(!/\bwin(s|ning)?\b|guarantee|reversed/i.test(text), text);
})();

(function aCitationWithNothingInItDoesNotRenderUndefined() {
  const out = SHIELD.readAnswer({ ...ASSEMBLE, citations: [null, {}, "x"] });
  const text = SHIELD.draftParagraph(out, S);
  assert.ok(!/undefined|null/.test(text), text);
})();

// ── 3. no string promises an outcome ───────────────────────────────────────

(function theWordingTableNeverPromisesAWin() {
  // AC5. Checked over every shield string rather than the ones this file
  // happens to render, so a new one cannot slip a promise in.
  for (const [key, value] of Object.entries(S)) {
    if (!key.startsWith("shield") && !key.startsWith("draft") && !key.startsWith("disclosed") &&
      !key.startsWith("certificateLine")) continue;
    assert.ok(
      typeof value === "string" && !/\bwin\b|\bwins\b|guaranteed|reversed/i.test(value),
      `${key} promises an outcome: ${value}`,
    );
  }
  // The refusal exists and says the honest thing.
  assert.ok(/refund/i.test(S.shieldRefusal), S.shieldRefusal);
})();

// ── 2. it never submits ────────────────────────────────────────────────────

(function theScriptCannotActOnTheEbayPage() {
  // AC4, asserted against the SOURCE because it is not a property a behavioural
  // test can observe: an extension that filled the form and one that did not
  // both render the same panel. "We already have the pack, why not attach it"
  // is the improvement this exists to refuse.
  const src = fs
    .readFileSync(path.resolve(__dirname, "..", "research", "return-shield.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((l) => {
      const i = l.search(/(^|[^:])\/\//);
      return i === -1 ? l : l.slice(0, i);
    })
    .join("\n");

  for (const forbidden of [
    ".click(",
    ".submit(",
    ".value =",
    "dispatchEvent",
    "requestSubmit",
    "DataTransfer",
    "fetch(",
  ]) {
    assert.ok(
      !src.includes(forbidden),
      `return-shield.js contains ${forbidden} — it must read a URL and render, ` +
        `never act on eBay's page or reach the network itself`,
    );
  }
})();

console.log("return-shield.test.cjs: ok");

// ── the wiring (US-3068 AC1/AC3/AC6) ───────────────────────────────────────
//
// The render needs a DOM, so what is asserted here is the wiring that decides
// whether it ever runs — every one of these is a way the panel would silently
// never appear while every case above stayed green.

const MANIFEST = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "..", "manifest.json"), "utf8"),
);
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map(function (l) {
      const i = l.search(/(^|[^:])\/\//);
      return i === -1 ? l : l.slice(0, i);
    })
    .join("\n");
}

const BOOT = fs.readFileSync(
  path.resolve(__dirname, "..", "research", "return-shield-boot.js"),
  "utf8",
);
const BACKGROUND = fs.readFileSync(
  path.resolve(__dirname, "..", "background.js"),
  "utf8",
);
const OVERLAY_CSS = fs.readFileSync(
  path.resolve(__dirname, "..", "research", "overlay.css"),
  "utf8",
);

(function theModulesLoadTogetherAndInOrder() {
  const block = MANIFEST.content_scripts.find(
    (c) => Array.isArray(c.js) && c.js.includes("research/return-shield-boot.js"),
  );
  assert.ok(block, "no content-script block loads the return shield");

  // Every global the boot script reads has to be in the SAME block and BEFORE
  // it, or the reads are undefined, the early return fires and the panel
  // silently never renders — with no error anywhere.
  for (const dep of [
    "research/return-shield.js",
    "research/condition-format.js",
    "research/overlay-host.js",
    "research/overlay-css.js",
    "attribution.js",
  ]) {
    assert.ok(block.js.includes(dep), `the return-shield block is missing ${dep}`);
    assert.ok(
      block.js.indexOf(dep) < block.js.indexOf("research/return-shield-boot.js"),
      `${dep} must load BEFORE return-shield-boot.js`,
    );
  }

  // And it runs ONLY on Seller Hub dispute paths. A match on the whole of
  // ebay.com would put this on every listing page a seller opens.
  assert.ok(block.matches.length > 0);
  for (const m of block.matches) {
    assert.ok(
      /\/sh\/(rtn|cases|returns)\//.test(m),
      `${m} is broader than a Seller Hub dispute path`,
    );
  }
})();

(function itAsksOnceAndNeverRetries() {
  // A 404 is an ANSWER — a return this workspace does not own — and asking
  // again will not change it. More than that: a seller reading a dispute must
  // not have a GradeThread panel appear four seconds late on a retry, on the
  // page where they are deciding whether to refund somebody.
  const doneAt = BOOT.indexOf("done = true;");
  const sendAt = BOOT.indexOf('send({ type: "GT_RETURN_PACK"');
  assert.ok(doneAt > -1, "the boot script has no once-per-page latch");
  assert.ok(sendAt > -1, "the boot script never asks for the pack");
  assert.ok(
    doneAt < sendAt,
    "the latch is set AFTER the round trip, so an SPA navigation inside Seller " +
      "Hub can start a second request for the same page",
  );
  // Stripped of comments first: the prose above the code says the word "retry"
  // while explaining why there is not one, and a guard that reads the comment
  // fires on the explanation instead of on the behaviour.
  const code = stripComments(BOOT);
  assert.ok(!/(retry|attempts|setInterval)/i.test(code), "the boot script retries");
  // The only timer is the Copied-label reset. A second one would be a re-ask.
  assert.strictEqual(
    (code.match(/setTimeout\(/g) || []).length,
    1,
    "the boot script gained a timer beyond the copy-label reset",
  );
  assert.ok(!/setTimeout\([\s\S]{0,80}boot\(/.test(code), "boot() is scheduled on a timer");
})();

(function theBootScriptTouchesNothingOfEbays() {
  // AC4 again, on the half that actually has a document. It appends one host
  // and reads location.href; it queries, clicks, fills and submits nothing.
  for (const forbidden of [
    ".click(",
    ".submit(",
    ".value =",
    "querySelector",
    "requestSubmit",
    "DataTransfer",
  ]) {
    assert.ok(
      !BOOT.includes(forbidden),
      `return-shield-boot.js contains ${forbidden} — it must not act on eBay's page`,
    );
  }
  // getElementById is allowed and is ours: it checks for OUR host id.
  assert.ok(BOOT.includes('getElementById(HOST_ID)'));
})();

(function theBackgroundCarriesTheSellersTokenAndDoesNotRetry() {
  assert.ok(
    BACKGROUND.includes('case "GT_RETURN_PACK":'),
    "the background has no handler, so every send resolves to undefined",
  );
  const fn = BACKGROUND.slice(
    BACKGROUND.indexOf("async function returnShieldPack"),
    BACKGROUND.indexOf("async function listingCertificates"),
  );
  assert.ok(fn.length > 100, "returnShieldPack not found where expected");
  // ⚠ THIS ONE CARRIES THE SELLER'S TOKEN, unlike the badge lookup beside it.
  // It reads their grade report, their listing's disclosure and their dispute —
  // none of which is public.
  // ⚠ On the AUTHORIZATION HEADER, not merely somewhere in the function. Reading
  // the token out of storage and then not sending it left this green when the
  // header was deleted, which is the whole failure it exists to catch.
  assert.ok(
    /"Authorization":\s*"Bearer "\s*\+\s*gtBuyerToken/.test(fn),
    "the return-shield read sends no identity",
  );
  assert.ok(fn.includes("RETURN_SHIELD_ENDPOINT"), "the read goes somewhere else");
  assert.ok(
    /RETURN_SHIELD_ENDPOINT\s*=[\s\S]{0,200}\/api\/flipdesk\/return-shield\/preview/.test(
      BACKGROUND,
    ),
    "RETURN_SHIELD_ENDPOINT does not point at the preview mount",
  );
  assert.ok(!/retry|attempts|setTimeout/i.test(fn), "the background retries the read");
  // AC6. A 404 is an ANSWER — a return this workspace does not own — so it comes
  // back as ok:false and renders nothing, exactly like an offline read does.
  assert.ok(
    /if \(!resp\.ok\) return \{ ok: false \};/.test(fn),
    "a non-200 is not turned into a rendered nothing",
  );
  const guard = stripComments(BOOT).indexOf("if (!res || !res.ok) return;");
  assert.ok(guard > -1, "the boot script renders whatever the background returned");
  assert.ok(
    guard < stripComments(BOOT).indexOf("createOverlayHost"),
    "the panel is mounted before the answer is checked",
  );
})();

(function everyClassTheRenderUsesIsStyled() {
  const SRC = fs.readFileSync(
    path.resolve(__dirname, "..", "research", "return-shield.js"),
    "utf8",
  );
  for (const cls of [
    "gt-rs",
    "gt-rs-title",
    "gt-rs-meta",
    "gt-rs-refusal",
    "gt-rs-note",
    "gt-rs-draft",
    "gt-rs-copy",
    "gt-rs-open",
  ]) {
    assert.ok(SRC.includes('"' + cls + '"'), `${cls} is styled but never rendered`);
    // Anchored at the END of the class name too: every one of these is a prefix
    // of the next, so a plain substring check passes on a renamed rule.
    assert.ok(
      new RegExp("\\." + cls + "(?![\\w-])").test(OVERLAY_CSS),
      `${cls} is rendered but has no CSS rule`,
    );
  }
})();
