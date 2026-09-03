// US-3042: prove the eBay path reads nothing off the page.
//
// THE DECAY THIS EXISTS TO STOP. The eBay branch is three `ebayItemIdHere()`
// checks in a file whose entire job is scraping listings. Every other adapter in
// it extracts a title, a gallery and a price, and the obvious "improvement" to
// the eBay branch — we already have the title on screen, why make the server
// fetch it again — silently reinstates the exact thing that had to be removed.
//
// The answer to that question is that where the data came from is the whole
// point, and it is not a property any behavioural test can observe: a scraped
// title and an API title are the same string. So this is asserted against the
// SOURCE, the same way comp-read-no-crawl_test.ts pins the comp worker.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
// US-3112: normalise line endings. This suite matches a literal newline against
// the source, and a Windows checkout hands it CRLF, so every one of those
// probes silently missed and the guard failed for a reason that has nothing to
// do with scraping. It passed in CI on Linux the whole time, which is the worst
// version of this: a compliance guard green where nobody looks and red where
// they do.
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/** Comments argue about scraping; code must not scrape. Strip the argument. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => {
      const i = line.search(/(^|[^:])\/\//);
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
}

/** The body of a named top-level function. Brace-matched. */
function functionBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `function ${name} has been renamed or removed`);

  // Walk the PARAMETER list to its closing paren first. A destructured
  // signature — `function f({ a, b })` — opens a brace before the body does,
  // and taking the first `{` after the name returns the parameter object
  // instead of the function, which reads as an empty body and passes nothing.
  const paren = src.indexOf("(", start);
  let pdepth = 0;
  let i = paren;
  for (; i < src.length; i++) {
    if (src[i] === "(") pdepth++;
    else if (src[i] === ")") {
      pdepth--;
      if (pdepth === 0) break;
    }
  }
  const open = src.indexOf("{", i);
  assert.ok(open !== -1, `no body found for ${name}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const MARKETPLACE = codeOnly(read("research/marketplace.js"));
const BACKGROUND = codeOnly(read("background.js"));

// The DOM extractors. Calling any of these on the eBay path is the regression.
const EXTRACTORS = [
  "extractImageUrls",
  "extractTitle",
  "extractBrand",
  "extractPrice",
  "extractCondition",
];

// ── the id parser itself ────────────────────────────────────────────────────

// The repo is `"type": "module"`, so a bare require() of a .js file returns an
// empty ESM namespace rather than the UMD export. Every other suite here loads
// these classic scripts the same way: run the source with a fake `self` and read
// the global it registers, which is exactly what a content script does.
function loadGlobal(rel, globalName) {
  const src = read(rel);
  const scope = {};
  return new Function("self", `${src}; return self.${globalName};`)(scope);
}

const EB = loadGlobal("research/ebay-item-id.js", "GT_EBAY_ITEM");

{
  // The shapes eBay actually serves.
  assert.strictEqual(
    EB.itemIdFromUrl("https://www.ebay.com/itm/123456789012"),
    "123456789012",
  );
  assert.strictEqual(
    EB.itemIdFromUrl("https://www.ebay.com/itm/nike-air-max-90-size-11/123456789012?hash=item1a"),
    "123456789012",
    "a slug containing digits must not be mistaken for the id",
  );
  assert.strictEqual(
    EB.itemIdFromUrl("https://www.ebay.com/itm/?item=123456789012"),
    "123456789012",
  );
  assert.strictEqual(
    EB.itemIdFromUrl("https://www.ebay.co.uk/itm/123456789012"),
    "123456789012",
    "every eBay domain we support, not just .com",
  );
}

{
  // Not a listing. Null is the safe answer: the overlay stays quiet rather than
  // grading a page that is not an item.
  const notListings = [
    "https://www.ebay.com/sch/i.html?_nkw=patagonia",
    "https://www.ebay.com/usr/someseller",
    "https://www.ebay.com/b/Mens-Clothing/1059",
    "https://www.poshmark.com/listing/thing-123456789012",
    "https://evil.example.com/itm/123456789012",
    "not a url",
    "",
  ];
  for (const url of notListings) {
    assert.strictEqual(EB.itemIdFromUrl(url), null, `should not parse: ${url}`);
  }
}

{
  // A hostname that merely CONTAINS "ebay" is not eBay.
  assert.strictEqual(EB.isEbayUrl("https://www.ebay.com/itm/1"), true);
  assert.strictEqual(EB.isEbayUrl("https://notebay.com/itm/1"), false);
  assert.strictEqual(EB.isEbayUrl("https://ebay.com.evil.example/itm/1"), false);
}

// ── the grade path ──────────────────────────────────────────────────────────

{
  const body = functionBody(MARKETPLACE, "runGrade");
  assert.ok(
    body.includes("ebayItemIdHere()"),
    "runGrade no longer branches on the eBay item id",
  );
  // Every extractor call in runGrade must sit in a statement that also consults
  // the id. Statements, not lines: the guard is a multi-line ternary
  // (`const x = ebayItemId ? [] : extractX();`), so a line-level check would
  // read the two halves as unrelated. Splitting on `;` is crude and adequate —
  // an object literal's fields are separated by commas, so each
  // `const ... = ...;` here is exactly one chunk.
  for (const stmt of body.split(";")) {
    const used = EXTRACTORS.filter((fn) => stmt.includes(`${fn}(`));
    if (used.length === 0) continue;
    assert.ok(
      stmt.includes("ebayItemId"),
      `runGrade calls ${used.join(", ")} without checking ebayItemId in the ` +
        `same statement:\n${stmt.trim().slice(0, 300)}`,
    );
  }
}

// ── the alerts / ingest path ────────────────────────────────────────────────

{
  const body = functionBody(MARKETPLACE, "alertControls");
  assert.ok(
    body.includes("ebayItemIdHere(renderedUrl)"),
    "the alerts path no longer branches on the eBay item id",
  );
  // The eBay arm of the send must carry the URL and nothing scraped.
  const ebayArm = body.slice(
    body.indexOf("ingestIsEbay ?"),
    body.indexOf("} : {"),
  );
  assert.ok(ebayArm.includes("url: renderedUrl"), "the eBay arm sends no URL");
  for (const fn of EXTRACTORS) {
    assert.ok(
      !ebayArm.includes(`${fn}(`),
      `the eBay ingest arm calls ${fn}()`,
    );
  }
}

// ── the flip appraisal path ─────────────────────────────────────────────────

{
  const body = functionBody(MARKETPLACE, "runAppraise");
  assert.ok(
    body.includes("appraiseEbayId"),
    "runAppraise no longer branches on the eBay item id",
  );
  // Same statement-level rule as runGrade: an extractor may be called only in a
  // statement that has already consulted the id.
  for (const stmt of body.split(";")) {
    const used = EXTRACTORS.filter((fn) => stmt.includes(`${fn}(`));
    if (used.length === 0) continue;
    assert.ok(
      stmt.includes("appraiseEbayId"),
      `runAppraise calls ${used.join(", ")} without checking appraiseEbayId ` +
        `in the same statement:\n${stmt.trim().slice(0, 300)}`,
    );
  }
}

// ── the background: what actually leaves the browser ────────────────────────

{
  // The last line of defence, and the one that matters most: even if a content
  // script regressed, these three request bodies are what would carry the
  // scraped fields over the wire.
  const grade = functionBody(BACKGROUND, "gradeFromUrls");
  assert.ok(grade.includes("byEbayId"), "the grade sender lost its eBay branch");
  const gradeEbayArm = grade.slice(
    grade.indexOf("byEbayId\n"),
    grade.indexOf(": {", grade.indexOf("byEbayId\n")),
  );
  for (const field of ["title:", "brand:", "condition:", "imageUrls:", "price:"]) {
    assert.ok(
      !gradeEbayArm.includes(field),
      `the eBay grade request still carries ${field}`,
    );
  }
  assert.ok(gradeEbayArm.includes("ebayItemId"), "the eBay grade request sends no id");
}

{
  const appraise = functionBody(BACKGROUND, "appraiseListing");
  assert.ok(
    appraise.includes("byListingUrl"),
    "the appraise sender lost its URL-only branch",
  );
}

{
  const ingest = functionBody(BACKGROUND, "ingestListing");
  assert.ok(
    ingest.includes("ingestByUrlOnly"),
    "the ingest sender lost its URL-only branch",
  );
  assert.ok(
    ingest.includes("isEbayListingUrl"),
    "a photo-less ingest is no longer restricted to eBay",
  );
}

console.log("ebay-no-scrape: ok");
