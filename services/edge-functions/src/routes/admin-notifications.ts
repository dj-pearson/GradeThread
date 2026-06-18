import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { type NotificationType, PREF_KEY } from "../lib/notify.ts";

// US-1058: admin notification event catalog.
//
// Mounted at /api/admin/notifications — inherits authMiddleware +
// adminAuthMiddleware (admin/super_admin + AAL2 MFA) from the /api/admin/*
// group in main.ts. Cross-tenant by design (the catalog spans every user's
// in-app notifications); the admin+MFA gate is the authorization boundary,
// mirroring admin-monitoring.ts.
//
// GET /catalog returns every notification type, the preference category that
// gates it (straight from notify.ts PREF_KEY — the SAME gate used at send time,
// so the catalog reflects the real end-to-end behaviour) and its delivery
// volume, so the operator can see what fires and how often.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminNotificationsRoutes = new Hono<AdminEnv>();

const ALL_TYPES = Object.keys(PREF_KEY) as NotificationType[];

interface CatalogEntry {
  type: NotificationType;
  pref_key: string | null;
  total: number;
  last_30d: number;
}

adminNotificationsRoutes.get("/catalog", async (c) => {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();

  // Count rows per type in parallel via head/exact-count queries (no group-by
  // in supabase-js). One pair of cheap COUNT(*) per type.
  const entries = await Promise.all(
    ALL_TYPES.map(async (type): Promise<CatalogEntry> => {
      const [{ count: total }, { count: last30 }] = await Promise.all([
        supabaseAdmin
          .from("notifications")
          .select("id", { count: "exact", head: true })
          .eq("type", type),
        supabaseAdmin
          .from("notifications")
          .select("id", { count: "exact", head: true })
          .eq("type", type)
          .gte("created_at", since),
      ]);
      return {
        type,
        pref_key: PREF_KEY[type],
        total: total ?? 0,
        last_30d: last30 ?? 0,
      };
    }),
  );

  const totalVolume = entries.reduce((sum, e) => sum + e.total, 0);

  return c.json({ catalog: entries, total_volume: totalVolume });
});
