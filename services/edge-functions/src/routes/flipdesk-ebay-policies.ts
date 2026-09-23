// eBay routes: business policies, the merchant location and seller programs.
//
// Split out of flipdesk-ebay.ts, which mounts this router at /api/flipdesk/ebay
// alongside its siblings. The local router keeps the name flipdeskEbayRoutes so
// every handler below is byte-for-byte the text it had before the split.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  createDefaultPolicies,
  createInventoryLocation,
  isEbayConfigured,
  setDefaultPolicies,
  syncBusinessPolicies,
  getOptedInPrograms,
  optInToProgram,
  optOutOfProgram,
  isAlreadyInProgramStateError,
  type EbaySellerProgram,
} from "../lib/ebay-client.ts";
import { failSafe } from "../lib/http-errors.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { type EbayEnv } from "./flipdesk-ebay-shared.ts";


export const flipdeskEbayRoutes = new Hono<EbayEnv>();

// ── US-314: business policies + merchant location ────────────────────
//
// GET  /policies          → list cached policies + locations (syncs if empty);
//                           tenant-scoped to the workspace owner.
// PUT  /policies/default  → set the default policy of each kind (and merchant
//                           location key) — written to business_policies and
//                           marketplace_connections respectively.
// POST /policies/sync     → force a fresh pull from eBay (UI "Re-sync" button).

interface BusinessPolicyRow {
  policy_id: string;
  policy_type: "fulfillment" | "payment" | "return";
  policy_name: string;
  is_default: boolean;
  synced_from_ebay_at: string | null;
}

async function listCachedPolicies(userId: string) {
  const { data } = await supabaseAdmin
    .from("business_policies")
    .select("policy_id, policy_type, policy_name, is_default, synced_from_ebay_at")
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .order("policy_type", { ascending: true })
    .order("policy_name", { ascending: true });
  return (data ?? []) as BusinessPolicyRow[];
}

async function loadMerchantLocationKey(userId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("marketplace_connections")
    .select("merchant_location_key")
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true)
    // US-671: read the selected (primary) connection's ship-from location.
    .order("is_primary", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { merchant_location_key: string | null } | null)
    ?.merchant_location_key ?? null;
}

flipdeskEbayRoutes.get("/policies", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  try {
    let policies = await listCachedPolicies(ownerId);
    let merchantLocationKey = await loadMerchantLocationKey(ownerId);

    // Empty cache → sync once so the UI has something to render.
    if (policies.length === 0) {
      await syncBusinessPolicies(ownerId);
      policies = await listCachedPolicies(ownerId);
      merchantLocationKey = await loadMerchantLocationKey(ownerId);
    }

    const defaults = {
      fulfillment_policy_id:
        policies.find((p) => p.policy_type === "fulfillment" && p.is_default)?.policy_id ?? null,
      payment_policy_id:
        policies.find((p) => p.policy_type === "payment" && p.is_default)?.policy_id ?? null,
      return_policy_id:
        policies.find((p) => p.policy_type === "return" && p.is_default)?.policy_id ?? null,
      merchant_location_key: merchantLocationKey,
    };
    return c.json({ policies, defaults });
  } catch (err) {
    console.error("[flipdesk-ebay] /policies failed:", err);
    return c.json({ error: "Could not load eBay policies." }, 502);
  }
});

flipdeskEbayRoutes.post("/policies/sync", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  try {
    const result = await syncBusinessPolicies(ownerId);
    return c.json({
      synced: result.policies.length,
      merchant_location_key: result.merchantLocationKey,
      missing: result.missing,
      // US-2855 AC2: kinds whose stored default pointed at a policy the seller
      // deleted on eBay. The sync has already moved each to the account's first
      // policy of that kind; this is what lets the caller SAY so once, instead
      // of the seller meeting it as a refused publish.
      replaced_defaults: result.replacedDefaults,
    });
  } catch (err) {
    console.error("[flipdesk-ebay] /policies/sync failed:", err);
    return c.json({ error: "Could not sync eBay policies." }, 502);
  }
});

