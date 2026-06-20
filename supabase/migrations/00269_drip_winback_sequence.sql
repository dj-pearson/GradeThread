-- US-941: Phase 3 post-trial win-back sequence (days 15–28).
--
-- The default trial-conversion campaign graph (seeded in 00255) shipped with a
-- minimal 2-touch win-back tail (win_back_1 + win_back_final). This migration
-- replaces that tail with the full, respectful post-trial sequence for a
-- trialist who lapsed to Free, anchored to the (14-day) trial end:
--
--   • Day 16 (trial_end + 48h)  win_back_free  — "you're on Free now; here's
--                                what you're missing" (outcome + lost Pro features)
--   • Day 20 (trial_end + 144h) win_back_value — value / objection-handling
--   • Day 24 (trial_end + 240h) win_back_offer — incentive offer (config-gated:
--                                surfaces a code ONLY when graph.incentive is on,
--                                US-942, and the user hasn't converted)
--   • Day 28 (trial_end + 336h) win_back_final — final touch, THEN exit the
--                                journey → the user is handed back to the standard
--                                (occasional) newsletter cadence.
--
-- Every win-back step gates on `converted = is_false`, so a user who converted
-- during the trial never enters win-back (and a conversion exits the whole
-- journey instantly — routes/drip.ts). Marketing consent / suppression /
-- unsubscribe are enforced at dispatch (the engine exits an opted-out recipient),
-- so the sequence is unambiguously marketing and fully honors opt-out.
--
-- The in-trial steps (welcome, tips, ending_soon, ending_soon_active) are
-- unchanged except their `next` now points at the new first win-back step.
--
-- Idempotent + non-clobbering: only the recognizable ORIGINAL default graph (has
-- win_back_1, lacks win_back_free) is rewritten. Once the new steps exist — or an
-- operator has edited the graph in the builder — this is a no-op.

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
      "next": "ending_soon",
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
      "id": "ending_soon",
      "label": "Trial ending — convert with incentive",
      "phase": "in_trial",
      "trigger": "before_trial_end",
      "anchor": "trial_end",
      "delayHours": -72,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "Urgency: trial ends in 3 days. Offer the launch incentive. Make upgrading one click.",
      "incentiveEnabled": true,
      "branches": [
        { "conditions": [{ "field": "gradesUsed", "op": "gte", "value": 1 }], "targetStepId": "ending_soon_active" }
      ],
      "next": "win_back_free",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 50,
          "subject": "Your trial ends in 3 days, {{firstName}}",
          "html": "<p>Hi {{firstName}},</p><p>Your trial ends {{trialEndsAt}}. Upgrade now to keep grading.</p>{{incentive}}"
        },
        {
          "id": "B",
          "weight": 50,
          "subject": "Don't lose your reports, {{firstName}}",
          "html": "<p>Hi {{firstName}},</p><p>Keep your certificates and reports — upgrade before {{trialEndsAt}}.</p>{{incentive}}"
        }
      ]
    },
    {
      "id": "ending_soon_active",
      "label": "Trial ending — engaged users",
      "phase": "in_trial",
      "trigger": "before_trial_end",
      "anchor": "trial_end",
      "delayHours": -72,
      "conditions": [{ "field": "converted", "op": "is_false" }],
      "brief": "For users who already graded items: emphasize what they'll lose access to and how cheap continuing is.",
      "incentiveEnabled": true,
      "branches": [],
      "next": "win_back_free",
      "exit": false,
      "variants": [
        {
          "id": "A",
          "weight": 100,
          "subject": "Keep grading, {{firstName}} — your trial ends {{trialEndsAt}}",
          "html": "<p>Hi {{firstName}},</p><p>You've already graded items this trial. Upgrade to keep your reports and grade more.</p>{{incentive}}"
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
  AND graph -> 'steps' @> '[{"id": "win_back_1"}]'::jsonb
  AND NOT (graph -> 'steps' @> '[{"id": "win_back_free"}]'::jsonb);

COMMIT;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync
-- regardless of how this migration is applied.
INSERT INTO public.applied_migrations (version) VALUES ('00269')
ON CONFLICT (version) DO NOTHING;
