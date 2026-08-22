// GradeThread sold-sync observer guards (US-2698).
//
// WHAT THIS FILE IS DEFENDING. A Poshmark order row prints the buyer's name and
// their shipping address beside the sale price. The observer must be incapable
// of carrying either, not merely uninterested in them, because the failure is
// silent: nobody notices PII arriving at a server that accepted it.
//
// The other half is purity. sync/observe.js has no chrome.*, no DOM and no
// fetch so that everything above can be held to account here, with zero
// dependencies and no browser.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");

function load(rel, globalName) {
  const src = fs.readFileSync(path.join(dir, rel), "utf8");
  const scope = {};
  return new Function("self", `${src}; return self.${globalName};`)(scope);
}

const O = load("sync/observe.js", "GT_SYNC_OBSERVE");
const NOW = "2026-08-20T00:00:00.000Z";

// ── 1. The emitted shape is an allowlist, not a filter ─────────────────────

{
  const obs = O.buildSoldObservation({
    listingUrl: "https://poshmark.com/listing/aaa",
    title: "Carhartt Detroit Jacket",
    priceText: "$85.00",
    dateText: "Aug 18, 2026",
    orderRef: "PM-1",
    // Everything below is on a real Poshmark order row and must not survive.
    buyerName: "Jane Doe",
    buyer_handle: "@janedoe",
    shippingAddress: "1 Main St, Springfield",
    recipient: "Jane Doe",
    phone: "555-0100",
    email: "jane@example.com",
    trackingNumber: "1Z999",
  }, NOW);

  assert.deepStrictEqual(
    Object.keys(obs).sort(),
    [...O.ALLOWED_SOLD_FIELDS].sort(),
    "a sold observation carried a key outside ALLOWED_SOLD_FIELDS",
  );

  for (const banned of ["buyerName", "buyer_handle", "shippingAddress", "recipient", "phone", "email", "trackingNumber"]) {
    assert.ok(!(banned in obs), `${banned} survived into the observation`);
  }

  // And the fields we DO want are actually read.
  assert.strictEqual(obs.title, "Carhartt Detroit Jacket");
  assert.strictEqual(obs.soldPriceCents, 8500);
  assert.strictEqual(obs.orderRef, "PM-1");
}

// The allowlist itself cannot quietly grow a PII field.
{
  const forbidden = /buyer|recipient|address|street|postcode|zip|phone|email|cookie|session|token|password/i;
  for (const field of O.ALLOWED_SOLD_FIELDS) {
    assert.ok(
      !forbidden.test(field),
      `ALLOWED_SOLD_FIELDS gained a field that looks like PII or a credential: ${field}`,
    );
  }
  assert.strictEqual(O.ALLOWED_SOLD_FIELDS.length, 6, "the allowlist changed size — was that deliberate?");
}

// ── 2. Purity: no chrome, no DOM, no network ───────────────────────────────
//
// The module is loaded above with `new Function("self", …)`. If it touched
// `document`, `chrome` or `fetch` at load time it would already have thrown.
// This is the source-level half, which also catches a reference added inside a
// function body that no test happens to call.

