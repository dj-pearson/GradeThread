-- US-940: Phase 2 in-trial conversion-push sequence (days 7–14).
--
-- The default trial-conversion campaign graph (00255 → 00269) carried a thin
-- in-trial middle: welcome (day 0) → tips (day 3) → a single ending_soon touch
-- (~day 11, with an engaged-user branch) → the post-trial win-back tail. This
-- migration replaces that single ending_soon touch with the full conversion-push
-- sequence that carries a trialist to the finish line:
--
--   • Day 7  (enrollment + 168h)  recap            — mid-trial personalized recap
--            + ROI framing from their REAL activity ({{gradesCount}}/
--            {{listingsCount}}/{{salesCount}}/{{certificatesCount}}). Sends only
--            when they have activity; a zero-activity trialist instead falls
--            through to…
--   • Day 7  (enrollment + 168h)  recap_reactivate — re-activation variant for a
--            zero-activity trialist (totalActivity = 0).
--   • Day 10 (enrollment + 240h)  feature_deepdive — deep-dive on the shareable
--            certificate (a high-value feature). Branch: if they've already made
--            a certificate (certificatesCount > 0) the step is skipped.
--   • Day 12 (trial_end − 48h)    urgency_2d       — "trial ends in 2 days".
--   • Day 13 (trial_end − 24h)    urgency_1d       — "ends tomorrow / what you'll
--            lose" (grounded {{lostFeatures}} list).
--   • Day 14 (trial_end)          urgency_today    — "last chance today", then on
--            to the post-trial win-back tail.
--
-- The three urgency steps are anchored to the ACTUAL trial_end (anchor
-- "trial_end"), NOT a fixed offset from enrollment — so an admin-adjusted trial
-- window (admin-billing.ts) stays correct (AC2). Every step gates on
-- `converted = is_false`, so conversion at ANY point skips all further sends and
-- the engine exits the journey instantly (routes/drip.ts). Each step's primary
-- CTA is the subscribe / add-a-card deep-link ({{checkoutUrl}} →
-- /dashboard/billing?upgrade=pro for the recommended plan).
--
-- Idempotent + non-clobbering: only the recognizable 00269-shape default graph
-- (has ending_soon, lacks recap) is rewritten. Once the conversion-push steps
-- exist — or an operator has edited the graph in the builder — this is a no-op.

BEGIN;

UPDATE public.drip_campaigns
SET graph = $json$
{
  "entryStepId": "welcome",
  "steps": [
    {
      "id": "welcome",
      "label": "Welcome — grade your first item",
      "phase": "in_trial",
      "trigger": "trial_started",
      "anchor": "enrollment",
      "delayHours": 0,
      "conditions": [],
      "brief": "Warm welcome. One clear CTA: upload your first garment and get a grade in minutes. No card on file — reassure them the trial is free.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "tips",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Welcome to GradeThread, {{firstName}} — let's grade your first item",
          "html": "<p>Hi {{firstName}},</p><p>Your free trial is live. Upload a garment and get a standardized condition grade in minutes.</p><p><a href=\"https://gradethread.com/dashboard\">Grade your first item</a></p>"
        }
      ]
    },
    {
      "id": "tips",
      "label": "Day 3 — get better grades",
      "phase": "in_trial",
      "trigger": "after_previous",
      "anchor": "previous",
      "delayHours": 72,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Educational: how to photograph for the most accurate grade (front/back/label/detail). Reinforce value of the certificate.",
      "incentiveEnabled": false,
      "branches": [],
      "next": "recap",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Get sharper grades, {{firstName}}",
          "html": "<p>Hi {{firstName}},</p><p>Four photos — front, back, label, and a detail — get you the most accurate grade and a shareable certificate.</p>"
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
  AND graph -> 'steps' @> '[{"id": "ending_soon"}]'::jsonb
  AND NOT (graph -> 'steps' @> '[{"id": "recap"}]'::jsonb);

COMMIT;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync
-- regardless of how this migration is applied.
INSERT INTO public.applied_migrations (version) VALUES ('00270')
ON CONFLICT (version) DO NOTHING;
