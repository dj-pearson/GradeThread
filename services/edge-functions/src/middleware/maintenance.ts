import { createMiddleware } from "hono/factory";
import {
  decideMaintenance,
  getEffectiveWindows,
  isAdminUserCached,
} from "../lib/maintenance.ts";

// US-887: maintenance-window enforcement guard.
//
// Mounted on the user-facing action prefixes (/api/grade, /api/flipdesk,
// /api/payments) AFTER their authMiddleware, so c.get("userId") is set for an
// authenticated caller. When a window is effective it:
//   • 503s every in-scope request under a 'blocked' window (non-admins);
//   • 503s in-scope WRITES under a 'read_only' window (non-admins);
//   • does nothing under a 'banner' window.
// Admins always bypass (AC#6); /api/admin is exempt anyway (the guard isn't even
// mounted there). The decision itself lives in the pure decideMaintenance().
//
// Fast path: no effective window → a single (cached) read and next(). The
// admin-role lookup only runs when a window IS active.
export const maintenanceGuard = createMiddleware(async (c, next) => {
  const windows = await getEffectiveWindows();
  if (windows.length === 0) return next();

  const userId = c.get("userId") as string | undefined;
  const isAdmin = userId ? await isAdminUserCached(userId) : false;

  const decision = decideMaintenance({
    path: c.req.path,
    method: c.req.method,
    isAdmin,
    windows,
  });

  if (decision.action === "block") {
    return c.json(
      {
        error: decision.message ||
          "GradeThread is undergoing maintenance. Please try again shortly.",
        code: decision.code,
        scope: decision.scope,
      },
      decision.status ?? 503,
    );
  }

  return next();
});
