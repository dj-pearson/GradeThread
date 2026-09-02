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
import type {
  ActivationFunnelExit,
  ActivationFunnelStep,
} from "./activation-analytics";

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
  "rn_lookup_searched": "Someone looked up a registered identification number.",
  "rn_tag_read": "The free tag reader read a care label.",
  "rn_lookup_cta_click": "A conversion control below an RN lookup answer was pressed.",
  "fit_checker_result": "The public fit checker produced a verdict.",
  "fit_checker_share": "A fit-checker verdict was shared.",
  "authenticity_checker_result": "The public authenticity checker produced a result.",
  "authenticity_checker_cta_click": "A conversion control on an authenticity result was pressed.",
  "verify_lookup": "A certificate id was looked up on the verify page.",
  // US-2750: a reseller typed a Lululemon style code into the public lookup.
  // The event that says whether the pSEO surface is reaching the audience it
  // was built for.
  "style_code_lookup": "A Lululemon style code was looked up on /style.",
  "style_code_submission": "A visitor told us what an unnamed Lululemon style code is.",

  // ── Closet import (US-9201) ───────────────────────────────────────────────
  // The switching-cost gap: a seller with a full Poshmark or Mercari closet
  // will not move without bringing it. `closet_import_started` is the press;
  // `closet_import_completed` is the run finishing, with `inserted`, `updated`
  // and `platform`. `closet_import_first_item` fires ONCE per account, the
  // first time a closet import creates an item, and carries
  // `seconds_since_extension_install` (from the extension's own install
  // timestamp, which otherwise never leaves the device). That number is the
  // install-to-first-imported-item time the activation funnel reads; it is a
  // duration, never a timestamp, so it cannot be joined back to an install.
  "closet_import_started": "The seller pressed Import my closet. Property `platform`.",
  "closet_import_completed":
    "A closet import run finished. Properties `platform`, `status`, `inserted`, `updated`, `failed`.",
  "closet_import_first_item":
    "A closet import created this account's first imported item. Property `seconds_since_extension_install`.",

  // ── Review flow (US-9204) ─────────────────────────────────────────────────
  // The hours-saved number. `seconds_from_first_photo` is the time between the
  // first photo (the file's capture time, else the moment it was staged) and
  // the Approve press; `channels_now` and `channels_queued` are counts. A
  // duration and two counts, never an item id, so nothing here joins back to a
  // seller's inventory.
  "review_approved":
    "Approve was pressed on the one-screen review. Properties `seconds_from_first_photo`, `channels_now`, `channels_queued`, `source`.",

  // ── Extension install funnel (US-9210) ────────────────────────────────────
  // The click on an install call to action on the site. The install itself is
  // a store-side fact; the join to a signup rides the campaign tag on the
  // extension's first-run page (vault/40-growth/extension-funnel-attribution.md).
  // Properties `page` (the path the CTA was on) and `store` (chrome | firefox).
  "extension_install_cta_click":
    "An install call to action for the browser extension was pressed. Properties `page`, `store`.",

  // ── Marketplace comparison handoff (US-9018) ──────────────────────────────
  // The two migration sections on /compare/{a}-vs-{b} answer "how do I move my
  // listings from X to Y" — 13 queries and 202 impressions of intent that had
  // no next step. This records the click on that next step, NOT the migration
  // happening. Properties are `source` (the comparison slug) and `destination`,
  // the same pair US-9010 uses for the calculator handoff, so both funnels read
  // off one property shape.
  "comparison_crosslist_cta_click":
    "A comparison page handed off to the FlipDesk crosslisting page.",

  // ── Calculator handoff (US-9006, extended by US-9010) ─────────────────────
  // The profit calculator is the only one of the family with a condition axis,
  // which makes "grade this item" its natural next step rather than an advert
  // bolted on. This records the CLICK on that step, not a grade being bought;
  // the grade itself is already recorded server-side by `grade.paid`.
  // Properties are `source` (the calculator slug) and `destination`, the same
  // pair `comparison_crosslist_cta_click` uses, so the two funnels read off one
  // property shape.
  "calculator_grading_cta_click":
    "A calculator handed off to the grading flow.",

  // ── Calculator funnel (US-9010) ───────────────────────────────────────────
  // Four steps, and the first is the denominator. A funnel built only from
  // clicks answers "how many clicked" and never "out of how many", which is
  // the question the story actually asks: acquisition channel, or just traffic.
  //
  // `calculator_used` is deliberately NOT the same as a view. It fires once, on
  // the first input change, so "landed and read the tables" can be told apart
  // from "landed and computed something". Every event carries `calculator`.
  //
  // signup_started_from_tool exists because the handoff does not go straight to
  // signup — it goes to the matching FlipDesk surface, and without carrying the
  // slug across that hop the signup is attributed to the landing page and the
  // calculator that produced it disappears.
  "calculator_view": "A calculator page was loaded. Property `calculator` is the slug.",
  "calculator_used": "A calculator input was changed for the first time this visit.",
  "calculator_cta_clicked": "A calculator handed off to its matching FlipDesk surface.",
  "signup_started_from_tool":
    "Signup was started from a FlipDesk page the visitor reached from a calculator.",
  // US-9022. The download IS the tool on /tools/reseller-inventory-spreadsheet,
  // so `calculator_used` alone would report every visitor as having used it.
  // This separates reading the column guide from taking the file.
  "inventory_template_downloaded":
    "The free reseller inventory spreadsheet was downloaded. Property `slug` is the tool.",

  // ── Commercial landing funnel (US-9009) ───────────────────────────────────
  // The funnel is: calculator view -> landing page view -> signup start.
  // `calculator_grading_cta_click` (US-9006) is the other exit from step one.
  //
  // WHY THESE ARE JUDGED ON CONVERSION AND NOT POSITION: combined volume on the
  // five commercial terms is 2,200/mo and the SERP is held by independent
  // listicles a vendor page cannot outrank. The job of these pages is to catch
  // traffic that already arrived from the calculators, so the number that
  // matters is what share of them starts a signup.
  "commercial_landing_view":
    "A FlipDesk commercial landing page was viewed. Property `landing` is the slug.",
  "commercial_landing_signup_start":
    "The primary call to action on a FlipDesk commercial landing page was pressed.",
  "crosslist_listicle_vendor_handoff":
    "The crosslisting listicle handed off to the FlipDesk crosslisting page.",

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
  "reward_card_share":
    "A badge or level card was actually shared or copied — the client half of the K-factor numerator.",
  "reward_card_share_dismissed":
    "The share sheet for a reward card was opened and backed out of, which is NOT a share.",

  // ── Cross-surface nudges ──────────────────────────────────────────────────
  "cross_surface_nudge_shown": "A cross-surface nudge was rendered.",
  "cross_surface_nudge_clicked": "A cross-surface nudge was acted on.",
  "cross_surface_nudge_dismissed": "A cross-surface nudge was dismissed.",

  // ── Experiments ───────────────────────────────────────────────────────────
  //
  // US-2361 (2026-08-15): `experiment_exposed` is GONE, with the client
  // experiment layer that emitted it. It was the only emitter, and this
  // registry's own guard — no declared entry may sit unemitted — is what caught
  // the leftover the moment the code went. Re-add it with the hook if the layer
  // is ever revived; vault/40-growth/experimentation.md keeps the reasoning,
  // including why exposure rather than evaluation is the event to analyse on.

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
  // GT-001: the verify-email funnel. Signup was already observable and
  // verification was not, so "people sign up and never come back" could be
  // stated but not located. These four are the steps between the two, and each
  // records the CLIENT reaching a state — a person who never opens the mail
  // emits none of them, which is itself the answer when the counts collapse
  // between `signup.confirm_sent` and `signup.email_verified`.
  "signup.confirm_sent": "The check-your-email screen was shown after signup.",
  "signup.confirm_resend": "A confirmation email was requested again.",
  "signup.email_verified": "An email confirmation completed and a session exists.",
  "signup.verify_failed": "An email confirmation attempt failed; `reason` says how.",
  "onboarding.use_case_selected": "A use case was chosen during onboarding.",
  "onboarding.notifications_enabled": "Notifications were enabled from the checklist.",
  "onboarding.activation_checklist_dismissed": "The activation checklist was dismissed.",
  // US-2859: which step a user actually reached for, from whichever surface
  // was showing the one checklist. The full funnel is US-2884's job; this is
  // the event that story will build on.
  "onboarding.activation_step_started":
    "An activation-checklist step's button was pressed.",
  // US-2884: the tour's two endings, which nothing recorded. Without them
  // "tour finished" and "tour skipped" were indistinguishable from "never
  // reached the tour".
  "onboarding.tour_finished": "The first-run tour reached its last slide.",
  "onboarding.tour_skipped": "The first-run tour was skipped.",

  // ── Content studio ────────────────────────────────────────────────────────
  "content.generated": "Content was generated.",
  "content.draft.created": "A content draft was created.",
  "content.published": "Content was published.",
  "topic.researched": "A topic was researched.",

  // ── Help center (US-2592) ─────────────────────────────────────────────────
  //
  // ⚠ THESE EVENTS SEE ONLY THE REACT APP, AND THAT IS THE MOST IMPORTANT THING
  // TO KNOW ABOUT THEM. Every PUBLIC help URL is server-rendered by a Pages
  // Function and the app never mounts on it, so posthog-js is not there. A "top
  // articles" chart built from `help_article_view` is a chart of in-app reading,
  // not of the organic traffic the help centre exists to earn — that number is
  // counted server-side into help_article_views and shown in the admin report.
  // The two are reported side by side and must never be summed.
  "help_article_view": "A help article was opened INSIDE the app (SPA route or in-app reader).",
  "help_search": "A help search ran and returned at least one hit.",
  "help_search_zero_results":
    "A help search returned nothing — the backlog signal, also recorded in help_search_misses.",
  "help_feedback_vote": "A reader voted on whether an article helped.",
  "help_deflection":
    "The support form was left without a ticket after a suggested article was opened.",
  "help_contextual_open": "A contextual help sheet was opened from a product surface.",
  // US-2864: which invented word a user actually stopped to look up. The only
  // direct measure of which of our nouns are not carrying their meaning.
  "help_term_open": "A product-term definition popover was opened.",

  // ── Dashboard widget board (US-3074) ──────────────────────────────────────
  // A board layout is per-user rows in dashboard_layouts, so the SAVED shape is
  // knowable server-side at any time; what is not knowable is how it got there.
  // These four record the editing, not the state. `dashboard_layout_saved`
  // carries four counters rather than firing four events because one Done press
  // is one decision, and the question it answers is which of the four affordances
  // sellers actually use — reorder is the expensive one to build and the easiest
  // to be wrong about.
  //
  // The add and hide events fire on the EDIT, before Done, so a seller who adds
  // a widget and then cancels is still counted as having wanted it. That is the
  // number worth having: what the catalog gets asked for, not what survived.
  "dashboard_layout_saved":
    "Customize mode was saved with Done; counts the edits made in that one pass.",
  "dashboard_layout_reset": "A board was put back to its persona default in Customize mode.",
  "dashboard_widget_added": "A widget was picked from the Add-widget catalog (before Done).",
  "dashboard_widget_hidden": "A widget was hidden from a board in Customize mode (before Done).",

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
 * US-2884: the activation funnel, the same way and for the same reason.
 *
 * `activationEventName()` computes its name from the ordered step list in
 * activation-analytics.ts, so this is a template-literal family too.
 * `activation_first_grade` type-checks; `activation_first_grad` does not.
 */
export type ActivationEventName =
  `activation_${ActivationFunnelStep | ActivationFunnelExit}`;

/**
 * Every name `track()` accepts.
 *
 * ⚠ The import above is TYPE-ONLY and deliberately so: `buyer-analytics.ts`
 * imports `track` from `analytics.ts`, which imports this file, so a runtime
 * import back would close a module cycle at boot. Type-only imports erase. This
 * is the same call `rewards-economics.ts` documents for the same reason.
 */
export type AnalyticsEvent =
  | keyof typeof ANALYTICS_EVENTS
  | BuyerFunnelEventName
  | ActivationEventName;

/** The literal names, for the drift guard. Not for runtime dispatch. */
export const ANALYTICS_EVENT_NAMES = Object.keys(ANALYTICS_EVENTS) as AnalyticsEvent[];
