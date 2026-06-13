-- US-844: launch wiring for the AI Support Assistant (EPIC: AI Support Assistant).
--
-- Two things ship here, both idempotent:
--   1. The `support_assistant` feature flag — the single launch kill-switch the
--      engine (loadGateAndDecide) and the widget (GET /eligibility) both read via
--      support-assistant-config.ts. Seeded enabled=FALSE so the assistant stays
--      fully off until an operator flips it on at launch; a partial merge can
--      never expose the bot in prod. The edge reads it FAIL-CLOSED, so even a
--      missing row or a DB blip keeps it off.
--   2. The initial published KB corpus — the ONLY system-side knowledge the
--      assistant may answer product questions from (US-830/833). Covers the
--      grading scale + tiers + factors, reading a grade report, photo
--      requirements, plans/caps, disputes, FlipDesk basics, and a billing/account
--      FAQ. ON CONFLICT (slug) DO NOTHING so re-running never clobbers later edits.

-- ── 1. Launch kill-switch (OFF by default) ──────────────────────────────────
insert into public.feature_flags (key, enabled, description) values
  ('support_assistant', false,
   'AI Support Assistant (US-844). OFF until launch; flip enabled=true to turn on. Read fail-closed by the edge.')
on conflict (key) do nothing;

-- ── 2. Seed published KB articles ────────────────────────────────────────────
insert into public.support_kb_articles (slug, title, body_md, category, audience, is_published)
values
(
  'grading-scale-tiers-factors',
  'How GradeThread grading works: the 1.0–10.0 scale, tiers, and factors',
  $kb$
GradeThread scores condition on a **1.0–10.0 scale in half-point increments**. A higher number means better condition.

## Condition tiers

| Grade | Tier | Meaning |
|---|---|---|
| 10 | NWT | New with tags |
| 9 | NWOT | New without tags |
| 8 | Excellent | Worn lightly, no notable flaws |
| 7 | Very Good | Minor wear, fully usable |
| 6 | Good | Visible wear, no major issues |
| 5 | Fair | Noticeable flaws |
| 3–4 | Poor | Significant flaws or damage |

## The five factors

Each grade is a weighted blend of five factors:

- **Fabric Condition (30%)** — pilling, fading, thinning, stains, holes.
- **Structural Integrity (25%)** — seams, hems, fabric strength.
- **Cosmetic Appearance (20%)** — overall look, wrinkles, presentation.
- **Functional Elements (15%)** — zippers, buttons, snaps, closures.
- **Odor & Cleanliness (10%)** — smells, residue, general cleanliness.

## Confidence

Every grade includes a **confidence score (0.0–1.0)**. When confidence falls **below 0.75**, the submission is routed for human review before the grade is finalized, so low-confidence results aren't published automatically.
  $kb$,
  'grading', 'public', true
),
(
  'reading-your-grade-report',
  'How to read your grade report',
  $kb$
Your grade report turns the photos you uploaded into a standardized condition assessment you can share with buyers.

## What's in the report

- **Overall grade (1.0–10.0)** and the matching condition tier (e.g. "Very Good").
- **Factor breakdown** — the score for each of the five factors (fabric, structural, cosmetic, functional, odor & cleanliness) so buyers see *why* the item scored the way it did.
- **Condition notes** — specific observations the grader made (e.g. "light pilling on the left cuff").
- **Confidence** — how certain the grade is. Reports under 0.75 confidence are reviewed by a human before they're finalized.
- **Certificate** — a shareable, public certificate link you can include in any listing.

## Sharing a certificate

Open the submission, then use the certificate link. Anyone with the link can view the grade and notes — no account needed — which is what makes it useful to drop into a marketplace listing.
  $kb$,
  'grading', 'public', true
),
(
  'photo-requirements',
  'Photo requirements for accurate grading',
  $kb$
Good photos are the single biggest driver of an accurate, high-confidence grade.

## Required photos

- **Front** — the full front of the garment, flat or on a form.
- **Back** — the full back.
- **Label** — the brand/size/care label, in focus.
- **At least one detail** — a close-up of fabric, stitching, or a key area.

## Optional photos

- A **second detail** shot.
- Up to **three defect shots** — close-ups of any flaws (stains, holes, pilling, broken hardware). Showing defects clearly *helps* — the grader accounts for them instead of guessing.

## Tips for the best result

- Shoot in bright, even light; avoid harsh shadows.
- Use a plain, contrasting background.
- Fill the frame and keep the item in focus.
- Capture defects up close so they're unmistakable.

Missing or low-quality photos lower the confidence score and can trigger a human review.
  $kb$,
  'photos', 'public', true
),
(
  'plans-pricing-and-limits',
  'Plans, pricing, and usage limits',
  $kb$
GradeThread offers a Free tier and three paid plans — **Starter, Pro, and Business** — with increasing monthly grading allowances and FlipDesk capabilities.

## How limits work

- Each plan includes a monthly allowance of grades and FlipDesk features.
- When you approach a cap you'll see a soft warning; when you hit it, grading is paused until the next cycle, you buy additional credits, or you upgrade.
- **Business** is the top tier and gets the highest limits and priority handling.

## What's included where

- The **AI support assistant** (this chat) is included on the paid plans.
- FlipDesk listing, sourcing, and reconciliation features scale up with the plan.

For exact current prices, allowances, and to change your plan, open **Billing** in your dashboard — it always shows your live plan, usage against your caps, and upgrade options.
  $kb$,
  'plans', 'public', true
),
(
  'how-disputes-work',
  'How grade disputes work',
  $kb$
If you believe a grade doesn't reflect an item's true condition, you can open a **dispute**.

## Opening a dispute

1. Open the submission and start a dispute from the grade report.
2. Explain what you think is wrong and add any extra photos that support your case.

## What happens next

- A reviewer re-examines the original photos, your notes, and any new evidence.
- The grade is either **upheld** or **adjusted**, and you'll be notified of the outcome.
- If the grade is adjusted, the report and its certificate are updated to match.

Clear, well-lit photos of the area in question give a dispute the best chance of a quick, accurate resolution.
  $kb$,
  'disputes', 'public', true
),
(
  'flipdesk-basics',
  'FlipDesk basics: from sourcing to sold',
  $kb$
**FlipDesk** is GradeThread's reseller workspace. It manages the full eBay lifecycle for your inventory.

## The pipeline

Items move through these stages:

**source → catalog → measure → photograph → grade → comp → draft → list → sell → ship → reconcile**

- **Sources** — record where (and for how much) you bought items, so your profit math is accurate.
- **Catalog & measure** — capture item details and measurements.
- **Photograph & grade** — add listing photos and a GradeThread condition grade.
- **Comp** — pull comparable sold prices to set a competitive price.
- **Draft & list** — generate an eBay listing and publish it.
- **Sell, ship, reconcile** — track the sale, then reconcile payouts against fees and costs to see true profit.

## Connecting eBay

Connect your eBay account from the **Marketplaces** screen. Once connected, FlipDesk can create and publish listings and pull comps on your behalf.

You'll find FlipDesk under **FlipDesk** in the dashboard sidebar.
  $kb$,
  'flipdesk', 'public', true
),
(
  'billing-and-payments-faq',
  'Billing & payments FAQ',
  $kb$
## Where do I manage billing?

Open **Billing** in your dashboard. It shows your current plan, usage against your caps, and options to upgrade, downgrade, or update your payment method.

## How do I change or cancel my plan?

Use the plan controls on the Billing page. Upgrades take effect immediately; downgrades and cancellations apply at the end of the current billing period, so you keep access you've already paid for.

## My payment failed — what now?

Update your card on the Billing page. We retry failed payments for a short grace period; if it isn't resolved, paid features (including this assistant) pause until billing is current.

## Do you offer refunds?

Refund eligibility depends on your plan and timing. If you think you were charged in error, ask here and I can connect you with a human who can review your account.

## Can I buy extra grading credits?

Yes — if you hit your plan's monthly cap you can purchase additional credits without changing plans. Look for the credits option on the Billing page.
  $kb$,
  'billing', 'subscriber', true
),
(
  'account-and-access-faq',
  'Account & access FAQ',
  $kb$
## How do I reset my password?

Use **Forgot password** on the login screen, or change it from **Settings** while signed in.

## I signed up but can't log in.

If you signed up with email and password, check for a confirmation email and confirm your address first. If you signed up with Google, use the **Continue with Google** button rather than a password.

## How do I update my profile or email?

Open **Settings** to update your profile details.

## Team / workspace access

Workspace members access the owner's data according to their role. Billing and plan limits are tied to the workspace owner's account.

## Something else?

If you're locked out or can't access part of your account, ask here — I'll help where I can and connect you with a human if needed.
  $kb$,
  'account', 'subscriber', true
)
on conflict (slug) do nothing;
