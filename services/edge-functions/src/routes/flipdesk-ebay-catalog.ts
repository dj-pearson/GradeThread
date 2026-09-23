// eBay routes: taxonomy (category suggest, aspects, conditions), catalog match/adopt, aspect coverage and comps.
//
// Split out of flipdesk-ebay.ts, which mounts this router at /api/flipdesk/ebay
// alongside its siblings. The local router keeps the name flipdeskEbayRoutes so
// every handler below is byte-for-byte the text it had before the split.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  columnAspectProjection,
  columnBackedAspectMap,
  columnBackedAspectNames,
  reverseColumnAspects,
} from "../lib/aspect-registry.ts";
import type { RegistryItem } from "../lib/aspect-registry.ts";
import { type Measurements, resolveMeasurementAspects } from "../lib/measurements.ts";
import {
  type AspectCoverage,
  recommendedAspectCoverage,
  sourcesFor,
} from "../lib/aspect-provenance.ts";
import {
  getCategoryAspects,
  getCategoryName,
  getItemConditionPolicies,
  getCatalogProduct,
  searchCatalogProducts,
  isEbayConfigured,
  suggestCategories,
} from "../lib/ebay-client.ts";
import { conditionOptionsForCategory } from "../lib/publish-preflight.ts";
import { getSetting } from "../lib/system-settings.ts";
import {
  COMP_MIN_RESULTS_SETTING_KEY,
  DEFAULT_MIN_COMP_RESULTS,
  searchCompsWithLadder,
} from "../lib/comps-ladder.ts";
import { markComped } from "../lib/rewards-pipeline.ts";
import {
  allowedAspectsFromSpec,
  type AspectSpecRaw,
  deriveAspectsFromItem,
  type EbayEnv,
  type PublishItem,
  shoeScaleOf,
  toRegistryAspects,
} from "./flipdesk-ebay-shared.ts";


export const flipdeskEbayRoutes = new Hono<EbayEnv>();

// US-1475 chunk 1: find eBay catalog product (EPID) candidates for an inventory
// item (by GTIN in the SKU / brand+style/keywords). Read-only, tenant-scoped;
// returns candidates + the top product's authoritative aspects for preview.
flipdeskEbayRoutes.get("/catalog/match", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!ownerId) return c.json({ error: "Sign-in required" }, 401);
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const itemId = c.req.query("item_id");
  if (!itemId) return c.json({ error: "item_id is required" }, 400);
  try {
    const { data: item, error } = await supabaseAdmin
      .from("inventory_items")
      .select("id, title, brand, style, sku")
      .eq("id", itemId)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (error) throw error;
    const it = item as
      | { title?: string; brand?: string | null; style?: string | null; sku?: string | null }
      | null;
    if (!it) return c.json({ error: "Item not found." }, 404);
    // A SKU that's all digits (8–14) is very likely a scanned UPC/EAN (US-598).
    const gtin =
      it.sku && /^\d{8,14}$/.test(it.sku.trim()) ? it.sku.trim() : null;
    const candidates = await searchCatalogProducts({
      gtin,
      brand: it.brand ?? null,
      mpn: it.style ?? null,
      keywords: it.title ?? null,
    });
    // Enrich the top candidate with its catalog aspects so the UI can preview /
    // adopt them (US-1475 chunk 2).
    const top = candidates[0]
      ? await getCatalogProduct(candidates[0].epid)
      : null;
    return c.json({ candidates, top });
  } catch (err) {
    console.error("[flipdesk-ebay] /catalog/match failed:", err);
    return c.json({ error: "Could not search the eBay catalog." }, 502);
  }
});

