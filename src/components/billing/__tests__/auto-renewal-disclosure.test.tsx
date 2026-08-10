// US-2115: the disclosure has to say five specific things. This asserts the
// rendered text, not the props, because the requirement is about what the user
// can read on the screen.
//
// The five, per California's ARL as amended by AB 2863 (the binding standard,
// and the one that tracks the vacated federal rule most closely):
//   1. it continues until the user cancels
//   2. the recurring amount
//   3. the frequency IN WORDS, not a "/mo" unit
//   4. the first-charge and/or renewal date
//   5. how to cancel
//
// ⚠ The copy under test is NOT counsel-reviewed (US-2114 / this story's AC5).
// When counsel redlines it, these assertions are the checklist the new wording
// still has to satisfy — update the strings, keep the five obligations.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AutoRenewalDisclosure } from "../auto-renewal-disclosure";
import { disclosureSentences, frequencyWord } from "@/lib/auto-renewal-copy";

function html(el: React.ReactElement): string {
  return renderToStaticMarkup(el);
}

describe("AutoRenewalDisclosure", () => {
  it("states all five required elements for a plain monthly purchase", () => {
    const out = html(
      <AutoRenewalDisclosure amountCents={2900} interval="monthly" />,
    );
    expect(out).toContain("$29.00"); // 2: amount
    expect(out).toContain("every month"); // 3: frequency in words
    expect(out).toContain("until you cancel"); // 1: continues until cancelled
    expect(out).toContain("Billing starts today"); // 4: first charge
    expect(out).toMatch(/Cancel any time/i); // 5: how to cancel
  });

  it("says 'every year' for a yearly plan, never a '/yr' unit", () => {
    const out = html(
      <AutoRenewalDisclosure amountCents={29000} interval="yearly" />,
    );
    expect(out).toContain("$290.00");
    expect(out).toContain("every year");
    expect(out).not.toContain("/yr");
    expect(out).not.toContain("/mo");
  });

  it("quotes the yearly total, not a per-month equivalent", () => {
    // The picker DISPLAYS a yearly plan as a per-month figure. The disclosure
    // must state what actually gets charged, which is the annual sum.
    const out = html(
      <AutoRenewalDisclosure amountCents={29000} interval="yearly" />,
    );
    expect(out).toContain("$290.00");
    expect(out).not.toContain("$24.17");
  });

  it("fronts a free trial and names the charge that follows it", () => {
    const out = html(
      <AutoRenewalDisclosure
        amountCents={2900}
        interval="monthly"
        trialDays={14}
      />,
    );
    expect(out).toContain("Free for 14 days");
    expect(out).toContain("$29.00");
    expect(out).toContain("every month");
    // The contradiction guard: a trial must never also claim billing is today.
    expect(out).not.toContain("Billing starts today");
    expect(out).toContain("14-day free trial ends");
  });

  it("prefers a known first-charge date over the described one", () => {
    const out = html(
      <AutoRenewalDisclosure
        amountCents={2900}
        interval="monthly"
        trialDays={14}
        // Midday UTC, deliberately. Dates render in the reader's local zone, so
        // a midnight-UTC fixture would assert a different day depending on
        // where the test runs — the same wall-clock coupling US-2448 removed
        // from the edge suite. Midday lands on one calendar date everywhere
        // from UTC-11 to UTC+12.
        firstChargeOn="2026-08-23T12:00:00.000Z"
      />,
    );
    expect(out).toContain("August 23, 2026");
    expect(out).not.toContain("14-day free trial ends");
  });

  it("states the renewal date for an existing subscriber", () => {
    const out = html(
      <AutoRenewalDisclosure
        amountCents={2900}
        interval="monthly"
        renewsOn="2026-09-01T12:00:00.000Z"
      />,
    );
    expect(out).toContain("Renews on September 1, 2026");
    expect(out).not.toContain("Billing starts today");
  });

  it("honours a non-USD currency", () => {
    const out = html(
      <AutoRenewalDisclosure
        amountCents={2900}
        interval="monthly"
        currency="eur"
      />,
    );
    expect(out).toContain("€29.00");
  });

  it("survives an unparseable date instead of rendering 'Invalid Date'", () => {
    const out = html(
      <AutoRenewalDisclosure
        amountCents={2900}
        interval="monthly"
        renewsOn="not-a-date"
      />,
    );
    expect(out).not.toContain("Invalid Date");
    expect(out).toContain("Billing starts today");
  });

  it("is plain visible text, not a tooltip/accordion/link", () => {
    // AC1 is explicit that the disclosure may not hide behind an interaction.
    const out = html(
      <AutoRenewalDisclosure amountCents={2900} interval="monthly" />,
    );
    expect(out).toMatch(/^<p/);
    expect(out).not.toContain("<button");
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("<details");
    expect(out).not.toContain("aria-expanded");
    expect(out).not.toContain("hidden");
  });

  it("does not claim billing starts today on a plan listing", () => {
    // The marketing pricing page has no CTA — nobody is buying on it, so
    // "Billing starts today" would be false. Caught by reading the actual
    // prerendered HTML, not by review.
    const out = html(
      <AutoRenewalDisclosure
        amountCents={2900}
        interval="monthly"
        billingBegins="on-subscribe"
      />,
    );
    expect(out).not.toContain("Billing starts today");
    expect(out).toContain("Billing starts when you subscribe");
    // The other four elements survive the variant.
    expect(out).toContain("$29.00");
    expect(out).toContain("every month");
    expect(out).toContain("until you cancel");
    expect(out).toMatch(/Cancel any time/i);
  });

  it("a known date still wins over the listing wording", () => {
    const out = html(
      <AutoRenewalDisclosure
        amountCents={2900}
        interval="monthly"
        billingBegins="on-subscribe"
        renewsOn="2026-09-01T12:00:00.000Z"
      />,
    );
    expect(out).toContain("Renews on September 1, 2026");
    expect(out).not.toContain("Billing starts when you subscribe");
  });

  it("frequencyWord maps both intervals to words", () => {
    expect(frequencyWord("monthly")).toBe("month");
    expect(frequencyWord("yearly")).toBe("year");
  });

  it("disclosureSentences is the single place the wording lives", () => {
    // The guard test asserts no surface hand-writes this copy; this asserts the
    // function it must come from actually produces all five elements, so the
    // two halves cannot both pass while the user sees nothing.
    const sentences = disclosureSentences({
      amountCents: 2900,
      interval: "monthly",
    });
    expect(sentences.length).toBeGreaterThanOrEqual(3);
    const joined = sentences.join(" ");
    expect(joined).toContain("$29.00");
    expect(joined).toContain("every month");
    expect(joined).toContain("until you cancel");
    expect(joined).toMatch(/Cancel any time/i);
  });
});
