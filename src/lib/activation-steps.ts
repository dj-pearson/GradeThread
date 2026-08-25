import {
  Award,
  Bell,
  Chrome,
  KeyRound,
  Package,
  Shirt,
  Store,
  MapPin,
  type LucideIcon,
} from "lucide-react";
import type { UserUseCase } from "@/types/database";

// US-2859. THE SINGLE SOURCE OF TRUTH for "what does a new account still have
// to do". Before this file there were four:
//
//   1. OnboardingFlow          — a four-slide modal tour
//   2. ActivationChecklist     — dashboard: grade / item / eBay / notifications
//   3. the persona first-run card — rendered directly BELOW that checklist,
//      naming a different single first action
//   4. FlipdeskOnboarding      — /flipdesk: source / intake / send to grading
//
// US-1435 had already noticed they collided and sequenced 2 behind 4 for
// resellers. Sequencing is not the fix. A seller still walked three different
// lists, whose first steps were "grade a garment", "grade your first garment"
// and "add your first source", each with its own progress query and its own
// dismissal. There was no answer to "how far through setup am I" because three
// components each had their own.
//
// One list per persona now. Every surface renders FROM HERE.
//
// A step is done when the REAL THING happened -- a grade exists, a source row
// exists, eBay is connected -- never when a button was clicked. That rule
// predates this file (it is why the old checklists ran count queries) and it is
// the reason the list can be shown on more than one surface without them
// disagreeing.

export type ActivationStepKey =
  | "grade"
  | "item"
  | "source"
  | "ebay"
  | "apikey"
  | "notifications"
  // US-2883: the buyer's three, moved here from
  // components/buyer/buyer-first-steps.tsx -- a second 204-line checklist with
  // its own step list, its own count queries and its own localStorage
  // dismissal, which is precisely the duplication US-2859 removed on the
  // seller side and then left standing on the buyer side.
  | "extension"
  | "alert"
  | "closet";

/**
 * Everything any step needs in order to know whether it is done.
 *
 * One shape, resolved once per surface, rather than each card running its own
 * counts -- which is how two cards ended up disagreeing about the same account.
 */
export interface ActivationState {
  gradeCount: number;
  itemCount: number;
  sourceCount: number;
  apiKeyCount: number;
  ebayConnected: boolean;
  notificationsGranted: boolean;
  /** US-2883: buyer signals. Saved searches, closet rows, the extension. */
  alertCount: number;
  closetCount: number;
  extensionInstalled: boolean;
}

export interface ActivationStep {
  key: ActivationStepKey;
  icon: LucideIcon;
  title: string;
  /**
   * One line saying WHY this is worth doing. Not what the button does -- the
   * button already says that. This is the half every one of the four old
   * checklists left out, and it is the half that decides whether somebody
   * bothers.
   */
  reason: string;
  cta: string;
  /**
   * Canonical route. Never a redirect alias (US-2858), checked by
   * src/test/onboarding-copy-routes.test.ts.
   *
   * Undefined means the step is completed in place rather than by navigating --
   * only `notifications`, which asks the browser for permission.
   */
  to?: string;
  isDone: (s: ActivationState) => boolean;
}

const GRADE: ActivationStep = {
  key: "grade",
  icon: Award,
  title: "Grade your first garment",
  reason:
    "Four photos, a few minutes. The grade is what makes a buyer believe your condition claim.",
  cta: "Add photos",
  to: "/dashboard/submissions/new",
  isDone: (s) => s.gradeCount > 0,
};

const ITEM: ActivationStep = {
  key: "item",
  icon: Package,
  title: "Add your first item",
  reason:
    "Track a garment from the day you buy it to the day the payout lands.",
  cta: "Add item",
  to: "/dashboard/flipdesk/intake",
  isDone: (s) => s.itemCount > 0,
};

const SOURCE: ActivationStep = {
  key: "source",
  icon: MapPin,
  title: "Say where your inventory comes from",
  reason:
    "A source is the shop, sale or lot an item came from. It is how you find out which ones make you money.",
  cta: "Add a source",
  to: "/dashboard/flipdesk/sourcing?tab=sources",
  isDone: (s) => s.sourceCount > 0,
};

const EBAY: ActivationStep = {
  key: "ebay",
  icon: Store,
  title: "Connect eBay",
  reason:
    "Listings, orders and payouts sync both ways, so you stop typing everything twice.",
  cta: "Connect",
  to: "/dashboard/flipdesk/marketplaces",
  isDone: (s) => s.ebayConnected,
};

