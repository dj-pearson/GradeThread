// US-2963: the credentials cron refreshes a block-backed listing by RENDERING.
//   deno test --allow-read src/tests/credentials-refresh-blocks_test.ts
//
// Pure functions and source assertions — no env, no Supabase, no eBay. The cron
// itself is integration-shaped (a job secret, a lock, two eBay calls per dirty
// listing), so what is asserted here is the property the story is actually
// about: a re-render moves the credential block and nothing else, and the cron
// takes the render path rather than the div walk when blocks exist.
//
// WHY THE DIV WALK HAD TO GO. findSellerCredentialBlock gives up on an unclosed
// element or after MAX_TAG_SCAN tags, and its only safe answer is null. The loop
// reads null as "this listing has no block" and skips it — every run, forever,
// with no error and no log line. One malformed description defeated the refresh
// permanently and silently. A render cannot be defeated that way, because it
// never reads the old markup at all.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type DescriptionBlock,
  type RenderContext,
  renderDescription,
} from "../lib/description-blocks.ts";
import {
  buildSellerCredentialBlock,
  SELLER_CREDENTIALS_MARKER,
} from "../lib/seller-credentials.ts";

const cronSrc = Deno.readTextFileSync(
  new URL("../routes/jobs-credentials-refresh.ts", import.meta.url),
);
const renderSrc = Deno.readTextFileSync(
  new URL("../lib/description-render.ts", import.meta.url),
);

// ─── Fixtures ──────────────────────────────────────────────────────

const OLD_CREDENTIAL = {
  handle: "pearson",
  display_name: "Pearson Mercantile",
  stats: { total_graded: 13, average_grade: 8.1 },
};
const NEW_CREDENTIAL = {
  handle: "pearson",
  display_name: "Pearson Mercantile",
  stats: { total_graded: 23, average_grade: 8.3 },
};

function ctx(credential: typeof OLD_CREDENTIAL | null): RenderContext {
  return {
    item: {
      brand: "Veronica Beard",
      size: "8",
      color: "Black",
      material: null,
      measurements: { waist: 15, inseam: 29, length: 39.5 },
    },
    grade: null,
    credential,
    snippets: {},
    unit: "in",
  };
}

const BLOCKS: DescriptionBlock[] = [
  { key: "intro", on: true, src: "ai", text: "Jogger-style pants, new with tags." },
  { key: "features", on: true, src: "ai", text: "Elastic drawstring waist." },
  { key: "attributes", on: true, src: "item", fields: ["brand", "size", "color"] },
  { key: "measurements", on: true, src: "item", unit: "in" },
  { key: "credentials", on: true, src: "seller" },
  { key: "facts", on: true, src: "system" },
];

// ─── AC4: the refresh moves the badge and nothing else ─────────────

Deno.test("AC4: re-rendering swaps the credential and leaves every other block byte-identical", () => {
  const before = renderDescription(BLOCKS, ctx(OLD_CREDENTIAL));
  const after = renderDescription(BLOCKS, ctx(NEW_CREDENTIAL));

  assert(before !== after, "the refreshed stats have to actually change something");
  assertStringIncludes(before, "13 items");
  assertStringIncludes(after, "23 items");

  // Everything up to the credential marker is the same bytes. That is the whole
  // guarantee: a badge refresh must not restate a measurement or reword an
  // intro on a listing a buyer is already reading.
  const cut = before.indexOf(SELLER_CREDENTIALS_MARKER);
  assert(cut > 0, "the fixture must carry a credential block");
  assertEquals(after.indexOf(SELLER_CREDENTIALS_MARKER), cut);
  assertEquals(after.slice(0, cut), before.slice(0, cut));

  // And the fresh block is emitted verbatim after the marker, which is what
  // lets the cron decide freshness with a substring instead of a render.
  assertStringIncludes(after, buildSellerCredentialBlock(NEW_CREDENTIAL).html);
});

Deno.test("AC4: a malformed credential block cannot defeat the render", () => {
  // The exact shape the div walk refuses: an unclosed element after the marker.
  // findSellerCredentialBlock returns null for it, and the legacy loop reads
  // that as "no block". The render never looks at the old markup, so the same
  // listing comes out correct.
  const mangled =
    `Prose.\n\n${SELLER_CREDENTIALS_MARKER}<div class="gt"><span>13 items graded`;
  const rendered = renderDescription(BLOCKS, ctx(NEW_CREDENTIAL));
  assertStringIncludes(mangled, "13 items");
  assertStringIncludes(rendered, "23 items");
  assert(
    !rendered.includes("<span>13 items graded"),
    "the render is built from blocks, so the broken markup is simply gone",
  );
});

