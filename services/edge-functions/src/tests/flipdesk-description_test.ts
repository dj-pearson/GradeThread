// US-2958: the description-block routes and the single persist path.
//
//   deno test --allow-env --allow-read src/tests/flipdesk-description_test.ts
//
// Two kinds of test here, and the split is deliberate. The block-array logic is
// pure, so it is exercised directly. The persistence and tenant rules are
// properties of code that talks to Postgres, so they are asserted against the
// SOURCE: that one update writes both columns, that the read path writes
// nothing at all, and that every handler resolves the workspace owner. A source
// assertion is weaker than an integration test and stronger than a comment —
// and the integration coverage exists, in tenant-isolation_test.ts, which runs
// these four routes against a real two-tenant fixture.
// US-2379: FIRST import. Reading parseBlocks from the route pulls in
// description-render.ts and therefore lib/supabase.ts, which reads env at
// import time — so the env has to be in place before that chain loads, or
// this file only passes when another test happened to run before it.
import "./_env.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { replaceBlockText } from "../lib/description-blocks.ts";
import type { DescriptionBlock } from "../lib/description-blocks.ts";
import { parseBlocks } from "../routes/flipdesk-description.ts";

const routeSrc = Deno.readTextFileSync(
  new URL("../routes/flipdesk-description.ts", import.meta.url),
);
const renderSrc = Deno.readTextFileSync(
  new URL("../lib/description-render.ts", import.meta.url),
);
const mainSrc = Deno.readTextFileSync(new URL("../main.ts", import.meta.url));

// ─── AC2 + AC8: the four routes exist and are mounted ──────────────

Deno.test("AC2: all four routes are declared", () => {
  assertStringIncludes(routeSrc, '.get("/:listingId/blocks"');
  assertStringIncludes(routeSrc, '.post("/preview"');
  assertStringIncludes(routeSrc, '.post("/:listingId/save"');
  assertStringIncludes(routeSrc, '.post("/:listingId/regenerate"');
});

Deno.test("AC2: the router is mounted in main.ts", () => {
  assertStringIncludes(
    mainSrc,
    'app.route("/api/flipdesk/description", flipdeskDescriptionRoutes)',
  );
});

Deno.test("AC8: the mount carries auth, the access gate and the workspace resolver", () => {
  // Without these, c.get("userId") is undefined and every handler would fall
  // back to scoping on `undefined` — which is not a narrower query, it is a
  // broken one. This is the mistake flipdesk-auth-coverage_test.ts exists for;
  // asserting it here too keeps the failure local to this story.
  for (const mw of ["authMiddleware", "accessGateMiddleware", "workspaceMiddleware"]) {
    assertStringIncludes(mainSrc, `app.use("/api/flipdesk/description/*", ${mw});`);
  }
});

Deno.test("the model call is rate-limited harder than the render", () => {
  // Preview fires on a 400ms debounce as the seller types; regenerate is a
  // model call. One bucket for both would either throttle typing or leave the
  // expensive endpoint wide open.
  assertStringIncludes(routeSrc, "/regenerate");
  assertStringIncludes(mainSrc, '"flipdesk-description-regen"');
  assertStringIncludes(mainSrc, '"flipdesk-description"');
  const regenAt = mainSrc.indexOf('"/api/flipdesk/description/*/regenerate"');
  const broadAt = mainSrc.indexOf('app.use("/api/flipdesk/description/*", rateLimiter');
  assert(regenAt > 0 && broadAt > 0, "both rate-limit rules must exist");
  assert(
    regenAt < broadAt,
    "the regenerate limit must be registered FIRST — Hono runs middleware in " +
      "registration order, so the broad rule would otherwise be the only one " +
      "that counted",
  );
});

// ─── AC1 + AC6: one update, both columns ───────────────────────────