const APIKEY: ActivationStep = {
  key: "apikey",
  icon: KeyRound,
  title: "Create an API key",
  reason:
    "Grade garments straight from your own app. The sandbox costs nothing, so you can build before you buy credits.",
  cta: "Create key",
  to: "/dashboard/developers",
  isDone: (s) => s.apiKeyCount > 0,
};

const NOTIFICATIONS: ActivationStep = {
  key: "notifications",
  icon: Bell,
  title: "Turn on notifications",
  reason:
    "Hear about a sale or a payout when it happens, not the next time you open the app.",
  cta: "Turn on",
  isDone: (s) => s.notificationsGranted,
};

// US-2883: the buyer's three real steps.
//
// They replace US-2859's single `scan` step, which was written
// `isDone: () => false` -- a step nobody can ever complete. That is the exact
// defect US-2553 had already fixed in the buyer's OWN checklist ("Verify a
// certificate cannot complete: /verify is a public marketing page that records
// nothing against an account, so the card would have stayed lit forever"), and
// US-2859 reintroduced it here without knowing that component existed. A
// permanently-lit step is worse than a shorter list: it tells a buyer who has
// done everything that they have done nothing.
//
// Each of these three completes on a real signal.

const EXTENSION: ActivationStep = {
  key: "extension",
  icon: Chrome,
  title: "Get a second opinion",
  reason:
    "The extension shows an objective condition read on any listing you are eyeing, while you are on it.",
  cta: "Get the extension",
  // Resolved at render: the Web Store URL when one is configured, else the
  // settings page. See extensionWebStoreUrl() in src/lib/lister-extension.ts.
  isDone: (s) => s.extensionInstalled,
};

const ALERT: ActivationStep = {
  key: "alert",
  icon: Bell,
  title: "Set a condition alert",
  reason:
    "Snipe on grade, not just price. You hear when a graded item in your size and brands lists.",
  cta: "Create an alert",
  to: "/buyer/alerts",
  isDone: (s) => s.alertCount > 0,
};

const CLOSET: ActivationStep = {
  key: "closet",
  icon: Shirt,
  title: "Save a graded item",
  reason:
    "Verify a certificate and keep it, so the grade and the value travel with the garment.",
  cta: "Verify and save",
  to: "/verify",
  isDone: (s) => s.closetCount > 0,
};

/**
 * Whether the browser can do notifications at all. A step nobody can complete
 * is worse than a shorter list, so it drops out entirely rather than sitting
 * there permanently unchecked.
 */
export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/**
 * The ordered list for a persona.
 *
 * Ordered the way a garment moves, not by how easy each step is: grade, then
 * catalogue, then say where it came from, then connect the channel that sells
 * it. A new seller who follows it top to bottom has done one real cycle.
 */
export function activationStepsFor(
  useCase: UserUseCase | null,
  opts: { notifications?: boolean } = {},
): ActivationStep[] {
  const canNotify = opts.notifications ?? notificationsSupported();
  const tail = canNotify ? [NOTIFICATIONS] : [];

  switch (useCase) {
    case "buyer":
      // No notifications tail: the alert step already asks for the only
      // notification a buyer has a reason to want, and asking twice in one
      // list reads as the list not knowing what it already said.
      return [EXTENSION, ALERT, CLOSET];
    case "developer":
      return [APIKEY, GRADE, ...tail];
    case "consignment":
    case "seller":
    default:
      return [GRADE, ITEM, SOURCE, EBAY, ...tail];
  }
}

/** How many of a persona's steps the account has actually finished. */
export function activationProgress(
  steps: ActivationStep[],
  state: ActivationState,
): { done: number; total: number; firstIncomplete: number } {
  const done = steps.filter((s) => s.isDone(state)).length;
  return {
    done,
    total: steps.length,
    firstIncomplete: steps.findIndex((s) => !s.isDone(state)),
  };
}

/**
 * The state shape with nothing done. Used while the counts are still loading,
 * so a step never renders as complete on the strength of a missing answer.
 */
export const EMPTY_ACTIVATION_STATE: ActivationState = {
  gradeCount: 0,
  itemCount: 0,
  sourceCount: 0,
  apiKeyCount: 0,
  ebayConnected: false,
  notificationsGranted: false,
  alertCount: 0,
  closetCount: 0,
  extensionInstalled: false,
};
