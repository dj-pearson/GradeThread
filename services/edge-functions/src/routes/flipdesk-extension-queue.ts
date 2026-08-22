import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe } from "../lib/http-errors.ts";
import { resolveSellerEntitlement } from "../lib/buyer-entitlements.ts";
import {
  CREDENTIAL_KEYS,
  EXTENSION_QUEUE_KINDS,
  MAX_QUEUE_DEPTH,
  QUEUE_TTL_MS,
  QUEUED_NOTICE,
  normalizeQueuePayload,
  planExpiry,
  withSellerLocale,
  type ExtensionQueueKind,
} from "../lib/extension-queue.ts";

// US-2481: queue extension work from mobile, drain it on the desktop.
//
// WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT.
//
// Extension-mechanism channels can only be acted on from the seller's own
// logged-in browser — that is the decision in
// vault/60-decisions/adr-no-server-side-marketplace-automation.md, and the cost
// it accepts is that a seller sourcing with only a phone cannot cross-list, and
// a delist waits for the desktop.
//
// This endpoint softens that cost without paying the price the ADR refuses. The
// phone records an INSTRUCTION — an item id, a platform, a locale key — and the
// desktop extension drains it. What it never records is a way in: no password,
// no session cookie, nothing that would let a server act as the seller. That is
// checked here AND as a CHECK constraint on the table, because a promise made
// only in prose is a promise the next feature can quietly break.
//
// TENANCY (US-268). The service-role client bypasses RLS, so every query below
// is explicitly scoped to `workspaceOwnerId ?? userId`. A queue row is addressed
// by an id the CLIENT supplies, which makes every update here the exact shape
// the isolation rule exists for: the id is filtered together with the owner, so
// a foreign id matches zero rows rather than someone else's job.

export const flipdeskExtensionQueueRoutes = new Hono<{
  Variables: { userId: string; workspaceOwnerId: string };
}>();

interface QueueRow {
  id: string;
  kind: string;
  platform: string;
  inventory_item_id: string | null;
  listing_id: string | null;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  source: string;
  claimed_at: string | null;
  completed_at: string | null;
  result: Record<string, unknown> | null;
  expires_at: string;
  created_at: string;
}

const SELECT_COLS =
  "id, kind, platform, inventory_item_id, listing_id, payload, status, attempts, " +
  "source, claimed_at, completed_at, result, expires_at, created_at";

/**
 * May this account queue extension work?
 *
 * Reuses `resolveSellerEntitlement` — the SAME resolution behind the
 * extension's `lister` capability — rather than a plan check invented here.
 * Two different answers to "may this account cross-list" is how a free account
 * ends up filling a queue that never drains: the enqueue succeeds, the desktop
 * refuses every row, and the seller is told nothing.
 *
 * Returns a discriminated result rather than throwing so the caller can return
 * the 402 body verbatim — the frontend's upgrade dialog reads it.
 */
