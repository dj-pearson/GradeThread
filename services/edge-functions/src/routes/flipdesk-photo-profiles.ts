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

// US-2465: `?garment=` carries the free-text `inventory_items.category`
// ("blazer", "dress pants"). It is only consulted for clothing, where the
// item_category alone is too coarse — it is the difference between offering a
// t-shirt an inseam slot and not. Omitting it keeps the pre-US-2465 behavior.
flipdeskPhotoProfilesRoutes.get("/:category", (c) =>
  c.json(getPhotoProfile(c.req.param("category"), c.req.query("garment")))
);
