import { readStored, writeStored } from "@/lib/safe-storage";
import type { UserUseCase } from "@/types/database";

// US-3264. "How many listings do you already have, and where?"
//
// Signup asked which persona and nothing else, so every new seller was routed
// as if they were starting from an empty closet: the first thing a reseller
// with 300 live Poshmark listings was shown is a form for adding one item.
//
// WHERE THE ANSWER LIVES, and why it is not a column on public.users.
//
// The answer is used within a minute of being given -- it decides the first
// screen after the tour and pre-selects the import source -- and after that its
// value is a question about the POPULATION ("how many sellers arrive with a
// closet"), which analytics answers better than a column does. A users column
// would have cost a migration plus the 00526 self-update allowlist restatement
// plus a held push, to persist a fact whose consumer is one navigation away.
// So: local for the routing, PostHog for the question.
//
// The consequence, stated rather than discovered: answering on a laptop does
// not pre-select the import source on a phone. That is the whole cost.

export const LISTING_VOLUMES = ["none", "1-25", "26-200", "200+"] as const;
export type ListingVolume = (typeof LISTING_VOLUMES)[number];

export const LISTING_VOLUME_LABELS: Record<ListingVolume, string> = {
  none: "None yet",
  "1-25": "A few (1 to 25)",
  "26-200": "A closet (26 to 200)",
  "200+": "A shop (200+)",
};

export interface ExistingListingsAnswer {
  volume: ListingVolume;
  /** Marketplace ids from LISTING_PLATFORMS. Empty is allowed. */
  channels: string[];
}

function key(userId: string | undefined): string {
  return `gt.onboarding.existing_listings:${userId ?? "anon"}`;
}

export function saveExistingListings(
  userId: string | undefined,
  answer: ExistingListingsAnswer,
): void {
  writeStored(key(userId), JSON.stringify(answer));
}

/** The stored answer, or null when the question was never answered here. */
export function readExistingListings(
  userId: string | undefined,
): ExistingListingsAnswer | null {
  const raw = readStored(key(userId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ExistingListingsAnswer>;
    const volume = parsed.volume;
    if (!volume || !(LISTING_VOLUMES as readonly string[]).includes(volume)) {
      return null;
    }
    return {
      volume: volume as ListingVolume,
      channels: Array.isArray(parsed.channels)
        ? parsed.channels.filter((c): c is string => typeof c === "string")
        : [],
    };
  } catch {
    // A half-written or hand-edited value is the same as no answer.
    return null;
  }
}

/** Does this persona get asked at all? */
export function asksExistingListings(useCase: UserUseCase | null): boolean {
  return useCase === "seller" || useCase === "consignment";
}

/**
 * Where a finished tour lands.
 *
 * A seller who says they have listings somewhere goes to the importer, not to
 * the FlipDesk overview -- the overview's first instruction is "add an item",
 * which is the wrong one for them three hundred times over. Everyone else keeps
 * the destination they had.
 */
export function landingForAnswer(
  useCase: UserUseCase | null,
  answer: ExistingListingsAnswer | null,
  fallback: string,
): string {
  if (!asksExistingListings(useCase)) return fallback;
  if (!answer || answer.volume === "none") return fallback;
  return "/dashboard/flipdesk/import";
}

/**
 * The CSV preset a named channel exports into, when there is one.
 *
 * US-3264: a seller who said "my listings are on Etsy" should not then be asked
 * which tool their file came from. Only channels whose own export FlipDesk has
 * a preset for appear here; the rest fall back to the generic guess, which is
 * what the page did for everyone before.
 */
export function presetIdForChannel(channel: string): string | null {
  switch (channel) {
    case "ebay":
      return "ebay-file-exchange";
    case "shopify":
      return "shopify";
    case "etsy":
      return "etsy";
    default:
      return null;
  }
}

/**
 * The one preset to pre-select for an answer, or null.
 *
 * Deliberately null when the answer names TWO channels with presets: guessing
 * between them would mis-map a file half the time, and a wrong mapping is the
 * failure the whole preset mechanism exists to avoid.
 */
export function presetIdForAnswer(
  answer: ExistingListingsAnswer | null,
): string | null {
  if (!answer) return null;
  const ids = [...new Set(answer.channels.map(presetIdForChannel))].filter(
    (id): id is string => id !== null,
  );
  return ids.length === 1 ? (ids[0] ?? null) : null;
}
