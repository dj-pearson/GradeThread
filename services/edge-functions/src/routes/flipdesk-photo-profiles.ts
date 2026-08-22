import { Hono } from "hono";
import {
  applyAuthenticityMacroVisibility,
  getPhotoProfile,
  PHOTO_PROFILES,
  type PhotoProfile,
} from "../lib/photo-profiles.ts";
import { isFeatureEnabled } from "../lib/feature-flags.ts";
import { MACRO_CAPTURE_GUIDANCE } from "../lib/macro-capture-guidance.ts";

// Serves the server-authoritative photo profiles (see lib/photo-profiles.ts).
// Mounted under /api/flipdesk so it sits behind the same auth middleware as the
// rest of the surface. Clients fetch the whole table once and cache it; the
// per-category route is a convenience.
//
// US-2134: it is no longer PURELY static. The clothing profiles' two
// authenticity macros (serial / date code, brand stamp) are dropped for a seller
// who cannot use the authenticity add-on, because asking every clothing seller
// to "fill the frame with the date code" for a feature they do not have is a
// capture flow that costs them time and returns nothing.
//
// THE ONLY TENANT INPUT IS THE CALLER'S OWN ID. This route reads no row keyed by
// anything from the request — the flag is resolved for `workspaceOwnerId ??
// userId` and nothing else, so there is no id-from-the-body path to get wrong
// (US-268).
export const flipdeskPhotoProfilesRoutes = new Hono<
  { Variables: { userId: string; workspaceOwnerId?: string } }
>();

/**
 * Can this seller use the authenticity add-on at all?
 *
 * FAILS OPEN, to the pre-US-2134 behaviour. `isFeatureEnabled` defaults to true
 * on a missing row or a read error, and that is the right direction here: the
 * cost of wrongly showing two optional slots is a slightly longer capture list,
 * while the cost of wrongly hiding them is a seller who paid for the add-on and
 * was never asked for the photos it needs. One of those is recoverable by
 * scrolling.
 *
 * Note this is ACCOUNT eligibility, not the per-submission opt-in. The add-on is
 * chosen at grade time on a paid tier (routes/grade.ts), which has not happened
 * yet when the capture list is being drawn — so the honest question at this
 * point is "could they use these?", not "did they buy it?".
 */
async function authenticityEligible(
  userId: string | undefined,
): Promise<boolean> {
  if (!userId) return true;
  return await isFeatureEnabled("authenticity_addon", { userId });
}

// US-2137 AC1: the response also carries MACRO_CAPTURE_GUIDANCE — per-slot
// distance, lighting and framing copy.
//
// WHY HERE RATHER THAN IN EACH CLIENT. Web has this copy bundled; iOS and
// Android have NO capture guidance at all, and the whole reason this table is
// server-authoritative is that "label tweaks ship without an App Store
// release". Guidance is that kind of copy: wording with no behaviour attached.
// Serving it means a native client can render it as soon as it has somewhere to
// put it, and a reworded lighting line reaches every client at once.
//
// IT IS NOT FILTERED BY ELIGIBILITY, deliberately, unlike the slots above.
// Guidance describes how to photograph a slot the seller can already see —
// hiding the wording for a slot that IS shown would leave them the harder half
// of the job with none of the help. The authenticity macros are dropped from
// the profile itself for an ineligible seller, so its guidance is simply never
// looked up.
//
// On the LIST route only. A client fetching one category already holds the
// table, and repeating this on every per-category request would pay for the
// same copy once per category.
flipdeskPhotoProfilesRoutes.get("/", async (c) => {
  const eligible = await authenticityEligible(
    c.get("workspaceOwnerId") ?? c.get("userId"),
  );
  if (eligible) {
    return c.json({ profiles: PHOTO_PROFILES, macroGuidance: MACRO_CAPTURE_GUIDANCE });
  }
  const profiles: Record<string, PhotoProfile> = {};
  for (const [key, profile] of Object.entries(PHOTO_PROFILES)) {
    profiles[key] = applyAuthenticityMacroVisibility(profile, false);
  }
  return c.json({ profiles, macroGuidance: MACRO_CAPTURE_GUIDANCE });
});

// US-2465: `?garment=` carries the free-text `inventory_items.category`
// ("blazer", "dress pants"). It is only consulted for clothing, where the
// item_category alone is too coarse — it is the difference between offering a
// t-shirt an inseam slot and not. Omitting it keeps the pre-US-2465 behavior.
flipdeskPhotoProfilesRoutes.get("/:category", async (c) => {
  const eligible = await authenticityEligible(
    c.get("workspaceOwnerId") ?? c.get("userId"),
  );
  return c.json(
    applyAuthenticityMacroVisibility(
      getPhotoProfile(c.req.param("category"), c.req.query("garment")),
      eligible,
    ),
  );
});
