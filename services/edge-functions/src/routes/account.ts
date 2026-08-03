import { Hono } from "hono";
import Stripe from "stripe";
import { supabaseAdmin } from "../lib/supabase.ts";
import { sendAccountDeletedEmail } from "../lib/email.ts";
import { type AuthAssuranceClaims, isAal2 } from "../lib/jwt-claims.ts";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
} from "../lib/recovery-codes.ts";
import {
  type PageFetcher,
  pageThrough,
  streamJsonArrayMembers,
} from "../lib/export-stream.ts";
import { refuseWhileImpersonating } from "../lib/destructive-guard.ts";
import { fetchWithTimeout } from "../lib/circuit-breaker.ts";

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

// Minimal structural shape of the query builder we chain onto. Avoids importing
// supabase-js generics into a route file just to describe two methods.
type PostgrestLike = {
  eq: (col: string, val: unknown) => PostgrestLike;
  in: (col: string, vals: readonly unknown[]) => PostgrestLike;
  range: (from: number, to: number) => unknown;
};

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

  // US-2030: the three unbounded tables are now PAGED and STREAMED rather than
  // materialised. grade_reports/listings/sales are where a large seller's whole
  // commercial history lives, and select("*") with no bound on all three at once
  // was the most likely OOM in the service — failing for exactly the biggest
  // accounts. Peak memory is now ~one page per table instead of the account.
  //
  // The small, inherently-bounded sets above (profile, sources, passport nodes)
  // stay eager: paging a handful of rows buys nothing and costs clarity.
  //
  // The response is still ONE JSON DOCUMENT, written progressively — see
  // lib/export-stream.ts for why this streams the response rather than writing
  // NDJSON to a bucket (an export at rest is a new copy of the subject's data
  // with its own retention obligation, and iOS consumes these bytes as .json).
  const pageOf = (table: string, scope: (q: PostgrestLike) => PostgrestLike): PageFetcher =>
  (from, to) =>
    scope(supabaseAdmin.from(table).select("*")).range(from, to) as unknown as ReturnType<
      PageFetcher
    >;

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (s: string) => controller.enqueue(encoder.encode(s));
      try {
        push(
          `{"exported_at":${JSON.stringify(new Date().toISOString())},` +
            `"user_id":${JSON.stringify(userId)},` +
            `"profile":${JSON.stringify(profile.data ?? null)},` +
            `"submissions":${JSON.stringify(submissions.data ?? [])},` +
            `"inventory_items":${JSON.stringify(inventory.data ?? [])},` +
            `"sources":${JSON.stringify(sources.data ?? [])},` +
            `"passport_identity_nodes":${JSON.stringify(passportNodes.data ?? [])},`,
        );

        const streamed: Array<[string, PageFetcher | null]> = [
          [
            "grade_reports",
            submissionIds.length
              ? pageOf("grade_reports", (q) => q.in("submission_id", submissionIds))
              : null,
          ],
          ["listings", pageOf("listings", (q) => q.eq("user_id", userId))],
          ["sales", pageOf("sales", (q) => q.eq("user_id", userId))],
        ];

        for (let i = 0; i < streamed.length; i++) {
          const [key, fetcher] = streamed[i];
          push(`"${key}":[`);
          if (fetcher) {
            for await (const chunk of streamJsonArrayMembers(pageThrough(fetcher))) {
              push(chunk);
            }
          }
          push(i === streamed.length - 1 ? "]" : "],");
        }
        push("}");
        controller.close();
      } catch (err) {
        // A mid-stream failure cannot become a 500 — headers are already sent.
        // ERROR the stream rather than closing it: a truncated-but-valid-looking
        // JSON file is the worst outcome, because the subject receives something
        // that looks complete and is not. An aborted download is visibly broken.
        console.error("[account/export] stream failed:", err);
        controller.error(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="gradethread-export-${userId}.json"`,
    },
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
// ⚠ US-2005: that cascade is NOT sufficient on its own, and the previous wording
// here ("wipes every public table keyed to it") was reassuring in exactly the
// wrong way. It wipes every table keyed to the USER ID. Tables keyed by EMAIL
// ADDRESS — email_deliveries (which stores full rendered message bodies),
// marketing_send_log, newsletter_issue_recipients, email_consent_audit,
// waitlist_entries, email_subscribers — are untouched by it, and the
// ON DELETE SET NULL ones actively PRESERVE the address while dropping the link.
// Step 3c below purges/anonymizes those explicitly. If you add a table that
// stores an email, add it there.
//
// Body: { confirm: "DELETE MY ACCOUNT" } — guards against accidental calls.

/**
 * US-2351 AC4: confirm a password server-side.
 *
 * GoTrue's password grant is the only thing that can answer "is this the user's
 * password" without holding the hash, so this asks it directly. It does NOT use
 * the service-role client: that client is privileged by construction and would
 * happily mint a session, which is exactly what must not happen here — a
 * successful check must prove the password and produce nothing reusable. The
 * token this returns is discarded; only the status is read.
 */
async function verifyPassword(email: string, password: string): Promise<boolean> {
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon || !email) return false;
  try {
    // US-2321: a deadline. This is the last thing between a request and a
    // permanent account deletion, so it must resolve one way or the other — a
    // hang here is indistinguishable from a stuck delete to the person waiting.
    const res = await fetchWithTimeout(
      `${url}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: { apikey: anon, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      },
      8_000,
    );
    return res.ok;
  } catch {
    // Fail CLOSED. An unreachable auth service means we cannot prove the
    // password, and "cannot prove" must not read as "proved" on the one
    // endpoint that permanently destroys an account.
    return false;
  }
}

