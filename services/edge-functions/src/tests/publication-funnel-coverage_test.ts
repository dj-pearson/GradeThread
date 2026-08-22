// US-2704 AC2: no eBay write reaches the wire without the snapshot funnel.
//
// WHY THIS IS A BUILD GATE AND NOT A REVIEW HABIT. Coverage cannot be
// backfilled. A description that was never snapshotted is gone, and the failure
// does not surface until a seller is in an INAD case months later - at which
// point the pack either has a gap or, worse, cites the text from a DIFFERENT
// revision as though it were the one that was live. That is manufactured
// evidence submitted under our signature, which is the one thing this epic must
// not ship.
//
// This repo has the same scar twice already: lib/pending-delists.ts and the
// EXTENSION_DELIST_PLATFORMS drift. Both were "just remember to call it".

import { assert, assertEquals } from "@std/assert";

const CLIENT = new URL("../lib/ebay-client.ts", import.meta.url);
const REFRESH = new URL("../routes/jobs-credentials-refresh.ts", import.meta.url);
const EBAY_ROUTE = new URL("../routes/flipdesk-ebay.ts", import.meta.url);

const FUNNEL = "recordPublication";

/** Comments stripped: a paragraph naming the funnel is not a call to it. */
function code(src: string): string {
  return src
    .replace(/\r\n/g, "\n")
    .replace(/\r\n?/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

const clientSrc = code(Deno.readTextFileSync(CLIENT));

/**
 * One exported function's body, by brace matching from its signature.
 *
 * Slicing to the next `export` would swallow a nested helper and pass on a
 * funnel call that belongs to the function AFTER the one being checked, which
 * is the failure mode that makes a source guard worthless.
 *
 * THE OPENING BRACE IS NOT THE FIRST ONE. `publishOffer` returns
 * `Promise<{ listingId: string }>` and `updateOfferFields` takes an inline
 * object type, so the first `{` after the name belongs to a TYPE. Taking it
 * yielded a 21-character "body" that contained no call to anything and would
 * have failed the guard for three functions that do call the funnel — a source
 * guard that lies in the safe direction is still a source guard that lies.
 *
 * So: walk the parameter list by paren depth, then walk the return type by
 * angle depth. The body opens at the first `{` seen with no angle bracket open.
 */
function bodyOf(src: string, name: string): string | null {
  const at = src.indexOf(`export async function ${name}(`);
  if (at === -1) return null;

  let i = src.indexOf("(", at);
  let parens = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") parens++;
    else if (src[i] === ")") {
      parens--;
      if (parens === 0) break;
    }
  }
  if (i >= src.length) return null;

  let angles = 0;
  let open = -1;
  for (i++; i < src.length; i++) {
    const c = src[i];
    if (c === "<") angles++;
    else if (c === ">") angles = Math.max(0, angles - 1);
    else if (c === "{" && angles === 0) {
      open = i;
      break;
    }
  }
  if (open === -1) return null;

  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, j + 1);
    }
  }
  return null;
}

// The five wire-level writes. Named individually rather than discovered, because
// a discovery rule that misses one fails silently and this is the file whose
// silence costs the most.
const WIRE_WRITES = [
  "createOrReplaceInventoryItem",
  "updateOfferFields",
  "updateOfferPrice",
  "publishOffer",
  "publishOfferByInventoryItemGroup",
];

Deno.test("US-2704: the guard can parse what it guards", () => {
  // Without this, a rename leaves every body null and every assertion below
  // vacuously true - the failure mode that makes source-scanning tests useless.
  assert(clientSrc.length > 10_000, "ebay-client.ts is missing or empty");
  for (const name of WIRE_WRITES) {
    const body = bodyOf(clientSrc, name);
    assert(body, `could not parse the body of ${name}`);
    // A LENGTH floor, because the first version of this parsed a 21-character
    // return type as three of the five bodies and reported them all as
    // uncovered. "Parsed something" is not "parsed the body".
    assert(
      body.length > 200,
      `${name}'s body parsed as ${body.length} characters — that is a type ` +
        "annotation, not a function body",
    );
  }
});

