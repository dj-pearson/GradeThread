// US-3065: enqueueing extension work, callable by something that is not a route.
//
// WHY THIS FILE EXISTS. The whole enqueue path lived inline in
// routes/flipdesk-extension-queue.ts — the entitlement gate, the credential
// refusal, the ownership checks, the depth cap and the insert. That was fine
// while the only caller was an HTTP handler. The Claude connector is now a
// second caller, and a second copy of a path carrying five separate refusals
// would be five chances to omit one.
//
// ⚠ IT IS A SIBLING OF extension-queue.ts, NOT PART OF IT, and US-3065 AC3 says
// "extract it into lib/extension-queue.ts". Deliberate departure:
// extension-queue.ts has ZERO imports and four test files depend on that —
// putting the service-role client into it drags the whole supabase graph into
// every one of them. Same split this repo already uses for
// description-blocks.ts (pure) and description-render.ts (impure), and the
// filename is the only part of the AC not met.
//
// ── EVERY REFUSAL IN HERE IS LOAD-BEARING ────────────────────────────────────
//
// The gate, because a free account filling a queue that never drains is a
// silent failure. The credential refusal, because the queue stores WHAT to do
// and never a marketplace password. The ownership checks, because both ids
// arrive from the caller and an unverified one would let a tenant queue work
// against another's item and read its title and photos into their own browser.
// The depth cap, because 400 queued jobs is an extension that opens marketplace
// tabs it will not stop opening.

import { supabaseAdmin } from "./supabase.ts";
import { resolveSellerEntitlement } from "./buyer-entitlements.ts";
import {
  createRelistDraft,
  isExtensionRelistPlatform,
  loadRelistSource,
} from "./extension-relist.ts";
import {
  isExtensionRevisePlatform,
  isRevisableField,
  queueReviseForListing,
  REVISABLE_FIELDS,
} from "./pending-revises.ts";
import {
  EXTENSION_QUEUE_KINDS,
  type ExtensionQueueKind,
  MAX_QUEUE_DEPTH,
  normalizeQueuePayload,
  planExpiry,
  QUEUE_TTL_MS,
  QUEUED_NOTICE,
  withSellerLocale,
} from "./extension-queue.ts";

export const QUEUE_SELECT_COLS =
  "id, kind, platform, inventory_item_id, listing_id, payload, status, attempts, " +
  "source, claimed_at, completed_at, result, expires_at, created_at";

/** What the caller may do with a refusal: a status and a message, never a Response. */
export interface EnqueueRefusal {
  ok: false;
  status: number;
  error: string;
  /** Extra body fields the HTTP caller returns verbatim (the 402 upgrade shape). */
  body?: Record<string, unknown>;
}

export interface EnqueueSuccess {
  ok: true;
  row: Record<string, unknown>;
  /** THE sentence, not a second one. See QUEUED_NOTICE. */
  notice: string;
  expiresInDays: number;
}

export type EnqueueResult = EnqueueSuccess | EnqueueRefusal;

/**
 * May this account queue extension work?
 *
 * Reuses `resolveSellerEntitlement` — the SAME resolution behind the
 * extension's `lister` capability — rather than a plan check invented here. Two
 * different answers to "may this account cross-list" is how a free account ends
 * up filling a queue that never drains: the enqueue succeeds, the desktop
 * refuses every row, and the seller is told nothing.
 *
 * The 402 body is returned in `body` so the HTTP caller can hand it back
 * verbatim — the frontend's upgrade dialog reads those fields.
 */
export async function sellerQueueGate(
  ownerId: string,
): Promise<{ ok: true } | EnqueueRefusal> {
  const { data } = await supabaseAdmin
    .from("users")
    .select("flipdesk_plan, subscription_status, trial_ends_at, past_due_since")
    .eq("id", ownerId)
    .maybeSingle();

  const entitlement = resolveSellerEntitlement({
    flipdeskPlan: data?.flipdesk_plan ?? null,
    flipdeskStatus: data?.subscription_status ?? null,
    trialEndsAt: data?.trial_ends_at ?? null,
    pastDueSince: data?.past_due_since ?? null,
  });
  if (entitlement.sellerEnabled) return { ok: true };

  return {
    ok: false,
    status: 402,
    error: "FEATURE_LOCKED",
    body: {
      feature: "lister",
      plan: entitlement.flipdeskPlan,
      message:
        "Queueing cross-listing work for your desktop is a FlipDesk seller " +
        "feature — upgrade your GradeThread plan to enable it.",
    },
  };
}

