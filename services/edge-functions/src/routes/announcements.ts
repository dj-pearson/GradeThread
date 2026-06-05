// US-628: user-facing announcement reads.
//
//   GET  /api/announcements/active   the live, in-window, segment-matched,
//                                     non-dismissed banners for the caller
//   POST /api/announcements/:id/dismiss
//
// Authed (mounted with authMiddleware in main.ts). Uses the service-role client
// but every query is scoped to the caller (c.var.userId) — announcements are
// platform content, dismissals are per-user.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { userMatchesSegment } from "../lib/segments.ts";
import type { SegmentRules } from "../lib/segments.ts";

type Env = { Variables: { userId?: string } };

export const announcementRoutes = new Hono<Env>();

announcementRoutes.get("/active", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Sign-in required" }, 401);

  const nowIso = new Date().toISOString();
  const { data: rows, error } = await supabaseAdmin
    .from("announcements")
    .select("id, title, body, variant, cta_label, cta_url, dismissible, priority, segment_id")
    .eq("is_active", true)
    .lte("starts_at", nowIso)
    .or(`ends_at.is.null,ends_at.gt.${nowIso}`)
    .order("priority", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) return c.json({ error: error.message }, 500);

  const announcements = (rows ?? []) as Array<{
    id: string;
    title: string;
    body: string;
    variant: string;
    cta_label: string | null;
    cta_url: string | null;
    dismissible: boolean;
    priority: number;
    segment_id: string | null;
  }>;
  if (announcements.length === 0) return c.json({ announcements: [] });

  // Drop ones this user already dismissed.
  const { data: dismissed } = await supabaseAdmin
    .from("announcement_dismissals")
    .select("announcement_id")
    .eq("user_id", userId);
  const dismissedSet = new Set(
    ((dismissed ?? []) as Array<{ announcement_id: string }>).map((d) => d.announcement_id),
  );

  // Resolve the (small set of) referenced segments once.
  const segmentIds = [...new Set(announcements.map((a) => a.segment_id).filter(Boolean))] as string[];
  const segmentRules = new Map<string, SegmentRules>();
  if (segmentIds.length > 0) {
    const { data: segs } = await supabaseAdmin
      .from("audience_segments")
      .select("id, rules")
      .in("id", segmentIds);
    for (const s of (segs ?? []) as Array<{ id: string; rules: SegmentRules }>) {
      segmentRules.set(s.id, s.rules);
    }
  }

  const visible = [];
  for (const a of announcements) {
    if (dismissedSet.has(a.id)) continue;
    if (a.segment_id) {
      const rules = segmentRules.get(a.segment_id);
      if (rules) {
        try {
          if (!(await userMatchesSegment(userId, rules))) continue;
        } catch {
          continue; // a bad rule shouldn't surface the banner to everyone
        }
      }
    }
    visible.push({
      id: a.id,
      title: a.title,
      body: a.body,
      variant: a.variant,
      cta_label: a.cta_label,
      cta_url: a.cta_url,
      dismissible: a.dismissible,
      priority: a.priority,
    });
  }

  return c.json({ announcements: visible });
});

announcementRoutes.post("/:id/dismiss", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Sign-in required" }, 401);
  const id = c.req.param("id");

  const { error } = await supabaseAdmin
    .from("announcement_dismissals")
    .upsert(
      { announcement_id: id, user_id: userId },
      { onConflict: "announcement_id,user_id", ignoreDuplicates: true },
    );
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});
