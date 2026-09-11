// US-9201 — closet import intake.
//
// The browser extension reads the seller's OWN Poshmark closet or Mercari
// listing list, in a tab the seller opened, and posts what it saw. This route
// turns that batch into a durable import run (flipdesk_import_runs, the US-2518
// model): the rows are persisted before any writing starts, the worker in
// lib/closet-import-run.ts writes them with one effect row per change, the
// reclaim cron resumes a run whose container died, and the existing
// /api/flipdesk/import/runs/:id/undo puts everything back.
//
// WHY THE EXTENSION POSTS AND NOT THE WEB PAGE. The seller presses "Import my
// closet" on /dashboard/flipdesk/import, but the page cannot read a Poshmark
// tab. The web page messages the extension, the extension reads the closet tab
// the seller already has open, and the extension posts here with its own
// signed token — so this mount takes extensionOrUserAuthMiddleware, like sync
// and the extension queue. The run id comes back through the same message and
// the web page polls the ordinary import endpoints from there.
//
// TENANCY (US-268). Every query is scoped to workspaceOwnerId ?? userId. The
// batch names marketplace listing ids; those only ever match rows that also
// carry the owner, so a listing id belonging to another seller creates a new
// row for this tenant rather than touching theirs (tenant-isolation_test.ts).

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { resolveSellerEntitlement } from "../lib/buyer-entitlements.ts";
import { findForbiddenKey } from "../lib/sync-payload-guard.ts";
import { type CapacityHeadroom, capacityHeadroom, requireFlipdesk } from "../lib/plan-gate.ts";
import {
  applyFreeTierCap,
  closetImportPlatformSentence,
  type ClosetImportRow,
  FREE_CLOSET_IMPORT_ROWS,
  freeRowAllowance,
  isClosetImportPlatform,
  MAX_CLOSET_IMPORT_ROWS,
  normalizeClosetRows,
  platformLabel,
} from "../lib/closet-import.ts";
import { processClosetImportRun } from "../lib/closet-import-run.ts";

type ClosetImportEnv = {
  Variables: { userId: string; workspaceOwnerId?: string };
};

export const flipdeskClosetImportRoutes = new Hono<ClosetImportEnv>();

/** Same resolution as the extension's lister gate and the sync intake. */
async function sellerGate(ownerId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("users")
    .select("flipdesk_plan, subscription_status, trial_ends_at, past_due_since")
    .eq("id", ownerId)
    .maybeSingle();
  const row = data as {
    flipdesk_plan: string | null;
    subscription_status: string | null;
    trial_ends_at: string | null;
    past_due_since: string | null;
  } | null;
  return resolveSellerEntitlement({
    flipdeskPlan: row?.flipdesk_plan ?? null,
    flipdeskStatus: row?.subscription_status ?? null,
    trialEndsAt: row?.trial_ends_at ?? null,
    pastDueSince: row?.past_due_since ?? null,
  }).sellerEnabled;
}

/** Which of these marketplace ids does this tenant already hold a listing for? */
async function knownListingIds(
  ownerId: string,
  platform: string,
  ids: string[],
): Promise<Set<string>> {
  const known = new Set<string>();
  const CHUNK = 100;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await supabaseAdmin
      .from("listings")
      .select("platform_listing_id")
      .eq("user_id", ownerId)
      .eq("platform", platform)
      .in("platform_listing_id", ids.slice(i, i + CHUNK));
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ platform_listing_id: string | null }>) {
      if (r.platform_listing_id) known.add(r.platform_listing_id);
    }
  }
  return known;
}

