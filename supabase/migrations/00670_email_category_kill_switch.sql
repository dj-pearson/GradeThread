-- US-2854: register the outgoing-email kill switch in the settings registry.
--
-- One row in public.system_settings (00207 + 00208) holding the list of email
-- categories an operator has switched off. Read through getSetting(), so a
-- change lands on the next send rather than the next deploy — which is the whole
-- point: today, stopping a category of email mid-incident means edit, review,
-- build, deploy, wait.
--
-- The value is a json ARRAY of category ids, e.g. ["trial_expiring","ops_alert"].
-- It seeds EMPTY, so applying this changes nothing until somebody flips a switch.
--
-- Protected categories are NOT expressed here and never will be. Auth codes,
-- password resets, payment failures and receipts are enforced in code
-- (PROTECTED_CATEGORIES in lib/email-kill-switch.ts), refused both when the list
-- is written and again when it is read. A row edited by hand in this table still
-- cannot suppress one — which is exactly why the rule does not live in the row.
--
-- No REVOKE (see 00609 and the standing rule: a denied anon/authenticated call
-- segfaults this Postgres image). system_settings already has RLS enabled with
-- no client policies from 00207, so it stays service-role only by inheritance.
--
-- Idempotent: ON CONFLICT DO NOTHING, so a re-run never clobbers an operator's
-- live list.

INSERT INTO public.system_settings (key, value, value_type, default_value, category, description)
VALUES (
  'email_categories_disabled',
  '[]'::jsonb, 'json', '[]'::jsonb, 'email',
  'Outgoing email categories switched OFF by an operator, as a json array of category ids (e.g. ["trial_expiring"]). A disabled category is skipped at send and audited, never queued. Auth, receipt and payment-failure categories are protected in code and cannot be disabled here.'
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00670') ON CONFLICT DO NOTHING;
