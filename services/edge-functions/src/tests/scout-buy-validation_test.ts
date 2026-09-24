// SRC-4: POST /scout/buy validates its body before the INSERT, and the row it
// writes carries the owner as user_id and the person who pressed the button as
// created_by.
//
// gradeValue lands in inventory_items.grade_value, a decimal(3,1): 100 used to
// reach Postgres and come back as a 500. Strings had no length caps at all.

// US-2379: FIRST, before anything that reaches lib/supabase.ts at import time.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  BUY_NOTES_MAX,
  BUY_TITLE_MAX,
  parseScoutBuy,
  type ScoutBuyInput,
  scoutBuyRow,
} from "../routes/flipdesk-scout.ts";

function ok(body: Record<string, unknown>): ScoutBuyInput {
  const out = parseScoutBuy(body);
  assert(!("error" in out), `expected ok, got ${JSON.stringify(out)}`);
  return out as ScoutBuyInput;
}
function err(body: Record<string, unknown>): string {
  const out = parseScoutBuy(body);
  assert("error" in out, `expected an error for ${JSON.stringify(body)}`);
  return (out as { error: string }).error;
}

Deno.test("SRC-4: gradeValue outside 1.0-10.0 is a named 400, not a 500", () => {
  assertEquals(err({ title: "Tee", gradeValue: 100 }), "gradeValue must be a number from 1.0 to 10.0");
  assertEquals(err({ title: "Tee", gradeValue: 0.5 }), "gradeValue must be a number from 1.0 to 10.0");
  assertEquals(err({ title: "Tee", gradeValue: "8" }), "gradeValue must be a number from 1.0 to 10.0");
  assertEquals(ok({ title: "Tee", gradeValue: 8.46 }).gradeValue, 8.5);
  assertEquals(ok({ title: "Tee" }).gradeValue, null);
});

Deno.test("SRC-4: string fields are length-capped and the refusal names the field", () => {
  assertEquals(err({ title: "x".repeat(BUY_TITLE_MAX + 1) }), `title must be ${BUY_TITLE_MAX} characters or fewer`);
  assertEquals(err({ title: "Tee", brand: "b".repeat(81) }), "brand must be 80 characters or fewer");
  assertEquals(err({ title: "Tee", sourcedBy: "s".repeat(81) }), "sourcedBy must be 80 characters or fewer");
  assertEquals(
    err({ title: "Tee", conditionNotes: "n".repeat(BUY_NOTES_MAX + 1) }),
    `conditionNotes must be ${BUY_NOTES_MAX} characters or fewer`,
  );
  assertEquals(err({ title: "   " }), "title is required");
});

Deno.test("SRC-4: sourceId must be a uuid", () => {
  assertEquals(err({ title: "Tee", sourceId: "1; drop" }), "sourceId must be a source id");
  assertEquals(
    ok({ title: "Tee", sourceId: "0b8f7a2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b" }).sourceId,
    "0b8f7a2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b",
  );
});

Deno.test("SRC-4: sourceListingUrl must be https and is appended to the notes", () => {
  assertEquals(err({ title: "Tee", sourceListingUrl: "javascript:alert(1)" }), "sourceListingUrl must be an https link");
  assertEquals(err({ title: "Tee", sourceListingUrl: "http://www.ebay.com/itm/1" }), "sourceListingUrl must be an https link");
  const out = ok({ title: "Tee", conditionNotes: "Small mark", sourceListingUrl: "https://www.ebay.com/itm/1" });
  assertEquals(out.conditionNotes, "Small mark\n\nFound at https://www.ebay.com/itm/1");
});

Deno.test("SRC-4: a member's buy is written under the owner with the member as created_by", () => {
  const row = scoutBuyRow(ok({ title: "Tee", sourcedBy: "Sam", sourceId: "0b8f7a2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b" }), {
    ownerId: "owner-1",
    actorId: "member-1",
  });
  assertEquals(row.user_id, "owner-1");
  assertEquals(row.created_by, "member-1");
  assertEquals(row.sourced_by, "Sam");
  assertEquals(row.source_id, "0b8f7a2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b");
  assertEquals(row.status, "sourced");
});

Deno.test("SRC-4: the route owner-verifies sourceId before the insert", async () => {
  // Source pin: the ownership read must filter on the owner, and it must come
  // before the INSERT. A simplification to .eq("id", sourceId) alone reddens this.
  const src = await Deno.readTextFile(new URL("../routes/flipdesk-scout.ts", import.meta.url));
  const route = src.slice(src.indexOf('flipdeskScoutRoutes.post("/buy"'));
  const check = route.indexOf('.from("sources")');
  const insert = route.indexOf('.from("inventory_items")');
  assert(check > 0 && insert > check, "the source check must precede the insert");
  assert(
    /\.from\("sources"\)\s*\.select\("id"\)\s*\.eq\("id", input\.sourceId\)\s*\.eq\("user_id", userId\)/.test(route),
    "the source read must be scoped to the workspace owner",
  );
});