flipdeskEbayRoutes.put("/policies/default", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: {
    fulfillment_policy_id?: unknown;
    payment_policy_id?: unknown;
    return_policy_id?: unknown;
    merchant_location_key?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Validate each id by checking it exists in this workspace's cached
  // policies — prevents writing a stale or foreign id as default. Tenant
  // isolation: ownership is implicit in the user_id-scoped lookup.
  const cached = await listCachedPolicies(ownerId);
  const idsByKind = new Map<string, Set<string>>();
  for (const row of cached) {
    if (!idsByKind.has(row.policy_type)) idsByKind.set(row.policy_type, new Set());
    idsByKind.get(row.policy_type)!.add(row.policy_id);
  }

  const selection: {
    fulfillment_policy_id?: string;
    payment_policy_id?: string;
    return_policy_id?: string;
    merchant_location_key?: string;
  } = {};
  if (typeof body.fulfillment_policy_id === "string") {
    if (!idsByKind.get("fulfillment")?.has(body.fulfillment_policy_id)) {
      return c.json({ error: "Unknown fulfillment policy id" }, 400);
    }
    selection.fulfillment_policy_id = body.fulfillment_policy_id;
  }
  if (typeof body.payment_policy_id === "string") {
    if (!idsByKind.get("payment")?.has(body.payment_policy_id)) {
      return c.json({ error: "Unknown payment policy id" }, 400);
    }
    selection.payment_policy_id = body.payment_policy_id;
  }
  if (typeof body.return_policy_id === "string") {
    if (!idsByKind.get("return")?.has(body.return_policy_id)) {
      return c.json({ error: "Unknown return policy id" }, 400);
    }
    selection.return_policy_id = body.return_policy_id;
  }
  if (typeof body.merchant_location_key === "string" && body.merchant_location_key.trim()) {
    selection.merchant_location_key = body.merchant_location_key.trim();
  }

  await setDefaultPolicies(ownerId, selection);

  const next = await listCachedPolicies(ownerId);
  const nextLocation = await loadMerchantLocationKey(ownerId);
  return c.json({
    policies: next,
    defaults: {
      fulfillment_policy_id:
        next.find((p) => p.policy_type === "fulfillment" && p.is_default)?.policy_id ?? null,
      payment_policy_id:
        next.find((p) => p.policy_type === "payment" && p.is_default)?.policy_id ?? null,
      return_policy_id:
        next.find((p) => p.policy_type === "return" && p.is_default)?.policy_id ?? null,
      merchant_location_key: nextLocation,
    },
  });
});

