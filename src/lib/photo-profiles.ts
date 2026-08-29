import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { measurementGroupFor } from "@/lib/measurement-templates";
import type { FlipdeskPhotoType } from "@/types/database";

// Client mirror of the server-authoritative photo profiles
// (services/edge-functions/src/lib/photo-profiles.ts). The full table is
// fetched from `GET /api/flipdesk/photo-profiles` and cached; the small
// bundled fallback below keeps first paint / offline usable. The server table
// always wins once it loads, so the fallback only needs to be "good enough",
// not exhaustive.

export interface PhotoRole {
  type: FlipdeskPhotoType;
  /**
   * US-2465: the `item_photos.photo_role` qualifier this slot writes, or
   * undefined for a slot that takes none. Slot identity is (type, role) — that
   * is what lets a suit hold three separate `tag` slots.
   */
  role?: string;
  label: string;
  hint: string;
  required: boolean;
  icon: string;
}

export interface PhotoProfile {
  category: string;
  label: string;
  roles: PhotoRole[];
}

// Bundled fallback: the clothing profile (preserves historical behavior) plus a
// generic profile for anything else, used only until the server table loads.
// US-2465: the fallback now speaks the (type, role) vocabulary too. It is only
// on screen until the server table loads, so it stays short — but it must not
// offer a RETIRED type, or a seller can create a `detail_3` in the one second
// before the fetch resolves.
const CLOTHING_FALLBACK: PhotoProfile = {
  category: "clothing",
  label: "Clothing",
  roles: [
    { type: "front", label: "Front", hint: "Lay flat, full front in frame", required: true, icon: "shirt" },
    { type: "back", label: "Back", hint: "Same crop as the front shot", required: true, icon: "shirt" },
    { type: "tag", role: "brand", label: "Brand label", hint: "The maker's logo or wordmark", required: false, icon: "tag" },
    { type: "tag", role: "size", label: "Size tag", hint: "The size itself, close enough to read without zooming", required: false, icon: "tag" },
    { type: "tag", role: "care", label: "Care & fabric", hint: "The care label with the fibre content", required: false, icon: "tag" },
    { type: "detail", role: "fabric", label: "Fabric close-up", hint: "Fill the frame with the weave or knit, in even light", required: false, icon: "search" },
    { type: "detail", role: "hardware", label: "Hardware", hint: "Zip pull, buttons, rivets or snaps", required: false, icon: "search" },
    { type: "defect", label: "Defect", hint: "Tight crop on any flaw — be honest", required: false, icon: "alert-triangle" },
    { type: "interior", label: "Interior / Lining", hint: "Inside-out: lining, seams, interior tags", required: false, icon: "layers" },
    { type: "flatlay", label: "Flat lay", hint: "Styled flat lay for the listing gallery", required: false, icon: "layout-grid" },
    { type: "on_hanger", label: "On hanger", hint: "Hung straight on, showing how it drapes", required: false, icon: "shirt" },
    { type: "on_model", label: "On model", hint: "Worn on a model or mannequin", required: false, icon: "user" },
  ],
};

// US-2812: the THIRD bundled copy of this profile, after iOS and Android.
// A shoe captured before the profile fetch answers used to get the generic
// Front/Back/Detail set — no Sole slot, which is the first surface a shoe
// buyer looks at. Hints are abbreviated the same way the other fallbacks
// abbreviate the server's, which photo-profile-fallback-parity.test.ts
// documents as deliberate: the clients say less than the server, and what
// they must not do is say DIFFERENT things to two sellers.
const SHOES_FALLBACK: PhotoProfile = {
  category: "shoes",
  label: "Shoes",
  roles: [
    { type: "front", label: "Top / Toe", hint: "Top-down or front; show both shoes if a pair", required: true, icon: "footprints" },
    { type: "back", label: "Heel", hint: "Back of the heel, both shoes", required: true, icon: "footprints" },
    { type: "angle", label: "3/4 Angle", hint: "Angled side view showing the silhouette", required: true, icon: "footprints" },
    { type: "sole", label: "Sole", hint: "Outsole / tread — show wear honestly", required: true, icon: "footprints" },
    { type: "tag", label: "Size Stamp", hint: "Tongue or insole size + brand stamp", required: false, icon: "tag" },
    { type: "interior", label: "Insole", hint: "Inside the shoe — footbed condition", required: false, icon: "layers" },
    { type: "accessory", label: "Box / Extras", hint: "Original box, spare laces, papers", required: false, icon: "package" },
    { type: "defect", label: "Defect", hint: "Tight crop on any flaw — stain, snag, scuff, crack. Be honest.", required: false, icon: "alert-triangle" },
  ],
};

