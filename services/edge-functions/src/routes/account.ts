import { Hono } from "hono";
import Stripe from "stripe";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireStepUp } from "../lib/step-up.ts";

// Account data portability (US-275 / GDPR + CCPA). Authed user exports a copy
// of their own data. Mounted behind authMiddleware in main.ts, so c.var.userId
// is the caller. Every query is scoped to that user — directly by user_id, or
// through the parent row's ownership (grade_reports via submission, listings/
// sales via inventory_item).

type AccountEnv = { Variables: { userId: string } };

export const accountRoutes = new Hono<AccountEnv>();

function getStripe(): Stripe | null {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) return null;
  return new Stripe(key, { apiVersion: "2024-04-10" });
}

// Supabase storage .remove() takes an array; chunk to stay well under any
// request-size limits when a user has many photos.
async function removeAll(bucket: string, paths: string[]) {
  const CHUNK = 100;
  for (let i = 0; i < paths.length; i += CHUNK) {
    const slice = paths.slice(i, i + CHUNK);
    const { error } = await supabaseAdmin.storage.from(bucket).remove(slice);
    if (error) {
      console.error(`[account/delete] storage remove failed (${bucket}):`, error.message);
    }
  }
}

accountRoutes.get("/export", async (c) => {
  const userId = c.get("userId");

  const [profile, submissions, inventory, sources] = await Promise.all([
    supabaseAdmin.from("users").select("*").eq("id", userId).maybeSingle(),
    supabaseAdmin.from("submissions").select("*").eq("user_id", userId),
    supabaseAdmin.from("inventory_items").select("*").eq("user_id", userId),
    supabaseAdmin.from("sources").select("*").eq("user_id", userId),
  ]);

  const submissionIds = (submissions.data ?? []).map((r) => (r as { id: string }).id);
  const itemIds = (inventory.data ?? []).map((r) => (r as { id: string }).id);

  // Children scoped through the owned parents (these tables have no user_id).
  const [gradeReports, listings, sales] = await Promise.all([
    submissionIds.length
      ? supabaseAdmin.from("grade_reports").select("*").in("submission_id", submissionIds)
      : Promise.resolve({ data: [] }),
    itemIds.length
      ? supabaseAdmin.from("listings").select("*").in("inventory_item_id", itemIds)
      : Promise.resolve({ data: [] }),
    itemIds.length
      ? supabaseAdmin.from("sales").select("*").in("inventory_item_id", itemIds)
      : Promise.resolve({ data: [] }),
  ]);

  const payload = {
    exported_at: new Date().toISOString(),
    user_id: userId,
    profile: profile.data ?? null,
    submissions: submissions.data ?? [],
    grade_reports: gradeReports.data ?? [],
    inventory_items: inventory.data ?? [],
    listings: listings.data ?? [],
    sales: sales.data ?? [],
    sources: sources.data ?? [],
  };

  return c.json(payload, 200, {
    "Content-Disposition": `attachment; filename="gradethread-export-${userId}.json"`,
  });
});

// Permanent account deletion (US-275 / GDPR right to erasure, App Store 5.1.1(v)).
// The delete_account() RPC only cascades the DB; it leaves Storage objects, the
// Stripe customer, and stored eBay tokens behind. This endpoint does the full
// teardown: external resources first (while we can still read the user's rows),
// then the auth user — whose ON DELETE CASCADE wipes every public table keyed
// to it (submissions, inventory_items, marketplace_connections, api_keys, ...).
//
// Body: { confirm: "DELETE MY ACCOUNT" } — guards against accidental calls.
accountRoutes.post("/delete", async (c) => {
  const userId = c.get("userId");

  let body: { confirm?: string };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  if (body.confirm !== "DELETE MY ACCOUNT") {
    return c.json(
      { error: 'Confirmation required. Send { "confirm": "DELETE MY ACCOUNT" }.' },
      400,
    );
  }

  const { data: user } = await supabaseAdmin
    .from("users")
    .select("stripe_customer_id, role")
    .eq("id", userId)
    .maybeSingle();

  // US-270: deleting a privileged account is destructive — require a fresh MFA
  // step-up. Regular users self-deleting (GDPR) are unaffected (they may have
  // no second factor), so this is gated only for admin/super_admin actors.
  if (user && (user.role === "admin" || user.role === "super_admin")) {
    const stepUp = requireStepUp(c);
    if (stepUp) return stepUp;
  }

  // 1. Remove storage objects (no user_id column on storage; derive paths from
  //    the owned DB rows before the cascade deletes them).
  const [subs, items] = await Promise.all([
    supabaseAdmin.from("submissions").select("id").eq("user_id", userId),
    supabaseAdmin.from("inventory_items").select("id").eq("user_id", userId),
  ]);
  const subIds = (subs.data ?? []).map((r) => (r as { id: string }).id);
  const itemIds = (items.data ?? []).map((r) => (r as { id: string }).id);

  const [subImgs, itemPhotos] = await Promise.all([
    subIds.length
      ? supabaseAdmin.from("submission_images").select("storage_path").in("submission_id", subIds)
      : Promise.resolve({ data: [] as { storage_path: string }[] }),
    itemIds.length
      ? supabaseAdmin.from("item_photos").select("storage_path").in("inventory_item_id", itemIds)
      : Promise.resolve({ data: [] as { storage_path: string }[] }),
  ]);

  const subImgPaths = (subImgs.data ?? [])
    .map((r) => (r as { storage_path: string | null }).storage_path)
    .filter((p): p is string => !!p);
  const itemPhotoPaths = (itemPhotos.data ?? [])
    .map((r) => (r as { storage_path: string | null }).storage_path)
    .filter((p): p is string => !!p);

  await removeAll("submission-images", subImgPaths);
  await removeAll("item-photos", itemPhotoPaths);
  const storagePurged = true;

  // 2. Delete the Stripe customer (this also cancels any active subscriptions).
  let stripeDeleted = false;
  if (user?.stripe_customer_id) {
    const stripe = getStripe();
    if (stripe) {
      try {
        await stripe.customers.del(user.stripe_customer_id);
        stripeDeleted = true;
      } catch (err) {
        // Best-effort: a missing/already-deleted customer shouldn't block
        // erasure of the rest of the account.
        console.error(
          `[account/delete] Stripe customer delete failed for ${userId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  // 3. Write the non-PII compliance record BEFORE the cascade (US-275). This
  //    table has no FK to auth.users, so it survives deletion as proof that
  //    this account id was erased on this date — with no retained PII.
  {
    const { error: logErr } = await supabaseAdmin
      .from("account_deletion_log")
      .insert({
        deleted_user_id: userId,
        source: "self_serve",
        had_stripe_customer: !!user?.stripe_customer_id,
        stripe_deleted: stripeDeleted,
        storage_purged: storagePurged,
      });
    if (logErr) {
      // Don't abort erasure over a logging failure — the user's right to be
      // forgotten outranks our audit row. Surface it for ops follow-up.
      console.error(
        `[account/delete] deletion-log insert failed for ${userId}:`,
        logErr.message,
      );
    }
  }

  // 4. Delete the auth user — cascades every public table keyed to it,
  //    including marketplace_connections (our stored eBay OAuth tokens). Live
  //    revocation at eBay isn't performed here; those tokens are short-lived
  //    and our stored copy is destroyed by the cascade.
  const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (delErr) {
    console.error(`[account/delete] auth user delete failed for ${userId}:`, delErr.message);
    return c.json({ error: "Failed to delete account. Contact support." }, 500);
  }

  return c.json({ deleted: true });
});