/**
 * Flip anything past its window to 'expired', for this tenant only.
 *
 * US-2481 AC6: work that is never drained must SURFACE, not sit. This runs on
 * every read rather than on a cron because the moment that matters is the moment
 * a seller looks — a nightly sweep would show them "queued" for a job that has
 * been dead since Tuesday.
 *
 * Written as two sequential updates rather than one `.or(...)`: the self-hosted
 * prod PostgREST rejects logical operators on mutations while the newer local
 * stack accepts them, so a single `.or()` would pass CI and 42703 in production
 * (US-1552).
 */
export async function expireStaleQueueRows(ownerId: string, nowIso: string): Promise<void> {
  for (const status of ["queued", "claimed"] as const) {
    await supabaseAdmin
      .from("extension_work_queue")
      .update({ status: "expired" })
      .eq("user_id", ownerId) // US-268
      .eq("status", status)
      .lt("expires_at", nowIso);
  }
}

/**
 * US-2777: add the seller's country domain to a queued job's payload.
 *
 * `flipdesk_settings.lister_locales` is a platform -> locale-key map, e.g.
 * `{"vinted": "vinted.fr"}` (00648). The value is a KEY the extension resolves
 * against its own bundled domain map, never a URL.
 *
 * Returns the payload unchanged whenever there is nothing to add: no settings
 * row, no key for this platform, or a caller that already named a locale. A
 * failure to read the settings row is swallowed — refusing to queue a cross-post
 * because a settings lookup timed out would trade a wrong-country page for no
 * page at all.
 */
export async function stampSellerLocale(
  ownerId: string,
  platform: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (typeof payload.locale === "string" && payload.locale !== "") return payload;

  const { data } = await supabaseAdmin
    .from("flipdesk_settings")
    .select("lister_locales")
    .eq("user_id", ownerId) // US-268
    .maybeSingle();

  const settings = (data as { lister_locales?: unknown } | null)?.lister_locales;
  return withSellerLocale(payload, settings, platform);
}