// US-1475 chunk 2 (AC1-adopt + AC2): adopt an eBay catalog product for an item —
// persist its EPID + merge the catalog's authoritative aspects into ebay_aspects.
// Catalog PREFERRED over AI (overwrites ai_extracted values + fills gaps) but a
// MANUAL (user-set) aspect is never clobbered. Tenant-scoped; OUR-DB write only
// (the EPID reaches eBay at publish via the inventory-item product block).
flipdeskEbayRoutes.post("/catalog/adopt", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!ownerId) return c.json({ error: "Sign-in required" }, 401);
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  let body: { item_id?: string; epid?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const itemId = body.item_id;
  const epid = body.epid;
  if (!itemId || !epid) {
    return c.json({ error: "item_id and epid are required" }, 400);
  }
  try {
    const { data: item, error } = await supabaseAdmin
      .from("inventory_items")
      .select("id, ebay_aspects, ebay_aspect_sources")
      .eq("id", itemId)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (error) throw error;
    const it = item as
      | {
          ebay_aspects: Record<string, string[]> | null;
          ebay_aspect_sources: Record<string, string> | null;
        }
      | null;
    if (!it) return c.json({ error: "Item not found." }, 404);

    const product = await getCatalogProduct(epid);
    if (!product) {
      return c.json({ error: "That eBay catalog product no longer exists." }, 404);
    }

    const aspects: Record<string, string[]> = { ...(it.ebay_aspects ?? {}) };
    const sources: Record<string, string> = { ...(it.ebay_aspect_sources ?? {}) };
    let applied = 0;
    for (const [name, values] of Object.entries(product.aspects)) {
      const vals = (values ?? []).filter((v) => v && v.trim());
      if (vals.length === 0) continue;
      // Keep a value the user set by hand; otherwise the catalog wins over AI
      // and fills gaps.
      if (sources[name] === "manual") continue;
      aspects[name] = vals;
      sources[name] = "catalog";
      applied += 1;
    }

    const { error: upErr } = await supabaseAdmin
      .from("inventory_items")
      .update({
        ebay_epid: epid,
        ebay_aspects: aspects,
        ebay_aspect_sources: sources,
      } as never)
      .eq("id", itemId)
      .eq("user_id", ownerId);
    if (upErr) throw upErr;

    return c.json({ epid, applied });
  } catch (err) {
    console.error("[flipdesk-ebay] /catalog/adopt failed:", err);
    return c.json({ error: "Could not adopt the eBay catalog product." }, 502);
  }
});

// ── Taxonomy ───────────────────────────────────────────────────────
// These run on the app-level (client_credentials) token — no seller OAuth
// required. Cheap to call, but rate-limited by eBay; the aspects endpoint
// is read-through cached in public.ebay_category_aspects.

flipdeskEbayRoutes.get("/category/suggest", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const q = c.req.query("q")?.trim();
  if (!q) {
    return c.json({ error: "q is required" }, 400);
  }
  try {
    const suggestions = await suggestCategories(q);
    return c.json({ suggestions });
  } catch (err) {
    // US-1559: eBay's Taxonomy API intermittently 500s (errorId 62000,
    // "internal system or process"). Suggestions are advisory — degrade to an
    // empty list instead of a 502 that TanStack Query retries into (and that
    // an upstream proxy can strip CORS headers from, masking the real error).
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[flipdesk-ebay] category suggest failed:", msg);
    if (msg.includes("(500)") || msg.includes("62000")) {
      return c.json({ suggestions: [], degraded: true });
    }
    return c.json({ error: "Category suggest failed" }, 502);
  }
});

flipdeskEbayRoutes.get("/category/:id/aspects", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const categoryId = c.req.param("id");
  if (!categoryId) {
    return c.json({ error: "category id is required" }, 400);
  }
  try {
    const result = await getCategoryAspects(categoryId);
    // Which of this category's aspects are already editable as MAIN-PAGE item
    // fields (Brand/Size/Color/Material/Style). A client rendering the
    // specifics inline on the item page uses this to skip those rows rather
    // than show the same value in two inputs — they share one column and one
    // write-authority, so two inputs is just the double-entry confusion.
    const rawAspects = (result.aspects as Record<string, unknown> | undefined)
      ?.aspects;
    const registryAspects = toRegistryAspects(
      Array.isArray(rawAspects) ? rawAspects as AspectSpecRaw[] : [],
    );
    const columnBacked = columnBackedAspectNames(registryAspects);
    // US-2839: the same answer keyed BY COLUMN, so a client can render the
    // item's own Style/Color/Material input from eBay's allowed values instead
    // of only knowing to hide the duplicate row. `?category=` is the item's
    // vertical (clothing / shoes / headwear) when the caller knows it, which is
    // what picks "US Shoe Size" over the generic "Size" on a shoe item.
    const vertical = (c.req.query("category") ?? "").trim().toLowerCase() || null;
    const columnBackedMap = columnBackedAspectMap(registryAspects, vertical);
    return c.json({
      ...result,
      columnBackedAspectNames: columnBacked,
      columnBackedAspects: columnBackedMap,
    });
  } catch (err) {
    console.error("[flipdesk-ebay] category aspects failed:", err);
    return c.json({ error: "Category aspects fetch failed" }, 502);
  }
});

