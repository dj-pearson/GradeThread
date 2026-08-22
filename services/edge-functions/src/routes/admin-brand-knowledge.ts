import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import {
  type CheckedUpdateClient,
  updateByIdChecked,
  ZeroRowsAffectedError,
} from "../lib/db-write.ts";
import { requireScope } from "../lib/scope-guard.ts";
import { resolveBrandKnowledgePack } from "../lib/brand-knowledge.ts";
import {
  EXHAUSTED_EMPTY_PASSES,
  MAX_DISCOVERY_OFFSET,
} from "../lib/style-code-discovery.ts";
import { runStyleCodeDiscovery } from "./jobs-style-code-discovery.ts";
import { validateTellsForWrite } from "../lib/brand-authenticity.ts";
import {
  groupStyleCodeRows,
  keywordsForPromotedStyle,
  orderReviewQueue,
  effectivePromotionSource,
  promotionRefusal,
  reviewItemFor,
} from "../lib/style-code-review.ts";

// US-1715: admin authoring + verification surface for the Brand & Style
// Knowledge Base (00389 tables: brand_knowledge / brand_styles /
// brand_style_codes / brand_colorways / brand_size_charts). Mounted at
// /api/admin/brand-knowledge, it inherits authMiddleware + adminAuthMiddleware
// (admin/super_admin + AAL2 MFA) from the /api/admin/* group in main.ts, plus a
// whole-router content:publish scope guard.
//
// The five tables are GLOBAL REFERENCE (no user_id / tenant, deny-all RLS), so
// all reads + writes run service-role and the admin+MFA+scope gate IS the
// authorization boundary — there is intentionally no per-tenant scoping. This is
// where AI-drafted / migration-seeded facts get human-VERIFIED (verified=true)
// or corrected; every fact carries source_url + confidence so a reviewer can
// judge it. `updated_by` is stamped with the acting admin for attribution.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminBrandKnowledgeRoutes = new Hono<AdminEnv>();

// Whole-router scope guard (registered in lib/admin-scope-map.ts).
adminBrandKnowledgeRoutes.use("*", requireScope("content:publish"));

const db = supabaseAdmin as unknown as CheckedUpdateClient;

// The five KB tables and the columns an admin may edit on each. brand_key is
// deliberately NOT editable — it's the identity/link key. Anything not listed
// is rejected, so a typo can never write an arbitrary column.
const KB_TABLES: Record<string, readonly string[]> = {
  brand_knowledge: [
    "canonical_brand", "aliases", "category_focus", "registered_numbers",
    "tag_eras", "country_patterns", "authentication_tells", "notes",
    "source_url", "confidence", "verified",
  ],
  brand_styles: [
    "style_name", "aliases", "product_line", "department", "category",
    "visual_fingerprint", "fabric_tech", "era", "msrp_band", "keywords",
    "source_url", "confidence", "verified",
  ],
  brand_style_codes: [
    "decoder_kind", "description", "pattern", "extraction_rules", "examples",
    "source_url", "confidence", "verified",
  ],
  brand_colorways: [
    "color_name", "aliases", "hex", "years",
    "source_url", "confidence", "verified",
  ],
  brand_size_charts: [
    "brand_label", "brand_match", "department", "garment", "category_match",
    "rows", "note", "source_url", "confidence", "verified",
  ],
};
const CHILD_TABLES = [
  "brand_styles", "brand_style_codes", "brand_colorways", "brand_size_charts",
] as const;

// ── GET / — list brands with child-row counts ────────────────────────────────
adminBrandKnowledgeRoutes.get("/", async (c) => {
  const { data: brands, error } = await supabaseAdmin
    .from("brand_knowledge")
    .select(
      "id, brand_key, canonical_brand, aliases, category_focus, verified, confidence, source_url, updated_by, updated_at",
    )
    .order("canonical_brand", { ascending: true });
  if (error) {
    console.error("[admin-brand-kb] list failed:", error.message);
    return c.json({ error: "Could not load brands" }, 500);
  }

  // Cheap per-brand child counts (the KB is small — dozens of brands).
  const counts: Record<string, Record<string, number>> = {};
  for (const table of CHILD_TABLES) {
    const { data } = await supabaseAdmin.from(table).select("brand_key");
    for (const row of (data ?? []) as Array<{ brand_key: string }>) {
      (counts[row.brand_key] ??= {})[table] =
        ((counts[row.brand_key] ??= {})[table] ?? 0) + 1;
    }
  }

  const rows = (brands ?? []).map((b) => ({
    ...b,
    counts: counts[(b as { brand_key: string }).brand_key] ?? {},
  }));
  return c.json({ brands: rows });
});