Deno.test("a credentials block switched off renders nothing, which the cron refuses to persist", () => {
  const off = BLOCKS.map((b) =>
    b.key === "credentials" ? { ...b, on: false } : b
  );
  const rendered = renderDescription(off, ctx(NEW_CREDENTIAL));
  assert(!rendered.includes(SELLER_CREDENTIALS_MARKER));
  // The cron's guard, which is what stops that render reaching a live listing.
  assertStringIncludes(cronSrc, "if (!fresh.description.includes(html))");
  assertStringIncludes(cronSrc, "credentials_refresh.render_would_drop_block");
});

// ─── AC1 + AC2 + AC3: the cron takes the right path ────────────────

Deno.test("AC1: a block-backed listing is persisted by renderAndPersistDescription", () => {
  assertStringIncludes(cronSrc, "if (blocks?.length) {");
  const start = cronSrc.indexOf("if (blocks?.length) {");
  const end = cronSrc.indexOf("// ── The legacy path", start);
  assert(end > start, "the two paths must be separable to assert on either");
  const branch = cronSrc.slice(start, end);

  assertStringIncludes(branch, "renderListingDescription(");
  assertStringIncludes(branch, "renderAndPersistDescription(");
});

Deno.test("AC3: the div walk is not on the block-backed write path", () => {
  const start = cronSrc.indexOf("if (blocks?.length) {");
  const end = cronSrc.indexOf("// ── The legacy path", start);
  const branch = cronSrc.slice(start, end);

  assert(
    !branch.includes("refreshSellerCredentialBlock("),
    "the block path must not call the div-walking swap",
  );
  assert(
    !branch.includes("findSellerCredentialBlock("),
    "nor the walk itself",
  );
  // The presence check that keeps the never-inject rule is a plain marker test.
  assertStringIncludes(branch, "dbDesc.includes(SELLER_CREDENTIALS_MARKER)");
});

Deno.test("AC2: a listing with no blocks still takes the legacy path", () => {
  const legacy = cronSrc.slice(cronSrc.indexOf("// ── The legacy path"));
  assertStringIncludes(legacy, "refreshSellerCredentialBlock(dbDesc, html)");
  assertStringIncludes(legacy, "result.no_block++");
});

Deno.test("the never-inject rule survives on both paths", () => {
  // A refresh that ADDED a badge would be putting marketing copy into a
  // description the seller wrote. Both paths answer "no block, skip".
  assertEquals((cronSrc.match(/result\.no_block\+\+/g) ?? []).length, 2);
});

Deno.test("freshness is a substring test, so a steady-state run costs nothing extra", () => {
  const start = cronSrc.indexOf("if (blocks?.length) {");
  const branch = cronSrc.slice(start, cronSrc.indexOf("// ── The legacy path", start));
  const freshAt = branch.indexOf("dbDesc.includes(html)");
  const renderAt = branch.indexOf("renderListingDescription(");
  assert(freshAt > 0, "the cheap freshness check must exist");
  assert(
    freshAt < renderAt,
    "it has to come BEFORE the render — otherwise every scanned listing pays " +
      "three queries per run to be told nothing changed",
  );
});

// ─── The render/persist split this story needed ────────────────────

Deno.test("renderListingDescription writes nothing", () => {
  const start = renderSrc.indexOf("export async function renderListingDescription");
  const end = renderSrc.indexOf("export async function renderAndPersistDescription");
  assert(start > 0 && end > start);
  const body = renderSrc.slice(start, end);
  assert(!body.includes(".update("), "the read half must not write");
  assertStringIncludes(body, "const description = renderDescription(next, ctx);");
});

Deno.test("the unit is stamped onto measurement blocks at the single write path", () => {
  // Without this, a background re-render has no seller preference to pass and
  // a centimetre seller's live listing would come back in inches — the numbers
  // a buyer is reading changing because a badge needed refreshing.
  assertStringIncludes(renderSrc, "function stampUnit(");
  assertStringIncludes(renderSrc, "stampUnit(blocks ?? blocksForListing(listing, ctx), unit)");
  const start = renderSrc.indexOf("function stampUnit(");
  const body = renderSrc.slice(start, renderSrc.indexOf("\n}", start));
  assertStringIncludes(body, 'b.key !== "measurements" || b.unit');
});

Deno.test("an explicit unit on a block wins over the caller's", () => {
  const cm: DescriptionBlock[] = BLOCKS.map((b) =>
    b.key === "measurements" ? { ...b, unit: "cm" as const } : b
  );
  const rendered = renderDescription(cm, ctx(NEW_CREDENTIAL));
  assertStringIncludes(rendered, "cm");
});