Deno.test("AC1: renderAndPersistDescription writes both columns in ONE update", () => {
  const updates = renderSrc.match(/\.update\(/g) ?? [];
  assertEquals(
    updates.length,
    1,
    "a second update would open a window where the blocks and the published " +
      "string disagree, and the string is what eBay receives",
  );
  const at = renderSrc.indexOf(".update(");
  const stmt = renderSrc.slice(at, at + 300);
  assertStringIncludes(stmt, "description_blocks");
  assertStringIncludes(stmt, "listing_description");
});

Deno.test("AC6: the persisted string is the render of the persisted blocks", () => {
  // Same `next` feeds both the render and the update, so they cannot diverge.
  // US-3114: the render goes through `renderSegments`, and the string is those
  // segments glued — one render, so the pieces the composer lets a seller click
  // and the bytes eBay receives cannot be two different things.
  assertStringIncludes(renderSrc, "const segments = renderSegments(next, ctx);");
  assertStringIncludes(
    renderSrc,
    'const description = segments.map((s) => s.sep + s.body).join("");',
  );
  assertStringIncludes(renderSrc, "description_blocks: next,");
  assertStringIncludes(renderSrc, "listing_description: description,");
});

// ─── AC3: the read path writes nothing ─────────────────────────────

Deno.test("AC3: the blocks GET handler performs no write", () => {
  const start = routeSrc.indexOf('.get("/:listingId/blocks"');
  const end = routeSrc.indexOf(".post(", start);
  const handler = routeSrc.slice(start, end);
  assert(!handler.includes(".update("), "GET /blocks must not write");
  assert(
    !handler.includes("renderAndPersistDescription"),
    "GET /blocks must not persist — the seller's first save does that",
  );
  assertStringIncludes(handler, "blocksForListing");
});

Deno.test("AC3: blocksForListing converts a legacy string without persisting", () => {
  assertStringIncludes(renderSrc, "parseLegacyDescription(listing.listing_description, ctx)");
  const start = renderSrc.indexOf("export function blocksForListing");
  const body = renderSrc.slice(start, start + 600);
  assert(!body.includes(".update("), "conversion must not write");
});

// ─── AC4: every handler resolves the workspace owner ───────────────

Deno.test("AC4: every handler scopes on workspaceOwnerId ?? userId", () => {
  const handlers = routeSrc.split(/flipdeskDescriptionRoutes\.(?:get|post)\(/).slice(1);
  // Four from US-2958, plus the snippet apply route US-2961 added. The count is
  // asserted so a handler added without the owner resolution below cannot slip
  // in as an untested fifth.
  assertEquals(handlers.length, 5, "expected exactly five handlers");
  for (const h of handlers) {
    assertStringIncludes(h, 'c.get("workspaceOwnerId") ?? c.get("userId")');
  }
});

Deno.test("AC4: the listing is only ever reached through the owner-scoped loader", () => {
  assert(
    !routeSrc.includes('.from("listings")'),
    "the route must not query listings directly — loadOwnedListing owns that",
  );
  assertStringIncludes(renderSrc, '.eq("inventory_items.user_id", ownerId)');
});

// ─── AC5: preview needs a listing, not a payload ───────────────────

Deno.test("AC5: preview requires listing_id", () => {
  const start = routeSrc.indexOf('.post("/preview"');
  const end = routeSrc.indexOf('.post("/:listingId/save"', start);
  const handler = routeSrc.slice(start, end);
  assertStringIncludes(handler, "listing_id is required");
  assertStringIncludes(handler, "loadOwnedListing");
  assert(
    !/body\.(item|measurements|brand)/.test(handler),
    "preview must not accept a free-floating item payload",
  );
});

// ─── AC7: regenerate touches exactly one block ─────────────────────

Deno.test("AC7: replaceBlockText changes one block and leaves the rest identical", () => {
  const blocks: DescriptionBlock[] = [
    { key: "intro", on: true, src: "ai", text: "old intro" },
    { key: "features", on: true, src: "ai", text: "old features" },
    { key: "measurements", on: true, src: "item", unit: "cm" },
    { key: "snippet", on: false, src: "account", ref: "s1", sep: "\n" },
  ];
  const next = replaceBlockText(blocks, "features", "new features");

  assertEquals(next[1].text, "new features");
  // Byte-identical, and the same object: nothing was rebuilt.
  assertEquals(next[0], blocks[0]);
  assertEquals(next[2], blocks[2]);
  assertEquals(next[3], blocks[3]);
  assert(next[0] === blocks[0], "untouched blocks are carried by reference");
  assert(next[2] === blocks[2]);
  // The original array is not mutated.
  assertEquals(blocks[1].text, "old features");
});

Deno.test("AC7: only the FIRST block with that key is replaced", () => {
  const blocks: DescriptionBlock[] = [
    { key: "intro", on: true, src: "ai", text: "first" },
    { key: "intro", on: true, src: "ai", text: "second" },
  ];
  const next = replaceBlockText(blocks, "intro", "fresh");
  assertEquals(next[0].text, "fresh");
  assertEquals(next[1].text, "second");
});

Deno.test("AC7: a missing block is appended, not silently skipped", () => {
  const blocks: DescriptionBlock[] = [
    { key: "intro", on: true, src: "ai", text: "hello" },
  ];
  const next = replaceBlockText(blocks, "features", "added");
  assertEquals(next.length, 2);
  assertEquals(next[1], { key: "features", on: true, src: "ai", text: "added" });
});

Deno.test("AC7: regenerate refuses a non-AI block", () => {
  const start = routeSrc.indexOf('.post("/:listingId/regenerate"');
  const handler = routeSrc.slice(start);
  assertStringIncludes(handler, "AI_KEYS.has(key)");
  assertStringIncludes(routeSrc, 'const AI_KEYS = new Set<DescriptionBlockKey>(["intro", "features", "condition"])');
});

Deno.test("AC7: a failed rewrite leaves the description untouched", () => {
  const start = routeSrc.indexOf('.post("/:listingId/regenerate"');
  const handler = routeSrc.slice(start);
  const failAt = handler.indexOf("text === null");
  const persistAt = handler.indexOf("renderAndPersistDescription");
  assert(failAt > 0, "the null return must be handled");
  assert(
    failAt < persistAt,
    "the failure must short-circuit BEFORE anything is written",
  );
});

Deno.test("regenerate denies the foreign listing BEFORE calling the model", () => {
  // Otherwise a rejected request still bills the workspace for a rewrite.
  const start = routeSrc.indexOf('.post("/:listingId/regenerate"');
  const handler = routeSrc.slice(start);
  const ownerCheck = handler.indexOf("if (!listing) return c.json");
  const modelCall = handler.indexOf("regenerateDescriptionBlock");
  assert(ownerCheck > 0 && modelCall > 0);
  assert(ownerCheck < modelCall, "ownership must be settled before the model call");
});

// ─── Request validation ────────────────────────────────────────────

Deno.test("parseBlocks accepts a well-formed array", () => {
  const out = parseBlocks([
    { key: "intro", on: true, src: "ai", text: "hi" },
    { key: "measurements", on: false, src: "item", unit: "cm" },
    { key: "snippet", on: true, src: "account", ref: "abc", sep: "\n\n\n" },
  ]);
  assert(out);
  assertEquals(out.length, 3);
  assertEquals(out[1].unit, "cm");
  assertEquals(out[2].sep, "\n\n\n");
});

Deno.test("parseBlocks REJECTS an unknown key rather than dropping it", () => {
  // Dropping would delete a section of the seller's description on a version
  // skew, and report success while doing it.
  assertEquals(parseBlocks([{ key: "sponsored", on: true, src: "ai" }]), null);
});

Deno.test("parseBlocks rejects a non-array and non-object entries", () => {
  assertEquals(parseBlocks("blocks"), null);
  assertEquals(parseBlocks({ key: "intro" }), null);
  assertEquals(parseBlocks([null]), null);
  assertEquals(parseBlocks([42]), null);
});

Deno.test("parseBlocks defaults `on` to true but honours an explicit false", () => {
  assertEquals(parseBlocks([{ key: "intro", src: "ai" }])?.[0].on, true);
  assertEquals(parseBlocks([{ key: "intro", src: "ai", on: false }])?.[0].on, false);
});

Deno.test("parseBlocks drops a bogus unit rather than rejecting the block", () => {
  const out = parseBlocks([{ key: "measurements", on: true, src: "item", unit: "furlongs" }]);
  assert(out);
  assertEquals(out[0].unit, undefined);
});

// ─── US-2961: apply a snippet edit to the drafts referencing it ─────

Deno.test("US-2961: the apply route is declared and owner-scoped", () => {
  assertStringIncludes(routeSrc, '.post("/snippets/:snippetId/apply"');
  const start = routeSrc.indexOf('.post("/snippets/:snippetId/apply"');
  const handler = routeSrc.slice(start);
  assertStringIncludes(handler, 'c.get("workspaceOwnerId") ?? c.get("userId")');
  assertStringIncludes(handler, "applySnippetToDrafts(snippetId, ownerId)");
});

Deno.test("US-2961: a foreign or unknown snippet gets the same 404", () => {
  // Two different answers would make the route an oracle: a caller could learn
  // that a guessed id belongs to somebody by the shape of the refusal.
  const start = routeSrc.indexOf('.post("/snippets/:snippetId/apply"');
  const handler = routeSrc.slice(start);
  assertStringIncludes(handler, "Snippet not found");
  assertEquals((handler.match(/c\.json\(\{ error/g) ?? []).length, 1);
});

Deno.test("US-2961: the snippet is ownership-checked before anything is rewritten", () => {
  const start = renderSrc.indexOf("export async function applySnippetToDrafts");
  const body = renderSrc.slice(start);
  const ownerCheck = body.indexOf('.eq("user_id", ownerId)');
  const listingRead = body.indexOf('.from("listings")');
  assert(ownerCheck > 0, "the snippet load must scope on user_id");
  assert(
    ownerCheck < listingRead,
    "the snippet has to be proven the caller's BEFORE any listing is read — " +
      "otherwise a foreign id decides which rows get rewritten",
  );
});

Deno.test("US-2961: apply touches drafts and only drafts", () => {
  // The safety property of the whole feature. A published listing's description
  // is live copy on eBay; rewriting it from a settings dialog would be an
  // outward-facing change nobody asked for. The filter is on the QUERY, so no
  // caller can widen it.
  const start = renderSrc.indexOf("export async function applySnippetToDrafts");
  const body = renderSrc.slice(start);
  assertStringIncludes(body, '.eq("listing_status", "draft")');
  assert(
    !/listing_status["\s,)]*[^d]/.test(body.replace('.eq("listing_status", "draft")', "")),
    "listing_status must appear exactly once, as the draft filter",
  );
});

Deno.test("US-2961: a jsonb containment filter is NOT used to find the references", () => {
  // `cs.` on an array of objects behaves differently across the PostgREST
  // versions this project runs — the local stack is newer than self-hosted
  // prod — and a containment filter that silently matched nothing would make
  // apply report success having rewritten nothing. The match happens in code.
  const start = renderSrc.indexOf("export async function applySnippetToDrafts");
  const body = renderSrc.slice(start);
  assert(!body.includes(".contains("), "no jsonb containment filter here");
  assertStringIncludes(body, 'b.key === "snippet" && b.ref === snippetId');
});

Deno.test("US-2961: a listing referenced only through an override is skipped", () => {
  const start = renderSrc.indexOf("export async function applySnippetToDrafts");
  const body = renderSrc.slice(start);
  assertStringIncludes(body, "refs.every((b) => (b.text ?? \"\").trim().length > 0)");
  assertStringIncludes(body, "skipped++");
});
