// US-9118: end, bulk end and relist.
//
// What the schemas and annotations declare is checked here; the behaviour that
// needs a database (the loads, the ends) is checked in the tenant-isolation
// lane, which drives these through a real stack.
//
// The one behaviour asserted here without a stack is the RENDERING, because it
// is where US-2641's shape reappears. endOwnedListing distinguishes ended
// upstream from queued-for-the-extension from already-not-live, and collapsing
// those into "ended" is how a seller believes a buyer can no longer buy an item
// that is still for sale.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { endListingTool, endListingsBulkTool, relistTool } = await import(
  "../lib/mcp-lifecycle-tools.ts"
);
const { TOOLS, listToolsFor } = await import("../lib/mcp-tools.ts");

const SRC = await Deno.readTextFile(
  new URL("../lib/mcp-lifecycle-tools.ts", import.meta.url),
);

const ctx = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "11111111-1111-4111-8111-111111111111",
  apiKeyId: "22222222-2222-4222-8222-222222222222",
  scopes: ["read", "submit"] as Array<"read" | "submit" | "webhook_manage">,
};

function textOf(r: { content: Array<{ text: string }> }): string {
  return r.content.map((c) => c.text).join("\n");
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

Deno.test("all three are submit-scoped, destructive and open-world", () => {
  for (const tool of [endListingTool, endListingsBulkTool, relistTool]) {
    assertEquals(tool.requiredScope, "submit", `${tool.name}`);
    assertEquals(tool.annotations.destructiveHint, true, `${tool.name}`);
    assertEquals(
      tool.annotations.openWorldHint,
      true,
      `${tool.name} reaches a marketplace, and the marketplace's answer is what decides`,
    );
  }
});

Deno.test("a read-only credential sees none of them", () => {
  const names = listToolsFor(["read"]).map((t) => t.name as string);
  for (const n of ["gradethread_end_listing", "gradethread_end_listings", "gradethread_relist"]) {
    assert(!names.includes(n), `${n} is visible to a read-only key`);
  }
});

Deno.test("all three are in the registry", () => {
  const names = TOOLS.map((t) => t.name);
  assert(names.includes("gradethread_end_listing"));
  assert(names.includes("gradethread_end_listings"));
  assert(names.includes("gradethread_relist"));
});

// ---------------------------------------------------------------------------
// argument handling, which happens before any database work
// ---------------------------------------------------------------------------

Deno.test("each tool needs its id", async () => {
  assertEquals((await endListingTool.handler({}, ctx)).isError, true);
  assertEquals((await endListingsBulkTool.handler({ listing_ids: [] }, ctx)).isError, true);
  assertEquals((await relistTool.handler({}, ctx)).isError, true);
});

Deno.test("an oversized bulk end is refused with the cap named", async () => {
  const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`);
  const result = await endListingsBulkTool.handler({ listing_ids: ids }, ctx);
  assertEquals(result.isError, true);
  assert(textOf(result).includes("100"));
});

// ---------------------------------------------------------------------------
// the properties the story is about
// ---------------------------------------------------------------------------

Deno.test("bulk end loops the SINGLE end rather than adding a delist loop", () => {
  // The codebase already has two adapter.delist call sites and a guard that
  // counts them. A third would be a third place for a fix to miss.
  assert(
    /endOwnedListing\(/.test(SRC),
    "the lifecycle tools no longer call endOwnedListing",
  );
  assert(
    !/adapter\.delist\(/.test(SRC),
    "a delist call site appeared in the connector tools; it belongs in " +
      "lib/listing-lifecycle.ts with the other one",
  );
});

Deno.test("QUEUED is not counted as ended", () => {
  // The whole point. A marketplace with no delist API is queued for the Lister
  // extension and STAYS LIVE until the seller next opens FlipDesk. Counting it
  // as ended is the lie this tool exists not to tell.
  assert(
    /queued !== true\) ended\+\+/.test(SRC),
    "queued listings are being counted as ended",
  );
  assert(
    /still live on the marketplace until/.test(SRC),
    "the queued outcome must say the listing is still live",
  );
});

Deno.test("the three end outcomes stay distinguishable in the rendering", () => {
  for (const marker of ["ALREADY ENDED", "QUEUED", "ENDED ·", "STILL LIVE"]) {
    assert(SRC.includes(marker), `the "${marker}" outcome was collapsed away`);
  }
});

Deno.test("bulk end applies the same plan gate the dashboard's bulk-end applies", () => {
  // A tool must not be the entry point that makes a paid feature free.
  assert(
    /featureAllowedForUser\(ctx\.tenantId, "bulkActions"\)/.test(SRC),
    "the bulkActions gate is missing from the bulk end tool",
  );
  // And the refusal names the way out, so a model does not just retry. Matched
  // loosely because the copy is split across a string concatenation.
  assert(
    /at a time with gradethread_end_listing/.test(SRC),
    "the plan refusal must point at the single-listing tool",
  );
});

Deno.test("relist refuses to report success without a NEW listing id", () => {
  // US-2641: the verb is checked, not inferred. AC2 also requires the new id be
  // reported, which is the same requirement from the other side.
  assert(
    /cannot confirm it is live/.test(SRC),
    "relist no longer treats a missing listing id as unconfirmed",
  );
  assert(/duplicate/.test(SRC), "say why not to just try again");
});

Deno.test("the relist token covers the QUANTITY, not just the listing", () => {
  // Relisting one and relisting twelve are different decisions, and the seller
  // agreed to one of them.
  assert(
    /payload: \[id, String\(quantity\)\]/.test(SRC),
    "the relist token is not bound to the quantity",
  );
});

Deno.test("the end token is bound to what is CURRENTLY ownable", () => {
  // Binding to the requested ids instead would let a listing that left the
  // workspace between preview and confirm be silently dropped from the set
  // rather than invalidating the token.
  assert(
    /payload: endPayload\(candidates\.map\(\(c\) => c\.id\)\)/.test(SRC),
    "the end token is bound to the requested ids rather than the owned ones",
  );
});

Deno.test("a thrown error does not claim nothing happened", () => {
  // Same asymmetry as publish: an exception can land after a marketplace
  // accepted the withdraw.
  assert(/may or may not be live/.test(SRC) || /Check whether it is still live/.test(SRC));
  assert(!/nothing was ended/i.test(SRC));
});