const GENERIC_FALLBACK: PhotoProfile = {
  category: "other",
  label: "Other",
  roles: [
    { type: "front", label: "Front", hint: "Main view in frame", required: true, icon: "image" },
    { type: "back", label: "Back", hint: "Reverse view", required: true, icon: "image" },
    { type: "detail", label: "Detail", hint: "Distinguishing detail or label", required: false, icon: "search" },
    { type: "defect", label: "Defect", hint: "Tight crop on any flaw — be honest", required: false, icon: "alert-triangle" },
  ],
};

// Mirror of the edge's GROUP_TO_CATEGORY: the join between the measurement
// group taxonomy and the item_category taxonomy.
const GROUP_TO_CATEGORY: Record<string, string> = {
  shoes: "shoes",
  watch: "watches",
  bag: "bags",
  accessory: "accessories",
  headwear: "headwear",
};

function fallbackProfile(category: string | null | undefined): PhotoProfile {
  if (category === "shoes") return SHOES_FALLBACK;
  return category === "clothing" || !category
    ? CLOTHING_FALLBACK
    : GENERIC_FALLBACK;
}

/**
 * The bundled profiles, for surfaces that cannot wait for the server table.
 *
 * US-9022/US-9023: /tools/photograph-clothes-to-sell prerenders, so it has no
 * fetch to await and renders this. That makes it a FIFTH consumer of the shot
 * list after web, iOS, Android and the server, which is exactly why it reads
 * the same constant rather than copying it into a marketing file — the copy
 * would be the one nothing keeps current, and a public page telling sellers a
 * different shot list from the app is worse than no public page.
 *
 * These are deliberately shorter than the server's, which
 * photo-profile-fallback-parity.test.ts documents: the clients say LESS than
 * the server, and what they must not do is say something DIFFERENT.
 */
export const BUNDLED_PHOTO_PROFILES: readonly PhotoProfile[] = [
  CLOTHING_FALLBACK,
  SHOES_FALLBACK,
  GENERIC_FALLBACK,
] as const;

export function bundledPhotoProfile(category: string | null | undefined): PhotoProfile {
  return fallbackProfile(category);
}

/**
 * The required slots a set of photos does not cover yet.
 *
 * US-2769 AC3. The gate is per TYPE, not per (type, role): `front` and `back`
 * are the only required roles and neither takes a qualifier, so "has a front"
 * is the right question and a role-blind count is the right instrument — the
 * same one PhotoUploader uses to advance an item to "photographed". Callers
 * pass whatever they hold, stored rows or photos staged in memory before the
 * item exists, so intake and the item page cannot answer this differently.
 */
export function missingRequiredRoles(
  profile: PhotoProfile,
  have: ReadonlyArray<{ photoType: FlipdeskPhotoType }>,
): PhotoRole[] {
  const types = new Set(have.map((p) => p.photoType));
  return profile.roles.filter((r) => r.required && !types.has(r.type));
}

/** Fetches + caches the whole profile table. Static config → long stale time. */
function usePhotoProfiles() {
  return useQuery({
    queryKey: ["photo_profiles"],
    staleTime: 60 * 60 * 1000, // 1h — config rarely changes within a session
    queryFn: async (): Promise<Record<string, PhotoProfile>> => {
      const res = await edgeFetch("/api/flipdesk/photo-profiles");
      if (!res.ok) throw new Error("Failed to load photo profiles");
      const body = (await res.json()) as { profiles: Record<string, PhotoProfile> };
      return body.profiles;
    },
  });
}

/**
 * Resolves the photo profile for an item. Returns the server profile once
 * loaded, otherwise a sensible bundled fallback, so callers can render slots
 * immediately and refine when the fetch resolves.
 *
 * `category` is the item_category enum. `garment` is the free-text
 * `inventory_items.category` ("blazer", "dress pants") and is only consulted
 * for clothing, where item_category alone is too coarse to know whether an
 * inseam slot belongs on screen (US-2465).
 *
 * The lookup mirrors the edge's `getPhotoProfile` exactly: non-clothing goes
 * straight to its category profile; clothing resolves a garment group and looks
 * for `clothing:<group>`, falling back to the flat `clothing` profile when the
 * garment word is unrecognised.
 */
export function usePhotoProfile(
  category: string | null | undefined,
  garment?: string | null,
): PhotoProfile {
  const { data } = usePhotoProfiles();
  if (!data) return fallbackProfile(category);

  if (category && category !== "clothing" && data[category]) return data[category];
  // `items_full` has no item_category column, so this hook is often handed the
  // free-text garment word. Resolving a group from whichever string arrived
  // makes both call shapes correct — see the edge's getPhotoProfile.
  const group = measurementGroupFor(garment ?? category);
  const byGroup = GROUP_TO_CATEGORY[group];
  if (byGroup && data[byGroup]) return data[byGroup];
  return data[`clothing:${group}`] ?? data.clothing ?? fallbackProfile(category);
}
