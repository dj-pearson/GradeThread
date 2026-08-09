import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  loadLegalVersionState,
  needsReacceptance,
} from "../lib/legal-versions.ts";
import {
  decideSignupConsentEvidence,
  SIGNUP_CONFIRMED_METHOD,
} from "../lib/signup-consent-evidence.ts";

// US-377 / US-904: ToS/Privacy clickwrap acceptance.
//
// Mounted behind authMiddleware in main.ts, so c.var.userId is the verified
// caller. Every query is scoped to that user (per the CLAUDE.md
// service-role-bypasses-RLS rule).
//
//   GET  /api/legal/status  → does the caller need to (re-)accept?
//   POST /api/legal/accept  → record affirmative acceptance of the CURRENT
//                             versions (stamps users columns + appends an audit
//                             row with best-effort IP/user-agent).
//   GET  /api/legal/export  → the caller's full acceptance history (JSON download).
//
// US-904: the CURRENT/REQUIRED versions are no longer hardcoded — they are read
// from the operator-managed `legal_documents` table via loadLegalVersionState()
// (with the 2026-04-01 baseline as a fallback). Publishing a new version flips
// users to "must re-accept" with no deploy.

type LegalEnv = { Variables: { userId: string } };

export const legalRoutes = new Hono<LegalEnv>();

