// US-2727: listed_at on the extension writeback, both halves of it.
//
// The half that shipped in migration 00634: the column was NOT NULL DEFAULT
// now() since 00002, the INSERT below writes an explicit null for a draft, and
// so every prefill writeback failed with 23502 on every environment. 00634
// dropped the NOT NULL and prod carries it.
//
// The half that did not: 00634 KEPT the default, on purpose, because dropping
// it would change behaviour for every writer that omits the column. Several of
// those writers create DRAFT rows and omit it (lib/cross-push.ts,
// lib/extension-relist.ts, lib/ai-listing.ts, routes/flipdesk-import.ts), so the
// default stamps a draft with the moment the DRAFT was made. The writeback then
// promoted such a row with `existing.listed_at ?? now` and kept that value,
// backdating the publish to the draft's creation.
//
// These call buildWritebackPatch rather than scanning for its text. The rule is
// logic, and a scan on logic pins the spelling of a gate and never its answer.
// The two scans at the bottom hold WIRING, which is what a scan is for.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { buildWritebackPatch } from "../lib/extension-writeback.ts";

const NOW = "2026-09-11T12:00:00.000Z";
const DRAFT_CREATED = "2026-08-01T09:30:00.000Z";
const REAL_LISTED = "2026-07-04T18:00:00.000Z";

function patch(over: Partial<Parameters<typeof buildWritebackPatch>[0]>) {
  return buildWritebackPatch({
    published: false,
    existingStatus: "draft",
    existingListedAt: null,
    listingUrl: null,
    groupId: null,
    now: NOW,
    ...over,
  });
}

Deno.test("publishing a draft that carries a DEFAULT now() stamp lists it NOW", () => {
  const p = patch({
    published: true,
    existingStatus: "draft",
    existingListedAt: DRAFT_CREATED,
  });
  assertEquals(
    p.listed_at,
    NOW,
    "a draft's listed_at is a default-now artifact, never a marketplace date; " +
      "keeping it backdates the publish to whenever the draft was created",
  );
  assertEquals(p.listing_status, "active");
  assertEquals(p.is_active, true);
});

Deno.test("publishing a draft with no listed_at lists it now", () => {
  const p = patch({ published: true, existingStatus: "draft", existingListedAt: null });
  assertEquals(p.listed_at, NOW);
});

Deno.test("re-confirming an ALREADY-ACTIVE listing never moves its listed_at", () => {
  const p = patch({
    published: true,
    existingStatus: "active",
    existingListedAt: REAL_LISTED,
  });
  assertEquals(
    p.listed_at,
    REAL_LISTED,
    "a live row's date is real; a second 'I published it' must not reset it",
  );
});

Deno.test("an ended row keeps its real listed_at when re-published", () => {
  const p = patch({
    published: true,
    existingStatus: "ended",
    existingListedAt: REAL_LISTED,
  });
  assertEquals(p.listed_at, REAL_LISTED);
});

Deno.test("an active row with no stored date falls back to now", () => {
  const p = patch({ published: true, existingStatus: "active", existingListedAt: null });
  assertEquals(p.listed_at, NOW);
});

Deno.test("a prefill never writes listed_at at all", () => {
  const p = patch({ published: false, existingStatus: "draft", existingListedAt: null });
  assert(
    !("listed_at" in p),
    "a prefill is not a publish; naming the column here would let the default " +
      "or a stale value stand in for a listing date",
  );
  assertEquals(p.listing_status, "draft");
  assertEquals(p.is_active, false);
});

Deno.test("a prefill of a LIVE listing leaves it active and untouched", () => {
  const p = patch({
    published: false,
    existingStatus: "active",
    existingListedAt: REAL_LISTED,
  });
  assert(
    !("listing_status" in p),
    "demoting a live row to draft hides it from the delist queue (oversell)",
  );
  assert(!("is_active" in p));
  assert(!("listed_at" in p));
});

Deno.test("a publish without a captured URL does not blank the one on record", () => {
  const p = patch({ published: true, existingStatus: "draft", listingUrl: null });
  assert(!("listing_url" in p), "a manual 'I published it' carries no URL");
  const withUrl = patch({
    published: true,
    existingStatus: "draft",
    listingUrl: "https://poshmark.com/listing/abc",
  });
  assertEquals(withUrl.listing_url, "https://poshmark.com/listing/abc");
});

Deno.test("draft_id is omitted rather than nulled when the item has no group", () => {
  assertEquals(patch({ groupId: null }).draft_id, undefined);
  assertEquals(patch({ groupId: "group-1" }).draft_id, "group-1");
});

// ---- wiring, which is what a source scan is good for --------------------

const SRC = Deno.readTextFileSync(
  new URL("../lib/extension-writeback.ts", import.meta.url),
);
// Strip block comments as blocks first, then line comments: this file's own
// prose quotes the tokens below, and a comment that satisfies the guard it
// documents is the oldest way one of these fails open.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !/^\s*\/\//.test(l))
  .join("\n");

Deno.test("the update branch goes through buildWritebackPatch", () => {
  assert(
    CODE.includes("const patch = buildWritebackPatch({"),
    "the route inlined the patch again, so the rules above guard nothing. " +
      "This matches the CALL, not the `export function` line.",
  );
});

Deno.test("the INSERT still writes an explicit null for a draft", () => {
  assert(
    CODE.includes("listed_at: published ? now : null"),
    "the INSERT must NAME listed_at. Omitting it hands the row to " +
      "`DEFAULT now()` (00634 kept the default on purpose), which is the " +
      "phantom dateable draft US-1877 exists to prevent.",
  );
});
