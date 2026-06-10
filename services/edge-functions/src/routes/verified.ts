import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe, jsonError } from "../lib/http-errors.ts";

// GradeThread Verified — seller-profile management (US: revolutionary-flipping).
//
// The caller manages their OWN public trust profile: claim a handle, set a
// display name + bio, and toggle the profile public. Mounted behind
// authMiddleware in main.ts, so c.var.userId is the caller. Every write is
// scoped to that user (`.eq("id", userId)`) — this endpoint never touches
// another tenant's row (US-268). Public READS live in content-public.ts.

type VerifiedEnv = { Variables: { userId: string } };

export const verifiedRoutes = new Hono<VerifiedEnv>();

// 3–30 chars, lowercase alnum + hyphen, no leading/trailing hyphen. Mirrors the
// DB CHECK constraint (migration 00057) and the client-side validation.
const HANDLE_RE = /^[a-z0-9]([a-z0-9-]{1,28})[a-z0-9]$/;

// Handles we never let a seller claim — they'd collide with real routes or
// impersonate the platform.
const RESERVED_HANDLES = new Set([
  "admin", "api", "app", "auth", "billing", "blog", "cert", "dashboard",
  "gradethread", "flipdesk", "help", "login", "logout", "og", "pricing",
  "settings", "signup", "support", "verified", "www",
]);

interface ProfileBody {
  handle?: unknown;
  display_name?: unknown;
  bio?: unknown;
  enabled?: unknown;
  show_listings?: unknown;
}

/** Normalize + validate a handle. Returns the clean handle or an error reason. */
function parseHandle(raw: unknown): { handle: string } | { error: string } {
  if (typeof raw !== "string") return { error: "Handle is required." };
  const handle = raw.trim().toLowerCase();
  if (handle.length < 3 || handle.length > 30) {
    return { error: "Handle must be 3–30 characters." };
  }
  if (!HANDLE_RE.test(handle)) {
    return {
      error:
        "Use lowercase letters, numbers and hyphens only (no leading/trailing hyphen).",
    };
  }
  if (RESERVED_HANDLES.has(handle)) {
    return { error: "That handle is reserved. Try another." };
  }
  return { handle };
}

const MAX_BIO = 280;
const MAX_DISPLAY_NAME = 60;

/** Count + average of the caller's certified (public) grades. */
async function ownStats(
  userId: string,
): Promise<{ total_graded: number; average_grade: number }> {
  const { data } = await supabaseAdmin
    .from("grade_reports")
    .select("overall_score, submissions!inner(user_id)")
    .eq("submissions.user_id", userId)
    .not("certificate_id", "is", null)
    .limit(1000);
  const rows = (data ?? []) as unknown as { overall_score: number }[];
  const total = rows.length;
  const avg =
    total > 0
      ? Math.round((rows.reduce((a, r) => a + Number(r.overall_score), 0) / total) * 10) / 10
      : 0;
  return { total_graded: total, average_grade: avg };
}

// ── GET /handle-available?handle=foo ──────────────────────────────
verifiedRoutes.get("/handle-available", async (c) => {
  const parsed = parseHandle(c.req.query("handle"));
  if ("error" in parsed) {
    return c.json({ available: false, reason: parsed.error });
  }
  const userId = c.get("userId");
  const { data } = await supabaseAdmin
    .from("users")
    .select("id")
    .ilike("verified_handle", parsed.handle)
    .maybeSingle();
  // Available if unclaimed, or already claimed by the caller themselves.
  const available = !data || data.id === userId;
  return c.json({
    available,
    handle: parsed.handle,
    reason: available ? null : "That handle is already taken.",
  });
});

// ── GET /profile ──────────────────────────────────────────────────
verifiedRoutes.get("/profile", async (c) => {
  const userId = c.get("userId");
  const { data: user, error } = await supabaseAdmin
    .from("users")
    .select(
      "verified_handle, verified_display_name, verified_bio, verified_enabled, verified_since, verified_show_listings, full_name",
    )
    .eq("id", userId)
    .maybeSingle();
  if (error) return failSafe(c, 500, "Couldn't load your profile.", error, "verified.get");

  const stats = await ownStats(userId);
  return c.json({
    profile: {
      handle: user?.verified_handle ?? null,
      display_name: user?.verified_display_name ?? user?.full_name ?? null,
      bio: user?.verified_bio ?? null,
      enabled: user?.verified_enabled ?? false,
      verified_since: user?.verified_since ?? null,
      show_listings: user?.verified_show_listings ?? false,
    },
    stats,
  });
});

// ── PUT /profile ──────────────────────────────────────────────────
verifiedRoutes.put("/profile", async (c) => {
  const userId = c.get("userId");

  let body: ProfileBody;
  try {
    body = (await c.req.json()) as ProfileBody;
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  const update: Record<string, unknown> = {};

  // Handle (optional on update; required before a profile can go public).
  if (body.handle !== undefined && body.handle !== null && body.handle !== "") {
    const parsed = parseHandle(body.handle);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    update.verified_handle = parsed.handle;
  }

  if (body.display_name !== undefined) {
    const dn = typeof body.display_name === "string" ? body.display_name.trim() : "";
    update.verified_display_name = dn ? dn.slice(0, MAX_DISPLAY_NAME) : null;
  }

  if (body.bio !== undefined) {
    const bio = typeof body.bio === "string" ? body.bio.trim() : "";
    update.verified_bio = bio ? bio.slice(0, MAX_BIO) : null;
  }

  // Storefront opt-in: surface active listings on the public profile.
  if (body.show_listings !== undefined) {
    update.verified_show_listings = body.show_listings === true;
  }

  // Determine the resulting handle (incoming or already-stored) so we can
  // refuse to go public without one, and stamp verified_since on first enable.
  const { data: current } = await supabaseAdmin
    .from("users")
    .select("verified_handle, verified_enabled, verified_since")
    .eq("id", userId)
    .maybeSingle();
  const resultingHandle =
    (update.verified_handle as string | undefined) ?? current?.verified_handle ?? null;

  if (body.enabled !== undefined) {
    const enabled = body.enabled === true;
    if (enabled && !resultingHandle) {
      return c.json(
        { error: "Claim a handle before making your profile public." },
        400,
      );
    }
    update.verified_enabled = enabled;
    // Stamp the "Verified since" date the first time the profile goes public.
    if (enabled && !current?.verified_since) {
      update.verified_since = new Date().toISOString();
    }
  }

  if (Object.keys(update).length === 0) {
    return c.json({ error: "Nothing to update." }, 400);
  }

  const { data, error } = await supabaseAdmin
    .from("users")
    .update(update)
    .eq("id", userId)
    .select(
      "verified_handle, verified_display_name, verified_bio, verified_enabled, verified_since, verified_show_listings",
    )
    .maybeSingle();

  if (error) {
    // 23505 = unique_violation on the case-insensitive handle index.
    if ((error as { code?: string }).code === "23505") {
      return jsonError(c, 409, "That handle is already taken.");
    }
    return failSafe(c, 500, "Couldn't update your profile.", error, "verified.update");
  }

  return c.json({
    profile: {
      handle: data?.verified_handle ?? null,
      display_name: data?.verified_display_name ?? null,
      bio: data?.verified_bio ?? null,
      enabled: data?.verified_enabled ?? false,
      verified_since: data?.verified_since ?? null,
      show_listings: data?.verified_show_listings ?? false,
    },
  });
});
