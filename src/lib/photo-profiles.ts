import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import type { FlipdeskPhotoType } from "@/types/database";

// Client mirror of the server-authoritative photo profiles
// (services/edge-functions/src/lib/photo-profiles.ts). The full table is
// fetched from `GET /api/flipdesk/photo-profiles` and cached; the small
// bundled fallback below keeps first paint / offline usable. The server table
// always wins once it loads, so the fallback only needs to be "good enough",
// not exhaustive.

export interface PhotoRole {
  type: FlipdeskPhotoType;
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
const CLOTHING_FALLBACK: PhotoProfile = {
  category: "clothing",
  label: "Clothing",
  roles: [
    { type: "front", label: "Front", hint: "Lay flat, full front in frame", required: true, icon: "shirt" },
    { type: "back", label: "Back", hint: "Same crop as the front shot", required: true, icon: "shirt" },
    { type: "tag", label: "Garment Tag", hint: "Care + size label, close enough to read", required: true, icon: "tag" },
    { type: "detail", label: "Detail", hint: "Texture, weave, or a distinctive feature", required: true, icon: "search" },
    { type: "tag_2", label: "Garment Tag 2", hint: "Second tag — brand stamp or care label", required: false, icon: "tag" },
    { type: "detail_2", label: "Detail 2", hint: "Another close-up", required: false, icon: "search" },
    { type: "detail_3", label: "Detail 3", hint: "Another close-up", required: false, icon: "search" },
    { type: "detail_4", label: "Detail 4", hint: "Another close-up", required: false, icon: "search" },
    { type: "interior", label: "Interior / Lining", hint: "Inside-out: lining, seams, interior tags", required: false, icon: "layers" },
    { type: "flatlay", label: "Flat lay", hint: "Styled flat lay for the listing gallery", required: false, icon: "layout-grid" },
    { type: "on_model", label: "On model", hint: "Worn on a model or mannequin", required: false, icon: "user" },
    { type: "defect", label: "Defect", hint: "Tight crop on any flaw — be honest", required: false, icon: "alert-triangle" },
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

function fallbackProfile(category: string | null | undefined): PhotoProfile {
  return category === "clothing" || !category
    ? CLOTHING_FALLBACK
    : GENERIC_FALLBACK;
}

/** Fetches + caches the whole profile table. Static config → long stale time. */
export function usePhotoProfiles() {
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
 * Resolves the photo profile for an item_category. Returns the server profile
 * once loaded, otherwise a sensible bundled fallback, so callers can render
 * slots immediately and refine when the fetch resolves.
 */
export function usePhotoProfile(category: string | null | undefined): PhotoProfile {
  const { data } = usePhotoProfiles();
  if (data) {
    if (category && data[category]) return data[category];
    return data.clothing ?? fallbackProfile(category);
  }
  return fallbackProfile(category);
}