// Category-aware CONDITION options for the composer. Many apparel leaves accept
// only {1000,1500,1750,2990,3000,3010} and reject the legacy USED_* tiers, so a
// fixed dropdown offers conditions eBay then rejects at publish. This returns the
// SELECTABLE conditions for the leaf (best→worst, only ones we can emit) plus the
// full allowed-label list. `restricted:false` (unrestricted / unknown category)
// tells the client to fall back to its full static option list.
// App-token metadata (read-through cached in ebay_category_condition_policies) —
// no seller OAuth or tenant data involved.
flipdeskEbayRoutes.get("/category/:id/conditions", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const categoryId = c.req.param("id");
  if (!categoryId) {
    return c.json({ error: "category id is required" }, 400);
  }
  try {
    const { conditionIds, cached } = await getItemConditionPolicies(categoryId);
    const { options, allowedLabels } = conditionOptionsForCategory(conditionIds);
    return c.json({
      categoryId,
      restricted: conditionIds.length > 0,
      conditionIds,
      options,
      allowedLabels,
      cached,
    });
  } catch (err) {
    // Advisory — never block the composer on a policy-fetch hiccup. The client
    // falls back to the full static option list on any non-200.
    console.error("[flipdesk-ebay] category conditions failed:", err);
    return c.json({ error: "Category conditions fetch failed" }, 502);
  }
});

