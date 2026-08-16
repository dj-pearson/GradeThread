import { Hono } from "hono";
import Stripe from "stripe";
import { supabaseAdmin } from "../lib/supabase.ts";
import { purgeEmailKeyedPii } from "../lib/account-email-purge.ts";
import { retainFinancialRecords } from "../lib/financial-retention.ts";
import { captureException } from "../lib/observability.ts";
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
import { BUYER_PII_TABLES } from "../lib/buyer-pii.ts";
import {
  decryptBusinessPhone,
  decryptShipFrom,
  encryptBusinessPhone,
  encryptShipFrom,
  isEncrypted,
  normalizeShipFrom,
} from "../lib/user-shipping-pii.ts";

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
//   • purchase_arrival_captures.storage_path — US-2645. A BUYER's photos of a
//     garment as it arrived, written to this same bucket at
//     {userId}/{purchaseId}/arrival_*. Added in 00418, after US-1637 swept the
//     other three, and never added here — so deleting an account cascaded the
//     ROW away and left the PHOTOGRAPH in the bucket. Worse than kept: with no
//     row left pointing at it the object is ORPHANED, and every sweep in this
//     codebase drives off DB rows, so nothing could ever find it again.
// De-duplicated so a path present twice isn't removed twice.
export function collectSubmissionImagePaths(
  subImages: { storage_path: string | null; original_storage_path: string | null }[],
  disputes: { evidence_paths: string[] | null }[],
  arrivalCaptures: { storage_path: string | null }[] = [],
): string[] {
  const imagePaths = subImages
    .flatMap((r) => [r.storage_path, r.original_storage_path])
    .filter((p): p is string => !!p);
  const evidencePaths = disputes
    .flatMap((r) => r.evidence_paths ?? [])
    .filter((p): p is string => typeof p === "string" && p.length > 0);
  const arrivalPaths = arrivalCaptures
    .map((r) => r.storage_path)
    .filter((p): p is string => !!p);
  return [...new Set([...imagePaths, ...evidencePaths, ...arrivalPaths])];
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

  // US-2417: `select("*")` above now pulls two AES-GCM envelopes. Handing a
  // person "v2:AbC…" where their own address should be is not a GDPR export, it
  // is a receipt for one — the whole obligation is that the subject can READ
  // what we hold. So the profile is decrypted before it is serialized.
  //
  // Best-effort, and that direction is deliberate: an export must not fail
  // wholesale because one optional field could not be unlocked. A failure
  // exports everything else with these two nulled, which is honest; refusing
  // the export would be worse for the person exercising the right.
  let exportProfile = profile.data ?? null;
  if (exportProfile) {
    const p = exportProfile as Record<string, unknown>;
    try {
      exportProfile = {
        ...p,
        business_phone: await decryptBusinessPhone(userId, p.business_phone as string | null),
        ship_from_address: await decryptShipFrom(userId, p.ship_from_address),
      } as typeof exportProfile;
    } catch (err) {
      console.warn(
        `[account/export] shipping PII decrypt failed for ${userId}:`,
        err instanceof Error ? err.message : String(err),
      );
      exportProfile = { ...p, business_phone: null, ship_from_address: null } as typeof exportProfile;
    }
  }

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
            `"profile":${JSON.stringify(exportProfile)},` +
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
          // US-1864: the reseller's own Thrift Radar visit log. Paged rather than
          // eager because it grows with field trips, and included because it is
          // the ONE Radar table that is subject data — the shared event store
          // (00550) deliberately has no account column, so there is nothing in it
          // to hand back and no way to ask which rows were theirs.
          [
            "radar_personal_scans",
            pageOf("radar_personal_scans", (q) => q.eq("user_id", userId)),
          ],
          // US-1846: the buyer half of the account. Driven off the register in
          // lib/buyer-pii.ts rather than listed here, because a hand-written
          // list is exactly what left every buyer table out of this response
          // for the whole of the buyer epic — the tables existed, each was
          // correctly RLS'd, and none of them were reachable by the subject.
          // Adding a buyer table now means adding a register entry (enforced by
          // buyer-pii_test.ts), and the export follows for free.
          //
          // Paged like the three above even though most are small: one extra
          // round trip per table is cheaper than deciding, per table, whether a
          // buyer's row count can ever grow (ingested_listings and the reward
          // ledger both can).
          ...BUYER_PII_TABLES.map((t) =>
            [
              t.exportKey,
              pageOf(t.table, (q) => q.eq(t.scopeColumn, userId)),
            ] as [string, PageFetcher | null]
          ),
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

  // 0. US-2562: THE FINANCIAL RECORD, BEFORE ANYTHING IS DESTROYED.
  //
  //    Migration 00595 removed the cascading foreign keys, so the credit ledger
  //    and the subscription-event trail now survive this endpoint on their own.
  //    Two things still have to happen explicitly: count what is being retained
  //    (step 3's log proves the retention with that number), and REDACT
  //    flipdesk_subscription_events.raw_payload, which is the verbatim Stripe
  //    object and carries customer email and billing address. The cascade used
  //    to remove those rows entirely; keeping them means stripping that column
  //    by hand, or 00595 has quietly converted an erasure into a retention.
  //
  //    ⚠ THIS RUNS FIRST, ahead of the storage purge and the Stripe customer
  //    delete, and the position is the point. A redaction failure refuses the
  //    erasure, and "refuse" is only a safe answer while the account is still
  //    whole — the same check after step 1 would leave a half-erased account
  //    whose photos are gone and whose PII is not.
  //
  //    The sequence and its two different failure policies live in
  //    lib/financial-retention.ts so the refusal branch is testable without a
  //    database; everything here is the service-role adapter.
  const retention = await retainFinancialRecords(userId, {
    countLedgerRows: async (id) => {
      const { count, error } = await supabaseAdmin
        .from("grade_credit_transactions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", id);
      return { count: count ?? null, error: error ? error.message : null };
    },
    redactSubscriptionEvents: async (id) => {
      const { data, error } = await supabaseAdmin.rpc(
        "redact_subscription_event_pii",
        { p_user_id: id },
      );
      return {
        redacted: typeof data === "number" ? data : null,
        error: error ? error.message : null,
      };
    },
    report: (message, err) => {
      console.error(message, err instanceof Error ? err.message : (err ?? ""));
      if (err !== undefined) {
        captureException(err, {
          route: "account.delete",
          tags: { phase: "financial-retention", user: userId },
        });
      }
    },
  });
  if (!retention.ok) {
    // Nothing has been touched. Say so plainly — a user who thinks a failed
    // deletion partially happened will file a support ticket about data we
    // still hold, and they would be right to.
    console.error(
      `[account/delete] REFUSING to erase ${userId}: ${retention.reason}`,
    );
    return c.json(
      {
        error:
          "We could not complete the deletion right now. Nothing was removed " +
          "from your account. Please try again in a few minutes.",
        code: "retention_precondition_failed",
      },
      503,
    );
  }

  // 1. Remove storage objects (no user_id column on storage; derive paths from
  //    the owned DB rows before the cascade deletes them).
  const [subs, items] = await Promise.all([
    supabaseAdmin.from("submissions").select("id").eq("user_id", userId),
    supabaseAdmin.from("inventory_items").select("id").eq("user_id", userId),
  ]);
  const subIds = (subs.data ?? []).map((r) => (r as { id: string }).id);
  const itemIds = (items.data ?? []).map((r) => (r as { id: string }).id);

  const [subImgs, itemPhotos, disputeRows, arrivalRows, exportRows] = await Promise.all([
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
    // US-2645: arrival captures, the fourth source in this bucket. Owned
    // directly via user_id, so no parent lookup is needed.
    supabaseAdmin
      .from("purchase_arrival_captures")
      .select("storage_path")
      .eq("user_id", userId),
    // US-2646: any COMPLIANCE EXPORT ARCHIVE assembled for this person, in the
    // separate private `compliance-exports` bucket.
    //
    // This is the most complete copy of an account that exists — processExport
    // assembles submissions, inventory, listings, sales and a storage manifest
    // into one file — and it exists precisely BECAUSE the person exercised a
    // data right. Nothing has ever removed an object from that bucket. The
    // data_requests row cascades on self-serve deletion, so the archive was
    // left behind with nothing pointing at it.
    supabaseAdmin
      .from("data_requests")
      .select("file_path")
      .eq("user_id", userId),
  ]);

  const submissionImagePaths = collectSubmissionImagePaths(
    (subImgs.data ?? []) as { storage_path: string | null; original_storage_path: string | null }[],
    (disputeRows.data ?? []) as { evidence_paths: string[] | null }[],
    (arrivalRows.data ?? []) as { storage_path: string | null }[],
  );
  const itemPhotoPaths = (itemPhotos.data ?? [])
    .map((r) => (r as { storage_path: string | null }).storage_path)
    .filter((p): p is string => !!p);

  // US-2646: a different bucket, so a separate sweep. Kept beside the others
  // rather than folded into the collector, whose name and contract are about
  // submission-images specifically.
  const complianceExportPaths = [
    ...new Set(
      ((exportRows.data ?? []) as { file_path: string | null }[])
        .map((r) => r.file_path)
        .filter((p): p is string => !!p),
    ),
  ];

  await removeAll("submission-images", submissionImagePaths);
  await removeAll("item-photos", itemPhotoPaths);
  await removeAll("compliance-exports", complianceExportPaths);
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
        // US-2562: the retention, recorded as numbers rather than asserted in a
        // comment. `stripe_customer_id` is the join key a representment starts
        // from — an opaque Stripe handle, not PII, and the reason
        // had_stripe_customer alone was never enough to work a dispute from.
        // A null ledger count means the count read failed, NOT that the account
        // had no transactions; the rows are retained either way.
        stripe_customer_id: user?.stripe_customer_id ?? null,
        ledger_rows_retained: retention.ledgerRowsRetained,
        subscription_events_redacted: retention.subscriptionEventsRedacted,
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
    // US-2005 AC3: the plan and the sequence live in lib/account-email-purge.ts
    // so the property this AC actually asks for — "nothing addressable
    // survives" — can be asserted against a fake store instead of needing a
    // seeded database. Column names are verified there against the migrations;
    // a wrong one fails with 42703, which we log and step past, so it would
    // otherwise look exactly like a successful purge.
    await purgeEmailKeyedPii(purgeEmail, {
      del: async (table, column, value) => {
        const { error } = await supabaseAdmin.from(table).delete().eq(column, value);
        return { error: error ? { message: error.message } : null };
      },
      anonymize: async (table, column, value, clear) => {
        const patch: Record<string, null> = {};
        for (const c of clear) patch[c] = null;
        const { error } = await supabaseAdmin.from(table).update(patch).eq(column, value);
        return { error: error ? { message: error.message } : null };
      },
      report: (message) => console.error(message),
    });
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

// ── Business & shipping profile (US-2417 AC1) ────────────────────────────────
//
// WHY THIS EXISTS AT ALL, since settings.tsx wrote these three columns directly
// with supabase-js for two years and it worked: `business_phone` and
// `ship_from_address` are now AES-256-GCM ciphertext bound to the account owner
// (user-shipping-pii.ts), and EDGE_ENCRYPTION_KEY is an edge-only secret that
// has to stay one. A browser cannot encrypt or decrypt them, so the read and the
// write both have to happen here. Migration 00567 drops both columns from the
// users self-update allowlist so the old path fails loudly rather than writing
// plaintext around the new one.
//
// `business_name` rides along even though it is NOT encrypted and is still
// self-service. One form with one Save button should be one request; splitting
// it would leave a half-saved card whenever the second write failed.
//
// Tenant scoping is `c.get("userId")` and NOT workspaceOwnerId, deliberately.
// This is the caller's own account row — a workspace member acting inside
// someone else's workspace must not read or rewrite the owner's home address.

interface ShippingProfileBody {
  business_name?: unknown;
  business_phone?: unknown;
  ship_from_address?: unknown;
}

// GET /api/account/shipping-profile — decrypted, for the caller's own row only.
accountRoutes.get("/shipping-profile", async (c) => {
  const userId = c.get("userId");
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("business_name, business_phone, ship_from_address")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    console.error("[account/shipping-profile] load failed:", error.message);
    return c.json({ error: "Failed to load your business details." }, 500);
  }
  const row = (data ?? {}) as {
    business_name?: string | null;
    business_phone?: string | null;
    ship_from_address?: unknown;
  };

  try {
    return c.json({
      business_name: row.business_name ?? null,
      business_phone: await decryptBusinessPhone(userId, row.business_phone),
      ship_from_address: await decryptShipFrom(userId, row.ship_from_address),
    });
  } catch (err) {
    // A decrypt failure here is a wrong key or a ciphertext that was moved
    // between accounts. Neither is "you have no address" — answering 503 keeps
    // the seller from re-typing details that are already stored, and keeps a
    // key misconfiguration visible instead of silently emptying every profile.
    console.error(
      `[account/shipping-profile] decrypt failed for ${userId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return c.json({
      error: "Your business details could not be unlocked. Support has been notified.",
    }, 503);
  }
});

// PUT /api/account/shipping-profile — encrypt, then write. One statement.
accountRoutes.put("/shipping-profile", async (c) => {
  const userId = c.get("userId");
  let body: ShippingProfileBody;
  try {
    body = await c.req.json() as ShippingProfileBody;
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  const name = typeof body.business_name === "string" ? body.business_name.trim() : "";
  if (name.length > 200) {
    return c.json({ error: "Business name is too long." }, 400);
  }
  const phone = typeof body.business_phone === "string" ? body.business_phone.trim() : "";
  if (phone.length > 40) {
    return c.json({ error: "Phone number is too long." }, 400);
  }
  // Reject an envelope arriving from the client. Nothing legitimate sends one,
  // and accepting it would let a caller paste another account's ciphertext into
  // their own row — where the AAD makes it undecryptable, so the damage is a
  // permanently broken profile rather than a leak, but it is still not a state
  // any real save can produce.
  if (isEncrypted(phone)) {
    return c.json({ error: "Invalid phone number." }, 400);
  }
  if (typeof body.ship_from_address === "string") {
    return c.json({ error: "Invalid ship-from address." }, 400);
  }

  let update: Record<string, unknown>;
  try {
    // ENCRYPT BEFORE THE WRITE, never write-then-update. An insert of the
    // plaintext followed by an update would leave the address readable in the
    // WAL and in any replica that saw the first version, which is most of what
    // a stolen-dump scenario actually covers.
    update = {
      business_name: name || null,
      business_phone: await encryptBusinessPhone(userId, phone),
      ship_from_address: await encryptShipFrom(userId, body.ship_from_address),
    };
  } catch (err) {
    console.error(
      `[account/shipping-profile] encrypt failed for ${userId}:`,
      err instanceof Error ? err.message : String(err),
    );
    // 503 and NOT a plaintext fallback. Storing the address unencrypted because
    // the key was missing is the exact outcome this story exists to prevent.
    return c.json({
      error: "Your business details could not be saved securely. Support has been notified.",
    }, 503);
  }

  const { error } = await supabaseAdmin
    .from("users")
    .update(update)
    .eq("id", userId);
  if (error) {
    console.error("[account/shipping-profile] save failed:", error.message);
    return c.json({ error: "Failed to save your business details." }, 500);
  }

  // Echo back what a GET would now return, so the client does not have to
  // round-trip to render the saved state.
  return c.json({
    business_name: name || null,
    business_phone: phone || null,
    ship_from_address: normalizeShipFrom(body.ship_from_address),
  });
});