// POST /policies/create → make the three business policies a first-time
// seller does not have, from four plain answers (US-3265).
//
// FlipDesk already read all three, opted the account into policy management and
// created the merchant location. It stopped short of CREATING the policies, so
// a seller with none was sent to eBay's own settings in the middle of connecting
// and every publish refused until they came back. This is the last hand-off in
// that flow.
//
// Only missing policies are created. An account that already has a shipping
// policy keeps it, untouched.
flipdeskEbayRoutes.post("/policies/create", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }

  let body: {
    handling_days?: unknown;
    shipping_cost_cents?: unknown;
    accepts_returns?: unknown;
    return_days?: unknown;
    return_shipping_paid_by?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const handlingDays = Number(body.handling_days);
  if (!Number.isInteger(handlingDays) || handlingDays < 0 || handlingDays > 30) {
    return c.json({ error: "Handling time must be a whole number of days, 0 to 30." }, 400);
  }
  const shippingCostCents = Number(body.shipping_cost_cents ?? 0);
  if (!Number.isInteger(shippingCostCents) || shippingCostCents < 0 || shippingCostCents > 100_000) {
    return c.json({ error: "Shipping cost must be a whole number of cents, 0 to 100000." }, 400);
  }
  const acceptsReturns = body.accepts_returns !== false;
  const returnDays = Number(body.return_days ?? 30);
  if (acceptsReturns && returnDays !== 30 && returnDays !== 60) {
    return c.json({ error: "eBay allows a 30 or 60 day return window." }, 400);
  }
  const paidBy = body.return_shipping_paid_by === "SELLER" ? "SELLER" : "BUYER";

  // The policies this account already has. Read from the CACHE that the
  // Marketplaces page itself reads, refreshed first so a policy created on eBay
  // five minutes ago is not duplicated here.
  try {
    await syncBusinessPolicies(ownerId);
  } catch (err) {
    console.error("[flipdesk-ebay] /policies/create pre-sync failed:", err);
  }
  const existing = await listCachedPolicies(ownerId);
  const have = new Set(
    existing
      .map((p) => p.policy_type)
      .filter((t): t is "fulfillment" | "payment" | "return" =>
        t === "fulfillment" || t === "payment" || t === "return"
      ),
  );
  if (have.size === 3) {
    return c.json({
      ok: true,
      created: [],
      message: "This eBay account already has all three policies.",
    });
  }

  // eBay refuses policy writes on an account that is not in the policy
  // management program, with an error that names neither the program nor the
  // fix. Opt in first; already-in is success.
  try {
    await optInToProgram(ownerId, "SELLING_POLICY_MANAGEMENT");
  } catch (err) {
    if (!isAlreadyInProgramStateError(err)) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[flipdesk-ebay] policy-management opt-in failed:", msg);
      return c.json(
        {
          error:
            "eBay would not turn on business policies for this account. That has " +
            "to happen before any policy can be created.",
          detail: msg.slice(0, 300),
        },
        502,
      );
    }
  }

  // ...and then ASK, rather than assume. optInToProgram returns void, so "the
  // call did not throw" is not the same fact as "the account is in the
  // program" -- US-2641 was three eBay verbs (price, end, relist) that each
  // reported success on exactly that reasoning. get_opted_in_programs is the
  // read that settles it, and the client already has it.
  //
  // A failed READ is a different thing from a negative answer: it says nothing
  // about the program, and blocking on it would strand a seller whose account
  // is fine. So an unreadable program list falls through to the create, where
  // eBay's own refusal is surfaced verbatim; only a list that comes back
  // WITHOUT the program is refused here.
  let optedIn: string[] | null = null;
  try {
    optedIn = await getOptedInPrograms(ownerId);
  } catch (err) {
    console.warn(
      "[flipdesk-ebay] could not read opted-in programs; letting the create " +
        "surface eBay's own error:",
      err instanceof Error ? err.message : String(err),
    );
  }
  if (optedIn && !optedIn.includes("SELLING_POLICY_MANAGEMENT")) {
    return c.json(
      {
        error:
          "eBay still has business policies switched off for this account, so " +
          "there is nowhere to put them. Turn on business policies in your eBay " +
          "account settings, then press this again.",
      },
      502,
    );
  }

  let result: { created: string[] };
  try {
    result = await createDefaultPolicies(
      ownerId,
      {
        handlingDays,
        shippingCostCents,
        acceptsReturns,
        returnDays: returnDays === 60 ? 60 : 30,
        returnShippingPaidBy: paidBy,
      },
      have,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[flipdesk-ebay] /policies/create failed:", msg);
    return c.json(
      {
        error: "eBay refused one of the policies. Nothing else was changed.",
        detail: msg.slice(0, 300),
      },
      502,
    );
  }

  // Pull the new ids back through the normal sync, then make them the
  // workspace defaults through the same writer the picker uses -- so there is
  // one path that sets a default, not two.
  await syncBusinessPolicies(ownerId);
  const after = await listCachedPolicies(ownerId);
  const pick = (kind: string) =>
    after.find((p) => p.policy_type === kind && p.is_default)?.policy_id ??
      after.find((p) => p.policy_type === kind)?.policy_id;
  const selection: {
    fulfillment_policy_id?: string;
    payment_policy_id?: string;
    return_policy_id?: string;
  } = {};
  const fulfillment = pick("fulfillment");
  const payment = pick("payment");
  const ret = pick("return");
  if (fulfillment) selection.fulfillment_policy_id = fulfillment;
  if (payment) selection.payment_policy_id = payment;
  if (ret) selection.return_policy_id = ret;
  await setDefaultPolicies(ownerId, selection);

  const final = await listCachedPolicies(ownerId);

  // Confirm that the three policies the publish path reads are actually there,
  // as defaults, before telling the seller they can publish. eBay accepting a
  // POST is not the same event as the policy being readable on the account, and
  // an ok:true here with a kind still missing is precisely the message the
  // seller has already had once: "Configure eBay business policies", after
  // being told it was done. readCachedDefaults() requires an is_default row per
  // kind, so that is the bar checked here -- the same one publish uses.
  const confirmed = new Set(
    final.filter((p) => p.is_default).map((p) => p.policy_type),
  );
  const stillMissing = (["fulfillment", "payment", "return"] as const).filter(
    (kind) => !confirmed.has(kind),
  );
  if (stillMissing.length > 0) {
    const plain: Record<string, string> = {
      fulfillment: "shipping",
      payment: "payment",
      return: "returns",
    };
    const names = stillMissing.map((k) => plain[k] ?? k).join(" and ");
    console.error(
      `[flipdesk-ebay] /policies/create: eBay did not return ${stillMissing.join(", ")} after creating them for ${ownerId}`,
    );
    return c.json(
      {
        ok: false,
        created: result.created,
        still_missing: stillMissing,
        error:
          `eBay has not given back your ${names} policy yet, so publishing would ` +
          `still fail. Nothing was lost: press this again in a moment and it will ` +
          `pick up whatever was already made.`,
      },
      502,
    );
  }

  return c.json({
    ok: true,
    created: result.created,
    policies: final,
    defaults: {
      fulfillment_policy_id:
        final.find((p) => p.policy_type === "fulfillment" && p.is_default)?.policy_id ?? null,
      payment_policy_id:
        final.find((p) => p.policy_type === "payment" && p.is_default)?.policy_id ?? null,
      return_policy_id:
        final.find((p) => p.policy_type === "return" && p.is_default)?.policy_id ?? null,
    },
  });
});

