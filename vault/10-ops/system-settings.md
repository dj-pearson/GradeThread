---
title: Deploy-free configuration — the system_settings registry
aliases: [system_settings, getSetting, tunable thresholds]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/system-settings.ts
  - supabase/migrations/00208_system_settings_registry.sql
  - services/edge-functions/src/routes/admin-settings.ts
reviewed: 2026-09-11
tags: [ops, config, admin, contract]
summary: A typed key→jsonb registry read through a caching helper, editable by a super-admin without a deploy — which is the point and also the risk. A key with no seed migration is unreachable, not off.
---

# Deploy-free configuration

`public.system_settings` is a typed key→jsonb registry: `key` PK, `value`,
`value_type` (`number | bool | string | json`, CHECK-constrained),
`default_value`, `category`, plus `updated_at` / `updated_by`.

**RLS is on with no client policies** — service-role only, the same shape as
`cron_runs`. The admin endpoints are role-gated at the API layer rather than by
policy.

## Read it through the helper, never directly

`services/edge-functions/src/lib/system-settings.ts`:

- `getSetting(key, fallback)` — async, 30s TTL cache, busted on write.
- `getSettingSync(key, fallback)` — for genuinely synchronous call sites (a
  rate-limiter's `maxRequests` resolver, for instance). It answers from cache and
  warms in the background, so the first call may return the fallback.
- `coerceSettingValue(type, raw)`, `bustSettingCache(key)`.

The fallback argument is not decoration: a key that has never been written, or a
cold `getSettingSync`, returns it. **Pick a fallback that is safe to run
production on**, because sooner or later it will.

## A new key needs a SEED MIGRATION, or the switch does not exist

`PUT /api/admin/settings/:key` loads the row first and answers **404 "Unknown
setting"** when there is none. That is deliberate (it needs `value_type` to
validate against) and it means the editor can never CREATE a key. Rows are born
in migrations and nowhere else.

So a feature gated on `getSetting("my_key", {})` with no seed row is not "off by
default". It is **unreachable**: the fallback is the only value it will ever
have, and no operator surface can change that. Nothing warns, and the feature
reads as working code with a switch.

US-3359 is the worked example. The selective second-opinion grading pass shipped
2026-08-17 with a caller, four wiring guards and a resolver that refuses unsafe
models, all passing. Its key, `grading_second_opinion`, appeared in 0 of 785
migrations. It could not have run once, and nothing in the repo said so.

**Ship the seed migration in the same change as the code that reads the key**,
with the row seeded to the code default so applying it changes no behaviour.
`ON CONFLICT (key) DO NOTHING`, never an upsert: prod may already hold a
hand-seeded row and this table is invisible to the anon OpenAPI probe, so you
cannot prove otherwise before writing the SQL.

## Editing is a privileged, audited action

`GET /api/admin/settings` (grouped by category) and
`PUT /api/admin/settings/:key` — super-admin, **MFA step-up**, audited, and the
write busts the cache. The editor lives at `/admin/ops/settings`.

> The whole value is changing a threshold without a deploy. The matching risk is
> that a bad value takes effect within 30 seconds, with no review, no CI and no
> rollback beyond editing it back. Treat a settings change as a production change:
> know the previous value before you overwrite it.

## Prefer a key here over a new table

New config-shaped work — plan limits, AI budgets, feature thresholds, the buyer
guarantee gates in [[buyer-economy]] — should store keys in this registry rather
than growing a bespoke table each time. That is what it was generalised for, and
it is why the editor and the audit trail exist once instead of per feature.

> [!note] Historical trap worth not repeating
> The table was created early by the system-health story because it needed
> deploy-free thresholds *before* the registry story that was going to own it.
> The follow-up story had to **extend** the existing table rather than create it:
> a second `create table … if not exists` would have silently no-opped and left
> the two definitions diverging. When a story says it will "own" a table that
> already exists, read the earlier migration first.

## Related

- [[buyer-economy]] — guarantee gates that live here
- [[mfa]] — the step-up a settings write requires
- [[migrations-process]] — how the columns got there
- [[moc-ops]]
