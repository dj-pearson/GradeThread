import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireScope } from "../lib/scope-guard.ts";
import {
  parseRegisteredNumber,
  registeredNumberKey,
  resetRegisteredNumberIndex,
} from "../lib/registered-numbers.ts";

// US-2244: the RN/CA resolve queue. Mounted at /api/admin/registered-numbers, it
// inherits authMiddleware + adminAuthMiddleware (admin/super_admin + AAL2 MFA)
// from the /api/admin/* group in main.ts, plus a whole-router content:publish
// guard — the same gate as the rest of the brand knowledge base.
//
// WHY THIS EXISTS: the FTC registry has no API and no bulk download, so RN
// coverage cannot be imported. US-2243 counts the numbers real tags carry; this
// router is where an operator resolves the most-sighted ones, cheapest-first.
//
// Both tables (00501 sightings, 00502 registry) are AGGREGATE, non-tenant
// reference data with no owner column, so there is deliberately no per-tenant
// scoping here: the admin + MFA + scope gate IS the authorization boundary, and
// nothing these routes can return belongs to a seller.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminRegisteredNumbersRoutes = new Hono<AdminEnv>();

adminRegisteredNumbersRoutes.use("*", requireScope("content:publish"));

// ── GET / — the queue: unresolved numbers, most-sighted first ────────────────
adminRegisteredNumbersRoutes.get("/", async (c) => {
  const includeResolved = c.req.query("include_resolved") === "true";
  const limitRaw = Number(c.req.query("limit") ?? "100");
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.floor(limitRaw), 1), 500)
    : 100;

  let query = supabaseAdmin
    .from("registered_number_sightings")
    .select(
      "registry_key, kind, digits, sighting_count, declared_brands, resolved, first_seen_at, last_seen_at",
    )
    .order("sighting_count", { ascending: false })
    .limit(limit);
  if (!includeResolved) query = query.eq("resolved", false);

  const [sightings, registry] = await Promise.all([
    query,
    supabaseAdmin
      .from("registered_number_registry")
      .select("registry_key, company_name, brand_keys, source_url, notes, verified, updated_at")
      .order("updated_at", { ascending: false })
      .limit(limit),
  ]);
  if (sightings.error || registry.error) {
    console.error(
      "[admin-rn] queue load failed:",
      sightings.error?.message ?? registry.error?.message,
    );
    return c.json({ error: "Could not load registered numbers" }, 500);
  }

  return c.json({
    sightings: sightings.data ?? [],
    registry: registry.data ?? [],
  });
});

// ── POST / — record who a number is registered to ───────────────────────────
adminRegisteredNumbersRoutes.post("/", async (c) => {
  const body = await c.req.json().catch(() => null) as {
    registry_key?: unknown;
    company_name?: unknown;
    brand_keys?: unknown;
    source_url?: unknown;
    notes?: unknown;
    verified?: unknown;
  } | null;
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  // Accept either the canonical key ("RN:87370") or a number as printed, and
  // normalize both through the same parser the cross-check uses — a registry row
  // keyed differently from the sighting would never match anything.
  const rawKey = typeof body.registry_key === "string"
    ? body.registry_key.trim()
    : "";
  if (!rawKey) return c.json({ error: "registry_key is required" }, 400);
  const parsed = parseRegisteredNumber(rawKey.replace(":", " "));
  if (!parsed) {
    return c.json(
      { error: "registry_key is not a parseable RN/CA number" },
      400,
    );
  }
  const registryKey = registeredNumberKey(parsed);

  const company = typeof body.company_name === "string"
    ? body.company_name.trim()
    : "";
  const brandKeys = Array.isArray(body.brand_keys)
    ? body.brand_keys
      .filter((b): b is string => typeof b === "string")
      .map((b) => b.trim())
      .filter(Boolean)
    : [];
  if (!company && brandKeys.length === 0) {
    return c.json(
      { error: "Give a company_name, brand_keys, or both — an empty row records nothing." },
      400,
    );
  }

  const { error: upsertError } = await supabaseAdmin
    .from("registered_number_registry")
    .upsert(
      {
        registry_key: registryKey,
        kind: parsed.kind,
        digits: parsed.digits,
        company_name: company || null,
        brand_keys: brandKeys,
        source_url: typeof body.source_url === "string"
          ? body.source_url.trim() || null
          : null,
        notes: typeof body.notes === "string" ? body.notes.trim() || null : null,
        verified: body.verified === true,
        resolved_by: c.get("userId"),
      } as never,
      { onConflict: "registry_key" },
    );
  if (upsertError) {
    console.error("[admin-rn] registry upsert failed:", upsertError.message);
    return c.json({ error: "Could not save the registrant" }, 500);
  }

  // Take the number off the queue. A miss is fine: an operator may resolve a
  // number nobody has photographed yet.
  const { error: sightingError } = await supabaseAdmin
    .from("registered_number_sightings")
    .update({ resolved: true } as never)
    .eq("registry_key", registryKey);
  if (sightingError) {
    console.error(
      "[admin-rn] sighting resolve flag failed (row saved):",
      sightingError.message,
    );
  }

  // The cross-check index is cached for 5 minutes; drop it here so this instance
  // starts corroborating the number on the very next grade.
  resetRegisteredNumberIndex();

  await writeAuditLog(c, {
    action: "registered_number.resolve",
    targetType: "registered_number_registry",
    targetId: registryKey,
    after: {
      company_name: company || null,
      brand_keys: brandKeys,
      verified: body.verified === true,
    },
  });

  return c.json({ registry_key: registryKey, brand_keys: brandKeys });
});