// ── GET /:brandKey — all facts for a brand + the compact pack preview ─────────
adminBrandKnowledgeRoutes.get("/:brandKey", async (c) => {
  const brandKey = c.req.param("brandKey");

  const [knowledge, styles, codes, colorways, charts] = await Promise.all([
    supabaseAdmin.from("brand_knowledge").select("*").eq("brand_key", brandKey)
      .maybeSingle(),
    supabaseAdmin.from("brand_styles").select("*").eq("brand_key", brandKey)
      .order("style_name", { ascending: true }),
    supabaseAdmin.from("brand_style_codes").select("*").eq("brand_key", brandKey)
      .order("decoder_kind", { ascending: true }),
    supabaseAdmin.from("brand_colorways").select("*").eq("brand_key", brandKey)
      .order("color_name", { ascending: true }),
    supabaseAdmin.from("brand_size_charts").select("*").eq("brand_key", brandKey)
      .order("department", { ascending: true }),
  ]);

  const err = knowledge.error || styles.error || codes.error ||
    colorways.error || charts.error;
  if (err) {
    console.error("[admin-brand-kb] detail failed:", err.message);
    return c.json({ error: "Could not load brand knowledge" }, 500);
  }

  // Pack preview — EXACTLY what the extractor (US-1713) would receive for this
  // brand, so a reviewer sees the effect of their edits (noCache = live).
  let pack = null;
  const canonical = (knowledge.data as { canonical_brand?: string } | null)
    ?.canonical_brand;
  if (canonical) {
    try {
      pack = await resolveBrandKnowledgePack(canonical, { noCache: true });
    } catch (e) {
      console.warn(
        "[admin-brand-kb] pack preview failed:",
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  return c.json({
    knowledge: knowledge.data ?? null,
    styles: styles.data ?? [],
    codes: codes.data ?? [],
    colorways: colorways.data ?? [],
    charts: charts.data ?? [],
    pack,
  });
});

// Validate + coerce a patch against a table's editable-column allow-list.
// Exported for unit testing — it is the write-safety boundary (a non-editable
// column, a bad confidence, or a non-boolean verified must never reach the DB).
export function buildPatch(
  table: string,
  body: Record<string, unknown>,
): { patch: Record<string, unknown> } | { error: string } {
  const allowed = KB_TABLES[table];
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.includes(key)) continue; // silently drop non-editable keys
    if (key === "confidence") {
      // US-1996 AC5: a NULL confidence is no longer writable. This branch used
      // to pass `null` straight through, which is how the "every fact carries
      // source_url + confidence" claim in US-1716 AC4 became a convention
      // instead of a rule — the columns are nullable in 00389 and nothing
      // upstream said no. Migration 00578 now enforces it in the database, so
      // leaving this open would only convert a clean 400 into a constraint
      // violation surfacing as a 500.
      //
      // Note what is NOT required: a HIGH confidence. 0 is a legitimate value
      // and 00576 deliberately seeds dating claims at 0.4. The requirement is
      // that somebody said how sure they were.
      if (value === null) {
        return { error: "confidence is required — a fact with no confidence is not a fact" };
      }
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        return { error: "confidence must be a number in [0,1]" };
      }
      patch.confidence = n;
      continue;
    }
    if (key === "source_url") {
      // US-1996 AC5, the other half of the same rule. Blank is what the DB
      // constraint refuses, so refuse it here where the error can say why.
      // `seed:<file>.ts` is an accepted form — it names a real, readable origin.
      if (typeof value !== "string" || value.trim() === "") {
        return { error: "source_url is required — say where the fact came from" };
      }
      patch.source_url = value.trim();
      continue;
    }
    if (key === "verified") {
      if (typeof value !== "boolean") {
        return { error: "verified must be a boolean" };
      }
      patch.verified = value;
      continue;
    }
    // US-1768: enforce STRUCTURED authentication tells on write. The generic
    // JSONB column would otherwise accept any shape; here we require an array of
    // checkable {category, claim, check, confidence, ...} entries and store the
    // canonicalized result (unknown categories → 'other', confidence clamped).
    if (table === "brand_knowledge" && key === "authentication_tells") {
      const v = validateTellsForWrite(value);
      if (!v.ok) return { error: v.error };
      patch.authentication_tells = v.tells;
      continue;
    }
    patch[key] = value;
  }
  if (Object.keys(patch).length === 0) {
    return { error: "No editable fields in the request" };
  }
  return { patch };
}