// US-824: deterministic, NO-AI aspect refill for a category change. Given an
// item + a (possibly new) eBay category, returns the aspects we can fill from
// the item's columns + US-821 canonical attributes — mapped through the shared
// registry (US-822) and normalized to eBay's allowed values (US-823) — plus the
// new category's valid aspect names so the client can classify keep/drop. The
// client calls this when the seller switches category so still-valid values are
// kept and gaps are refilled WITHOUT an AI pass (mirrors the web composer's
// remapAspectsForCategory). `knownAspects` are passed through as `existing` and
// are NEVER overwritten (user-set / still-valid values win).
//
// Tenant-scoped (US-268): the item is loaded by id AND user_id — an item id in
// the body alone never grants access to another tenant's row.
// POST /aspects/write-back — fold specifics-editor edits back into the item's
// structured columns (Brand/Size/Color/Material/Style), so those five stay
// SINGLE-ENTRY no matter which screen the seller typed them on.
//
// The web composer does this inline on save (aspectWriteBackPatch →
// reverseProjectAspectColumns). iOS had no equivalent, so an aspect typed in
// the specifics editor never reached its column — and since the column is the
// write-authority at publish/revise, the seller's entry was silently clobbered
// on the next item save and they had to type it in BOTH places. This endpoint
// gives every non-web client the same close-the-loop write off the SHARED
// registry, rather than a second mapping table that can drift.
flipdeskEbayRoutes.post("/aspects/write-back", async (c) => {
  // US-268: service-role client bypasses RLS — scope the item read AND the
  // update to the caller's workspace, and never trust the body's item id alone.
  const userId = (c.get("workspaceOwnerId") ?? c.get("userId")) as
    | string
    | undefined;
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  let body: {
    itemId?: string;
    aspects?: Record<string, string[]>;
    sources?: Record<string, string>;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const itemId = (body.itemId ?? "").trim();
  if (!itemId) return c.json({ error: "itemId is required" }, 400);
  const aspects = body.aspects ?? {};
  const sources = body.sources ?? {};

  const { data: item, error: itemErr } = await supabaseAdmin
    .from("inventory_items")
    .select("id, user_id, item_category, brand, size, color, material, style")
    .eq("id", itemId)
    .eq("user_id", userId)
    .maybeSingle();
  if (itemErr) return c.json({ error: "Could not load item." }, 500);
  if (!item) return c.json({ error: "Item not found." }, 404);

  const patch = reverseColumnAspects(
    item as unknown as RegistryItem,
    aspects,
    sources,
  );
  if (Object.keys(patch).length === 0) return c.json({ updated: {} });

  const { error: upErr } = await supabaseAdmin
    .from("inventory_items")
    .update(patch as never)
    .eq("id", itemId)
    .eq("user_id", userId);
  if (upErr) return c.json({ error: "Could not update item." }, 500);
  return c.json({ updated: patch });
});

flipdeskEbayRoutes.post("/category/:id/derive-aspects", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = (c.get("workspaceOwnerId") ?? c.get("userId")) as
    | string
    | undefined;
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const categoryId = c.req.param("id");
  if (!categoryId) return c.json({ error: "category id is required" }, 400);

  let body: { itemId?: string; knownAspects?: Record<string, string[]> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const itemId = (body.itemId ?? "").trim();
  if (!itemId) return c.json({ error: "itemId is required" }, 400);
  const known = body.knownAspects ?? {};

  const { data: item, error: itemErr } = await supabaseAdmin
    .from("inventory_items")
    .select(
      "id, user_id, title, brand, size, description, condition_notes, item_category, color, material, style, attributes, measurements",
    )
    .eq("id", itemId)
    .eq("user_id", userId)
    .maybeSingle();
  if (itemErr) return c.json({ error: "Could not load item." }, 500);
  if (!item) return c.json({ error: "Item not found." }, 404);

  try {
    const aspectsResp = await getCategoryAspects(categoryId);
    const raw = (aspectsResp.aspects as Record<string, unknown>).aspects;
    const list = Array.isArray(raw) ? (raw as AspectSpecRaw[]) : [];
    const validAspectNames = list
      .map((a) => (a.localizedAspectName ?? "").trim())
      .filter((n) => n.length > 0);
    const derived = deriveAspectsFromItem(
      item as unknown as PublishItem,
      list,
      known,
    );
    // US-1503: fold captured measurements onto the category's free-text
    // measurement aspects (Inseam, Chest Size, …) — the SAME registry mapping
    // AutoLister uses (measurements.ts) — so a measurement edit reaches the
    // composer/publish/revise, not just the initial AI generation. Never
    // overwrites a known/derived value.
    const meas = (item as { measurements?: Measurements }).measurements;
    if (meas && Object.keys(meas).length > 0) {
      const measAspects = resolveMeasurementAspects(
        meas,
        allowedAspectsFromSpec(list),
        { ...known, ...derived },
        "in",
        // US-2796 AC3: a UK or EU number must not fill "US Shoe Size". Absent
        // scale = today's behaviour, so nothing changes for a US shoe.
        shoeScaleOf(item),
      );
      for (const [k, v] of Object.entries(measAspects)) derived[k] = v;
    }
    // The five COLUMN-owned aspects (Brand/Size/Color/Material/Style) are not
    // gap-fills — the main-page column is their write-authority, exactly as the
    // web composer treats them (projectColumnAspects in src/lib/ebay-prefill.ts,
    // and applyColumnAspects on the publish path). `derived` above only fills
    // BLANKS, so an aspect the AI had already written stayed put and a seller who
    // fixed Brand on the item page still had to retype it in the specifics
    // editor. Force the projection here and name the aspects the client must
    // overwrite regardless of their current provenance — that is the whole
    // difference between the desktop and iOS behaviour.
    const registryAspects = toRegistryAspects(list);
    const projection = columnAspectProjection(
      item as unknown as RegistryItem,
      registryAspects,
    );
    for (const [name, values] of Object.entries(projection.set)) {
      derived[name] = values;
    }
    // US-825: tell the client these gap-fills are inventory_derived so its
    // provenance badges and the source map it persists stay accurate.
    const sources = sourcesFor(Object.keys(derived), "inventory_derived");
    return c.json({
      categoryId,
      derived,
      sources,
      validAspectNames,
      // Overwrite these even if they are currently marked manual/AI.
      columnOwned: Object.keys(projection.set),
      // The backing column was blanked — drop these instead of keeping a stale
      // value the seller believes they deleted.
      columnCleared: projection.clear,
    });
  } catch (err) {
    console.error("[flipdesk-ebay] derive-aspects failed:", err);
    return c.json({ error: "Aspect derivation failed" }, 502);
  }
});

// Compares the current eBay category against what the Taxonomy API would
// suggest for the listing's title today. Lets the user spot listings that
// are filed under a suboptimal category (which hurts search visibility).
//
// Returns the current category (id + name + breadcrumb) and the top 5
// suggestions. `match` is true iff the top suggestion equals the current.
flipdeskEbayRoutes.get("/listings/:id/category-check", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");

  // Load the listing + its title (from the joined inventory_item or the
  // listing's own listing_title). Ownership check via the item user_id.
  const { data: row } = await supabaseAdmin
    .from("listings")
    .select(
      "id, platform_category_id, platform_listing_id, listing_title, inventory_items!inner(user_id, title, brand, style)"
    )
    .eq("id", listingId)
    .maybeSingle();
  if (!row) return c.json({ error: "Listing not found" }, 404);
  const r = row as unknown as {
    id: string;
    platform_category_id: string | null;
    platform_listing_id: string | null;
    listing_title: string | null;
    inventory_items: {
      user_id: string;
      title: string | null;
      brand: string | null;
      style: string | null;
    };
  };
  if (r.inventory_items.user_id !== userId) {
    return c.json({ error: "Listing not found" }, 404);
  }

  // Title we'll feed into the Taxonomy query — use whatever's most
  // representative: the listing's actual title beats the item title.
  const queryParts = [r.listing_title ?? r.inventory_items.title]
    .filter((s): s is string => !!s && s.trim() !== "");
  if (queryParts.length === 0) {
    return c.json(
      { error: "Listing has no title — can't suggest a category." },
      400
    );
  }
  const query = queryParts[0]!;

  // Run current-category lookup + suggestions in parallel — independent calls.
  const [currentInfo, suggestions] = await Promise.all([
    r.platform_category_id
      ? getCategoryName(r.platform_category_id).catch(() => null)
      : Promise.resolve(null),
    suggestCategories(query).catch((err) => {
      console.error("[flipdesk-ebay] suggestCategories failed:", err);
      return [] as Awaited<ReturnType<typeof suggestCategories>>;
    }),
  ]);

  const top = suggestions[0] ?? null;
  const match =
    !!r.platform_category_id && !!top && top.categoryId === r.platform_category_id;

  return c.json({
    listing_id: listingId,
    current: r.platform_category_id
      ? {
          id: r.platform_category_id,
          name: currentInfo?.name ?? null,
          path: currentInfo?.path ?? null,
        }
      : null,
    suggested: suggestions.slice(0, 5).map((s) => ({
      id: s.categoryId,
      name: s.categoryName,
      path: s.categoryTreePath,
    })),
    match,
    query_used: query,
  });
});

