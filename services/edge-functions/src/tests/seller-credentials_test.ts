// US-1126: the verified-seller credential block embedded in listing descriptions.
// Pure renderer — no DB, no env.
//
// eBay-policy hardening: NO variant may carry a URL or an <a> tag. eBay hides
// listings whose description links off-eBay (observed policy hit, ref
// 2-106523659851), and the other marketplaces the plain variant reaches
// (Poshmark, Mercari) prohibit external links too. The trust signal is
// text-only: brand + handle + stats.

import { assert, assertEquals } from "@std/assert";
import {
  buildSellerCredentialBlock,
  classifyRefreshSkip,
  findSellerCredentialBlock,
  locateSellerCredentialBlock,
  refreshSellerCredentialBlock,
  SELLER_CREDENTIALS_MARKER,
  type SellerCredential,
} from "../lib/seller-credentials.ts";

const BASE: SellerCredential = {
  handle: "fadedglory",
  display_name: "Faded Glory Vintage",
  stats: { total_graded: 42, average_grade: 8.3 },
};

Deno.test("credential block carries name + stats in every rendering", () => {
  const b = buildSellerCredentialBlock(BASE, "https://gradethread.com");
  for (const text of [b.plain, b.markdown, b.html]) {
    assert(text.includes("Faded Glory Vintage"), "carries the display name");
    assert(text.includes("8.3"), "carries the average grade");
    assert(text.includes("42"), "carries the graded count");
    assert(text.includes("fadedglory"), "carries the handle (searchable)");
  }
});

