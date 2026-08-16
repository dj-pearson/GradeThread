---
title: Data retention, purge and GDPR rights
aliases: [DATA_RETENTION, GDPR, right to erasure]
type: runbook
status: current
source_of_truth: vault
code_refs:
  - services/edge-functions/src/lib/account-storage-purge.ts
  - services/edge-functions/src/routes/account.ts
  - services/edge-functions/src/routes/admin-compliance.ts
  - services/edge-functions/src/lib/account-email-purge.ts
  - services/edge-functions/src/lib/financial-retention.ts
reviewed: 2026-08-16
tags: [ops, privacy, gdpr, retention]
summary: The retention schedule and purge job, plus the export and erasure paths that satisfy portability and right-to-be-forgotten.
---
# Data Retention & PII Purge (US-521)

GradeThread enforces storage-limitation/data-minimization through documented
retention windows and an automated purge job. This file is the operational
source of truth; the customer-facing summary lives in the Privacy Policy
(`src/pages/legal/privacy.tsx`, §7) and the subprocessor list.

## Retention schedule

| Data category | Store | Retention | Mechanism |
|---|---|---|---|
| Grading photos | `submission-images` bucket + `submission_images` rows | **2 years** from submission (`DATA_RETENTION_DAYS`, default 730) | Automated purge cron (`/api/jobs/data-retention`) deletes the storage objects + index rows; the grade report is kept (anonymized) |
| Grade reports & certificates | `grade_reports` | Life of account | Kept so public certificates stay verifiable |
| Account profile & auth | `users`, Supabase Auth | Deleted/de-identified ≤ 90 days after account closure | Account-deletion flow (US-275) + manual closure |
| Billing & transactions | `flipdesk_subscription_events`, Stripe | Up to 7 years | Tax/accounting obligation; Stripe is system of record |
| Support & dispute records | `disputes` | Up to 3 years after resolution | Manual |
| Server & security logs | log aggregator | ≤ 90 days | Aggregator retention policy |

## The purge job

- **Endpoint:** `POST /api/jobs/data-retention` (gated by `X-Internal-Job-Secret`).
- **Code:** `services/edge-functions/src/lib/data-retention.ts`.
- **Behavior:** finds submissions older than the window, deletes their
  `submission-images` storage objects **first** (so a mid-run failure can't
  orphan objects), then deletes the `submission_images` rows. The
  `grade_reports` row is intentionally retained — the grade is the non-PII
  product and the certificate must stay verifiable. This is **anonymization**
  (photos removed), not destruction of the grade.
- **Overlap-safe:** wrapped in the `data-retention` job lock (US-503).
- **Observability:** emits `retention.objects_purged` metric + a structured
  `retention.sweep` log; failures go to the error tracker (US-491).
- **Batch size:** 200 submissions/run; safe to run frequently (idempotent —
  re-running re-deletes any objects whose row delete failed last time).

## Scheduling

Add to the Coolify scheduled-task list (see `services/edge-functions/COOLIFY.md`):

```
# Daily at 04:00 UTC
curl -fsS -X POST https://functions.gradethread.com/api/jobs/data-retention \
  -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET"
```

## Tuning

- `DATA_RETENTION_DAYS` — grading-photo window in days (default 730). Lowering
  it purges more aggressively on the next run.

## Early deletion (user request)

Users can request deletion before the window via the account-deletion flow
(US-275) or by contacting privacy@gradethread.com. Account deletion cascades
`submission_images` (FK `ON DELETE CASCADE`) and removes storage objects.

## Verification

After a run, confirm:
1. `POST /api/jobs/data-retention` returns `{ ok: true, objects_deleted, rows_deleted }`.
2. A sampled old `submission_images.storage_path` no longer resolves in the
   `submission-images` bucket.
3. The corresponding `grade_reports` row still exists (anonymized grade kept).

---

## Absorbed from `docs/DATA_RETENTION.md` (US-2049)

Complementary halves again: this file covered the **operational** side (retention
schedule, the purge job, scheduling, tuning, verification) while the `docs/` copy
covered the **compliance** side (export / right to portability, deletion / right
to erasure, and how external resources are handled). A privacy request needs both.

How GradeThread handles user data lifecycle for GDPR / CCPA (US-275).

## Export (right to portability)

**There are TWO export paths and they must answer with the same set.**
`GET /api/account/export` (`routes/account.ts`) streams the self-serve
download; `assembleUserExport()` (`lib/data-export.ts`) builds the archive the
admin compliance queue hands to a subject.

Both are driven off REGISTERS rather than hand-written lists — `BUYER_PII_TABLES`
(`lib/buyer-pii.ts`) plus `SELLER_EXPORT_TABLES` — because a hand-written list
is what left every buyer table out of the response for a whole epic (US-1846),
and then left the FORMAL path returning less than the self-serve one for months
after that was fixed (US-2648). `data-export_test.ts` compares the two as SETS
in both directions; do not add a table to one path only.

