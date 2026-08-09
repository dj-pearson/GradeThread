// US-2446: the registry of product analytics events.
//
// `track()` used to take an unconstrained `string`, across 75 call sites and 59
// distinct names, with nothing to stop the same idea being recorded under two
// spellings. This file is the source of truth: an event that is not declared
// here fails `tsc -b` at the call site.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ THERE ARE TWO NAMING CONVENTIONS AND BOTH ARE DECLARED AS THEY EXIST.
//
// 30 names are snake_case (`cert_share`) and 29 are dotted and namespaced
// (`subscription.paused`). The dotted set is not scattered — it covers the money
// surfaces (subscription, plan_picker, credit_pack, trial, upgrade, grade.paid),
// which reads as a convention introduced later and never backfilled.
//
// **NOTHING IS RENAMED HERE, and that is the load-bearing decision.** Every name
// in this file is the name already being emitted. A rename would silently break
// whatever PostHog dashboards, funnels and insights already exist — they match on
// the string, and nobody would see the break until a chart quietly went flat.
// Unifying the conventions may well be right; it is a SEPARATE decision with its
// own migration of the saved queries, not something to smuggle into a registry.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT A NOTE IS FOR. Each entry says what the event OBSERVES, because the name
// alone repeatedly turns out to be ambiguous in the way that matters. The worked
// example is `reward_celebration_shown` (US-1915): it records the client SEEING
// a reward, not the reward being granted — the grant happens on the edge and is
// already in `reputation_events`. A client-side "reward_granted" would
// double-count across tabs and miss anyone who never comes back. The name and
// that fact have to live together or the fact is lost.

import type { BuyerFunnelExit, BuyerFunnelStep } from "./buyer-analytics";

/**
 * Every event emitted with a LITERAL name.
 *
 * Keys are the wire names. Values say what the event observes — present tense,
 * one line, and specific enough to tell it apart from its neighbours.
 */