// ── POST /runs — accept one closet read and start writing it ──────────────
flipdeskClosetImportRoutes.post("/runs", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const userId = c.get("userId");

  let body: Record<string, unknown>;
  try {
    const parsed = await c.req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return c.json({ error: "Expected a JSON closet batch." }, 400);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  // The same refusal the sync intake makes, for the same reason: a closet page
  // is the seller's own, but the reader runs next to pages that print buyer
  // identity, and a key that should never travel is refused before anything
  // is logged or stored.
  const forbidden = findForbiddenKey(body);
  if (forbidden) {
    return c.json(
      {
        error: "FORBIDDEN_KEY",
        key: forbidden,
        message: "A closet import may not carry credentials or buyer identity.",
      },
      400,
    );
  }

  // US-3263: an account without a seller plan is no longer refused here.
  //
  // It used to be, with a 402 and nothing else, and the person on the other end
  // of that refusal was usually deciding whether to pay. What decides it is
  // seeing their own closet appear. So an unentitled account gets a bounded
  // import instead of a locked door, and the bound is applied BELOW, after the
  // rows are read, so the response can say exactly how many were left behind.
  const sellerEnabled = await sellerGate(ownerId);

  const platform = typeof body.platform === "string" ? body.platform.toLowerCase() : "";
  if (!isClosetImportPlatform(platform)) {
    return c.json(
      { error: `Closet import supports ${closetImportPlatformSentence()}.` },
      400,
    );
  }
  if (!Array.isArray(body.listings) || body.listings.length === 0) {
    return c.json({ error: "No listings to import." }, 400);
  }
  if (body.listings.length > MAX_CLOSET_IMPORT_ROWS) {
    return c.json(
      { error: `A closet import is capped at ${MAX_CLOSET_IMPORT_ROWS} listings per read.` },
      400,
    );
  }

  const allRows: ClosetImportRow[] = normalizeClosetRows(platform, body.listings);
  if (allRows.length === 0) {
    return c.json(
      {
        error: "NO_LISTINGS_READ",
        message:
          `Nothing on that page read as a ${platformLabel(platform)} listing. ` +
          "Open your own closet, scroll so the listings are on screen, and try again.",
      },
      400,
    );
  }

  // Cap: only listings this tenant does NOT already hold consume a slot, so a
  // re-read of the same closet is free. Imported listings are live on the
  // marketplace, so they count exactly as pulled eBay listings do; the 80%
  // warning header is copied into the body because the extension, not the
  // browser, receives this response (vault/50-business/flipdesk-plan-gating.md).
  //
  // This lookup runs BEFORE the free bound is applied (it used to run after),
  // because the bound now has to know which rows are already here: a row this
  // tenant already holds takes no new slot and must survive the trim.
  let known: Set<string>;
  try {
    known = await knownListingIds(ownerId, platform, allRows.map((r) => r.platform_listing_id));
  } catch (err) {
    console.error("[closet-import] lookup failed:", err instanceof Error ? err.message : err);
    return c.json({ error: "Could not check your existing listings." }, 500);
  }

  // The cap is enforced HERE, on the server, from the account's own
  // entitlement. The browser and the extension both say what they think the
  // limit is; neither is the gate.
  //
  // An unentitled account is bounded by the SMALLER of two numbers: the 25-row
  // read bound, and what is left of its own plan's active-listing cap. The
  // first cut of US-3263 skipped the capacity accounting entirely on the
  // grounds that "an unentitled account has no plan to account against". Free
  // is a plan and it does have one (activeListingCap), so that reading turned a
  // per-read bound into no bound at all: twenty presses, five hundred live
  // listings, on a plan that allows twenty-five. Composing the two keeps the
  // first read of an empty catalog at the full 25 and stops the twenty-first.
  let headroom: CapacityHeadroom | null = null;
  if (!sellerEnabled) {
    headroom = await capacityHeadroom(ownerId, "activeListings");
  }
  const capped = applyFreeTierCap(allRows, sellerEnabled, {
    allowance: freeRowAllowance(headroom ? headroom.headroom : null),
    isKnown: (r) => known.has(r.platform_listing_id),
  });
  const rows = capped.rows;
  const newRows = rows.filter((r) => !known.has(r.platform_listing_id)).length;

  if (rows.length === 0) {
    // Only reachable on the unentitled path, with the plan's listing cap full
    // and nothing in the read already here. That is a real refusal rather than
    // a wall this story should remove (the seller is holding as many live
    // listings as the free plan allows), so it answers in the SAME shape the
    // plan gate refuses in, which the web card and the extension both already
    // turn into "you are at N of M live listings".
    return c.json(
      {
        error: "CAP_REACHED",
        cap: "activeListings",
        used: headroom?.used ?? 0,
        delta: allRows.length,
        limit: headroom?.limit ?? FREE_CLOSET_IMPORT_ROWS,
        plan: headroom?.plan ?? "free",
        requiredPlan: "starter",
      },
      402,
    );
  }

  // Unchanged for entitled accounts: the plan's own gate, counting only rows
  // this tenant does not already hold.
  if (sellerEnabled) {
    const capGate = await requireFlipdesk(c, {
      capacity: { kind: "activeListings", delta: newRows },
      userId: ownerId,
    });
    if (capGate) return capGate;
  }
  const planWarning = c.res.headers.get("X-Plan-Warning");

  const { data: run, error } = await supabaseAdmin
    .from("flipdesk_import_runs")
    .insert({
      user_id: ownerId,
      created_by: userId,
      origin: platform,
      status: "pending",
      total_rows: rows.length,
      payload: rows,
    })
    .select("id")
    .single();
  if (error || !run) {
    console.error("[closet-import] could not create run:", error?.message);
    // US-3261: a CHECK violation here means the DEPLOY is inconsistent — the
    // code knows a platform the database has not been widened for — and it
    // read as an ordinary outage for months. 23514 is Postgres's
    // check-violation code; say what is wrong so the next person looks at the
    // constraint rather than at the extension.
    if (error?.code === "23514") {
      return c.json(
        {
          error:
            `This server does not accept ${platformLabel(platform)} imports yet. ` +
            "The database is behind the app. Nothing was imported, and trying " +
            "again will not help until it is updated.",
        },
        503,
      );
    }
    return c.json({ error: "Could not start the import." }, 500);
  }
  const runId = (run as { id: string }).id;

  // Start now so the seller sees progress at once; durability does not depend
  // on this promise. The reclaim cron resumes the run if this container dies.
  void processClosetImportRun(runId).catch((err) =>
    console.error("[closet-import] background run crashed:", err)
  );

  return c.json(
    {
      run_id: runId,
      platform,
      total_rows: rows.length,
      new_rows: newRows,
      known_rows: rows.length - newRows,
      plan_warning: planWarning,
      // US-3263: what the free bound cost this read, so the page can say it
      // rather than quietly importing a quarter of somebody's closet.
      //
      // free_cap is the allowance ACTUALLY applied, which is the flat row bound
      // until the account's own listing cap is the smaller of the two. Saying
      // "the free plan imports 25 at a time" to somebody who was trimmed to 4
      // because they already hold 21 live listings would be a true sentence
      // about the wrong rule, so free_cap_reason names which one bit.
      free_capped: capped.capped,
      free_cap: capped.allowance,
      free_cap_reason: sellerEnabled
        ? null
        : (capped.allowance ?? 0) < FREE_CLOSET_IMPORT_ROWS
        ? "activeListings"
        : "rows",
      left_behind: capped.leftBehind,
    },
    202,
  );
});