async function sellerGate(
  ownerId: string,
): Promise<{ ok: true } | { ok: false; response: Response }> {
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
    response: new Response(
      JSON.stringify({
        error: "FEATURE_LOCKED",
        feature: "lister",
        plan: entitlement.flipdeskPlan,
        message:
          "Queueing cross-listing work for your desktop is a FlipDesk seller " +
          "feature — upgrade your GradeThread plan to enable it.",
      }),
      { status: 402, headers: { "content-type": "application/json" } },
    ),
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
async function expireStale(ownerId: string, nowIso: string): Promise<void> {
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
 * against its own bundled domain map, never a URL — the US-1876 rule that a
 * navigation target comes from the extension's config and never from a message
 * is what makes it safe to carry this through the database.
 *
 * Returns the payload unchanged whenever there is nothing to add: no settings
 * row, no key for this platform, or a caller that already named a locale. That
 * last case is the important one — an explicit locale in the request is a
 * statement about this job and must not be replaced by an account default.
 *
 * A failure to read the settings row is swallowed. The locale is an
 * IMPROVEMENT on today's behaviour, not a precondition for it: refusing to
 * queue a cross-post because a settings lookup timed out would trade a
 * wrong-country page for no page at all.
 */
async function stampLocale(
  ownerId: string,
  platform: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Skip the round trip entirely when the caller already decided. The decision
  // itself lives in withSellerLocale and is re-checked there; this is only an
  // early exit, not a second copy of the rule.
  if (typeof payload.locale === "string" && payload.locale !== "") return payload;

  const { data } = await supabaseAdmin
    .from("flipdesk_settings")
    .select("lister_locales")
    .eq("user_id", ownerId) // US-268
    .maybeSingle();

  const settings = (data as { lister_locales?: unknown } | null)?.lister_locales;
  return withSellerLocale(payload, settings, platform);
}

// POST / — enqueue one piece of extension work.
//
// Called from iOS, Android and the web dashboard. The desktop does NOT have to
// be awake; that is the entire point.
flipdeskExtensionQueueRoutes.post("/", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  // The queue may only hold work the extension is actually allowed to RUN.
  //
  // resolveSellerEntitlement is the same function behind the extension's
  // `lister` capability, which is deliberate: gating the two differently is how
  // a free account fills a queue that silently never drains, and a job that
  // never runs and never says so is the failure mode this whole feature is
  // arranged to avoid.
  const gate = await sellerGate(ownerId);
  if (!gate.ok) return gate.response;

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid request body." }, 400);
  }

  const kind = String((body as { kind?: unknown }).kind ?? "");
  if (!EXTENSION_QUEUE_KINDS.includes(kind as ExtensionQueueKind)) {
    return c.json(
      { error: `kind must be one of: ${EXTENSION_QUEUE_KINDS.join(", ")}.` },
      400,
    );
  }
  const platform = String((body as { platform?: unknown }).platform ?? "").trim();
  if (!platform) return c.json({ error: "platform is required." }, 400);

  // The bright line, checked before anything is written. The table's CHECK
  // constraint would also reject this, but a 400 naming the key is a better
  // answer than a 500 from a constraint violation — and the two together mean
  // neither a client bug nor a future server path can get a credential in here.
  const payload = normalizeQueuePayload((body as { payload?: unknown }).payload);
  if (payload.rejectedKey) {
    return c.json(
      {
        error:
          `payload may not contain "${payload.rejectedKey}". The queue stores ` +
          `WHAT to do, never a marketplace credential — GradeThread's servers ` +
          `never hold a marketplace password or session cookie.`,
      },
      400,
    );
  }

  // Ownership of the referenced rows, BEFORE the insert. Both ids come from the
  // request body, so neither may be trusted: an unverified inventory_item_id
  // would let one tenant queue work against another's item and, once drained,
  // read that item's title and photos into their own browser.
  const itemId = optionalUuid((body as { inventory_item_id?: unknown }).inventory_item_id);
  const listingId = optionalUuid((body as { listing_id?: unknown }).listing_id);

  if (itemId) {
    const { data } = await supabaseAdmin
      .from("inventory_items")
      .select("id")
      .eq("id", itemId)
      .eq("user_id", ownerId) // US-268
      .maybeSingle();
    if (!data) return c.json({ error: "Item not found." }, 404);
  }
  if (listingId) {
    const { data } = await supabaseAdmin
      .from("listings")
      .select("id")
      .eq("id", listingId)
      .eq("user_id", ownerId) // US-268
      .maybeSingle();
    if (!data) return c.json({ error: "Listing not found." }, 404);
  }

  // US-2777: stamp the seller's country domain onto the job.
  //
  // HERE, not in the clients. Vinted is one app on 22 country domains, and
  // `newListingUrlForLocale` silently returns the platform default when the job
  // names no locale — so a French seller queued a job that opened vinted.com.
  // Web, iOS and Android all enqueue `payload: {}`, and asking each of them to
  // look the setting up would be three copies of one lookup that only has to be
  // wrong in one of them to reproduce this exactly.
  //
  // The stored key is passed through UNFILTERED. The extension's bundled map is
  // the authority on which domains it can open and it already refuses one it
  // does not cover, naming the domain (US-2479 AC2). Filtering here would turn
  // that loud refusal into a silent fall back to the default, which is the
  // failure being fixed.
  //
  // A locale the CLIENT supplied WINS. A caller that names one is making a
  // statement about this job; overwriting it with the account default would
  // make the field unusable for anything else, forever.
  const payloadValue = await stampLocale(ownerId, platform, payload.value);

  const nowIso = new Date().toISOString();
  await expireStale(ownerId, nowIso);

  // A depth cap, because the failure mode without one is specific and bad: a
  // seller queues 400 jobs from their phone over a week, opens their laptop, and
  // the extension starts opening marketplace tabs it will not stop opening.
  const { count } = await supabaseAdmin
    .from("extension_work_queue")
    .select("id", { count: "exact", head: true })
    .eq("user_id", ownerId) // US-268
    .in("status", ["queued", "claimed"]);
  if ((count ?? 0) >= MAX_QUEUE_DEPTH) {
    return c.json(
      {
        error:
          `You already have ${count} jobs waiting for your desktop. Open your ` +
          `browser with the GradeThread extension installed to run them, then ` +
          `queue more.`,
        queued: count,
      },
      409,
    );
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
      source: normalizeSource((body as { source?: unknown }).source),
      expires_at: planExpiry(Date.now()),
    })
    .select(SELECT_COLS)
    .single();

  if (error) {
    return failSafe(c, 500, "Could not queue that work.", error, "flipdesk.queue.enqueue");
  }

  return c.json({
    queued: data,
    // The honest sentence, returned by the API so every client says the same
    // thing (US-2481 AC7). A mobile screen that renders "Done" for a queued job
    // has told the seller their listing is live when it is not.
    // ...which means it has to be THE sentence, not a second one written here.
    // This route used to hand back its own wording (it named the five channels),
    // so the API and the four client copies of QUEUED_NOTICE said different
    // things and the byte-identical-copy rule the clients are built around was
    // enforced everywhere except the source they all mirror.
    notice: QUEUED_NOTICE,
    expiresInDays: Math.round(QUEUE_TTL_MS / 86_400_000),
  }, 201);
});