Both also return a `storage_objects` manifest built from the same collector the
ERASURE paths use, so "what we hold for you" and "what we delete for you" cannot
describe different sets (US-2650). The self-serve manifest ships PATHS, not
signed URLs — the person is already authenticated as themselves; whether Art. 15
"a copy" obliges the bytes is an open legal question recorded on that story.

## Deletion (right to erasure)

**THERE ARE TWO ERASURE PATHS, AND THE SECOND ONE INHERITS NOTHING.**

`POST /api/account/delete` (`routes/account.ts`) is the self-serve teardown —
the Settings page requires the user to type `DELETE MY ACCOUNT`. It DELETES the
`auth.users` row, so the `ON DELETE CASCADE` chain rooted at `public.users`
wipes the DB-resident data and every `ON DELETE SET NULL` trigger fires.

`processDelete()` (`routes/admin-compliance.ts`) is the formal path a written
erasure request goes through — super_admin, a fresh MFA step-up and a typed
confirm. It **ANONYMIZES and KEEPS** the `users` row so financial and audit
records stay referentially intact.

> [!important] Everything the self-serve path gets free from the cascade, the
> admin path must do BY HAND
> This is the single rule that explains six separate leaks (US-2645, US-2646,
> US-2647, US-2649, US-2651, US-2652). Keeping the row means no FK fires: no
> cascade delete, and no `ON DELETE SET NULL` — so the Garment Passport linkage
> survived with `identity_revealed` still true, on a public surface, after an
> erasure that reported success.

Both paths now run the same sequence, in this order:

1. **`retainFinancialRecords()`** — counts the retained ledger and REDACTS
   `flipdesk_subscription_events.raw_payload`, the verbatim Stripe object
   carrying customer email and billing address. It can REFUSE, and refusing is
   only safe while the account is whole, which is why it runs first.
2. **`collectOwnedStorageObjects()`** (`lib/account-storage-purge.ts`) — the
   ONE list of every storage object an account owns, across **five** buckets:
   `submission-images` (served copies, EXIF-intact originals, dispute evidence,
   arrival captures), `item-photos`, `compliance-exports`, `expense-receipts`
   and `avatars`. Avatars are found by LISTING the user's folder, because
   uploads are timestamped and `users.avatar_url` names only the current one.
3. **`purgeEmailKeyedPii()`** — before the address is destroyed (see below).
4. **Garment Passport teardown** — `identity_revealed`, `identity_revealed_at`
   and `linked_user_id` cleared explicitly on `owner_nodes`.
5. **Stripe customer delete** — also cancels a live subscription. Stripe keeps
   charges and invoices against a deleted customer, so the retained financial
   record is unaffected.
6. Then the path diverges: self-serve deletes the auth user; the admin path
   anonymizes and bans it.

The bucket list in step 2 is DERIVED from `INSERT INTO storage.buckets` across
the migrations, not hand-written — a hand-written one passed for months while
`avatars` leaked, and the derived form found `expense-receipts` on its first
run. `account-deletion-sweep_test.ts` fails on any bucket that is neither swept
nor carrying a written reason.

The legacy `delete_account()` RPC (migration `00043`) still exists for the
client-side self-service path, but it only does step 3 — prefer the endpoint,
which also handles the external resources below.

### Notes on external resources

- **Storage objects** — handled in step 1 (not FK-cascaded).
- **Stripe customer** — handled in step 2.
- **Marketplace OAuth tokens** — the stored `marketplace_connections` rows
  (incl. eBay tokens) are removed by the cascade. Live revocation at eBay is
  not performed in-line; those tokens are short-lived and our stored copy is
  destroyed. See `docs/INCIDENT_RESPONSE.md` if proactive revocation is needed.

### Email-keyed PII — the half the cascade cannot reach (US-2005)

The cascade reaches only tables with an FK to `auth.users`. Seven tables are
keyed by **email address** instead, including `email_deliveries`, which stores
the full rendered `html` of every critical message we sent. Step 3 above ran
while those stayed queryable.

Since US-2005 the endpoint runs `purgeEmailKeyedPii()` **before** the cascade —
ordering is load-bearing, because after it `users.email` is gone and there is
nothing left to key on. The table list and the delete/anonymize decision for each
live in `services/edge-functions/src/lib/account-email-purge.ts`; do not restate
them anywhere else, and do not write a second script that hardcodes them.

`email_suppressions` is **deliberately exempt**. Forgetting a bounced or
complained address means it starts receiving mail again, harming the very person
the erasure protects.

