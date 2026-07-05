import { Hono } from "hono";
import Stripe from "stripe";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireStepUp } from "../lib/step-up.ts";
import { sendAccountDeletedEmail } from "../lib/email.ts";
import { type AuthAssuranceClaims, isAal2 } from "../lib/jwt-claims.ts";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
} from "../lib/recovery-codes.ts";

// Account data portability (US-275 / GDPR + CCPA). Authed user exports a copy
// of their own data. Mounted behind authMiddleware in main.ts, so c.var.userId
// is the caller. Every query is scoped to that user — directly by user_id, or
// through the parent row's ownership (grade_reports via submission, listings/
// sales via inventory_item).

type AccountEnv = {
  Variables: { userId: string; authClaims?: AuthAssuranceClaims };
};

export const accountRoutes = new Hono<AccountEnv>();

// US-1637: collect every submission-images object owned by a deleting account so
// {deleted:true} means the bytes are actually gone. Pure + exported so the sweep
// is unit-testable (account-deletion-sweep_test.ts). Includes:
//   • storage_path — the served (metadata-stripped) image, and
//   • original_storage_path — the EXIF/GPS-INTACT original retained for
//     forensics (US-339); omitting it left GPS-bearing PII behind, and
//   • disputes.evidence_paths — filer-attached evidence, also in this bucket.
// De-duplicated so a path present twice isn't removed twice.
export function collectSubmissionImagePaths(
  subImages: { storage_path: string | null; original_storage_path: string | null }[],
  disputes: { evidence_paths: string[] | null }[],
): string[] {
  const imagePaths = subImages
    .flatMap((r) => [r.storage_path, r.original_storage_path])
    .filter((p): p is string => !!p);
  const evidencePaths = disputes
    .flatMap((r) => r.evidence_paths ?? [])
    .filter((p): p is string => typeof p === "string" && p.length > 0);
  return [...new Set([...imagePaths, ...evidencePaths])];
}

// ── MFA recovery codes (US-374) ────────────────────────────────────────────
//
// All three endpoints are tenant-scoped to c.var.userId (the verified caller),
// per the CLAUDE.md service-role-bypasses-RLS rule. The `mfa_recovery_codes`
// table only ever holds SHA-256 hashes; plaintext is returned once at generate.

const RECOVERY_CODE_COUNT = 10;

// GET /api/account/mfa/recovery-codes — how many unused codes remain.
accountRoutes.get("/mfa/recovery-codes", async (c) => {
  const userId = c.get("userId");
  const { count, error } = await supabaseAdmin
    .from("mfa_recovery_codes")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("used_at", null);
  if (error) {
    console.error("[account/mfa] recovery-code count failed:", error.message);
    return c.json({ error: "Failed to load recovery codes." }, 500);
  }
  return c.json({ remaining: count ?? 0 });
});

// POST /api/account/mfa/recovery-codes — (re)generate a fresh set. Requires an
// AAL2 session (proof the caller currently controls their second factor), so a
// walk-up attacker on an unlocked AAL1 session can't mint backup codes. Any
// previously issued codes are invalidated.
accountRoutes.post("/mfa/recovery-codes", async (c) => {
  const userId = c.get("userId");

  if (!isAal2(c.get("authClaims") ?? { aal: null, amr: [] })) {
    return c.json(
      {
        error:
          "Verify your authenticator first. Recovery codes can only be generated from an MFA-verified session.",
        code: "MFA_REQUIRED",
      },
      403,
    );
  }

  const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
  const hashes = await Promise.all(codes.map((code) => hashRecoveryCode(code)));

  // Replace the existing set atomically enough for our purposes: delete then
  // insert. A race here only ever costs the user one regenerate.
  const { error: delErr } = await supabaseAdmin
    .from("mfa_recovery_codes")
    .delete()
    .eq("user_id", userId);
  if (delErr) {
    console.error("[account/mfa] clear old codes failed:", delErr.message);
    return c.json({ error: "Failed to generate recovery codes." }, 500);
  }

  const { error: insErr } = await supabaseAdmin
    .from("mfa_recovery_codes")
    .insert(hashes.map((code_hash) => ({ user_id: userId, code_hash })));
  if (insErr) {
    console.error("[account/mfa] insert codes failed:", insErr.message);
    return c.json({ error: "Failed to generate recovery codes." }, 500);
  }

  // Plaintext returned exactly once — never stored, never retrievable again.
  return c.json({ codes, remaining: codes.length });
});

