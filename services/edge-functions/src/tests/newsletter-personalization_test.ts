import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  activityTokens,
  buildWeekRecapSection,
  emptyActivity,
  hasActivity,
  personalizeIssueSections,
  type RecipientActivity,
  substituteTokens,
  tailoredCta,
} from "../lib/newsletter-personalization.ts";
import { renderNewsletterHtml } from "../lib/newsletter-issue.ts";

// US-921: the per-recipient personalization logic is PURE (no supabase/env) so it
// tests directly — token substitution, the recap block, the tailored CTA, and the
// non-leaky composed render for a high-activity vs a zero-activity recipient.

const HIGH: RecipientActivity = {
  gradesThisWeek: 5,
  itemsListedThisWeek: 3,
  salesThisWeek: 2,
  slowMovers: 4,
  ungradedItems: 7,
  trialDaysLeft: 2,
  creditsBalance: 12,
};

const baseSections = [
  { heading: "This week", body: "<p>You have {{credits_balance}} credits left.</p>" },
];

Deno.test("substituteTokens replaces known tokens and never leaks 'undefined'", () => {
  const out = substituteTokens("Hi, {{ungraded_items}} waiting, {{missing}} gone", {
    ungraded_items: "7",
  });
  assertEquals(out, "Hi, 7 waiting,  gone");
  // A stray/unknown token collapses to empty — never the literal "undefined".
  assert(!out.includes("undefined"));
});

Deno.test("activityTokens give safe fallbacks for null credits/trial", () => {
  const tokens = activityTokens(emptyActivity());
  assertEquals(tokens.credits_balance, "0"); // null → "0", never "undefined"
  assertEquals(tokens.trial_days_left, ""); // no trial → empty
  for (const v of Object.values(tokens)) assert(!v.includes("undefined"));
});

Deno.test("hasActivity / recap block reflect real activity", () => {
  assert(hasActivity(HIGH));
  assert(!hasActivity(emptyActivity()));
  const recap = buildWeekRecapSection(HIGH);
  assert(recap);
  assertStringIncludes(recap!.body, "graded 5 items");
  assertStringIncludes(recap!.body, "listed 3 items");
  assertStringIncludes(recap!.body, "2 sales");
  // Zero activity ⇒ no recap block.
  assertEquals(buildWeekRecapSection(emptyActivity()), null);
});

Deno.test("tailoredCta prioritizes trial-ending, then ungraded, then slow, then evergreen", () => {
  assertEquals(tailoredCta(HIGH).reason, "trial_ending");
  assertEquals(
    tailoredCta({ ...HIGH, trialDaysLeft: null }).reason,
    "ungraded_items",
  );
  assertEquals(
    tailoredCta({ ...HIGH, trialDaysLeft: null, ungradedItems: 0 }).reason,
    "slow_movers",
  );
  assertEquals(
    tailoredCta({ ...HIGH, trialDaysLeft: null, ungradedItems: 0, slowMovers: 0 }).reason,
    "keep_selling",
  );
  // Zero-activity recipient always lands on the evergreen variant.
  assertEquals(tailoredCta(emptyActivity()).reason, "evergreen");
});

Deno.test("AC5: high-activity vs zero-activity render is correct and non-leaky", () => {
  // High-activity recipient.
  const high = personalizeIssueSections(baseSections, HIGH);
  const highHtml = renderNewsletterHtml(
    { subject: "Weekly", preheader: null, sections: high.sections },
    { unsubscribeUrl: "https://x/u", postalAddress: "Addr" },
  );
  // Recap + tailored CTA present; base copy got the recipient's own credits.
  assertStringIncludes(highHtml, "Your week on GradeThread");
  assertStringIncludes(highHtml, "Your trial ends in 2 days");
  assertStringIncludes(highHtml, "You have 12 credits left.");
  assert(!highHtml.includes("undefined"));
  assert(!highHtml.includes("{{"));

  // Zero-activity recipient: evergreen variant, NO recap, safe credits fallback.
  const zero = personalizeIssueSections(baseSections, emptyActivity());
  const zeroHtml = renderNewsletterHtml(
    { subject: "Weekly", preheader: null, sections: zero.sections },
    { unsubscribeUrl: "https://x/u", postalAddress: "Addr" },
  );
  assert(!zeroHtml.includes("Your week on GradeThread"));
  assertStringIncludes(zeroHtml, "Grade an item");
  assertStringIncludes(zeroHtml, "You have 0 credits left."); // null → "0"
  assert(!zeroHtml.includes("undefined"));
  assert(!zeroHtml.includes("{{"));

  // Privacy: the zero-activity render must NOT contain the high user's numbers.
  assert(!zeroHtml.includes("12 credits"));
  assert(!zeroHtml.includes("Your trial ends"));
  assert(!zeroHtml.includes("waiting to be graded"));
});

Deno.test("null activity is treated as empty (evergreen, no leak)", () => {
  const p = personalizeIssueSections(baseSections, null);
  assertEquals(p.cta.reason, "evergreen");
  assertEquals(p.recap, null);
  assertStringIncludes(p.sections.map((s) => s.body).join(""), "0 credits left.");
});
