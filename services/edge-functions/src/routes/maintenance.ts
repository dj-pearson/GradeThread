import { Hono } from "hono";
import { getEffectiveWindows } from "../lib/maintenance.ts";

// US-887: PUBLIC maintenance-status endpoint.
//
// Mounted at /api/maintenance with NO auth so the SPA app shell (and logged-out
// / public surfaces) can render the maintenance notice for everyone. Returns
// only the windows effective RIGHT NOW, projected to a public-safe shape (no
// created_by). Management lives behind admin auth at /api/admin/ops/maintenance.
export const maintenanceRoutes = new Hono();

maintenanceRoutes.get("/active", async (c) => {
  const windows = await getEffectiveWindows();
  return c.json({
    windows: windows.map((w) => ({
      id: w.id,
      scope: w.scope,
      mode: w.mode,
      message: w.message,
      starts_at: w.starts_at,
      ends_at: w.ends_at,
    })),
  });
});
