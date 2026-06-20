-- US-939: Phase 1 in-trial ACTIVATION sequence (days 0–6).
--
-- The trial-conversion campaign graph (00255 → 00269 → 00270) carried a thin
-- early in-trial run: welcome (day 0) → a single "tips" touch (day 3) → the
-- Phase-2 conversion-push (recap, day 7+). This migration replaces that thin
-- early run with the full first-week activation sequence that gets a new
-- trialist to value fast, then hands off to the (unchanged) Phase-2 recap:
--
--   • Day 0 (enrollment + 0)    welcome          — warm welcome + grade-your-
--            first-item CTA (deep-links into /dashboard/submissions/new).
--   • Day 1 (enrollment + 24h)  day1_first_grade — first-grade nudge. Sends ONLY
--            while they have NOT graded yet (`gradesCount is_false`); once the
--            first grade exists the step is SKIPPED (not the journey).
--   • Day 2 (enrollment + 48h)  day2_value       — "how grading lifts resale
--            price" value email, gated on the first grade having happened
--            (`gradesCount gte 1`) — the first_grade event, expressed as state.
--   • Day 3 (enrollment + 72h)  day3_education   — accurate listing-management
--            education (deep-links into FlipDesk). Branch: a 3-day inactivity
--            nudge if the trialist has gone quiet (see below).
--   • Day 5 (enrollment + 120h) day5_social      — social-proof + a feature
--            highlight, then on to the Phase-2 recap (day 7).
--
--   • inactivity_nudge (enrollment + 96h) — fires ONLY when the trialist has had
--            no real activity for 3+ days (`daysSinceActive gte 3`, derived in
--            the engine from their latest grade/listing/sale, anchored to signup
--            for a never-active user). Reached via a branch off day3_education;
--            its `next` rejoins the main timeline at day5_social so the nudge is
--            INSERTED without breaking the sequence. The branch re-evaluates each
--            tick, so a reactivated user is routed straight to day5_social and
--            never sees it.
--
-- Every step gates on `converted = is_false`, so a conversion at ANY point skips
-- all further sends and the engine exits the journey instantly (routes/drip.ts).
-- Consent (US-911), suppression (US-914), CAN-SPAM unsubscribe and the frequency
-- cap are enforced universally at dispatch. CTAs deep-link into the exact next
-- action with UTM tracking (utm_source=drip…), and copy is personalized
-- ({{firstName}}, {{gradesCount}}) with safe fallbacks.
--
-- The Phase-2 / win-back tail (recap … win_back_final) is carried through
-- BYTE-IDENTICAL to 00270 — this migration only rewrites the early run.
--
-- Idempotent + non-clobbering: only the recognizable 00270-shape graph (has
-- `recap`, lacks `day1_first_grade`) is rewritten. Once the activation steps
-- exist — or an operator has edited the graph in the builder — this is a no-op.

BEGIN;