// US-1895: bulk recommended-aspect coverage for the AutoLister drafts list, so a
// bulk session can sort/fix low-coverage drafts. Body { itemIds: string[] } →
// { coverage: { [itemId]: { filled, total, missing } } }. Tenant-scoped: only
// the caller's own items resolve (foreign ids simply don't match and are
// omitted). Category specs are cached + de-duped so a page of drafts sharing a
// category costs one Taxonomy read. Uses the same recommendedAspectCoverage
// rule as the composer meter + publish preflight (single source).
flipdeskEbayRoutes.post("/aspect-coverage", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { itemIds?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const itemIds = Array.isArray(body.itemIds)
    ? [...new Set(body.itemIds.filter((x): x is string => typeof x === "string"))]
        .slice(0, 200)
    : [];
  if (itemIds.length === 0) return c.json({ coverage: {} });

  // Owner-scoped: per-listing canonical aspects + category first, item mirror as
  // the fallback for drafts that never got a listing override.
  const [{ data: listingsRaw }, { data: itemsRaw }] = await Promise.all([
    supabaseAdmin
      .from("listings")
      .select("inventory_item_id, platform_category_id, item_specifics_override")
      .eq("user_id", userId)
      .in("inventory_item_id", itemIds),
    supabaseAdmin
      .from("inventory_items")
      .select("id, ebay_category_id, ebay_aspects")
      .eq("user_id", userId)
      .in("id", itemIds),
  ]);

  const listingByItem = new Map<
    string,
    { platform_category_id: string | null; item_specifics_override: Record<string, string[]> | null }
  >();
  for (const l of (listingsRaw ?? []) as Array<{
    inventory_item_id: string;
    platform_category_id: string | null;
    item_specifics_override: Record<string, string[]> | null;
  }>) listingByItem.set(l.inventory_item_id, l);

  const itemById = new Map<
    string,
    { ebay_category_id: string | null; ebay_aspects: Record<string, string[]> | null }
  >();
  for (const it of (itemsRaw ?? []) as Array<{
    id: string;
    ebay_category_id: string | null;
    ebay_aspects: Record<string, string[]> | null;
  }>) itemById.set(it.id, it);

  // Fetch each distinct category's spec once.
  const specCache = new Map<string, AspectSpecRaw[]>();
  async function specFor(categoryId: string): Promise<AspectSpecRaw[]> {
    const hit = specCache.get(categoryId);
    if (hit) return hit;
    try {
      const resp = await getCategoryAspects(categoryId);
      const raw = (resp.aspects as Record<string, unknown>).aspects;
      const list = Array.isArray(raw) ? (raw as AspectSpecRaw[]) : [];
      specCache.set(categoryId, list);
      return list;
    } catch {
      specCache.set(categoryId, []);
      return [];
    }
  }

  const coverage: Record<string, AspectCoverage> = {};
  for (const itemId of itemIds) {
    const listing = listingByItem.get(itemId);
    const item = itemById.get(itemId);
    if (!listing && !item) continue; // not owned → omit
    const categoryId = listing?.platform_category_id ?? item?.ebay_category_id ?? null;
    if (!categoryId) continue;
    const aspects = listing?.item_specifics_override ?? item?.ebay_aspects ?? {};
    coverage[itemId] = recommendedAspectCoverage(await specFor(categoryId), aspects);
  }

  return c.json({ coverage });
});

