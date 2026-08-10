---
title: Signup consent capture — who writes the clickwrap, and what it says
type: contract
status: current
source_of_truth: code
code_refs:
  - supabase/migrations/00586_handle_new_user_restore_legal_acceptance.sql
  - services/edge-functions/src/lib/legal-versions.ts
  - services/edge-functions/src/lib/signup-consent-evidence.ts
  - services/edge-functions/src/routes/legal.ts
  - services/edge-functions/src/tests/legal-acceptance-trigger_test.ts
  - src/lib/auth.ts
reviewed: 2026-08-10
tags: [legal, consent, gdpr, signup, migrations]
summary: How a signup's terms acceptance is recorded, why the version is server-resolved, and the CREATE OR REPLACE failure that silently deleted the whole capture for months.
---

# Signup consent capture

An account's answer to *"what did this user agree to, and how do you know?"*
comes from two places, and they are written by different things at different
times.

| Where | Written by | What it is |
|---|---|---|
| `users.tos_accepted_version` / `privacy_accepted_version` (+ `_at`) | the `handle_new_user` trigger, or `POST /api/legal/accept` | the CURRENT state the gate reads |
| `legal_acceptances` rows | the trigger, `/accept`, and `/confirm-signup` | the append-only history |

## The four acceptance methods

- `signup_clickwrap` — email signup. Written by the `handle_new_user` Postgres
  trigger. Guaranteed, but weak: a trigger has no HTTP request, so no IP and no
  user-agent.
- `signup_clickwrap_confirmed` — the first authenticated session after that
  signup, from `POST /api/legal/confirm-signup`, with the IP and user-agent the
  edge observed itself. Best-effort, but strong. **It corroborates the row
  above and refuses when that row is missing**, rather than inventing one.
- `oauth_clickwrap` — an OAuth user's first pass through the legal gate.
- `reacceptance` — the gate firing on a version bump.

Read the first two as a pair. The `_confirmed` row's `accepted_at` is when the
server observed the session, **not** when consent was given — conflating those
is the one way it could overstate what we know.

## The version is server-resolved, not client-claimed

The browser sends `tos_version` / `privacy_version` in the signup metadata from
a hardcoded constant (`LEGAL_VERSIONS` in `src/lib/constants.ts`, mirrored in
iOS). That constant does **not** move when an operator publishes a new document,
while `/terms` serves the live one — so a record built from it names a version
the user was never shown. That is US-2017's residual hole.

So the trigger uses the metadata's **presence** as the signal ("this was an
email signup with a checkbox"; an OAuth signup sends none and must stay NULL for
the gate) and reads the **value** from `legal_documents`.

> [!important] The trigger's `ORDER BY` mirrors `deriveKind()`
> `effective_date DESC, version DESC`, with `2026-04-01` when the table is empty
> — the same as `FALLBACK_TOS_VERSION`. If the two ever disagree about which row
> is "current", a fresh signup is stamped with a version the gate does not
> accept (re-prompted forever) or one it thinks is newer (never prompted).
> `legal-acceptance-trigger_test.ts` counts BOTH lookups, because a sabotage
> that drifted only the tos one left the privacy one matching and passed.

`accepted_at` is `now()`, not the client's `legal_accepted_at`. Same reason a
client-supplied IP is refused: a forgeable value on a consent record is worse
than an absent one, because it looks authoritative exactly where the record's
only value is that it can be trusted.

## ⚠ The failure this note exists for: CREATE OR REPLACE deletes silently

`handle_new_user` is defined by **seven** migrations. `CREATE OR REPLACE
FUNCTION` does not warn that a new body dropped what an earlier one added.

- `00142` added the clickwrap capture.
- `00303` replaced the function to add `use_case` and did not carry it forward.
- `00379` and `00401` rebased on the truncated body — `00401` states in its own
  header that the body is "identical to 00379".
- `00586` restored it.

Nothing failed in between. The columns are nullable, no test exercised the
trigger's SQL, and the `db` verify lane proves migrations *apply* to a fresh
schema without ever signing anyone up. For the whole window, email signups
recorded no clickwrap, and `/confirm-signup` refused every caller — correctly,
for a row that no longer existed — while its module and `00573`'s column comment
both read as though it worked.

**Accounts created in that window cannot be backfilled.** The acceptance they
gave was never recorded, and writing a row now would be a fabricated consent
record. They are covered by whatever the legal gate captured on first sign-in.

**Rule: any migration that replaces `handle_new_user` must be diffed against the
previous definition, not written fresh.** `legal-acceptance-trigger_test.ts`
reads the LAST definition on disk and fails if the clickwrap block is not in it,
which is the check that would have caught `00303`.

## Related

- [[data-retention]] — erasure removes these rows by cascade
- [[buyer-legal-and-privacy]] — the buyer product's legal surfaces
- [[INDEX]]
