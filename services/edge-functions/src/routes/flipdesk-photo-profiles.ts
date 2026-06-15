import { Hono } from "hono";
import {
  getPhotoProfile,
  PHOTO_PROFILES,
} from "../lib/photo-profiles.ts";

// Serves the server-authoritative photo profiles (see lib/photo-profiles.ts).
// Static config — no tenant data — but mounted under /api/flipdesk so it sits
// behind the same auth middleware as the rest of the surface. Clients fetch the
// whole table once and cache it; the per-category route is a convenience.
export const flipdeskPhotoProfilesRoutes = new Hono();

flipdeskPhotoProfilesRoutes.get("/", (c) =>
  c.json({ profiles: PHOTO_PROFILES })
);

flipdeskPhotoProfilesRoutes.get("/:category", (c) =>
  c.json(getPhotoProfile(c.req.param("category")))
);
