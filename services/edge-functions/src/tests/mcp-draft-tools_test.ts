// US-9115: the draft write tools.
//
// Two properties carry this story, and neither is "does it save":
//
//   1. A PUBLISHED listing is refused. Writing the local row for something a
//      buyer can see leaves the seller's copy disagreeing with the marketplace,
//      and nothing surfaces that.
//   2. An item specific over eBay's 65-character limit is shortened BEFORE it
//      is stored. eBay hard-rejects longer values and the offer then sticks in
//      a state that can be neither published nor cleared, so a draft carrying
//      one is worse than no draft.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { createDraftTool, updateDraftTool } = await import("../lib/mcp-draft-tools.ts");
const { EBAY_ASPECT_VALUE_MAX_LEN } = await import("../lib/ebay-client.ts");
const { TOOLS, listToolsFor } = await import("../lib/mcp-tools.ts");

const TENANT = "11111111-1111-4111-8111-111111111111";

const ctx = {
  tenantId: TENANT,
  userId: TENANT,
  apiKeyId: "22222222-2222-4222-8222-222222222222",
  scopes: ["read", "submit"] as Array<"read" | "submit" | "webhook_manage">,
};

Deno.test("both draft tools require submit, and a read key never sees them", () => {
  for (const tool of [createDraftTool, updateDraftTool]) {
    assertEquals(tool.requiredScope, "submit");
    assertEquals(tool.annotations.destructiveHint, true);
  }
  const readOnly = listToolsFor(["read"]).map((t) => t.name as string);
  assert(!readOnly.includes("gradethread_create_draft"));
  assert(!readOnly.includes("gradethread_update_draft"));
});

Deno.test("both are registered", () => {
  const names = TOOLS.map((t) => t.name);
  assert(names.includes("gradethread_create_draft"));
  assert(names.includes("gradethread_update_draft"));
});

Deno.test("create_draft warns that a regeneration replaces a reviewed draft", () => {
  // US-1568: a fresh generation overwrites whatever a human already fixed. The
  // seller should hear that from the model BEFORE they lose the edit, so the
  // warning lives in the tool's own output rather than only in a code comment.
  //
  const src = Deno.readTextFileSync(
    new URL("../lib/mcp-draft-tools.ts", import.meta.url),
  );
  assert(
    /the new one replaces it/.test(src),
    "the regeneration warning is gone; a seller can now lose a hand-fixed draft " +
      "to a tool call that reported success",
  );
});

Deno.test("create_draft refuses an empty list before touching anything", async () => {
  const result = await createDraftTool.handler({ item_ids: [] }, ctx);
  assertEquals(result.isError, true);
});

Deno.test("update_draft needs a listing id", async () => {
  const result = await updateDraftTool.handler({}, ctx);
  assertEquals(result.isError, true);
});

Deno.test("update_draft refuses a call that changes nothing", async () => {
  // Not pedantry: an empty patch that reported success would let a model tell
  // the seller their edit was saved when no field was ever named.
  const result = await updateDraftTool.handler({ listing_id: "no-such-id" }, ctx);
  assertEquals(result.isError, true);
});

Deno.test("update_draft declares the aspect cap in its own schema", () => {
  // The model has to know values get shortened, or it reports the seller's full
  // text back to them as saved.
  const schema = updateDraftTool.inputSchema.properties?.item_specifics;
  assert(schema, "item_specifics is not in the schema");
  assert(
    String((schema as { description?: string }).description ?? "").includes(
      String(EBAY_ASPECT_VALUE_MAX_LEN),
    ),
    "the item_specifics description does not name the 65-character limit",
  );
});

Deno.test("update_draft caps aspect values through the shared eBay chokepoint", () => {
  // Pinned as a source guard rather than reimplemented: the point is that this
  // tool uses capAspectValuesForEbay, the same function the publish path uses.
  // A local truncation here would be a second definition of eBay's limit, and
  // the two would drift the first time eBay moved it.
  const src = Deno.readTextFileSync(
    new URL("../lib/mcp-draft-tools.ts", import.meta.url),
  );
  assert(
    /capAspectValuesForEbay\(/.test(src),
    "the draft tool no longer routes item specifics through capAspectValuesForEbay, " +
      "so an over-long value can be stored and the offer will stick at publish",
  );
  assert(
    !/\.slice\(0,\s*65\)|substring\(0,\s*65\)/.test(src),
    "a hand-rolled 65-character truncation appeared alongside the shared one",
  );
});

Deno.test("update_draft refuses a published listing, in words a seller can act on", () => {
  // Source-guarded for the same reason the case above is: reaching this branch
  // needs a real listings row. What must not drift is that the branch EXISTS
  // and points at the right tool.
  const src = Deno.readTextFileSync(
    new URL("../lib/mcp-draft-tools.ts", import.meta.url),
  );
  assert(
    /wasPublishedUpstream\(row\)/.test(src),
    "the published-listing refusal is gone; editing a live listing locally now " +
      "silently desyncs the seller's copy from what buyers see",
  );
  assert(
    /reprice/i.test(src),
    "the refusal must name what to use instead, or the model just retries",
  );
});

Deno.test("update_draft loads the listing through the owner-verified loader", () => {
  const src = Deno.readTextFileSync(
    new URL("../lib/mcp-draft-tools.ts", import.meta.url),
  );
  assert(
    /loadOwnedListing\(listingId, ctx\.tenantId\)/.test(src),
    "US-268: the listing must be loaded scoped to the caller's tenant",
  );
  // And the write is scoped too, so a race between load and write cannot land
  // on another tenant's row.
  assert(
    /\.eq\("user_id", ctx\.tenantId\)/.test(src),
    "the update must also filter on user_id, not rely on the load alone",
  );
});

Deno.test("a title change also writes the item, per the precedence contract", () => {
  // Publish reads listing-first, so writing only the item is the documented
  // silent-failure shape. This tool writes the LISTING row; the item write-back
  // is the composer's US-2593 behaviour, kept so the two surfaces that both
  // show a title stop diverging.
  const src = Deno.readTextFileSync(
    new URL("../lib/mcp-draft-tools.ts", import.meta.url),
  );
  assert(
    /listing_title/.test(src) && /from\("inventory_items"\)[\s\S]{0,200}?title:/.test(src),
    "a title edit must reach both the draft row and the item",
  );
});
