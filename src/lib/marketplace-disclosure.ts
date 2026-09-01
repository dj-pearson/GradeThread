import {
  LISTING_PLATFORMS,
  MARKETPLACE_LABELS,
  MARKETPLACE_MECHANISM,
  type MarketplaceMechanism,
} from "@/lib/constants";

// US-2475: per-channel automation risk disclosure.
//
// WHY THIS IS ITS OWN MODULE AND NOT PART OF constants.ts (US-2112 budget).
// constants.ts is in the EAGER graph — the route table pulls it, so every
// marketing page downloads it before first paint. This block is ~5.5 KB of
// English prose that only the Marketplaces screen ever renders, and the bundle
// budget failed the build when it sat there: the eager graph went 215.31 KB gz
// against a 215 KB ceiling. Raising the ceiling was the wrong fix and the check
// says so — it trades LCP on pages that will never show this copy.
//
// Moving it here means the lazy Marketplaces route carries its own copy and the
// marketing pages carry none of it. Nothing about the CONTENT changed.

export interface MarketplaceDisclosure {
  /** Block heading. Answers "where does this run" in four words. */
  title: string;
  /** The facts, one per bullet. Order is deliberate: risk first, then who owns it. */
  facts: readonly string[];
  /** Optional deep link — /trademarks for the licensed-API channels. */
  href?: string;
  hrefLabel?: string;
}

// The per-mechanism base. `{label}` is substituted with the marketplace's name
// by marketplaceDisclosureFor() so the copy reads naturally per channel without
// becoming a per-channel string that can drift.
const MECHANISM_DISCLOSURE: Record<MarketplaceMechanism, MarketplaceDisclosure> = {
  extension: {
    title: "Runs in your browser, not on our servers",
    facts: [
      // The four facts US-2475 requires, in this order.
      "{label}'s terms restrict third-party automation. Plenty of sellers use tools like this one, and {label} can still limit an account it decides is automated.",
      "The actions run in your own browser, in the {label} tab you are already signed in to. Nothing about {label} runs on GradeThread's servers.",
      "GradeThread's servers never receive your {label} password or session cookie. The extension has no permission to read a cookie on any site, so it could not send one even if it tried.",
      "Your account, your responsibility. If {label} limits it, GradeThread cannot appeal on your behalf.",
    ],
  },
  api: {
    title: "An authorized developer connection",
    facts: [
      "GradeThread connects to {label} through its authorized developer API, under {label}'s own developer terms.",
      "You grant access by signing in on {label} itself. GradeThread holds a revocable access token, never your password.",
      "{label} sees GradeThread as the registered application it approved, so this is a sanctioned integration rather than automation of your session.",
    ],
    href: "/trademarks",
    hrefLabel: "Trademarks and API attribution",
  },
  none: {
    title: "No integration yet",
    facts: [
      "GradeThread does not connect to {label}. Nothing is automated and nothing about your {label} account is linked.",
      "You can still copy a finished draft's fields across by hand from the item page.",
    ],
  },
};

// Per-platform additions. These are APPENDED to the mechanism's facts — they
// never replace them, so a platform can add what is specific to it without being
// able to drop one of the four extension facts.
const MARKETPLACE_DISCLOSURE_NOTE: Partial<
  Record<(typeof LISTING_PLATFORMS)[number], string>
> = {
  // US-2482: engagement automation is a bigger ask than listing, so it gets its
  // own sentence rather than hiding inside the generic extension wording.
  poshmark:
    "Sharing, following and sending offers are capped and metered, and the extension shows how much of today's cap you have used. Going past what Poshmark tolerates puts a closet in share jail, where shares stop reaching buyers.",
  // 2026-08-11: Grailed lists but cannot auto-delist, and the seller has to
  // know that BEFORE they cross-list, not after something sells. Grailed
  // confirms a delete with a native browser dialog, which nothing running in a
  // page can answer — so this is permanent, not a gap waiting on a fix.
  grailed:
    "Grailed listings have to be ended by hand. Grailed confirms a delete with a browser pop-up that no extension can answer, so when an item sells somewhere else GradeThread flags the Grailed copy and reminds you — it cannot close it for you.",
  // US-2479: Vinted is EU-first, and this is also the one place we have coverage
  // a competitor structurally cannot match.
  // 2026-08-11: listing is on, delisting is not yet, and the seller has to know
  // that BEFORE they cross-list rather than after something sells.
  vinted:
    "Vinted is EU-first. The flow runs on the country domains the extension covers and reports “list manually” on any other rather than guessing at a form it has not seen. Crosslist does not serve EU customers at all. Vinted listings have to be ended by hand for now — when an item sells somewhere else GradeThread flags the Vinted copy and reminds you, but it cannot close it for you yet.",
  // US-2480: Meta's terms are stricter than the generic case and Marketplace
  // form churn is the highest of any channel we support.
  facebook:
    "Meta's platform terms restrict automated interaction with Marketplace. The flow only ever touches the listing form in your own signed-in session, and it stops and asks you to finish by hand whenever the form has changed.",
};

// Resolve the disclosure a channel actually shows. Substitutes the marketplace
// label into the mechanism copy and appends the platform note if there is one.
export function marketplaceDisclosureFor(
  platform: (typeof LISTING_PLATFORMS)[number],
): MarketplaceDisclosure {
  const base = MECHANISM_DISCLOSURE[MARKETPLACE_MECHANISM[platform]];
  const label = MARKETPLACE_LABELS[platform];
  const note = MARKETPLACE_DISCLOSURE_NOTE[platform];
  const facts = base.facts.map((f) => f.split("{label}").join(label));
  return {
    ...base,
    facts: note ? [...facts, note] : facts,
  };
}

// US-9201: what "Import my closet" reads, said before the first run.
//
// Same rule as the per-channel block above: the sentences the seller sees
// come from ONE place, so a test can hold them and a screen cannot quietly
// drop the one that says the read happens in their own signed-in tab.
export const CLOSET_IMPORT_PLATFORMS = ["poshmark", "mercari"] as const;
export type ClosetImportPlatform = (typeof CLOSET_IMPORT_PLATFORMS)[number];

export function closetImportDisclosureFor(
  platform: ClosetImportPlatform,
): MarketplaceDisclosure {
  const label = MARKETPLACE_LABELS[platform];
  return {
    title: `Reads your ${label} closet in your own tab`,
    facts: [
      `Open your own ${label} closet in another tab first. The extension reads the listings on that page when you press Import, and only then. Nothing runs on a schedule and no tab is opened for you.`,
      `It runs in the ${label} tab you are already signed in to. GradeThread's servers never receive your ${label} password or session, and the extension has no permission to read a cookie.`,
      `Per listing it reads the title, description, price, size, brand, your stated condition, the photos and the listing address. It cannot read a buyer's name or address; the field list is fixed in code and the server refuses anything else.`,
      `Photos are copied into your GradeThread storage, never linked from ${label}. Every imported listing counts as a live listing on your plan, the same as a pulled eBay listing.`,
      "Reading a closet twice updates the listings you already have instead of duplicating them. The whole import is one Undo away from the same page.",
    ],
  };
}

