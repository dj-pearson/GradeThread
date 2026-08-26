// US-2917: GET /api/flipdesk/size-bands.
//
// The route reads charts DB-first through resolveBrandKnowledgePack, so these
// tests drive it with NO reachable database. That is not a limitation being
// worked around — it is the fallback path in production too (a brand missing
// from brand_size_charts, a pre-migration container, a transient read error),
// and it is the path that must never lie about its tier. Every case below
// therefore asserts against the in-code SIZING_CHARTS seed, where `verified` is
// absent by construction, so tier can only ever be "brand", "generic" or "none".
//
//   deno test --allow-env --allow-read --allow-net src/tests/size-bands-route_test.ts

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { flipdeskSizeBandsRoutes } from "../routes/flipdesk-size-bands.ts";
import { clearBrandKnowledgeCache } from "../lib/brand-knowledge.ts";

const app = new Hono();
app.route("/api/flipdesk/size-bands", flipdeskSizeBandsRoutes);

interface Body {
  tier: string;
  brandLabel: string | null;
  department: string | null;
  garment: string | null;
  sourceUrl: string | null;
  sizeSystem: string | null;
  sizeClass: string | null;
  measurementBasis: string;
  rows: Array<{ size: string; index: number; bands: Record<string, [number, number]> }>;
}

async function get(query: string): Promise<{ status: number; body: Body; headers: Headers }> {
  clearBrandKnowledgeCache();
  const res = await app.request(`/api/flipdesk/size-bands?${query}`);
  return { status: res.status, body: (await res.json()) as Body, headers: res.headers };
}

Deno.test("a brand chart comes back with bands, its own garment scope and tier 'brand'", async () => {
  const { status, body } = await get("brand=Lululemon&garment=tee&gender=men");
  assertEquals(status, 200);
  assertEquals(body.tier, "brand");
  assertEquals(body.brandLabel, "Lululemon");
  assertEquals(body.department, "Men");
  assertEquals(body.measurementBasis, "body");
  // The seed carries no source_url, so the response must not invent one.
  assertEquals(body.sourceUrl, null);
  assertEquals(body.rows[0]?.size, "XS");
  assertEquals(body.rows[0]?.bands.chest, [18, 22.5]);
  assertEquals(body.rows[3]?.bands.chest, [22, 26.5]);
});

Deno.test("no brand falls back to the generic chart and says so", async () => {
  const { body } = await get("garment=tee&gender=men");
  assertEquals(body.tier, "generic");
  assertEquals(body.department, "Men");
  assertEquals(body.rows.find((r) => r.size === "L")?.bands.chest, [22, 26.5]);
});

Deno.test("a brand with charts in two departments and no gender drops to generic", async () => {
  // Lululemon seeds Men's and Women's tops. Picking one would put a women's
  // chart behind a men's tee.
  const withGender = await get("brand=Lululemon&garment=tee&gender=women");
  assertEquals(withGender.body.tier, "brand");
  assertEquals(withGender.body.department, "Women");

  const without = await get("brand=Lululemon&garment=tee");
  assert(
    without.body.tier !== "brand",
    `no-gender request must not claim a brand chart, got ${without.body.tier}`,
  );
  assertEquals(without.body.brandLabel, null);
});

Deno.test("the response never reports a brand chart it did not use", async () => {
  // A brand with nothing in the corpus resolves through the pack's own generic
  // fallback; the tier must follow the chart actually used, not the query.
  const { body } = await get("brand=Definitely%20Not%20A%20Real%20Brand&garment=tee&gender=men");
  assertEquals(body.tier, "generic");
  assert(
    body.brandLabel === null || !body.brandLabel.toLowerCase().includes("definitely"),
    "generic chart must not be relabelled with the queried brand",
  );
});

Deno.test("an unknown garment with no generic chart returns 200, tier 'none', rows []", async () => {
  const { status, body } = await get("brand=Rolex&garment=wristwatch&gender=men");
  assertEquals(status, 200);
  assertEquals(body.tier, "none");
  assertEquals(body.rows, []);
});

Deno.test("US-268: an itemId param is rejected, not quietly ignored", async () => {
  for (const param of ["itemId", "item_id", "userId", "user_id"]) {
    const res = await app.request(
      `/api/flipdesk/size-bands?brand=Lululemon&garment=tee&gender=men&${param}=00000000-0000-0000-0000-000000000000`,
    );
    assertEquals(res.status, 400, `${param} should be refused`);
    const body = await res.json();
    assert(String(body.error).includes("no item or user id"));
  }
});

Deno.test("US-268: brand_size_charts is the only table the route names", async () => {
  const src = await Deno.readTextFile(
    new URL("../routes/flipdesk-size-bands.ts", import.meta.url),
  );
  // The route itself must not query anything; its only DB access is through
  // resolveBrandKnowledgePack, which reads the five global brand_* reference
  // tables and nothing tenant-scoped.
  assert(!src.includes("supabaseAdmin"), "the route must not hold a service-role client");
  assert(!src.includes(".from("), "the route must not query a table directly");
  for (const tenantTable of ["inventory_items", "listings", "sales", "item_photos"]) {
    assert(!src.includes(tenantTable), `route must not reference ${tenantTable}`);
  }
});

Deno.test("the response is cacheable and identical params give an identical body", async () => {
  const a = await get("brand=Lululemon&garment=tee&gender=men");
  const b = await get("brand=Lululemon&garment=tee&gender=men");
  assertEquals(JSON.stringify(a.body), JSON.stringify(b.body));
  assertEquals(a.headers.get("Cache-Control"), "private, max-age=1800");
});

Deno.test("size system and class are read off the chart, never guessed", async () => {
  const alpha = await get("brand=Lululemon&garment=tee&gender=men");
  assertEquals(alpha.body.sizeSystem, "alpha");
  assertEquals(alpha.body.sizeClass, "standard");

  // Lululemon women's charts are bare numbers: a bare "8" could be US or UK and
  // nothing in the row says which, so the system stays null.
  const numeric = await get("brand=Lululemon&garment=legging&gender=women");
  assertEquals(numeric.body.sizeSystem, null);
});