// Client IP, trusting Cloudflare's CF-Connecting-IP first (can't be spoofed by
// the client), then the first X-Forwarded-For hop. Mirrors audit-log.ts.
function clientIp(c: Context): string | null {
  const cf = c.req.header("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return null;
}

// GET /api/legal/status — whether the caller's recorded acceptance matches the
// current document versions. Drives the dashboard legal gate.
legalRoutes.get("/status", async (c) => {
  const userId = c.get("userId");
  const [state, userRes] = await Promise.all([
    loadLegalVersionState(),
    supabaseAdmin
      .from("users")
      .select("tos_accepted_version, privacy_accepted_version, tos_accepted_at, privacy_accepted_at")
      .eq("id", userId)
      .maybeSingle(),
  ]);
  if (userRes.error) {
    console.error("[legal/status] read failed:", userRes.error.message);
    return c.json({ error: "Failed to load acceptance status." }, 500);
  }

  const row = (userRes.data ?? {}) as {
    tos_accepted_version?: string | null;
    privacy_accepted_version?: string | null;
    tos_accepted_at?: string | null;
    privacy_accepted_at?: string | null;
  };
  const needsAcceptance = needsReacceptance(state, {
    tos: row.tos_accepted_version ?? null,
    privacy: row.privacy_accepted_version ?? null,
  });

  return c.json({
    needsAcceptance,
    current: { tos: state.tos.current, privacy: state.privacy.current },
    accepted: {
      tosVersion: row.tos_accepted_version ?? null,
      privacyVersion: row.privacy_accepted_version ?? null,
      tosAt: row.tos_accepted_at ?? null,
      privacyAt: row.privacy_accepted_at ?? null,
    },
  });
});

// POST /api/legal/confirm-signup — US-2116 AC4. Append server-observed IP and
// user-agent evidence beside an email-signup clickwrap, which the Postgres
// trigger could not record because it has no request. Idempotent, and it
// REFUSES rather than inventing a record when there is no clickwrap to
// corroborate. The rules and the two shortcuts they rule out are in
// lib/signup-consent-evidence.ts — read that before changing this.
//
// Deliberately not part of /accept: that endpoint stamps the CURRENT versions
// and the users.*_accepted_version columns, both of which would be wrong here.
legalRoutes.post("/confirm-signup", async (c) => {
  const userId = c.get("userId");

  const { data, error } = await supabaseAdmin
    .from("legal_acceptances")
    .select("method, tos_version, privacy_version, accepted_at")
    .eq("user_id", userId)
    .order("accepted_at", { ascending: true });
  if (error) {
    console.error("[legal/confirm-signup] read failed:", error.message);
    return c.json({ error: "Failed to record acceptance." }, 500);
  }

  const decision = decideSignupConsentEvidence(data ?? []);
  // Neither non-insert outcome is an error. A returning user and an OAuth user
  // both land here on every sign-in, and answering 4xx would turn ordinary
  // traffic into alert noise — which is how a genuine failure stops being read.
  if (decision.action !== "insert") {
    return c.json({ ok: true, recorded: false, reason: decision.reason });
  }

  const now = new Date().toISOString();
  const { error: insErr } = await supabaseAdmin.from("legal_acceptances").insert({
    user_id: userId,
    // COPIED from the clickwrap row, never resolved fresh: the confirmation
    // must name the documents that were actually accepted, not whatever is
    // published by the time the user clicks the email link.
    tos_version: decision.tosVersion,
    privacy_version: decision.privacyVersion,
    method: SIGNUP_CONFIRMED_METHOD,
    user_agent: (c.req.header("user-agent") ?? "").slice(0, 500) || null,
    ip_address: clientIp(c),
    // When the SERVER observed this session — not when consent was given. The
    // clickwrap row holds that, and conflating the two is what would make this
    // row overstate what we know.
    accepted_at: now,
  });
  if (insErr) {
    console.error("[legal/confirm-signup] insert failed:", insErr.message);
    return c.json({ error: "Failed to record acceptance." }, 500);
  }

  return c.json({
    ok: true,
    recorded: true,
    confirmed: {
      tos: decision.tosVersion,
      privacy: decision.privacyVersion,
      signupAt: decision.signupAcceptedAt,
      observedAt: now,
    },
  });
});

// POST /api/legal/accept — record affirmative acceptance of the CURRENT
// versions. Used by the dashboard legal gate (OAuth first-access capture +
// re-acceptance on a version bump). Body: { method?: string }.
legalRoutes.post("/accept", async (c) => {
  const userId = c.get("userId");

  let body: { method?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  // Constrain the method to the known set; default to re-acceptance.
  //
  // ⚠ "signup_clickwrap" is in this allowlist and NOTHING sends it (checked
  // across src/, ios/, android/ and extension-unified/). Do not reach for it to
  // record an email signup: this handler stamps the CURRENT published versions
  // and the users.*_accepted_version columns, so on a signup confirmed after a
  // version bump it would record acceptance of a document the user never saw
  // AND clear a re-acceptance prompt nobody answered. Use
  // POST /api/legal/confirm-signup, which copies the versions off the trigger's
  // own row (US-2116 AC4).
  const requested = typeof body.method === "string" ? body.method : "";
  const method =
    requested === "oauth_clickwrap" || requested === "signup_clickwrap"
      ? requested
      : "reacceptance";

  const now = new Date().toISOString();
  // Stamp the CURRENT published versions (US-904 source of truth).
  const state = await loadLegalVersionState();
  const tosVersion = state.tos.current;
  const privacyVersion = state.privacy.current;

  // 1. Append the immutable audit row (the provable record).
  const { error: logErr } = await supabaseAdmin.from("legal_acceptances").insert({
    user_id: userId,
    tos_version: tosVersion,
    privacy_version: privacyVersion,
    method,
    user_agent: (c.req.header("user-agent") ?? "").slice(0, 500) || null,
    ip_address: clientIp(c),
    accepted_at: now,
  });
  if (logErr) {
    console.error("[legal/accept] audit insert failed:", logErr.message);
    return c.json({ error: "Failed to record acceptance." }, 500);
  }

  // 2. Update the current-acceptance columns the gate reads.
  const { error: updErr } = await supabaseAdmin
    .from("users")
    .update({
      tos_accepted_version: tosVersion,
      tos_accepted_at: now,
      privacy_accepted_version: privacyVersion,
      privacy_accepted_at: now,
    })
    .eq("id", userId);
  if (updErr) {
    console.error("[legal/accept] users update failed:", updErr.message);
    return c.json({ error: "Failed to record acceptance." }, 500);
  }

  return c.json({
    ok: true,
    accepted: { tos: tosVersion, privacy: privacyVersion, at: now },
  });
});

// GET /api/legal/export — the caller's full acceptance history as a downloadable
// JSON record (the "record is exportable" acceptance criterion).
legalRoutes.get("/export", async (c) => {
  const userId = c.get("userId");
  const { data, error } = await supabaseAdmin
    .from("legal_acceptances")
    .select("*")
    .eq("user_id", userId)
    .order("accepted_at", { ascending: false });
  if (error) {
    console.error("[legal/export] read failed:", error.message);
    return c.json({ error: "Failed to export acceptance record." }, 500);
  }

  const state = await loadLegalVersionState();
  const payload = {
    exported_at: new Date().toISOString(),
    user_id: userId,
    current_versions: { tos: state.tos.current, privacy: state.privacy.current },
    acceptances: data ?? [],
  };
  return c.json(payload, 200, {
    "Content-Disposition": `attachment; filename="legal-acceptances-${userId}.json"`,
  });
});