// GET / — what is outstanding, for a human to look at.
//
// This is the seller-facing view: still waiting, plus anything that expired
// undrained. The expired half is the point (AC6) — silence about work that never
// ran is how a delist quietly turns into a double sale.
flipdeskExtensionQueueRoutes.get("/", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const nowIso = new Date().toISOString();
  await expireStale(ownerId, nowIso);

  const { data, error } = await supabaseAdmin
    .from("extension_work_queue")
    .select(SELECT_COLS)
    .eq("user_id", ownerId) // US-268
    .in("status", ["queued", "claimed", "expired", "failed"])
    .order("created_at", { ascending: true })
    .limit(200);

  if (error) {
    return failSafe(c, 500, "Could not load the queue.", error, "flipdesk.queue.list");
  }

  const rows = (data ?? []) as unknown as QueueRow[];
  return c.json({
    pending: rows.filter((r) => r.status === "queued" || r.status === "claimed"),
    // Surfaced separately so a client cannot render them as "still coming".
    needsAttention: rows.filter((r) => r.status === "expired" || r.status === "failed"),
  });
});

// POST /claim — the desktop extension takes the next batch.
//
// Claiming rather than plain reading is what stops two open browsers running the
// same share job twice. `claimed_by` is the extension's install id, which is not
// trusted for anything — it is a diagnostic label, and the tenant scope is what
// actually decides which rows may be touched.
flipdeskExtensionQueueRoutes.post("/claim", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  const limit = Math.min(
    10,
    Math.max(1, Number((body as { limit?: unknown }).limit) || 5),
  );
  const claimedBy = String((body as { installId?: unknown }).installId ?? "")
    .slice(0, 64) || null;

  const nowIso = new Date().toISOString();
  await expireStale(ownerId, nowIso);

  const { data: available, error: readError } = await supabaseAdmin
    .from("extension_work_queue")
    .select(SELECT_COLS)
    .eq("user_id", ownerId) // US-268
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (readError) {
    return failSafe(c, 500, "Could not read the queue.", readError, "flipdesk.queue.claim");
  }

  const rows = (available ?? []) as unknown as QueueRow[];
  if (rows.length === 0) return c.json({ claimed: [] });

  const ids = rows.map((r) => r.id);
  const { data: claimed, error } = await supabaseAdmin
    .from("extension_work_queue")
    .update({ status: "claimed", claimed_at: nowIso, claimed_by: claimedBy })
    .in("id", ids)
    .eq("user_id", ownerId) // US-268 — the id list is ours, the scope proves it
    .eq("status", "queued") // lost race → the other browser keeps it
    .select(SELECT_COLS);

  if (error) {
    return failSafe(c, 500, "Could not claim the queue.", error, "flipdesk.queue.claim");
  }

  return c.json({ claimed: claimed ?? [] });
});

// POST /:id/complete — the extension reports what happened.
//
// `id` is client-supplied, so it is filtered WITH the owner. A foreign id
// updates zero rows and gets a 404, which is the whole US-268 rule in one query.
flipdeskExtensionQueueRoutes.post("/:id/complete", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const ok = (body as { ok?: unknown }).ok === true;

  // Bounded, and stripped of anything credential-shaped on the way back in — a
  // result envelope is still a write from a browser extension.
  const result = normalizeQueuePayload((body as { result?: unknown }).result);
  if (result.rejectedKey) {
    return c.json({ error: `result may not contain "${result.rejectedKey}".` }, 400);
  }

  const { data, error } = await supabaseAdmin
    .from("extension_work_queue")
    .update({
      status: ok ? "done" : "failed",
      completed_at: new Date().toISOString(),
      result: result.value,
    })
    .eq("id", id)
    .eq("user_id", ownerId) // US-268
    .select("id, status")
    .maybeSingle();

  if (error) {
    return failSafe(c, 500, "Could not record that result.", error, "flipdesk.queue.complete");
  }
  if (!data) return c.json({ error: "Not found." }, 404);

  return c.json({ updated: data });
});

// DELETE /:id — the seller cancels a job they no longer want run.
flipdeskExtensionQueueRoutes.delete("/:id", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const { data, error } = await supabaseAdmin
    .from("extension_work_queue")
    .delete()
    .eq("id", c.req.param("id"))
    .eq("user_id", ownerId) // US-268
    .select("id")
    .maybeSingle();

  if (error) {
    return failSafe(c, 500, "Could not cancel that job.", error, "flipdesk.queue.cancel");
  }
  if (!data) return c.json({ error: "Not found." }, 404);
  return c.json({ cancelled: data.id });
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function optionalUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

function normalizeSource(value: unknown): string {
  const s = String(value ?? "mobile");
  return ["mobile", "web", "ios", "android"].includes(s) ? s : "mobile";
}

// Re-exported so the tests can assert the refused keys without reaching into
// the lib — the list IS the contract.
export { CREDENTIAL_KEYS };