// POST /api/account/mfa/recovery-codes/consume — lost-device recovery. Works
// from an AAL1 session (the user can't reach AAL2 without their device). A
// valid, unused code is burned and ALL the caller's TOTP factors are unenrolled
// server-side, so they can sign in with their password and enroll a new device.
accountRoutes.post("/mfa/recovery-codes/consume", async (c) => {
  const userId = c.get("userId");

  let body: { code?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const code = typeof body.code === "string" ? body.code : "";
  if (!code.trim()) {
    return c.json({ error: "A recovery code is required." }, 400);
  }

  const codeHash = await hashRecoveryCode(code);

  // Burn the code: only matches an UNUSED row for THIS user. The update returns
  // the row iff it was still unused, closing the double-spend race.
  const { data: burned, error: burnErr } = await supabaseAdmin
    .from("mfa_recovery_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("code_hash", codeHash)
    .is("used_at", null)
    .select("id")
    .maybeSingle();
  if (burnErr) {
    console.error("[account/mfa] consume failed:", burnErr.message);
    return c.json({ error: "Failed to verify recovery code." }, 500);
  }
  if (!burned) {
    return c.json({ error: "Invalid or already-used recovery code." }, 400);
  }

  // Unenroll every TOTP factor so the lost device no longer guards the account.
  let factorsRemoved = 0;
  try {
    const { data: factorList } = await supabaseAdmin.auth.admin.mfa.listFactors({
      userId,
    });
    const factors = factorList?.factors ?? [];
    for (const factor of factors) {
      const { error: delFactorErr } = await supabaseAdmin.auth.admin.mfa
        .deleteFactor({ id: factor.id, userId });
      if (delFactorErr) {
        console.error(
          "[account/mfa] deleteFactor failed:",
          delFactorErr.message,
        );
      } else {
        factorsRemoved++;
      }
    }
  } catch (err) {
    console.error(
      "[account/mfa] factor teardown errored:",
      err instanceof Error ? err.message : String(err),
    );
  }

  return c.json({ ok: true, factors_removed: factorsRemoved });
});

function getStripe(): Stripe | null {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) return null;
  return new Stripe(key, { apiVersion: "2024-04-10", timeout: 20_000, maxNetworkRetries: 2 });
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

  const [profile, submissions, inventory, sources, passportNodes] = await Promise.all([
    supabaseAdmin.from("users").select("*").eq("id", userId).maybeSingle(),
    supabaseAdmin.from("submissions").select("*").eq("user_id", userId),
    supabaseAdmin.from("inventory_items").select("*").eq("user_id", userId),
    supabaseAdmin.from("sources").select("*").eq("user_id", userId),
    // US-1105: the Garment Passport hops linked to this account + the per-hop
    // identity-reveal consent. Pseudonymous by default; the export documents the
    // linkage + which hops the user opted to reveal so the subject sees exactly
    // what identity data we hold for them.
    supabaseAdmin
      .from("owner_nodes")
      .select("id, pseudonymous_label, kind, identity_revealed, identity_revealed_at, created_at")
      .eq("linked_user_id", userId),
  ]);

  const submissionIds = (submissions.data ?? []).map((r) => (r as { id: string }).id);

  // grade_reports is still scoped through the owned submissions; listings/sales
  // now carry a denormalized user_id (US-410), so they filter by the tenant key
  // directly — index-backed, no inventory_items round-trip.
  const [gradeReports, listings, sales] = await Promise.all([
    submissionIds.length
      ? supabaseAdmin.from("grade_reports").select("*").in("submission_id", submissionIds)
      : Promise.resolve({ data: [] }),
    supabaseAdmin.from("listings").select("*").eq("user_id", userId),
    supabaseAdmin.from("sales").select("*").eq("user_id", userId),
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
    passport_identity_nodes: passportNodes.data ?? [],
  };

  return c.json(payload, 200, {
    "Content-Disposition": `attachment; filename="gradethread-export-${userId}.json"`,
  });
});

// US-903: self-serve data-subject request entrypoint. An authenticated user
// files a formal export OR deletion request for THEIR OWN account; it lands in
// the admin compliance queue (data_requests) for an operator to process. This is
// distinct from the immediate /export + /delete above: it creates an audited,
// tracked request rather than acting inline, which is what GDPR/CCPA expects for
// a verifiable, defensible workflow. Tenant-scoped: the row is always keyed to
// c.var.userId — a caller can never file a request against another account.
accountRoutes.post("/data-requests", async (c) => {
  const userId = c.get("userId");

  let body: { type?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const type = body.type === "export" || body.type === "delete" ? body.type : "";
  if (!type) {
    return c.json({ error: "type must be 'export' or 'delete'" }, 400);
  }

  // De-dupe: don't stack multiple open requests of the same type for one user.
  const { data: pending } = await supabaseAdmin
    .from("data_requests")
    .select("id")
    .eq("user_id", userId)
    .eq("type", type)
    .in("status", ["received", "processing"])
    .maybeSingle();
  if (pending) {
    return c.json(
      { error: "You already have a pending request of this type.", id: (pending as { id: string }).id },
      409,
    );
  }

  const { data: inserted, error } = await supabaseAdmin
    .from("data_requests")
    .insert({
      user_id: userId,
      type,
      status: "received",
      requested_by: userId,
      source: "self_serve",
    })
    .select("id")
    .single();
  if (error || !inserted) {
    console.error("[account/data-requests] insert failed:", error?.message);
    return c.json({ error: "Failed to file your request." }, 500);
  }

  return c.json({ ok: true, id: (inserted as { id: string }).id }, 201);
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
    .select("stripe_customer_id, role, email, full_name")
    .eq("id", userId)
    .maybeSingle();

  // US-270: deleting a privileged account is destructive — require a fresh MFA
  // step-up. Regular users self-deleting (GDPR) are unaffected (they may have
  // no second factor), so this is gated only for admin/super_admin actors.
  if (user && (user.role === "admin" || user.role === "super_admin")) {
    const stepUp = requireStepUp(c);
    if (stepUp) return stepUp;
  }

  // US-372: this user may OWN a shared workspace. workspace_members.owner_id has
  // ON DELETE CASCADE, so deleting the owner would silently wipe the entire
  // shared workspace (every member's access + the membership rows) with no
  // notice. Block the deletion while members still exist and tell the owner to
  // remove them (or transfer ownership) first.
  {
    const { count: memberCount, error: memberErr } = await supabaseAdmin
      .from("workspace_members")
      .select("member_id", { count: "exact", head: true })
      .eq("owner_id", userId);
    if (memberErr) {
      console.error(`[account/delete] member check failed for ${userId}:`, memberErr.message);
      return c.json({ error: "Failed to verify workspace state. Try again." }, 500);
    }
    if ((memberCount ?? 0) > 0) {
      return c.json(
        {
          error:
            "Your workspace still has members. Remove all members (or transfer ownership) before deleting your account.",
          code: "workspace_has_members",
          member_count: memberCount,
        },
        409,
      );
    }
  }

  // 1. Remove storage objects (no user_id column on storage; derive paths from
  //    the owned DB rows before the cascade deletes them).
  const [subs, items] = await Promise.all([
    supabaseAdmin.from("submissions").select("id").eq("user_id", userId),
    supabaseAdmin.from("inventory_items").select("id").eq("user_id", userId),
  ]);
  const subIds = (subs.data ?? []).map((r) => (r as { id: string }).id);
  const itemIds = (items.data ?? []).map((r) => (r as { id: string }).id);

  const [subImgs, itemPhotos, disputeRows] = await Promise.all([
    // US-1637: also sweep original_storage_path — the metadata-INTACT original
    // (EXIF/GPS deliberately preserved for forensics, US-339). Selecting only
    // storage_path left GPS-bearing PII in the bucket after "deletion".
    subIds.length
      ? supabaseAdmin
        .from("submission_images")
        .select("storage_path, original_storage_path")
        .in("submission_id", subIds)
      : Promise.resolve({ data: [] as { storage_path: string; original_storage_path: string | null }[] }),
    itemIds.length
      ? supabaseAdmin.from("item_photos").select("storage_path").in("inventory_item_id", itemIds)
      : Promise.resolve({ data: [] as { storage_path: string }[] }),
    // US-1637: dispute evidence photos also live in submission-images and were
    // never swept — the account owns them via disputes.user_id.
    supabaseAdmin.from("disputes").select("evidence_paths").eq("user_id", userId),
  ]);

  const submissionImagePaths = collectSubmissionImagePaths(
    (subImgs.data ?? []) as { storage_path: string | null; original_storage_path: string | null }[],
    (disputeRows.data ?? []) as { evidence_paths: string[] | null }[],
  );
  const itemPhotoPaths = (itemPhotos.data ?? [])
    .map((r) => (r as { storage_path: string | null }).storage_path)
    .filter((p): p is string => !!p);

  await removeAll("submission-images", submissionImagePaths);
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

  // 3b. US-1105: re-pseudonymize this user's Garment Passport hops BEFORE the
  //     cascade. owner_nodes.linked_user_id is ON DELETE SET NULL (00256), so the
  //     account linkage is severed automatically — but we also explicitly clear
  //     the reveal consent + linkage here so no opted-in handle can resolve for
  //     even an instant, and the honoring is explicit/auditable, not implicit in
  //     a FK rule. Best-effort: a failure here never blocks erasure.
  {
    const { error: revealErr } = await supabaseAdmin
      .from("owner_nodes")
      .update({ identity_revealed: false, identity_revealed_at: null, linked_user_id: null })
      .eq("linked_user_id", userId);
    if (revealErr) {
      console.error(
        `[account/delete] passport reveal teardown failed for ${userId}:`,
        revealErr.message,
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

  // US-373: deletion model is IMMEDIATE HARD-DELETE (signed off): GDPR
  // erasure + App Store 5.1.1(v) both favor prompt destruction, and we keep no
  // recoverable PII (the account_deletion_log row above is non-PII proof only).
  // The compensating control is (1) the confirm-string + password re-auth on the
  // client, and (2) this confirmation email which gives the user a short
  // support window to flag an unintended/unauthorized deletion before backups
  // age out. Best-effort — never fail the (already-completed) deletion over it.
  if (user?.email) {
    try {
      await sendAccountDeletedEmail(user.email, user.full_name?.trim() || "there");
    } catch (err) {
      console.error(
        `[account/delete] confirmation email failed for ${userId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return c.json({ deleted: true });
});