// Live comps for the composer's pricing panel. Uses the Browse API + app token
// (no seller OAuth needed). US-1060: a narrow search auto-broadens down a ladder
// (drop size → drop trailing title tokens → brand+category → category) until it
// clears a configurable minimum, and the returned set is tagged with how broad
// it is. Sold (realized) comps via Marketplace Insights are merged in and tagged
// when the grant is enabled (graceful no-op otherwise).
flipdeskEbayRoutes.get("/comps", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const categoryId = c.req.query("category_id")?.trim();
  if (!categoryId) {
    return c.json({ error: "category_id is required" }, 400);
  }
  const q = c.req.query("q") ?? undefined;
  const brand = c.req.query("brand") ?? undefined;
  const size = c.req.query("size") ?? undefined;
  const conditionId = c.req.query("condition_id") ?? undefined;
  // US-2245: the tag's style code, when the item has one. Adds a rung ABOVE
  // exact; absent, the ladder behaves exactly as it did before.
  const styleCode = c.req.query("style_code")?.trim() || undefined;
  // US-2974: which item these comps are FOR, when the caller knows. Optional,
  // because this endpoint is otherwise item-agnostic (it takes brand/size/
  // category, not an id) and is also used for loose lookups. When present it is
  // what lets the comp stage earn XP: repricing_suggestions only exists once an
  // item has a listing, so a comp run during drafting left no mark at all.
  const compItemId = c.req.query("item_id")?.trim() || undefined;
  const limitRaw = c.req.query("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;

  try {
    const minResults = await getSetting<number>(
      COMP_MIN_RESULTS_SETTING_KEY,
      DEFAULT_MIN_COMP_RESULTS,
    );
    const result = await searchCompsWithLadder(
      {
        categoryId,
        q,
        brand,
        size,
        conditionId,
        styleCode,
        limit: Number.isFinite(limit) ? limit : undefined,
      },
      { minResults },
    );
    // Stamp AFTER a successful search: a failed lookup is not a comp. Set-once
    // and tenant-scoped inside markComped, and best-effort — a rewards
    // bookkeeping problem must not cost the seller the comps they asked for.
    if (compItemId) {
      const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
      if (ownerId) await markComped(ownerId, compItemId);
    }
    return c.json(result);
  } catch (err) {
    console.error("[flipdesk-ebay] comps search failed:", err);
    return c.json({ error: "Comps search failed" }, 502);
  }
});