// ── PATCH /:table/:id — edit or verify one fact ──────────────────────────────
adminBrandKnowledgeRoutes.patch("/:table/:id", async (c) => {
  const table = c.req.param("table");
  const id = c.req.param("id");
  const adminId = c.get("userId");
  // US-2356 AC5: `in` walks the PROTOTYPE CHAIN, so "toString",
  // "constructor", "valueOf" and friends all satisfied this allow-list.
  // Nothing catastrophic followed — the lookup then yields undefined and the
  // request dies on a TypeError or at PostgREST — but an allow-list that admits
  // names it does not list is not an allow-list, and "it fails later anyway" is
  // the argument that keeps a weak check in place right up until the thing after
  // it stops failing.
  if (!Object.hasOwn(KB_TABLES, table)) {
    return c.json({ error: "Unknown brand-knowledge table" }, 400);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const built = buildPatch(table, body);
  if ("error" in built) return c.json({ error: built.error }, 400);

  // Read the prior row for the audit trail.
  const { data: before } = await supabaseAdmin.from(table).select("*").eq(
    "id",
    id,
  ).maybeSingle();
  if (!before) return c.json({ error: "Row not found" }, 404);

  const patch = { ...built.patch, updated_by: `admin:${adminId}` };
  try {
    await updateByIdChecked(db, table, id, patch);
  } catch (e) {
    if (e instanceof ZeroRowsAffectedError) {
      return c.json({ error: "Row not found" }, 404);
    }
    console.error("[admin-brand-kb] update failed:", e);
    return c.json({ error: "Update failed" }, 500);
  }

  const { data: after } = await supabaseAdmin.from(table).select("*").eq(
    "id",
    id,
  ).maybeSingle();
  await writeAuditLog(c, {
    action: "brand_knowledge.update",
    targetType: table,
    targetId: id,
    before,
    after,
  });
  return c.json({ row: after });
});

// ── DELETE /:table/:id — remove a bad fact ───────────────────────────────────
adminBrandKnowledgeRoutes.delete("/:table/:id", async (c) => {
  const table = c.req.param("table");
  const id = c.req.param("id");
  if (!Object.hasOwn(KB_TABLES, table)) {
    return c.json({ error: "Unknown brand-knowledge table" }, 400);
  }

  const { data: before } = await supabaseAdmin.from(table).select("*").eq(
    "id",
    id,
  ).maybeSingle();
  if (!before) return c.json({ error: "Row not found" }, 404);

  const { error } = await supabaseAdmin.from(table).delete().eq("id", id);
  if (error) {
    console.error("[admin-brand-kb] delete failed:", error.message);
    return c.json({ error: "Delete failed" }, 500);
  }
  await writeAuditLog(c, {
    action: "brand_knowledge.delete",
    targetType: table,
    targetId: id,
    before,
  });
  return c.json({ ok: true });
});


// ── US-2693: the learned style-code index, and what to do about it ───────────
//
// Everything above edits facts a human authored. This edits what the machine
// LEARNED — style_code_names (00628), filled by the market sweep (US-2690) and
// by sellers correcting us (US-2692). Two verbs an admin needs and nothing else
// has: PROMOTE a name that is right into permanent brand_styles knowledge, and
// REJECT one that is wrong.
//
// Rejection RECORDS rather than deletes. A deleted row is one the sweep hands
// straight back next tick from the same listings; a rejected one it cannot.

/** Rows read per review page. The queue is ordered in code, not in SQL, because
 *  the ordering rule (conflict first, then thin evidence) is not expressible as
 *  a column and is worth a unit test. */
const STYLE_CODE_REVIEW_SCAN = 2000;

// ── GET /style-codes/discovery — how the brand-first crawl is doing ─────────
//
// US-2785: the crawl spends a shared eBay allowance every night and until now
// spent it invisibly. The number that decides whether to crawl MORE brands or
// FEWER brands deeper is codes per lookup, so it is computed here rather than
// left for whoever is reading to divide two totals in their head.
//
// Read-only. Nothing on this surface starts, stops or re-runs a crawl.
adminBrandKnowledgeRoutes.get("/style-codes/discovery", async (c) => {
  const [{ data: brands, error: brandErr }, { data: state, error: stateErr }] =
    await Promise.all([
      supabaseAdmin
        .from("brand_knowledge")
        .select("brand_key, canonical_brand")
        .order("canonical_brand", { ascending: true }),
      supabaseAdmin
        .from("style_code_discovery_state")
        .select(
          "brand_key, page_offset, last_run_at, pass_count, listings_seen, codes_found, empty_passes",
        ),
    ]);
  if (brandErr || stateErr) {
    console.error(
      "[admin-brand-kb] discovery read failed:",
      brandErr?.message ?? stateErr?.message,
    );
    return c.json({ error: "Could not load crawl state" }, 500);
  }

  const byKey = new Map<string, Record<string, unknown>>();
  for (const row of (state ?? []) as Array<Record<string, unknown>>) {
    byKey.set(String(row.brand_key), row);
  }

  const rows = ((brands ?? []) as Array<{
    brand_key: string;
    canonical_brand: string;
  }>).map((b) => {
    const st = byKey.get(b.brand_key);
    const listingsSeen = Number(st?.listings_seen ?? 0);
    const codesFound = Number(st?.codes_found ?? 0);
    const pageOffset = Number(st?.page_offset ?? 0);
    const emptyPasses = Number(st?.empty_passes ?? 0);
    return {
      brand_key: b.brand_key,
      brand: b.canonical_brand,
      last_run_at: (st?.last_run_at as string | null) ?? null,
      page_offset: pageOffset,
      pass_count: Number(st?.pass_count ?? 0),
      listings_seen: listingsSeen,
      codes_found: codesFound,
      empty_passes: emptyPasses,
      // A rate, not a total: a brand crawled twice as long is not a brand
      // yielding twice as well, and the totals alone read as if it were.
      codes_per_listing: listingsSeen > 0
        ? Math.round((codesFound / listingsSeen) * 1000) / 1000
        : null,
      // Wrapped cursor, or several passes with nothing new. Either way the
      // crawl has stopped learning from this brand for now.
      exhausted: pageOffset >= MAX_DISCOVERY_OFFSET ||
        emptyPasses >= EXHAUSTED_EMPTY_PASSES,
    };
  });

  return c.json({ brands: rows });
});

// ── POST /style-codes/discovery/run — crawl now, without waiting for 3am ────
//
// US-2787: the same tick the cron runs, called by hand. It is the SAME function
// (runStyleCodeDiscovery), not a second implementation, because a manual path
// with its own copy of the budget, the lock and the own-listing exclusion is a
// copy nobody would notice drifting.
//
// Body: { brand_key?: string }. With a brand, that brand is crawled now
// regardless of its cooldown and it is the only one crawled. Without, the run is
// exactly the nightly rotation.
//
// The job lock does the rate limiting: clicking the button three times while a
// crawl is running returns skipped twice rather than tripling the eBay spend.
adminBrandKnowledgeRoutes.post("/style-codes/discovery/run", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const brandKey = typeof body?.brand_key === "string"
    ? body.brand_key.trim()
    : "";

  try {
    const result = await runStyleCodeDiscovery(
      brandKey
        // One brand, and a budget of one so a manual run cannot quietly turn
        // into a full nightly rotation the operator did not ask for.
        ? { forceBrandKeys: [brandKey], budget: 1 }
        : {},
    );
    await writeAuditLog(c, {
      action: "brand_knowledge.run_style_code_discovery",
      targetType: "style_code_discovery",
      targetId: brandKey || null,
      details: {
        brand_key: brandKey || "rotation",
        crawled: result.crawled ?? 0,
        new_codes: result.newCodes ?? 0,
        skipped: result.skipped ?? false,
      },
    });
    return c.json(result);
  } catch (err) {
    console.error(
      "[admin-brand-kb] manual discovery run failed:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "The crawl failed to start" }, 500);
  }
});

adminBrandKnowledgeRoutes.get("/style-codes/review", async (c) => {
  const brand = c.req.query("brand")?.trim();
  const limit = Math.min(
    Math.max(Number.parseInt(c.req.query("limit") ?? "100", 10) || 100, 1),
    500,
  );

  let query = supabaseAdmin
    .from("style_code_names")
    .select(
      "id, brand_key, style_code_norm, style_code_raw, name, source, supporting, confidence, evidence_url, rejected_at, updated_at",
    )
    .order("updated_at", { ascending: false })
    .limit(STYLE_CODE_REVIEW_SCAN);
  if (brand) query = query.eq("brand_key", brand);

  const { data, error } = await query;
  if (error) {
    console.error("[admin-brand-kb] style-code review read failed:", error.message);
    return c.json({ error: "Read failed" }, 500);
  }

  const rows = (data ?? []) as Array<
    Parameters<typeof groupStyleCodeRows>[0][number]
  >;
  const queue = orderReviewQueue(groupStyleCodeRows(rows).map(reviewItemFor));
  return c.json({
    items: queue.slice(0, limit),
    total: queue.length,
    // Say it when the scan bound, so "nothing left to review" is never a lie
    // told by a LIMIT.
    truncated: rows.length >= STYLE_CODE_REVIEW_SCAN,
  });
});

// ── POST /style-codes/:id/reject — this name is wrong ────────────────────────
adminBrandKnowledgeRoutes.post("/style-codes/:id/reject", async (c) => {
  const id = c.req.param("id");
  // No updated_by stamp here on purpose: 00628's columns describe the NAME, not
  // who touched it, and the acting admin is already the audit log's subject.
  const { data: before } = await supabaseAdmin
    .from("style_code_names")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!before) return c.json({ error: "Row not found" }, 404);

  const { data: after, error } = await supabaseAdmin
    .from("style_code_names")
    .update({ rejected_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) {
    console.error("[admin-brand-kb] style-code reject failed:", error.message);
    return c.json({ error: "Reject failed" }, 500);
  }

  await writeAuditLog(c, {
    action: "brand_knowledge.style_code_reject",
    targetType: "style_code_names",
    targetId: id,
    before,
    after,
  });
  return c.json({ row: after });
});

// ── POST /style-codes/:id/promote — this name is right, keep it forever ──────
adminBrandKnowledgeRoutes.post("/style-codes/:id/promote", async (c) => {
  const id = c.req.param("id");
  const adminId = c.get("userId");

  let body: Record<string, unknown> = {};
  try {
    body = await c.req.json();
  } catch {
    // Body is optional — department is the only thing a human can add that the
    // code cannot, and an empty one is valid (00389 defaults it to '').
  }

  const { data: row } = await supabaseAdmin
    .from("style_code_names")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!row) return c.json({ error: "Row not found" }, 404);

  const learned = row as {
    brand_key: string;
    style_code_raw: string;
    name: string;
    source: string;
    confidence: number;
    evidence_url: string | null;
    rejected_at: string | null;
  };
  const sourceUrl = effectivePromotionSource(body.source_url, learned.evidence_url);
  const refusal = promotionRefusal(learned, sourceUrl);
  if (refusal) return c.json({ error: refusal.error }, refusal.status as 400 | 409);

  const department = typeof body.department === "string" ? body.department.trim() : "";
  const styleRow = {
    brand_key: learned.brand_key,
    style_name: learned.name,
    department,
    keywords: keywordsForPromotedStyle(learned.name),
    // The code itself is the most searchable alias a style row can carry.
    aliases: [learned.style_code_raw],
    source_url: sourceUrl,
    confidence: learned.confidence,
    // Promoting IS the human verification. That is the whole verb.
    verified: true,
    updated_by: `admin:${adminId}`,
  };

  const { data: created, error } = await supabaseAdmin
    .from("brand_styles")
    .upsert(styleRow, { onConflict: "brand_key,style_name,department" })
    .select("*")
    .maybeSingle();
  if (error) {
    console.error("[admin-brand-kb] style promote failed:", error.message);
    return c.json({ error: "Promote failed" }, 500);
  }

  await writeAuditLog(c, {
    action: "brand_knowledge.style_code_promote",
    targetType: "brand_styles",
    targetId: (created as { id?: string } | null)?.id ?? id,
    after: created,
  });
  return c.json({ style: created });
});
