import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  loadLegalVersionState,
  needsReacceptance,
} from "../lib/legal-versions.ts";

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