UPDATE public.drip_campaigns
SET graph = $json$
{
  "entryStepId": "welcome",
  "steps": [
    {
      "id": "welcome",
      "label": "Day 0 — welcome + grade your first item",
      "phase": "in_trial",
      "trigger": "trial_started",
      "anchor": "enrollment",
      "delayHours": 0,
      "conditions": [],
      "brief": "Warm welcome on signup. One clear CTA: upload your first garment and get a standardized condition grade in minutes. No card on file — reassure them the trial is free. Deep-link straight to the new-submission flow.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "day1_first_grade",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Welcome to GradeThread, {{firstName}} — let's grade your first item",
          "html": "<p>Hi {{firstName}},</p><p>Your free trial is live — no card needed. Upload a garment and get a standardized condition grade (and a shareable certificate) in minutes.</p><p><a href=\"https://gradethread.com/dashboard/submissions/new?utm_source=drip&utm_medium=email&utm_campaign=trial_conversion&utm_content=welcome\">Grade your first item</a></p>"
        }
      ]
    },
    {
      "id": "day1_first_grade",
      "label": "Day 1 — grade your first item (no grade yet)",
      "phase": "in_trial",
      "trigger": "day1_no_first_grade",
      "anchor": "enrollment",
      "delayHours": 24,
      "conditions": [
        { "field": "converted", "op": "is_false" },
        { "field": "gradesCount", "op": "is_false" }
      ],
      "brief": "Gentle day-1 nudge for a trialist who hasn't graded anything yet. No guilt — make the first grade feel effortless (four photos: front, back, label, a detail) and show the payoff. Skipped automatically once they've graded their first item. One low-friction CTA into the new-submission flow.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "day2_value",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "{{firstName}}, your first grade takes about 5 minutes",
          "html": "<p>Hi {{firstName}},</p><p>Ready to see GradeThread in action? Snap four photos — front, back, label, and a detail — and you'll get a standardized 1.0–10.0 condition grade plus a shareable certificate buyers trust.</p><p><a href=\"https://gradethread.com/dashboard/submissions/new?utm_source=drip&utm_medium=email&utm_campaign=trial_conversion&utm_content=day1_first_grade\">Grade your first item</a></p>"
        }
      ]
    },
    {
      "id": "day2_value",
      "label": "Day 2 — how grading lifts resale price",
      "phase": "in_trial",
      "trigger": "first_grade",
      "anchor": "enrollment",
      "delayHours": 48,
      "conditions": [
        { "field": "converted", "op": "is_false" },
        { "field": "gradesCount", "op": "gte", "value": 1 }
      ],
      "brief": "Value email triggered by their first grade (only sends once gradesCount >= 1). Connect grading to outcomes grounded in real platform capabilities: a standardized, certified condition grade sets buyer expectations, builds trust, and helps items sell faster and at better prices. Reference how many they've graded so far. CTA: grade another item.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "day3_education",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Nice work, {{firstName}} — here's what a grade does for your price",
          "html": "<p>Hi {{firstName}},</p><p>You've graded <strong>{{gradesCount}}</strong> item(s) so far — here's why that matters. A standardized condition grade and a shareable certificate set clear buyer expectations up front: that's how sellers build trust, cut 'what condition is it really?' questions, and move items faster.</p><p><a href=\"https://gradethread.com/dashboard/submissions/new?utm_source=drip&utm_medium=email&utm_campaign=trial_conversion&utm_content=day2_value\">Grade another item</a></p>"
        }
      ]
    },
    {
      "id": "day3_education",
      "label": "Day 3 — accurate listing management",
      "phase": "in_trial",
      "trigger": "day3_education",
      "anchor": "enrollment",
      "delayHours": 72,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Education on accurate listing management in FlipDesk: turn a graded item into a clean, accurate listing — measurements, condition grade, photos — so buyers know exactly what they're getting. Grounded only in real FlipDesk capabilities. CTA into FlipDesk. Branch: if the trialist has been inactive for 3+ days, route to the inactivity nudge first.",
      "incentiveEnabled": false,
      "branches": [
        { "conditions": [{ "field": "daysSinceActive", "op": "gte", "value": 3 }], "targetStepId": "inactivity_nudge" }
      ],
      "next": "day5_social",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "{{firstName}}, turn your grades into accurate listings",
          "html": "<p>Hi {{firstName}},</p><p>A grade is most powerful inside a listing. In FlipDesk you can carry the condition grade, measurements, and photos straight into an accurate listing — so buyers know exactly what they're getting and you field fewer questions and returns.</p><p><a href=\"https://gradethread.com/dashboard/flipdesk?utm_source=drip&utm_medium=email&utm_campaign=trial_conversion&utm_content=day3_education\">Manage your listings in FlipDesk</a></p>"
        }
      ]
    },
    {
      "id": "inactivity_nudge",
      "label": "Inactivity — no activity for 3 days",
      "phase": "in_trial",
      "trigger": "inactivity_3d",
      "anchor": "enrollment",
      "delayHours": 96,
      "conditions": [
        { "field": "converted", "op": "is_false" },
        { "field": "daysSinceActive", "op": "gte", "value": 3 }
      ],
      "brief": "Re-engagement for a trialist who's gone quiet (no grade/listing/sale for 3+ days). Friendly, no pressure — remind them the trial clock is running and that the first grade takes minutes. One low-friction CTA into the new-submission flow. Inserted between day 3 and day 5 without breaking the main sequence.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "day5_social",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Still there, {{firstName}}? Your trial's waiting",
          "html": "<p>Hi {{firstName}},</p><p>We noticed you haven't been back in a few days — no worries. Your free trial is still running, and grading an item takes about five minutes: four photos in, a standardized condition grade and shareable certificate out.</p><p><a href=\"https://gradethread.com/dashboard/submissions/new?utm_source=drip&utm_medium=email&utm_campaign=trial_conversion&utm_content=inactivity_nudge\">Pick up where you left off</a></p>"
        }
      ]
    },
    {
      "id": "day5_social",
      "label": "Day 5 — social proof + feature highlight",
      "phase": "in_trial",
      "trigger": "day5_social_proof",
      "anchor": "enrollment",
      "delayHours": 120,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Social-proof + a single feature highlight. Lead with why resellers trust standardized grading (consistent, transparent condition buyers can verify), then spotlight ONE high-value capability they may not have tried — the shareable, public condition certificate. Grounded only in real platform capabilities (no invented stats or testimonials). CTA to grade or view a certificate.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "recap",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Why resellers lead with a GradeThread grade, {{firstName}}",
          "html": "<p>Hi {{firstName}},</p><p>Resellers use GradeThread because a standardized, transparent condition grade is something buyers can actually verify — no more guessing from a few photos. One feature worth a look: every grade comes with a <strong>public, shareable certificate</strong> you can drop into any listing.</p><p><a href=\"https://gradethread.com/dashboard/submissions/new?utm_source=drip&utm_medium=email&utm_campaign=trial_conversion&utm_content=day5_social\">Grade an item & share its certificate</a></p>"
        }
      ]
    },
    {
      "id": "recap",
      "label": "Day 7 — your trial so far (recap + ROI)",
      "phase": "in_trial",
      "trigger": "midtrial_recap",
      "anchor": "enrollment",
      "delayHours": 168,
      "conditions": [
        { "field": "converted", "op": "is_false" },
        { "field": "totalActivity", "op": "gt", "value": 0 }
      ],
      "brief": "Mid-trial personalized recap. Reflect their REAL numbers (grades, listings, sales, certificates) and frame the ROI: standardized grades sell faster, build buyer trust, cut returns. Primary CTA: subscribe so they keep it all. Only sent to users with activity; the zero-activity branch sends a re-activation variant instead.",
      "incentiveEnabled": false,
      "branches": [
        { "conditions": [{ "field": "totalActivity", "op": "is_false" }], "targetStepId": "recap_reactivate" }
      ],
      "next": "feature_deepdive",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "{{firstName}}, here's your GradeThread trial so far",
          "html": "<p>Hi {{firstName}},</p><p>You're a week into your trial — here's what you've done:</p><ul><li><strong>{{gradesCount}}</strong> items graded</li><li><strong>{{certificatesCount}}</strong> shareable certificates</li><li><strong>{{listingsCount}}</strong> listings</li><li><strong>{{salesCount}}</strong> sales</li></ul><p>Sellers who lead with buyer-trusted grades move items faster and field fewer 'what condition is it really?' questions. Keep that momentum — subscribe to {{recommendedPlan}} before your trial ends.</p><p><a href=\"{{checkoutUrl}}\">Subscribe to {{recommendedPlan}}</a></p>"
        }
      ]
    },
    {
      "id": "recap_reactivate",
      "label": "Day 7 — re-activation (no activity yet)",
      "phase": "in_trial",
      "trigger": "midtrial_reactivate",
      "anchor": "enrollment",
      "delayHours": 168,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Re-activation for a trialist who hasn't done anything yet. No guilt — make the very first grade feel effortless and show the payoff. One low-friction CTA to grade a first item. Keep the subscribe option secondary.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "feature_deepdive",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "{{firstName}}, grade your first item in under 5 minutes",
          "html": "<p>Hi {{firstName}},</p><p>Your trial is running and you haven't graded anything yet — no worries, it takes minutes. Snap four photos (front, back, label, a detail) and get a standardized condition grade plus a shareable certificate buyers trust.</p><p><a href=\"https://gradethread.com/dashboard\">Grade your first item</a></p><p>Already convinced? <a href=\"{{checkoutUrl}}\">Subscribe to {{recommendedPlan}}</a>.</p>"
        }
      ]
    },
    {
      "id": "feature_deepdive",
      "label": "Day 10 — shareable certificate deep-dive",
      "phase": "in_trial",
      "trigger": "feature_deepdive",
      "anchor": "enrollment",
      "delayHours": 240,
      "conditions": [
        { "field": "converted", "op": "is_false" },
        { "field": "certificatesCount", "op": "is_false" }
      ],
      "brief": "Deep-dive on a high-value feature they haven't used yet: the shareable condition certificate. Show the outcome — a public, verifiable certificate buyers trust. Skipped (branch) for anyone who already created a certificate. CTA to subscribe so the certificates stay live.",
      "incentiveEnabled": false,
      "branches": [
        { "conditions": [{ "field": "certificatesCount", "op": "gt", "value": 0 }], "targetStepId": "urgency_2d" }
      ],
      "next": "urgency_2d",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "{{firstName}}, the one feature buyers love most",
          "html": "<p>Hi {{firstName}},</p><p>You've graded items — but have you shared a <strong>certificate</strong> yet? Each grade comes with a public, verifiable condition certificate you can drop into any listing. It's the single fastest way to turn 'what condition is it?' into a confident buy.</p><p><a href=\"https://gradethread.com/dashboard\">Create a certificate</a></p><p>Keep your certificates live after the trial — <a href=\"{{checkoutUrl}}\">subscribe to {{recommendedPlan}}</a>.</p>"
        }
      ]
    },
    {
      "id": "urgency_2d",
      "label": "Day 12 — trial ends in 2 days",
      "phase": "in_trial",
      "trigger": "trial_end_minus_2d",
      "anchor": "trial_end",
      "delayHours": -48,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Urgency, anchored to the ACTUAL trial end. Two days left. Clear, friendly nudge: add a card now to keep Pro. One-click subscribe CTA.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "urgency_1d",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Your trial ends in 2 days, {{firstName}}",
          "html": "<p>Hi {{firstName}},</p><p>Your trial ends {{trialEndsAt}} — that's two days away. Add a card now to keep grading, certificates, and your reports without interruption.</p><p><a href=\"{{checkoutUrl}}\">Subscribe to {{recommendedPlan}}</a></p>"
        }
      ]
    },
    {
      "id": "urgency_1d",
      "label": "Day 13 — ends tomorrow / what you'll lose",
      "phase": "in_trial",
      "trigger": "trial_end_minus_1d",
      "anchor": "trial_end",
      "delayHours": -24,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Ends tomorrow. Spell out concretely what drops on downgrade to Free (grounded {{lostFeatures}} list from plan entitlements). Make subscribing one click.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "urgency_today",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Tomorrow you go back to Free, {{firstName}} — here's what pauses",
          "html": "<p>Hi {{firstName}},</p><p>Your trial ends {{trialEndsAt}}. Once it does, you drop to the Free plan and these {{recommendedPlan}} features pause:</p>{{lostFeatures}}<p>Keep all of it — add a card before tomorrow.</p><p><a href=\"{{checkoutUrl}}\">Subscribe to {{recommendedPlan}}</a></p>"
        }
      ]
    },
    {
      "id": "urgency_today",
      "label": "Day 14 — last chance today",
      "phase": "in_trial",
      "trigger": "trial_end",
      "anchor": "trial_end",
      "delayHours": 0,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Final in-trial touch on the day the trial ends. Last-chance framing, single one-click subscribe CTA. After this the user lapses to Free and enters the post-trial win-back tail.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "win_back_free",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Last chance today, {{firstName}} — keep your Pro features",
          "html": "<p>Hi {{firstName}},</p><p>Your trial ends today. Add a card now to keep unlimited grading, shareable certificates, and full condition reports — no interruption.</p><p><a href=\"{{checkoutUrl}}\">Subscribe to {{recommendedPlan}} now</a></p>"
        }
      ]
    },
    {
      "id": "win_back_free",
      "label": "Win-back Day 16 — you're on Free now",
      "phase": "win_back",
      "trigger": "trial_expired",
      "anchor": "trial_end",
      "delayHours": 48,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Trial lapsed to Free. Friendly, no guilt. Name the specific Pro features they used during the trial that are now paused (unlimited grading, shareable certificates, full condition reports) and lead with the outcome — buyer-trusted grades sell faster. One low-friction CTA to upgrade.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "win_back_value",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "You're on Free now, {{firstName}} — here's what you're missing",
          "html": "<p>Hi {{firstName}},</p><p>Your trial wrapped up and you're back on the Free plan. The Pro features you used during your trial — unlimited grading, shareable certificates, and full condition reports — are paused.</p><p>Sellers using buyer-trusted grades move items faster and field fewer 'what condition is it really?' questions. Pick up right where you left off whenever you're ready.</p><p><a href=\"https://gradethread.com/pricing\">See what Pro unlocks</a></p>"
        }
      ]
    },
    {
      "id": "win_back_value",
      "label": "Win-back Day 20 — is it worth it?",
      "phase": "win_back",
      "trigger": "after_trial_end",
      "anchor": "trial_end",
      "delayHours": 144,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Objection-handling. Tackle the price objection head-on with outcomes: one extra sale a month more than covers Pro; standardized grades cut returns and disputes; certificates build buyer trust. No incentive yet — earn the upgrade on value.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "win_back_offer",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Is GradeThread worth it, {{firstName}}? Here's the honest math",
          "html": "<p>Hi {{firstName}},</p><p>Fair question. Here's how Pro pays for itself:</p><ul><li><strong>One extra sale a month</strong> more than covers it — standardized grades help items sell faster and at better prices.</li><li><strong>Fewer returns and disputes</strong> — a clear, certified condition grade sets buyer expectations up front.</li><li><strong>Buyer trust</strong> — a shareable certificate signals you're a serious, transparent seller.</li></ul><p><a href=\"https://gradethread.com/pricing\">Upgrade to Pro</a></p>"
        }
      ]
    },
    {
      "id": "win_back_offer",
      "label": "Win-back Day 24 — incentive offer",
      "phase": "win_back",
      "trigger": "after_trial_end",
      "anchor": "trial_end",
      "delayHours": 240,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Now sweeten it. Recap the value, then surface the conversion incentive (config-gated — only renders when the campaign incentive is enabled and the user hasn't converted). Make upgrading one click.",
      "incentiveEnabled": true,
      "branches": [],
      "next": "win_back_final",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "A little nudge to come back, {{firstName}}",
          "html": "<p>Hi {{firstName}},</p><p>You graded items, built certificates, and saw what standardized condition grading does for your listings. Here's a hand getting back to it.</p>{{incentive}}<p><a href=\"https://gradethread.com/pricing\">Upgrade to Pro</a></p>"
        }
      ]
    },
    {
      "id": "win_back_final",
      "label": "Win-back Day 28 — final, then exit",
      "phase": "win_back",
      "trigger": "after_trial_end",
      "anchor": "trial_end",
      "delayHours": 336,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Last touch of the focused win-back. Strongest incentive with a clear deadline, then exit the journey — the user is handed back to the standard occasional newsletter (no more drip). Respectful sign-off.",
      "incentiveEnabled": true,
      "branches": [],
      "next": null,
      "exit": true,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Last call, {{firstName}} — your offer expires soon",
          "html": "<p>Hi {{firstName}},</p><p>This is the last nudge from our trial series — your offer expires soon.</p>{{incentive}}<p>Whatever you decide, your past grades and certificates are safe, and we'll only send the occasional newsletter from here. Come back any time.</p><p><a href=\"https://gradethread.com/pricing\">Upgrade to Pro</a></p>"
        }
      ]
    }
  ]
}
$json$::jsonb
WHERE campaign = 'trial_conversion'
  AND graph -> 'steps' @> '[{"id": "recap"}]'::jsonb
  AND NOT (graph -> 'steps' @> '[{"id": "day1_first_grade"}]'::jsonb);

COMMIT;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync
-- regardless of how this migration is applied.
INSERT INTO public.applied_migrations (version) VALUES ('00271')
ON CONFLICT (version) DO NOTHING;