Deno.test("NO variant carries a URL or link — eBay hides off-eBay links", () => {
  const b = buildSellerCredentialBlock(BASE, "https://gradethread.com");
  for (const text of [b.plain, b.markdown, b.html]) {
    assert(!/https?:\/\//i.test(text), "no URL in any variant");
    assert(!text.includes("/verified/"), "no profile path in any variant");
  }
  assert(!/<a\b/i.test(b.html), "no anchor tag in the html variant");
  assert(!/\]\(/.test(b.markdown), "no markdown link");
});

Deno.test("credential block omits the stats line when no grades yet", () => {
  const b = buildSellerCredentialBlock({
    ...BASE,
    stats: { total_graded: 0, average_grade: 0 },
  });
  // Badge + verify pointer still present...
  assert(b.plain.includes("Verify grades at GradeThread"));
  assert(b.html.includes("Verified Seller"));
  // ...but no "0 items" / average line.
  assert(!b.plain.includes("independently graded"));
  assert(!b.html.includes("average condition grade"));
});

Deno.test("singular item label for exactly one grade", () => {
  const b = buildSellerCredentialBlock({
    ...BASE,
    stats: { total_graded: 1, average_grade: 9 },
  });
  assert(b.plain.includes("1 item independently graded"));
  assert(!b.plain.includes("1 items"));
});

Deno.test("falls back to handle when no display name", () => {
  const b = buildSellerCredentialBlock({ ...BASE, display_name: null });
  assert(b.plain.includes("fadedglory"));
});

Deno.test("html escapes the display name", () => {
  const b = buildSellerCredentialBlock({
    ...BASE,
    display_name: `Bob & "Co" <script>`,
  });
  assert(b.html.includes("Bob &amp; &quot;Co&quot; &lt;script&gt;"));
  assert(!b.html.includes("<script>"));
});

Deno.test("default site url param is accepted and still emits no link", () => {
  const b = buildSellerCredentialBlock(BASE);
  assertEquals(/https?:\/\//i.test(b.plain), false);
});

// ══════════════════════════════════════════════════════════════════
// US-2272: in-place refresh of a published block
// ══════════════════════════════════════════════════════════════════

/** A real published eBay description, block frozen at 13 graded items. */
const STALE = buildSellerCredentialBlock({
  handle: "pearson",
  display_name: "Pearson Mercantile",
  stats: { total_graded: 13, average_grade: 8.2 },
}).html;

/** The same seller today. */
const FRESH = buildSellerCredentialBlock({
  handle: "pearson",
  display_name: "Pearson Mercantile",
  stats: { total_graded: 19, average_grade: 8.2 },
}).html;

const PUBLISHED = "Please refer to photos for full visual condition details. " +
  "Smoke-free environment.\n" +
  `<!--gradethread-disclosure--><div style="x"><div>Defects: light pilling</div></div>\n` +
  SELLER_CREDENTIALS_MARKER + STALE +
  "\n\nGraded by GradeThread — Condition Grade 7.9 — Cert #GT-X9RQ0J6";

Deno.test("US-2272: refresh swaps ONLY the credential block", () => {
  const next = refreshSellerCredentialBlock(PUBLISHED, FRESH);
  assert(next !== null);
  assert(next!.includes("19 items independently graded"), "renders the new count");
  assert(!next!.includes("13 items"), "the stale count is gone");
  // Everything around it survives byte-for-byte — especially the cert line,
  // which sits AFTER the block (applyGradeListingPromotion appends it last).
  assert(next!.startsWith("Please refer to photos"), "body copy intact");
  assert(next!.includes("Smoke-free environment."), "body copy intact");
  assert(
    next!.endsWith("Graded by GradeThread — Condition Grade 7.9 — Cert #GT-X9RQ0J6"),
    "the trailing grade/cert line is NOT swallowed",
  );
  assert(next!.includes("Defects: light pilling"), "disclosure block intact");
  assertEquals(next!.split(SELLER_CREDENTIALS_MARKER).length - 1, 1, "exactly one marker");
});

Deno.test("US-2272: refresh is idempotent — a fresh block returns unchanged", () => {
  const once = refreshSellerCredentialBlock(PUBLISHED, FRESH)!;
  const twice = refreshSellerCredentialBlock(once, FRESH);
  assertEquals(twice, once, "second pass is a no-op the caller can skip");
});

Deno.test("US-2272: refresh NEVER injects a block into a description without one", () => {
  const plain = "Nice shirt. Smoke-free home.\n\nGraded by GradeThread — Condition Grade 8.0";
  assertEquals(refreshSellerCredentialBlock(plain, FRESH), null);
  assertEquals(findSellerCredentialBlock(plain), null);
});

Deno.test("US-2272: an unrecognised shape after the marker is left alone", () => {
  // Marker with no element after it (an eBay-side edit stripped the markup).
  assertEquals(
    refreshSellerCredentialBlock(`Body\n${SELLER_CREDENTIALS_MARKER}13 items graded`, FRESH),
    null,
  );
  // Unclosed div — refuse rather than guess where the block ends.
  assertEquals(
    refreshSellerCredentialBlock(
      `Body\n${SELLER_CREDENTIALS_MARKER}<div><div>13 items</div>`,
      FRESH,
    ),
    null,
  );
});

Deno.test("US-2272: nested divs of any depth close correctly", () => {
  const deep = `<div a><div b><div c>13 items</div></div></div>`;
  const desc = `Body\n${SELLER_CREDENTIALS_MARKER}${deep}\n\nTail line`;
  const span = findSellerCredentialBlock(desc);
  assert(span !== null);
  assertEquals(span!.html, deep, "span covers the whole outer element, no more");
  const next = refreshSellerCredentialBlock(desc, FRESH)!;
  assert(next.endsWith("Tail line"), "tail survives");
  assert(!next.includes("13 items"));
});

Deno.test("US-2272: a block with no stats line still refreshes", () => {
  // A seller opted in before their first grade landed: badge + verify pointer
  // only, two inner divs instead of three.
  const empty = buildSellerCredentialBlock({
    handle: "pearson",
    display_name: "Pearson Mercantile",
    stats: { total_graded: 0, average_grade: 0 },
  }).html;
  const desc = `Body\n${SELLER_CREDENTIALS_MARKER}${empty}\n\nGraded by GradeThread`;
  const next = refreshSellerCredentialBlock(desc, FRESH);
  assert(next !== null);
  assert(next!.includes("19 items independently graded"), "stats line appears");
  assert(next!.endsWith("Graded by GradeThread"));
});

// ─── US-3028: why the walk failed, not just that it did ────────────
//
// `findSellerCredentialBlock` answers null for four different situations and
// the refresh cron counted all four as "this listing has no block". Three of
// them are a stale badge nobody can see: the description HAS a block, the walk
// just could not parse it, and the listing is skipped every run forever. The
// reason has to survive the return so the cron can log and count it.

Deno.test("US-3028: no marker at all is `absent`", () => {
  const r = locateSellerCredentialBlock("<p>Just body copy.</p>");
  assertEquals(r.found, false);
  assertEquals(r.found === false && r.reason, "absent");
});

Deno.test("US-3028: marker with no element after it is `no-element`", () => {
  const r = locateSellerCredentialBlock(
    `<p>body</p>${SELLER_CREDENTIALS_MARKER}42 items independently graded`,
  );
  assertEquals(r.found, false);
  assertEquals(r.found === false && r.reason, "no-element");
});

Deno.test("US-3028: a block that never closes is `unclosed`", () => {
  const r = locateSellerCredentialBlock(
    `<p>body</p>${SELLER_CREDENTIALS_MARKER}<div>42 items independently graded`,
  );
  assertEquals(r.found, false);
  assertEquals(r.found === false && r.reason, "unclosed");
});

Deno.test("US-3028: a description with more divs than the cap is `scan-limit`", () => {
  const r = locateSellerCredentialBlock(
    `${SELLER_CREDENTIALS_MARKER}<div>${"<div></div>".repeat(300)}</div>`,
  );
  assertEquals(r.found, false);
  assertEquals(r.found === false && r.reason, "scan-limit");
});

Deno.test("US-3028: a block that parses reports the same span as findSellerCredentialBlock", () => {
  const desc = `<p>body</p>${SELLER_CREDENTIALS_MARKER}<div><span>42 items</span></div>\nCert #GT-X9RQ0J6`;
  const r = locateSellerCredentialBlock(desc);
  assert(r.found);
  assertEquals(r.found === true ? r.span : null, findSellerCredentialBlock(desc));
});

Deno.test("US-3028: findSellerCredentialBlock still answers null for all four", () => {
  for (
    const desc of [
      "<p>body</p>",
      `${SELLER_CREDENTIALS_MARKER}not an element`,
      `${SELLER_CREDENTIALS_MARKER}<div>unclosed`,
      `${SELLER_CREDENTIALS_MARKER}<div>${"<div></div>".repeat(300)}</div>`,
    ]
  ) {
    assertEquals(findSellerCredentialBlock(desc), null);
  }
});

// ─── US-3028: what the refresh cron's skip actually meant ──────────

Deno.test("US-3028: a legacy description with no marker skips as no_marker", () => {
  assertEquals(classifyRefreshSkip(null, "<p>body</p>"), {
    skip: true,
    kind: "no_marker",
  });
});

Deno.test("US-3028: a legacy description with an unparseable block skips as unparseable", () => {
  assertEquals(
    classifyRefreshSkip(null, `${SELLER_CREDENTIALS_MARKER}<div>never closed`),
    { skip: true, kind: "unparseable", reason: "unclosed" },
  );
  assertEquals(
    classifyRefreshSkip(null, `${SELLER_CREDENTIALS_MARKER}42 items graded`),
    { skip: true, kind: "unparseable", reason: "no-element" },
  );
});

Deno.test("US-3028: a legacy description with a parseable block is not skipped", () => {
  assertEquals(
    classifyRefreshSkip(null, `${SELLER_CREDENTIALS_MARKER}<div>42 items</div>`),
    { skip: false },
  );
});

Deno.test("US-3028: a block-backed listing needs only the marker, not a clean walk", () => {
  const blocks = [{ key: "credentials" }];
  // The walk would fail here; the render path does not care, because it never
  // reads the old markup.
  assertEquals(
    classifyRefreshSkip(blocks, `${SELLER_CREDENTIALS_MARKER}<div>unclosed`),
    { skip: false },
  );
});

Deno.test("US-3028: blocks say credentials but the stored string has no marker", () => {
  assertEquals(classifyRefreshSkip([{ key: "credentials" }], "<p>body</p>"), {
    skip: true,
    kind: "blocks_disagree",
  });
});

Deno.test("US-3028: a block-backed listing that simply has no credentials block", () => {
  assertEquals(
    classifyRefreshSkip([{ key: "title" }, { key: "measurements" }], "<p>body</p>"),
    { skip: true, kind: "no_marker" },
  );
});