Erasure for someone who never had an account — a guarantee claimant, a
consignor — is a different procedure with a different plan; see
[third-party subjects](#third-party-subjects-a-buyer-or-a-consignor-us-2433).

### What we can and cannot say about erasures made before US-2005

**Accounts deleted before US-2005 shipped did not get the email-keyed purge, and
that backlog cannot be enumerated.** This is the answer to give if asked; it is
a consequence of a deliberate design choice, not an oversight to be fixed later.

- `account_deletion_log` stores **no address**, by design — migration `00064`
  states the retained id "cannot be joined back to any PII". It proves *that*
  an account id was erased on a date. It cannot say *whose address* that was.
- `email_deliveries` has **no user column at all** (`00095`). Nothing to join.
- Every other planned table either severs its user link `ON DELETE SET NULL`
  (`marketing_send_log`, `email_subscribers`, `waitlist_entries`) or never had
  one (`email_journey_step_sends`).

So an address with no live account is **indistinguishable** from a lead who
never signed up — and `waitlist_entries` and `email_subscribers` exist for
exactly those people. Running the purge plan over that set would delete the
waitlist and the newsletter list on the theory that some of them might be
someone else. **Do not do it.**

What *does* reduce the residue:

- **Time.** US-2021 put `email_deliveries` on the retention sweep above: `sent`
  rows deleted after 90 days, `dead_letter` bodies stripped after 180. Confirm
  the `data-retention` cron is actually scheduled — if it is not, nothing is
  expiring.
- **A request.** When a subject writes in, the address is known and no inference
  is needed.

Two operator tools, both in `services/edge-functions/scripts/`:

| Script | What it does |
|---|---|
| `email-residue-census.ts` | Counts the residue per table, split into live-account and unattributable. **Read-only, and has no `--apply`** — there is no population one could safely act on. Never prints an address. |
| `purge-email-subject.ts` | Erases **one** address on request, running the same `EMAIL_PURGE_PLAN`. Dry run by default; refuses an address that still belongs to a live account. |

Neither is an endpoint. An unverified email claim that erases rows is a deletion
oracle — anyone could POST a stranger's address. Verification would be the work,
and it has not been designed.

### Third-party subjects: a buyer or a consignor (US-2433)

Two tables hold identifying data about someone who is **not** the account
holder and who may never have had an account:

| Table | Who it is about | Identifying columns |
|---|---|---|
| `guarantee_claims` | the **buyer** who filed a claim | `claimant_email` (NOT NULL), `claimant_name`, `order_reference` |
| `consignors` | the **consignor** who gave a seller items to sell | `name` (NOT NULL), `contact_email`, `contact_phone` |

Both cascade from the **seller**, so before this they were erased if and only
if that seller deleted their account. The buyer and the consignor had no lever.

**Both are anonymized, never deleted**, and both reasons are about someone
other than the subject. A guarantee claim is the audit record of a payout
decision, with `claim_accuracy_signals` and `guarantee_remedies` cascading
from it — deleting it destroys the evidence that we paid, which is the
seller's to rely on. A consignor row is the seller's own business record, and
`inventory_items.consignor_id` points at it so sale history survives.

**Intake is operator-run** (`scripts/purge-third-party-subject.ts`), same call
as the email-keyed purge above and for the same reason: an endpoint that erases
on an unverified email claim is a deletion oracle.

```
# 1. read-only. Shows which rows a name or address could mean.
deno run --allow-net --allow-env scripts/purge-third-party-subject.ts --find "a@b.test"

# 2. a claim buyer is matched by address; dry run first.
... --claim-buyer a@b.test
... --claim-buyer a@b.test --apply

# 3. a consignor is matched by ROW ID, chosen from step 1.
... --consignor <uuid>,<uuid> --apply
```

Two things to know before running it:

- **A consignor is never purged by name.** Names are unique only per seller
  (`UNIQUE(user_id, name)`, `00107`), so one name can be several different
  people across several sellers. `--find` lists candidates with their seller;
  choosing which are the subject's is a human judgement.
- **`guarantee_claims.reason`, `evidence_urls` and `consignors.notes` are not
  touched.** They are free text the buyer or seller wrote and may carry a name.
  `reason` is NOT NULL and *is* the claim, so blanking it turns a payout audit
  record into a row saying money moved for no stated cause. Whether a subject
  request should also scrub these is an owner call about how much audit
  substance an erasure may destroy. Say so when answering the subject.

> [!warning] `claimant_email` is stored with the buyer's own casing
> `00197` types it as plain `text` and the public intake trims but does not
> lowercase, so a claim filed as `Buyer@Example.com` is stored that way. A
> `.eq()` lookup on the lowercased address matches nothing and reports "no rows
> found" — which reads as a completed erasure while the address sits untouched.
> The script compares in TypeScript through `canonicalMatchValue`, and does not
> use `ILIKE`, because `_` and `%` are SQL wildcards and both are legal in an
> email local part.

## Retention

- **Active account data** is retained while the account exists.
- **On deletion**, DB data is removed immediately via the cascade; external
  cleanup (above) should run in the same flow.
- **Backups**: database and storage backups age out per the retention policy
  in `vault/10-ops/backups.md` (7 days local, 30 days offsite); deleted data is therefore
  purged from all backups within 30 days.
- **A minimal, non-PII record of the deletion request** (timestamp + opaque
  id) may be retained for compliance evidence.

Link this from the public privacy policy when the deletion UI ships.

## Related

- [[incident-response]] — a breach triggers the notification chain, not just a purge
- [[key-rotation]] — erasure of encrypted rows depends on which key encrypted them
- [[INDEX]]