Deno.test("US-2704 AC2: every eBay wire write calls the snapshot funnel", () => {
  const missing = WIRE_WRITES.filter((n) => !(bodyOf(clientSrc, n) ?? "").includes(FUNNEL));
  assertEquals(
    missing,
    [],
    "these eBay writes reach the wire without recording what they published: " +
      missing.join(", ") + ". A missed door means the evidence pack cites a " +
      "description that was never live.",
  );
});

Deno.test("US-2704 AC2: the credentials-refresh cron goes through a covered write", () => {
  // The AC names this file. It re-pushes offers on a schedule, so it is the
  // path most likely to be the ONLY writer for weeks at a time - and the one
  // whose duplicates AC3's collapse exists to absorb.
  const src = code(Deno.readTextFileSync(REFRESH));
  assert(
    src.includes("updateOfferFields"),
    "the refresh cron no longer goes through updateOfferFields - if it now " +
      "writes to eBay another way, that way needs the funnel too",
  );
  assert(
    !/\/sell\/inventory\/v1\//.test(src),
    "the refresh cron calls the Inventory API directly, bypassing the covered " +
      "wrappers and therefore the snapshot",
  );
});

Deno.test("US-2704 AC2: the publish route records the FIRST publish, AFTER persist", () => {
  // The ordering the wire-level funnel cannot solve alone: the inventory item
  // is PUT at step 2 and the listings row is not written until step 5, so the
  // snapshot taken inside createOrReplaceInventoryItem has no listing to attach
  // to and correctly skips. The original description - the single most useful
  // row this table will ever hold - would otherwise never be recorded at all.
  //
  // THE ASSERTION IS ORDERING, NOT PRESENCE, and the first version of it was
  // wrong in the way this whole story is about. It asserted only that the file
  // MENTIONS the funnel, so commenting out the call left the helper's
  // definition behind and the guard passed - a guard confirming its own
  // scaffolding. Sabotage caught it. What matters is that a record happens
  // after the listings row exists, so that is what is checked.
  const src = code(Deno.readTextFileSync(EBAY_ROUTE));
  const persistAt = src.indexOf("finalizePublishedListing({");
  assert(persistAt > 0, "the publish route no longer persists through finalizePublishedListing");
  const after = src.slice(persistAt);
  assert(
    after.includes(FUNNEL) || after.includes("recordFirstPublish()"),
    "nothing records a publication AFTER the listings row is persisted, so a " +
      "listing's ORIGINAL description is never snapshotted - the wire-level " +
      "funnel cannot do it, because at that point the row does not exist yet",
  );
});

Deno.test("US-2704 AC2: nothing outside the funnel writes the table", () => {
  // One writer. A second insert site would drift from the collapse rule and
  // start writing the duplicate rows AC3 exists to prevent.
  const files: string[] = [];
  // Plain path joining, not URL joining: `new URL(name, dir)` yields a
  // "/C:/..." pathname that Deno.readTextFileSync cannot open on Windows.
  const root = new URL("../", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "");
  function walk(dir: string) {
    for (const entry of Deno.readDirSync(dir)) {
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory) walk(child);
      else if (entry.name.endsWith(".ts")) files.push(child);
    }
  }
  walk(root);

  const offenders: string[] = [];
  for (const path of files) {
    if (path.endsWith("listing-publications.ts")) continue;
    if (path.includes("/tests/")) continue;
    const src = code(Deno.readTextFileSync(path));
    if (/from\(\s*["']listing_publications["']\s*\)/.test(src)) {
      offenders.push(path.split("/src/")[1] ?? path);
    }
  }
  assertEquals(
    offenders,
    [],
    "these files write listing_publications directly instead of through the " +
      "funnel: " + offenders.join(", "),
  );
});
