// Freshness registry (US-1694): keep platform/fee/policy and year-stamped pages
// current so retrieval engines don't demote stale content.
//
// This is the SINGLE SOURCE for the "Verified {month year}" stamps rendered on
// the protected pages — they are DERIVED from a real re-verification date, not
// hand-typed cosmetically. When you re-check a group against the live platform
// policies/fees, bump its `lastVerified` here and the stamp updates everywhere.
//
// The TRACKED AUTOMATION is the freshness test (freshness.test.ts, run in CI):
// it flags — by failing — any group that has passed its re-verify cadence, which
// is the signal to re-check + bump the date. This ties protected pages into the
// SEO measurement loop (the pages a low-impression prune also watches).
//
// PURE: no imports, no Date/Math.random in the derivations (verifiedLabel parses
// the stored ISO string). overdueGroups() takes the "as of" date as an argument
// so the module itself stays deterministic; the test supplies the real clock.

export type FreshnessGroup =
  | "platform-standards"
  | "comparisons"
  | "crosslisting-apps"
  | "competitor-alternatives"
  | "where-to-sell";

export interface FreshnessEntry {
  /** ISO date (YYYY-MM-DD) of the last human re-verification. Bump on re-check. */
  lastVerified: string;
  /** Re-verify cadence in months: 3 = quarterly (fees/policies), 12 = annual (year-stamped). */
  cadenceMonths: number;
  /** What this group covers (shown in the overdue report). */
  covers: string;
}

export const FRESHNESS_REGISTRY: Record<FreshnessGroup, FreshnessEntry> = {
  "platform-standards": {
    lastVerified: "2026-07-06",
    cadenceMonths: 3,
    covers: "Platform condition-standard pages (/grading/platform-standards/*)",
  },
  comparisons: {
    // 2026-09-05: all five platform fee strings re-read against the platforms'
    // own pages. Two were WRONG, which the previous verification had not caught
    // because both were hedged rather than numeric - see the dated callouts on
    // depop.fees and mercari.fees in comparison-guides.ts.
    lastVerified: "2026-09-05",
    cadenceMonths: 3,
    covers: "Marketplace comparison fee tables (/compare/*)",
  },
  "crosslisting-apps": {
    lastVerified: "2026-07-06",
    cadenceMonths: 3,
    covers: "Best crosslisting apps listicle (/reselling/best-crosslisting-apps)",
  },
  "competitor-alternatives": {
    lastVerified: "2026-07-20",
    cadenceMonths: 3,
    covers: "Competitor alternative pages (/reselling/*-alternative)",
  },
  "where-to-sell": {
    lastVerified: "2026-07-06",
    cadenceMonths: 12,
    covers: "Where-to-sell mega-guide (year-in-title) (/where-to-sell-used-clothes)",
  },
};

export const FRESHNESS_GROUPS = Object.keys(FRESHNESS_REGISTRY) as FreshnessGroup[];

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Parse a YYYY-MM-DD string into numeric parts (no Date — deterministic). */
function parseISO(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map((n) => Number(n));
  return { y: y ?? 0, m: m ?? 0, d: d ?? 0 };
}

/** Month index since year 0 (year*12 + month-1), for cadence comparison. */
function monthIndex(iso: string): number {
  const { y, m } = parseISO(iso);
  return y * 12 + (m - 1);
}

/** The rendered "Verified {Month Year}" stamp for a group, from its real re-check date. */
export function verifiedLabel(group: FreshnessGroup): string {
  const { y, m } = parseISO(FRESHNESS_REGISTRY[group].lastVerified);
  return `${MONTHS[m - 1] ?? "?"} ${y}`;
}

/** Month index at which a group next falls due for re-verification. */
export function dueMonthIndex(group: FreshnessGroup): number {
  return monthIndex(FRESHNESS_REGISTRY[group].lastVerified) + FRESHNESS_REGISTRY[group].cadenceMonths;
}

/** True when the group is due (or past due) for re-verification as of `asOfISO`. */
export function isOverdue(group: FreshnessGroup, asOfISO: string): boolean {
  return monthIndex(asOfISO) >= dueMonthIndex(group);
}

/** Every group due (or past due) for re-verification as of `asOfISO`. */
export function overdueGroups(asOfISO: string): FreshnessGroup[] {
  return FRESHNESS_GROUPS.filter((g) => isOverdue(g, asOfISO));
}