accountRoutes.post("/delete", async (c) => {
  // US-2351 AC3: never delete an account while an admin is viewing it.
  const blocked = await refuseWhileImpersonating(c, "Deleting an account");
  if (blocked) return blocked;
  const userId = c.get("userId");

  let body: { confirm?: string; password?: string };
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

  // US-2351 AC4: the password re-authentication runs HERE, not in the browser.
  //
  // settings.tsx called signInWithPassword() before POSTing, which is a UX
  // courtesy and nothing more — the server's only control was the confirm
  // string, so anything holding a session could delete the account by calling
  // this endpoint directly. That includes an impersonating admin, for whom the
  // client-side prompt never appears at all.
  //
  // OAuth accounts have no password to check and are exempt, deliberately: the
  // alternative is demanding a password that does not exist. They are covered by
  // the impersonation refusal above and by the confirm string.
  {
    const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(userId);
    const providers = (authUser?.user?.app_metadata?.providers ?? []) as string[];
    const hasPassword = providers.includes("email");
    if (hasPassword) {
      const password = typeof body.password === "string" ? body.password : "";
      if (!password) {
        return c.json(
          {
            error: "Enter your password to confirm deleting your account.",
            code: "password_required",
          },
          400,
        );
      }
      const email = (user?.email ?? authUser?.user?.email ?? "") as string;
      const ok = await verifyPassword(email, password);
      if (!ok) {
        return c.json(
          { error: "Incorrect password.", code: "password_incorrect" },
          403,
        );
      }
    }
  }

  // US-2350 AC3: an admin cannot self-serve delete at all. A step-up proved the
  // person at the keyboard was the account holder, which was never the question
  // — the question is whether the actor whose administrative decisions are on
  // record gets to remove themselves unilaterally. They do not. Another admin
  // demotes the role first, which is itself an audited action by a second
  // person, and the account then deletes normally as an ordinary user.
  //
  // 00519 makes the audit rows SURVIVE this deletion, so the trail is no longer
  // what is at stake here. What is at stake is that removing a privileged
  // account is an operational decision, and letting its holder make it alone is
  // the same one-person-controls gap as any other unilateral destructive act.
  //
  // Ordinary users self-deleting (GDPR) are completely unaffected: this branch
  // only fires for role admin or super_admin.
  if (user && (user.role === "admin" || user.role === "super_admin")) {
    return c.json(
      {
        error:
          "An admin account can't be deleted from here. Ask another admin to " +
          "remove your admin role first, then delete the account.",
        code: "admin_self_delete_blocked",
      },
      403,
    );
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

  // 3c. US-2005: EMAIL-KEYED PII. The cascade below reaches only tables with an
  //     FK to auth.users — but a whole class of PII is keyed by EMAIL ADDRESS
  //     instead, so erasure never touched it. Worse, the ON DELETE SET NULL
  //     tables sever the user_id link while PRESERVING the address, which is
  //     precisely the identifier a data subject would cite in an erasure
  //     complaint. The endpoint returned {deleted:true} while the address and
  //     the full rendered HTML of every payment-failed and grade-ready email
  //     stayed queryable forever.
  //
  //     Best-effort per table: a failure here must not block erasure (same rule
  //     as the deletion log above — the right to be forgotten outranks our
  //     bookkeeping), but each failure is logged so ops can finish the job.
  //
  //     ⚠ email_suppressions is DELIBERATELY EXCLUDED. A suppression list must
  //     survive erasure or a bounced/complained address starts receiving mail
  //     again the moment it is forgotten — deleting it would harm the very
  //     person the erasure protects, and CAN-SPAM/GDPR both treat suppression
  //     as a legitimate-interest retention. It stores the address for that
  //     purpose only.
  const purgeEmail = (user?.email as string | null)?.trim().toLowerCase() ?? "";
  if (purgeEmail) {
    // Column names VERIFIED against the migrations — these tables do not agree
    // on what the address column is called, and guessing would fail silently
    // (PostgREST 42703 on a .eq() is an error we log and move past, so a wrong
    // name here would look exactly like a successful purge).
    const HARD_DELETE: ReadonlyArray<readonly [string, string]> = [
      ["email_deliveries", "recipient"], // also carries `html`: the full body
      ["marketing_send_log", "recipient"],
      ["email_journey_step_sends", "recipient"],
      ["newsletter_issue_recipients", "email"],
    ];
    for (const [table, column] of HARD_DELETE) {
      const { error } = await supabaseAdmin.from(table).delete().eq(column, purgeEmail);
      if (error) {
        console.error(
          `[account/delete] email-keyed purge failed for ${table}.${column}:`,
          error.message,
        );
      }
    }

    // waitlist_entries.email and email_subscribers.email are NOT NULL (and
    // UNIQUE), so "anonymize by nulling" is not available — the write would just
    // fail and leave the PII in place. Delete the rows instead: a deleted
    // account has no waitlist position to hold and no newsletter subscription to
    // keep. (Unsubscribe protection does NOT depend on this row — that is
    // email_suppressions, deliberately preserved below.)
    for (const table of ["waitlist_entries", "email_subscribers"] as const) {
      const { error } = await supabaseAdmin.from(table).delete().eq("email", purgeEmail);
      if (error) {
        console.error(`[account/delete] purge failed for ${table}:`, error.message);
      }
    }

    // email_consent_audit is nullable on both identifying columns, so it is
    // ANONYMIZED rather than deleted: the row proves WHEN a consent action
    // happened, which is a record we may need to defend, and that meaning
    // survives the subject once the identifiers are gone.
    const { error: consentErr } = await supabaseAdmin
      .from("email_consent_audit")
      .update({ email: null, ip: null })
      .eq("email", purgeEmail);
    if (consentErr) {
      console.error(
        "[account/delete] consent-audit anonymize failed:",
        consentErr.message,
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
