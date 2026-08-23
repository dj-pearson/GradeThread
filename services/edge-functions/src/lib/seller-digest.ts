// US-2828 AC1/AC4: what goes in a seller's weekly digest, and whether there is
// one at all.
//
// Pure, like seller-anomaly.ts beside it. The job that will read the four
// sources and send the mail is separate, so the EDITORIAL decisions — what
// counts as worth an email, what order it reads in, what a missing section does
// — are testable without a database or a mail transport.
//
// ── THE NO-OP RULE IS THE POINT, NOT A DETAIL ────────────────────────────────
//
// AC4 says the digest is a no-op when the seller has nothing to report. That is
// the difference between a feature and a weekly obligation: a digest that
// arrives every Monday saying "nothing much happened" trains its reader to
// delete it unopened, and then the week something DID happen is deleted too.
//
// So `composeSellerDigest` returns null rather than an empty digest, and null is
// a real outcome the job logs. Callers cannot accidentally send an empty one
// because there is nothing to send.
//
// ── WHAT COUNTS AS "SOMETHING TO REPORT" ─────────────────────────────────────
//
// Not simply "a section produced a value". A scorecard always has a weakest
// metric — that is what a scorecard is — so treating its presence as news would
// make every digest non-empty and quietly delete the no-op rule. The four
// sources split into two kinds:
//
//   NEWS      an anomaly, or money left on the table this week. Something
//             happened, or something is recoverable.
//   CONTEXT   the scorecard gap and the capital-velocity extremes. True every
//             week, useful beside news, not a reason to send on their own.
//
// A digest goes out when there is at least one piece of NEWS. Context rides
// along. That rule is asserted directly rather than left to emerge.

import { describeAnomaly, type SellerAnomaly } from "./seller-anomaly.ts";

export interface ScorecardGap {
  /** Human label, e.g. "Sell-through". */
  metric: string;
  /** 0-100, the seller's standing among comparable sellers. */
  percentile: number;
}

export interface MoneyLeft {
  /** Dollars, this week only. */
  dollars: number;
  /** How many sold items contributed. */
  items: number;
}

export interface VelocityGroup {
  /** e.g. "Nike" or "outerwear". */
  label: string;
  /** Profit per dollar per day held. */
  perDollarPerDay: number;
}

export interface DigestInputs {
  scorecardGap: ScorecardGap | null;
  moneyLeft: MoneyLeft | null;
  bestVelocity: VelocityGroup | null;
  worstVelocity: VelocityGroup | null;
  anomalies: readonly SellerAnomaly[];
}

export interface DigestSection {
  kind: "anomaly" | "money_left" | "scorecard" | "velocity";
  /** One plain sentence. No jargon, no verdict — see seller-anomaly.ts. */
  text: string;
}

export interface SellerDigest {
  /** The single line worth putting in a subject. */
  headline: string;
  sections: DigestSection[];
}

/** Money below this is not worth an email of its own. */
export const MIN_MONEY_LEFT_DOLLARS = 25;

const usd = (n: number): string =>
  n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;

/**
 * The digest, or null when there is nothing worth sending.
 *
 * Order is deliberate and is the reading order: what happened, then what it
 * cost, then where the seller stands, then what is working. A reader who stops
 * after one line has read the most actionable one.
 */
export function composeSellerDigest(input: DigestInputs): SellerDigest | null {
  const sections: DigestSection[] = [];

  // NEWS — anomalies first. They are the only thing here that is time-bound.
  for (const a of input.anomalies) {
    sections.push({ kind: "anomaly", text: describeAnomaly(a) });
  }

  // NEWS — money left on the table, above a floor. A $3 shortfall is true and
  // is not worth anyone's Monday.
  const money = input.moneyLeft;
  const moneyIsNews = money != null && money.dollars >= MIN_MONEY_LEFT_DOLLARS;
  if (moneyIsNews) {
    sections.push({
      kind: "money_left",
      text:
        `${usd(money.dollars)} left on the table across ${money.items} sold ` +
        `${money.items === 1 ? "item" : "items"} this week.`,
    });
  }

  const hasNews = input.anomalies.length > 0 || moneyIsNews;
  if (!hasNews) return null;

  // CONTEXT — only reached when there is news to carry it.
  if (input.scorecardGap) {
    sections.push({
      kind: "scorecard",
      text:
        `${input.scorecardGap.metric} is your weakest number, at the ` +
        `${input.scorecardGap.percentile}th percentile among comparable sellers.`,
    });
  }

  // Both velocity ends in ONE section, because either alone invites the wrong
  // read: a "best" with no "worst" looks like praise, and a "worst" alone looks
  // like a telling-off. The pair is a comparison, which is what it is for.
  if (input.bestVelocity && input.worstVelocity) {
    sections.push({
      kind: "velocity",
      text:
        `${input.bestVelocity.label} returns the most per dollar per day held ` +
        `(${input.bestVelocity.perDollarPerDay.toFixed(3)}); ` +
        `${input.worstVelocity.label} the least ` +
        `(${input.worstVelocity.perDollarPerDay.toFixed(3)}).`,
    });
  }

  return { headline: sections[0]!.text, sections };
}