// POST /policies/location → create a default eBay inventory (merchant)
// location from a ZIP/address the seller confirms once. eBay requires an
// ENABLED location on every offer, and there's no Seller Hub UI to make one,
// so this fills the most common publish blocker ("merchant location").
flipdeskEbayRoutes.post("/policies/location", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }

  let body: {
    postal_code?: unknown;
    country?: unknown;
    address_line1?: unknown;
    city?: unknown;
    state?: unknown;
    name?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const country =
    typeof body.country === "string" && body.country.trim()
      ? body.country.trim().toUpperCase()
      : "US";
  const postalCode =
    typeof body.postal_code === "string" ? body.postal_code.trim() : "";
  // eBay needs a postal code to calculate shipping; enforce a valid US ZIP
  // when country is US (the only marketplace FlipDesk supports today).
  if (country === "US" && !/^\d{5}(-\d{4})?$/.test(postalCode)) {
    return c.json({ error: "A valid US ZIP code is required." }, 400);
  }

  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;

  try {
    const result = await createInventoryLocation(ownerId, {
      name: str(body.name),
      address: {
        addressLine1: str(body.address_line1),
        city: str(body.city),
        stateOrProvince: str(body.state),
        postalCode: postalCode || undefined,
        country,
      },
    });
    return c.json({ ok: true, merchant_location_key: result.merchantLocationKey });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[flipdesk-ebay] /policies/location failed:", msg);
    return c.json(
      { error: "Could not create your eBay ship-from location.", detail: msg.slice(0, 300) },
      502,
    );
  }
});

// US-1979 (AC3): seller program opt-in — GET /programs, POST /programs/:program,
// DELETE /programs/:program.
//
// The one that matters is OUT_OF_STOCK_CONTROL. eBay ENDS a multi-quantity listing
// the instant quantity hits 0; for evergreen clothing (the same tee in eight sizes,
// restocked continuously) that costs the item id, the watchers, the search standing
// and the sales history, and the seller relists from scratch. Opted in, the listing
// stays live at qty 0 and keeps all of it.
//
// It stays an explicit OPT-IN and this route never decides for the seller: for a
// single-quantity thrift item — most of FlipDesk — eBay's default is CORRECT, and
// a blanket opt-in would leave sold-out one-offs sitting live.
//
// These act on the seller's OWN eBay account via their own token, so there is no
// multi-tenant table to scope; the tenant IS the token (ownerId resolves the
// connection inside fetchAuthed). The access control that matters here is the
// authMiddleware whitelist entry in main.ts (US-1623) — without it the route 401s
// every signed-in seller.
const SELLER_PROGRAMS: Record<string, EbaySellerProgram> = {
  "out-of-stock": "OUT_OF_STOCK_CONTROL",
  "selling-policy-management": "SELLING_POLICY_MANAGEMENT",
};

flipdeskEbayRoutes.get("/programs", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    const programs = await getOptedInPrograms(ownerId);
    return c.json({
      programs,
      out_of_stock: programs.includes("OUT_OF_STOCK_CONTROL"),
    });
  } catch (err) {
    return failSafe(c, 502, "Couldn't read your eBay programs.", err, "ebay.programs.get");
  }
});

flipdeskEbayRoutes.post("/programs/:program", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const program = SELLER_PROGRAMS[c.req.param("program")];
  if (!program) return c.json({ error: "Unknown eBay program." }, 400);
  try {
    await optInToProgram(ownerId, program);
  } catch (err) {
    // Already opted in = already in the state they asked for = success.
    if (!isAlreadyInProgramStateError(err)) {
      return failSafe(c, 502, "eBay rejected the opt-in.", err, "ebay.programs.opt_in");
    }
  }
  await writeAuditLog(c, {
    action: "ebay.program.opt_in",
    targetType: "ebay_program",
    targetId: program,
    details: {},
  });
  return c.json({ ok: true, program, opted_in: true });
});

flipdeskEbayRoutes.delete("/programs/:program", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const program = SELLER_PROGRAMS[c.req.param("program")];
  if (!program) return c.json({ error: "Unknown eBay program." }, 400);
  try {
    await optOutOfProgram(ownerId, program);
  } catch (err) {
    if (!isAlreadyInProgramStateError(err)) {
      return failSafe(c, 502, "eBay rejected the opt-out.", err, "ebay.programs.opt_out");
    }
  }
  await writeAuditLog(c, {
    action: "ebay.program.opt_out",
    targetType: "ebay_program",
    targetId: program,
    details: {},
  });
  return c.json({ ok: true, program, opted_in: false });
});