export const ANALYTICS_EVENTS = {
  // ── Certificates and sharing ──────────────────────────────────────────────
  "cert_view": "A public certificate page was viewed.",
  "cert_share": "The share control on a certificate was used.",
  "cert_print": "A certificate was sent to print.",
  "seller_profile_share": "A seller shared their public profile.",
  "referral_share": "A referral link was copied or shared.",
  "achievement_badge_share": "An earned badge was shared from the rewards surface.",
  "graded_photo_copy": "A graded photo was copied to the clipboard.",
  "graded_photo_download": "A graded photo was downloaded.",

  // ── Free public tools ─────────────────────────────────────────────────────
  "grade_checker_result": "The public grade checker produced a result.",
  "grade_checker_share": "A grade-checker result was shared.",
  "grade_checker_cta_click": "A conversion control on a grade-checker result was pressed.",
  "fit_checker_result": "The public fit checker produced a verdict.",
  "fit_checker_share": "A fit-checker verdict was shared.",
  "authenticity_checker_result": "The public authenticity checker produced a result.",
  "authenticity_checker_cta_click": "A conversion control on an authenticity result was pressed.",
  "verify_lookup": "A certificate id was looked up on the verify page.",

  // ── Garment passport ──────────────────────────────────────────────────────
  "passport_scan_lookup": "A passport code was scanned or looked up.",
  "passport_view_cta_clicked": "The view control on a passport was pressed.",
  "passport_claim_cta_clicked": "The claim control on a passport was pressed.",
  "passport_create_cta_clicked": "The create control on a passport was pressed.",
  "passport_certificate_cta_clicked": "A passport linked through to its certificate.",

  // ── AutoLister ────────────────────────────────────────────────────────────
  "autolister_ai_suggestion": "An AI listing suggestion was offered to the seller.",
  "autolister_autogroup_run": "Auto-grouping was run over a batch.",
  "autolister_group_edit": "A seller edited an auto-produced group.",
  "autolister_grouping_outcome": "The grouping result was accepted or rejected.",
  "measure_correction_saved": "A seller corrected a measurement the model produced.",

  // ── Rewards (US-1915) ─────────────────────────────────────────────────────
  // ⚠ SHOWN, not granted. See the note at the top of this file.
  "reward_celebration_shown":
    "The client DISPLAYED a reward moment — not the grant, which lives on the edge.",
  "reward_celebration_suppressed":
    "Reward moments were detected and the rate limiter dropped them, so the user saw nothing.",

  // ── Cross-surface nudges ──────────────────────────────────────────────────
  "cross_surface_nudge_shown": "A cross-surface nudge was rendered.",
  "cross_surface_nudge_clicked": "A cross-surface nudge was acted on.",
  "cross_surface_nudge_dismissed": "A cross-surface nudge was dismissed.",

  // ── Experiments ───────────────────────────────────────────────────────────
  "experiment_exposed": "A user was exposed to an experiment variant.",

  // ── Money surfaces — the DOTTED convention (see the header) ───────────────
  "plan_picker.opened": "The plan picker was opened.",
  "plan_picker.cta_clicked": "A plan was chosen in the picker.",
  // ⚠ Fires on SIGNUP, for everyone. The 14-day Pro trial is granted by the
  // handle_new_user trigger (US-219), not chosen — so this is NOT a measure of
  // trial intent, and a "trial conversion rate" built on it is really a signup
  // conversion rate wearing a different name.
  "trial.started": "A signup was granted the automatic 14-day Pro trial.",
  "grade.paid": "A grade was paid for.",
  "grade.retake_started": "A retake of a paid grade was started.",
  "grade.pack_upsell_shown": "A credit-pack upsell was rendered after grading.",
  "grade.pack_upsell_converted": "That upsell was taken.",
  "credit_pack.opened": "The credit-pack surface was opened.",
  "credit_pack.cta_clicked": "A credit pack was chosen.",
  "credit_pack.purchased": "A credit pack was bought.",
  "upgrade.trigger.soft": "A soft upgrade prompt fired against a usage cap.",
  "upgrade.trigger.hard": "A hard upgrade block fired at a usage cap.",
  "subscription.upgrade_previewed": "An upgrade's price change was previewed.",
  "subscription.upgrade_confirmed": "An upgrade was confirmed.",
  "subscription.downgrade_previewed": "A downgrade's effect was previewed.",
  "subscription.downgrade_confirmed": "A downgrade was confirmed.",
  "subscription.paused": "A subscription was paused.",
  "subscription.resumed": "A paused subscription was resumed.",
  "subscription.cancel_scheduled": "A cancellation was scheduled.",
  "subscription.cancel_undone": "A scheduled cancellation was reversed.",

  // ── Signup and onboarding ─────────────────────────────────────────────────
  "signup.buyer": "Signup was reached with a buyer intent.",
  "signup.source_selected": "A signup source was chosen.",
  "onboarding.use_case_selected": "A use case was chosen during onboarding.",
  "onboarding.notifications_enabled": "Notifications were enabled from the checklist.",
  "onboarding.activation_checklist_dismissed": "The activation checklist was dismissed.",

  // ── Content studio ────────────────────────────────────────────────────────
  "content.generated": "Content was generated.",
  "content.draft.created": "A content draft was created.",
  "content.published": "Content was published.",
  "topic.researched": "A topic was researched.",

  // ── Buyer feature adoption ────────────────────────────────────────────────
  // One event with a `feature` property rather than one event per feature —
  // adoption is a group-by. See buyer-analytics.ts for why.
  "buyer_feature_used": "A tracked buyer feature was used for the first time this session.",
} as const;

/**
 * The buyer funnel emits one event per step, built from the step name.
 *
 * ⚠ THIS IS THE REASON `AnalyticsEvent` IS NOT SIMPLY `keyof typeof
 * ANALYTICS_EVENTS`. `buyerFunnelEventName()` computes its name, so a plain
 * union of literals would reject a legitimate call site. Expressing the family
 * as a TEMPLATE LITERAL TYPE keeps it enumerable and still rejects a typo:
 * `buyer_funnel_subscribed` type-checks, `buyer_funnel_subscribbed` does not.
 * An escape hatch — a cast, or widening back to `string` — would have given up
 * exactly the property this registry exists to provide.
 */
export type BuyerFunnelEventName = `buyer_funnel_${BuyerFunnelStep | BuyerFunnelExit}`;

/**
 * Every name `track()` accepts.
 *
 * ⚠ The import above is TYPE-ONLY and deliberately so: `buyer-analytics.ts`
 * imports `track` from `analytics.ts`, which imports this file, so a runtime
 * import back would close a module cycle at boot. Type-only imports erase. This
 * is the same call `rewards-economics.ts` documents for the same reason.
 */
export type AnalyticsEvent = keyof typeof ANALYTICS_EVENTS | BuyerFunnelEventName;

/** The literal names, for the drift guard. Not for runtime dispatch. */
export const ANALYTICS_EVENT_NAMES = Object.keys(ANALYTICS_EVENTS) as AnalyticsEvent[];
