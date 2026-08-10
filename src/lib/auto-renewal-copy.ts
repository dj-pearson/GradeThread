import type { BillingInterval } from "@/types/database";

// US-2115: the auto-renewal disclosure WORDING, and nothing else.
//
// ⚠ COPY IS PENDING COUNSEL REVIEW (US-2114, this story's AC5). The strings
// below were NOT written by counsel. They ship because the alternative was
// shipping nothing, and no disclosure at all is the actual exposure the audit
// found — but they live alone in this file so a redline lands in one function
// and no purchase surface has to be revisited. Do not scatter renewal wording
// back into the surfaces; src/test/subscription-disclosure-coverage.test.ts
// fails if you do.
//
// WHAT THE COPY HAS TO CONTAIN, designed to California's ARL as amended by
// AB 2863 because that is the binding standard today and it tracks the vacated
// federal rule closely:
//   1. that the subscription continues until the user cancels
//   2. the recurring amount
//   3. the billing frequency IN WORDS, not just a "/mo" unit label
//   4. the date of the first charge and/or the renewal date
//   5. how to cancel
// Dropping any one of the five fails the tests in
// src/components/billing/__tests__/auto-renewal-disclosure.test.tsx.

export interface AutoRenewalTerms {
  /** Recurring amount in cents, charged at `interval`. */
  amountCents: number;
  /** Billing frequency. Rendered as a word, never as a "/mo" unit. */
  interval: BillingInterval;
  /** ISO 8601. When the first charge is NOT today — i.e. a free trial. */
  firstChargeOn?: string | null;
  /** ISO 8601. When an existing paid period renews. */
  renewsOn?: string | null;
  /** Length of a free trial preceding the first charge, in days. */
  trialDays?: number | null;
  /** ISO 4217. Defaults to USD, the only currency the plan configs model. */
  currency?: string;
  /**
   * When billing begins, for the case where no date is known.
   *
   * "immediate" (default) is the checkout case: the user is buying now.
   * "on-subscribe" is a plan LISTING — the marketing pricing page, where there
   * is no CTA and nobody is purchasing. Saying "Billing starts today" there
   * would be plainly false, which is its own disclosure problem.
   */
  billingBegins?: "immediate" | "on-subscribe";
}

function money(cents: number, currency = "usd"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

function dateLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  // A bad or missing date must degrade to the "Billing starts today" branch
  // rather than printing "Invalid Date" into a legal disclosure.
  if (Number.isNaN(d.getTime())) return null;
  // Deliberately the READER'S local timezone, not UTC: this sentence answers
  // "when will my card be charged", and the answer a person can check against
  // their own calendar is the local one. Every date reaching here is a real
  // Stripe instant (period_end / next_renewal_at), never a date-only midnight
  // value, so local rendering cannot shift it onto the wrong day.
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** "month" / "year" — the frequency stated in words, per item 3 above. */
export function frequencyWord(interval: BillingInterval): string {
  return interval === "yearly" ? "year" : "month";
}

/**
 * The disclosure sentences. Exported so the tests assert the REAL strings
 * rather than a restatement of them.
 */
export function disclosureSentences({
  amountCents,
  interval,
  firstChargeOn,
  renewsOn,
  trialDays,
  currency,
  billingBegins = "immediate",
}: AutoRenewalTerms): string[] {
  const amount = money(amountCents, currency);
  const every = frequencyWord(interval);
  const firstCharge = dateLabel(firstChargeOn);
  const renews = dateLabel(renewsOn);

  const sentences: string[] = [];

  // Items 1 + 2 + 3 in one sentence, with the trial fronted when there is one
  // so the "free" and the charge that follows it are never separated.
  if (trialDays && trialDays > 0) {
    sentences.push(
      `Free for ${trialDays} days, then ${amount} every ${every} automatically until you cancel.`,
    );
  } else {
    sentences.push(`${amount} every ${every} automatically until you cancel.`);
  }

  // Item 4. Order matters: a known date beats a described one, and the trial
  // case MUST be checked before the fallback — a surface that knows a trial
  // applies but not the exact date would otherwise say "Free for 14 days" and
  // "Billing starts today." in the same breath, which is a contradiction the
  // disclosure exists to prevent.
  if (firstCharge) {
    sentences.push(`Your first charge is on ${firstCharge}.`);
  } else if (trialDays && trialDays > 0) {
    sentences.push(`Your first charge is when the ${trialDays}-day free trial ends.`);
  } else if (renews) {
    sentences.push(`Renews on ${renews}.`);
  } else if (billingBegins === "on-subscribe") {
    sentences.push("Billing starts when you subscribe.");
  } else {
    sentences.push("Billing starts today.");
  }

  // Item 5.
  sentences.push("Cancel any time in Settings, under Billing.");

  return sentences;
}