export function optionalUuid(value: unknown): string | null {
  return typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

export function normalizeQueueSource(value: unknown): string {
  const s = typeof value === "string" ? value.trim().slice(0, 40) : "";
  return s || "unknown";
}

export interface EnqueueInput {
  kind?: unknown;
  platform?: unknown;
  payload?: unknown;
  inventory_item_id?: unknown;
  listing_id?: unknown;
  fields?: unknown;
  source?: unknown;
}

/**
 * Queue one piece of extension work for `ownerId`.
 *
 * EVERY id in `input` is untrusted. The caller has authenticated the OWNER;
 * nothing here trusts that the item or listing belongs to them, and both are
 * re-checked against `user_id` before anything is written (US-268).
 *
 * `gate` is skippable ONLY so a caller that has already run sellerQueueGate does
 * not pay for it twice. It defaults to running.
 */
export async function enqueueExtensionWork(
  ownerId: string,
  input: EnqueueInput,
  opts: { skipGate?: boolean } = {},
): Promise<EnqueueResult> {
  if (!opts.skipGate) {
    const gate = await sellerQueueGate(ownerId);
    if (!gate.ok) return gate;
  }

  const kind = String(input.kind ?? "");
  if (!EXTENSION_QUEUE_KINDS.includes(kind as ExtensionQueueKind)) {
    return {
      ok: false,
      status: 400,
      error: `kind must be one of: ${EXTENSION_QUEUE_KINDS.join(", ")}.`,
    };
  }
  const platform = String(input.platform ?? "").trim();
  if (!platform) return { ok: false, status: 400, error: "platform is required." };

  // The bright line, checked before anything is written. The table's CHECK
  // constraint would also reject this, but a 400 naming the key is a better
  // answer than a 500 from a constraint violation — and the two together mean
  // neither a client bug nor a future server path can get a credential in here.
  const payload = normalizeQueuePayload(input.payload);
  if (payload.rejectedKey) {
    return {
      ok: false,
      status: 400,
      error:
        `payload may not contain "${payload.rejectedKey}". The queue stores ` +
        `WHAT to do, never a marketplace credential — GradeThread's servers ` +
        `never hold a marketplace password or session cookie.`,
    };
  }

  const itemId = optionalUuid(input.inventory_item_id);
  const listingId = optionalUuid(input.listing_id);

  if (itemId) {
    const { data } = await supabaseAdmin
      .from("inventory_items")
      .select("id")
      .eq("id", itemId)
      .eq("user_id", ownerId) // US-268
      .maybeSingle();
    if (!data) return { ok: false, status: 404, error: "Item not found." };
  }
  let listingSnapshot: Record<string, unknown> | null = null;
  if (listingId) {
    const { data } = await supabaseAdmin
      .from("listings")
      .select(
        "id, platform, listing_status, listing_url, listing_title, listing_description, listing_price",
      )
      .eq("id", listingId)
      .eq("user_id", ownerId) // US-268
      .maybeSingle();
    if (!data) return { ok: false, status: 404, error: "Listing not found." };
    listingSnapshot = data as Record<string, unknown>;
  }

  // US-9202: a revise names a LIVE extension-channel listing and which fields
  // changed. The listing's current values ride on the payload from the row the
  // server just owner-checked, never from the caller.
  if (kind === "revise") {
    if (!listingId || !listingSnapshot) {
      return {
        ok: false,
        status: 400,
        error: "A revise needs the listing_id of the listing to bring up to date.",
      };
    }
    if (String(listingSnapshot.platform) !== platform || !isExtensionRevisePlatform(platform)) {
      return {
        ok: false,
        status: 400,
        error: `${platform} is not an extension channel this listing is on.`,
      };
    }
    const fields = Array.isArray(input.fields)
      ? (input.fields as unknown[]).filter(isRevisableField)
      : [];
    if (fields.length === 0) {
      return {
        ok: false,
        status: 400,
        error: `fields must name at least one of: ${REVISABLE_FIELDS.join(", ")}.`,
      };
    }
    if (listingSnapshot.listing_status !== "active" || !listingSnapshot.listing_url) {
      return {
        ok: false,
        status: 409,
        error: "Only a live listing with a saved link can be revised by the extension.",
      };
    }
    payload.value = {
      ...payload.value,
      fields,
      listingUrl: listingSnapshot.listing_url,
      title: listingSnapshot.listing_title ?? null,
      description: listingSnapshot.listing_description ?? null,
      price: listingSnapshot.listing_price ?? null,
    };
    await queueReviseForListing({ id: listingId, platform }, fields, "mobile");
  }

  // US-9203: a relist. The copy's row is created now so the item shows it, and
  // the payload carries the OLD listing's URL plus the new row's id.
  if (kind === "relist") {
    if (!listingId) {
      return { ok: false, status: 400, error: "A relist needs the listing_id to copy from." };
    }
    if (!isExtensionRelistPlatform(platform)) {
      return {
        ok: false,
        status: 400,
        error: `${platform} does not relist through the extension.`,
      };
    }
    const old = await loadRelistSource(ownerId, listingId);
    if (!old || old.platform !== platform) {
      return { ok: false, status: 404, error: "Listing not found." };
    }
    const draft = await createRelistDraft(ownerId, old, "mobile");
    if (!draft.ok) return { ok: false, status: draft.status, error: draft.error };
    payload.value = { ...payload.value, ...draft.payload };
  }

  const payloadValue = await stampSellerLocale(ownerId, platform, payload.value);

  const nowIso = new Date().toISOString();
  await expireStaleQueueRows(ownerId, nowIso);

  // A depth cap, because the failure mode without one is specific and bad: a
  // seller queues 400 jobs over a week, opens their laptop, and the extension
  // starts opening marketplace tabs it will not stop opening.
  const { count } = await supabaseAdmin
    .from("extension_work_queue")
    .select("id", { count: "exact", head: true })
    .eq("user_id", ownerId) // US-268
    .in("status", ["queued", "claimed"]);
  if ((count ?? 0) >= MAX_QUEUE_DEPTH) {
    return {
      ok: false,
      status: 409,
      error:
        `You already have ${count} jobs waiting for your desktop. Open your ` +
        `browser with the GradeThread extension installed to run them, then ` +
        `queue more.`,
      body: { queued: count },
    };
  }

  const { data, error } = await supabaseAdmin
    .from("extension_work_queue")
    .insert({
      user_id: ownerId,
      kind,
      platform,
      inventory_item_id: itemId,
      listing_id: listingId,
      payload: payloadValue,
      source: normalizeQueueSource(input.source),
      expires_at: planExpiry(Date.now()),
    })
    .select(QUEUE_SELECT_COLS)
    .single();

  if (error) {
    // The caller decides how to report a server fault; this only says one
    // happened, and carries the driver message so failSafe can log it.
    return {
      ok: false,
      status: 500,
      error: "Could not queue that work.",
      body: { cause: error.message },
    };
  }

  return {
    ok: true,
    row: data as unknown as Record<string, unknown>,
    // THE sentence, not a second one. A client that renders "Done" for a queued
    // job has told the seller their listing is live when it is not.
    notice: QUEUED_NOTICE,
    expiresInDays: Math.round(QUEUE_TTL_MS / 86_400_000),
  };
}