{
  const src = fs.readFileSync(path.join(dir, "sync/observe.js"), "utf8");
  // Strip comments first — this file's own header NAMES the things it forbids,
  // and a guard its own documentation fails is a guard people delete.
  const code = src
    // CRLF FIRST. In JavaScript `.` does not match \r, so on a CRLF file the
    // line-comment strip below never reaches end-of-string and comments survive —
    // at which point the guard scans its own documentation and fires on the very
    // words it uses to describe what it forbids. Cost an hour on sync/content.js
    // the day its line endings changed.
    .replace(/\r\n/g, "\n")
    .replace(/\r\n?/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");

  for (const banned of ["chrome.", "browser.", "document", "window.", "fetch(", "XMLHttpRequest", "localStorage"]) {
    assert.ok(
      !code.includes(banned),
      `sync/observe.js references ${banned}. It is pure so the guards in this file can hold it; ` +
        `move anything needing a browser into the content script.`,
    );
  }
  // Date.now() would make parseSoldAt untestable and its output unreproducible.
  assert.ok(!code.includes("Date.now("), "sync/observe.js calls Date.now() — nowIso is a parameter for a reason");
}

// ── 3. Coverage is under-claimed, never invented ───────────────────────────
//
// The single most consequential field in the file. The server only treats a
// listing's absence as evidence when the enumeration completed, so a page-1-of-8
// read claiming completion would report a mass delisting.

{
  const truthy = O.buildClosetObservation(["https://poshmark.com/listing/a"], { pagesRead: 3, reachedEnd: true });
  assert.strictEqual(truthy.reachedEnd, true);
  assert.strictEqual(truthy.pagesRead, 3);

  for (const sneaky of ["true", 1, {}, [], "yes", undefined, null]) {
    const c = O.buildClosetObservation([], { pagesRead: 1, reachedEnd: sneaky });
    assert.strictEqual(
      c.reachedEnd,
      false,
      `reachedEnd accepted a truthy non-boolean (${JSON.stringify(sneaky)}) as completion`,
    );
  }

  const noCoverage = O.buildClosetObservation(["https://poshmark.com/listing/a"], undefined);
  assert.strictEqual(noCoverage.reachedEnd, false);
  assert.strictEqual(noCoverage.pagesRead, 0);
}

// A closet URL served twice at two sizes is one listing.
{
  const c = O.buildClosetObservation([
    "https://poshmark.com/listing/AAA?utm=1",
    "https://Poshmark.com/listing/aaa/",
    "https://poshmark.com/listing/bbb#x",
  ], { pagesRead: 1, reachedEnd: true });
  assert.deepStrictEqual(c.listingUrls, [
    "https://poshmark.com/listing/aaa",
    "https://poshmark.com/listing/bbb",
  ]);
}

// ── 4. Prices ──────────────────────────────────────────────────────────────

assert.strictEqual(O.parsePriceCents("$85"), 8500);
assert.strictEqual(O.parsePriceCents("$1,234.56"), 123456);
assert.strictEqual(O.parsePriceCents("US$85.00"), 8500);
assert.strictEqual(O.parsePriceCents(""), null);
assert.strictEqual(O.parsePriceCents("free"), null, "an unreadable price must be null, never 0");
assert.strictEqual(O.parsePriceCents(null), null);

// ── 5. Dates ───────────────────────────────────────────────────────────────

assert.strictEqual(O.parseSoldAt("2026-08-18T10:00:00.000Z", NOW), "2026-08-18T10:00:00.000Z");
assert.strictEqual(O.parseSoldAt("Aug 18, 2026", NOW), "2026-08-18T00:00:00.000Z");
assert.strictEqual(O.parseSoldAt("today", NOW), "2026-08-20T00:00:00.000Z");
assert.strictEqual(O.parseSoldAt("yesterday", NOW), "2026-08-19T00:00:00.000Z");
assert.strictEqual(O.parseSoldAt("3 days ago", NOW), "2026-08-17T00:00:00.000Z");
assert.strictEqual(O.parseSoldAt("sold on 18 Aug 2026", NOW), "2026-08-18T00:00:00.000Z");
assert.strictEqual(O.parseSoldAt("some time last spring", NOW), null, "an unparsed date must be null");
assert.strictEqual(O.parseSoldAt("", NOW), null);

// A bare "Dec 28" read in January belongs to LAST year, not eleven months ahead.
assert.strictEqual(
  O.parseSoldAt("Dec 28", "2026-01-05T00:00:00.000Z"),
  "2025-12-28T00:00:00.000Z",
  "a bare month/day landing in the future must roll back a year",
);

// ── 6. A login wall reports itself and carries nothing ─────────────────────

{
  const batch = O.buildBatch({
    platform: "poshmark",
    signedIn: false,
    nowIso: NOW,
    // Whatever the login page rendered is not evidence about the closet.
    soldRaw: [{ listingUrl: "https://poshmark.com/listing/aaa", priceText: "$85" }],
    closetRaw: [],
    coverage: { pagesRead: 1, reachedEnd: true },
  });
  assert.strictEqual(batch.signedIn, false);
  assert.deepStrictEqual(batch.sold, []);
  assert.strictEqual(batch.closet, null, "a logged-out read must not report an empty closet — that is a selector failure signal");
}

// ── 7. A closet not read this pass is null, not empty ──────────────────────
//
// The distinction the server depends on: null means no evidence, [] with
// reachedEnd means the closet really is empty, which is a selector failure when
// listings are believed live.

{
  const soldOnly = O.buildBatch({ platform: "poshmark", nowIso: NOW, soldRaw: [] });
  assert.strictEqual(soldOnly.closet, null);

  const withCloset = O.buildBatch({
    platform: "poshmark",
    nowIso: NOW,
    soldRaw: [],
    closetRaw: [],
    coverage: { pagesRead: 1, reachedEnd: true },
  });
  assert.notStrictEqual(withCloset.closet, null);
  assert.deepStrictEqual(withCloset.closet.listingUrls, []);
}

// ── 8. A whole scraped row cannot smuggle PII through the batch ────────────

{
  const batch = O.buildBatch({
    platform: "poshmark",
    nowIso: NOW,
    soldRaw: [{
      listingUrl: "https://poshmark.com/listing/aaa",
      priceText: "$85",
      buyerName: "Jane Doe",
      shipping_address: "1 Main St",
    }],
  });
  const serialized = JSON.stringify(batch);
  assert.ok(!/Jane Doe/.test(serialized), "a buyer name reached the posted batch");
  assert.ok(!/1 Main St/.test(serialized), "a shipping address reached the posted batch");
}

// ── 9. AC9: the fixture guard, standing BEFORE the first fixture ───────────
//
// AC9 asks for node guards driven by saved HTML fixtures of the seller's own
// Poshmark pages, scrubbed of buyer details, with a test asserting no fixture
// carries a street address.
//
// THE FIXTURES CANNOT BE WRITTEN FROM HERE. An authentic Sold page needs a
// logged-in Poshmark account, which is the same human step `enabled: false`
// in sync/selectors.js is waiting on. THE GUARD CAN, and the ordering is the
// whole point: a scrubbing rule written AFTER the first fixture lands is a
// rule that never inspected the thing it exists for. This one is armed and
// empty, so the first fixture to arrive is checked on the commit that adds it.
//
// It PASSES on an empty directory deliberately — an absent fixture is a gap in
// coverage (recorded on US-2698, and the reason `enabled` is still false), not
// a leak. Failing here would only pressure someone to add a fixture to make a
// test go green, which is exactly the wrong incentive for a file that may
// contain a stranger's address.

{
  const fixtureDir = path.join(dir, "test", "fixtures");
  const files = fs.existsSync(fixtureDir)
    ? fs.readdirSync(fixtureDir).filter((f) => /\.html?$/i.test(f))
    : [];

  // Patterns that mean a scrub was missed. Deliberately about SHAPE rather
  // than about a name: "Jane Doe" is unguessable, "1 Main St" is not.
  const leaks = [
    [/\b\d{1,6}\s+[A-Z][a-z]+\s+(St|Street|Ave|Avenue|Rd|Road|Ln|Lane|Blvd|Dr|Drive|Way|Ct|Court)\b/,
      "a street address"],
    [/\b\d{5}(-\d{4})?\b(?![^<]*<\/(?:price|span class="price")>)/, "a US ZIP code"],
    [/\b[A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2}\b/, "a UK postcode"],
    [/\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/, "an email address"],
    [/\b(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/, "a phone number"],
  ];
  for (const name of files) {
    const html = fs.readFileSync(path.join(fixtureDir, name), "utf8");
    for (const [re, what] of leaks) {
      assert.ok(
        !re.test(html),
        `fixture ${name} contains what looks like ${what}. Scrub it before ` +
          `committing — these files are captured from a real account, and the ` +
          `whole reason the observer has an allowlist is that the page prints ` +
          `the buyer's details beside the price.`,
      );
    }
  }
}

console.log("sync-observe.test.cjs: ok");
