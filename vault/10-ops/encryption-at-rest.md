---
title: Encryption at rest
aliases: [encryption at rest, at-rest encryption, security questionnaire]
type: reference
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/crypto-aes.ts
  - services/edge-functions/src/lib/api-key.ts
  - services/edge-functions/src/lib/recovery-codes.ts
  - services/edge-functions/src/lib/cert-integrity.ts
  - services/edge-functions/src/lib/measure-card-pii.ts
  - services/edge-functions/src/lib/user-shipping-pii.ts
  - scripts/ops/backup-postgres.sh
  - scripts/ops/backup-storage.sh
reviewed: 2026-08-12
tags: [security, encryption, compliance, pii]
summary: Exactly which GradeThread data is encrypted at rest, by what mechanism, and with which key reference — plus the gaps, stated plainly.
---

# Encryption at rest

Answer an enterprise security questionnaire from this page instead of from a
fresh code audit. A fresh audit under time pressure is how a posture gets
overstated, and an overstatement in a signed questionnaire is a much more
expensive mistake than a disclosed gap.

**The one-line summary: OAuth tokens, a handful of cache values, and the seller's
postal address and phone are encrypted by the application. Nothing else is.**
Photos, the rest of the database rows, offsite backups and the Postgres volume
itself sit in plaintext on disk. That is a real posture with real limits, and
this note states them rather than leaving a reviewer to find them.

The address and phone half is newer than the rest (US-2417) and its **backfill
has not been run**, so historical rows are still plaintext. Read the caveat under
the column table before answering a question about them.

Offsite backups are the one item mid-change: the encryption is written and
verified but not yet deployed, so today's answer is still "plaintext". Details
below — do not upgrade that answer until the key exists on the host.

> [!info] What this note does and does not own
> It owns the **inventory**: what is encrypted, where, and which key reference
> covers it. It does not own key rotation ([[key-rotation]]), backup operations
> ([[backups]]), retention and erasure ([[data-retention]]), private-bucket
> access ([[qa-photo-access]]) or the env var index ([[env-reference]]). Those
> notes are the authority on their own subjects; this one links rather than
> restates, per `vault/CONTRACT.md`.

## The stores

| Store | Holds | Encrypted at rest? | Mechanism | Key reference |
|---|---|---|---|---|
| Postgres volume (self-hosted Supabase, Contabo VPS via Coolify) | Every table below | **No** | — | — |
| Supabase Storage volume (`STORAGE_DIR`) | All eight buckets | **No** | — | — |
| Offsite backups (Cloudflare R2, bucket `gradethread-backups`) | `pg_dump` + a raw storage sync | **Mechanism yes, production not yet** | `age` public-key on the dump; rclone `crypt` remote for the storage mirror — both enforced by the scripts, which now refuse to upload plaintext (US-2416) | `BACKUP_AGE_RECIPIENT` / `BACKUP_AGE_IDENTITY` (see [[key-rotation]]) |
| Selected DB columns | OAuth tokens, cache values | **Yes** | AES-256-GCM, per-row AAD | `EDGE_ENCRYPTION_KEY` (see [[key-rotation]]) |
| Selected DB columns | Secrets never needed back | Not applicable — **hashed**, not encrypted | SHA-256 / HMAC-SHA256 | `API_KEY_PEPPER`, `CERT_SIGNING_KEY`, two salts |

The eight storage buckets and their public/private state are listed in
[[listing-photos]] and [[image-intake]]; the access rule for the private ones is
[[qa-photo-access]]. No bucket applies server-side object encryption — there is
no `[storage]` section in `supabase/config.toml` and no `x-amz-server-side-encryption`
header anywhere in the upload path. Bucket privacy is an **authorization**
control, not a confidentiality-at-rest control: a private bucket protects
objects from the network, not from anyone holding the disk.

## Application-layer encrypted columns

One helper, `services/edge-functions/src/lib/crypto-aes.ts`: AES-256-GCM, a
fresh 96-bit IV per value, and the authentication tag covering additional
authenticated data (AAD). The AAD is the owning `user_id`, so a ciphertext
lifted onto another tenant's row **fails to decrypt** rather than decrypting
into the wrong account — the isolation property, not just the confidentiality
one. Two stored formats exist (`v2:` current and keyed, `v1:` legacy and
decrypt-only); [[key-rotation]] owns both and owns the dual-key rotation path.

| Table | Column | AAD bound to |
|---|---|---|
| `marketplace_connections` | `access_token_encrypted` | `user_id` |
| `marketplace_connections` | `refresh_token_encrypted` | `user_id` |
| `google_connections` | `access_token_enc` | `user_id` |
| `google_connections` | `refresh_token_enc` | `user_id` |
| `google_photos_connections` | `refresh_token_enc` | `user_id` |
| `google_photos_import_sessions` | `access_token_enc` | the **session id** |
| `edge_shared_cache` | `value` (value rows) | the cache key |
| `measure_card_requests` | `ship_name`, `address_line1`, `address_line2`, `city`, `postal_code` | the owner `user_id` |
| `users` | `ship_from_address` (jsonb, stored as an envelope string) | the owner `user_id` |
| `users` | `business_phone` | the owner `user_id` |

`marketplace_connections` is shared by all five marketplace connectors — eBay,
Etsy, Depop, Shopify and Whatnot — so one row shape covers every seller
marketplace token. `edge_shared_cache` encrypts by default; the flag can be
disabled per cache and no current caller does.

The last three rows are the US-2417 PII columns, handled by
`lib/measure-card-pii.ts` and `lib/user-shipping-pii.ts` rather than by calling
`crypto-aes.ts` directly. Two things a questionnaire answer has to say about
them:

- **`measure_card_requests.state` and `.country` are deliberately NOT encrypted.**
  The fulfilment export filters by region, and encrypting those two would turn a
  filtered query into a full-table decrypt. That is a stated trade, not an
  oversight — see `measure-card-pii.ts:31`.
- **Ciphertext is complete only once the backfills have run.** New writes go
  through the helpers, but historical rows stay plaintext until
  `scripts/backfill-measure-card-pii.ts` and `scripts/backfill-user-shipping-pii.ts`
  are run against prod with `EDGE_ENCRYPTION_KEY` set. Both read paths tolerate
  either form, so the mixed state is safe — but "these columns are encrypted" is
  only true of the whole table after the backfill. Check before answering.

That table is the complete list. There is no `pgcrypto` usage anywhere and no
other ciphertext column in `supabase/migrations/`.

## Hash-only columns — not reversible, and not "encryption"

These hold a one-way digest. There is no key that recovers the original, which
means a database disclosure does not disclose the underlying secret. Worth
naming separately on a questionnaire, because "encrypted" is the wrong word and
using it invites a follow-up question you then have to walk back.

| Table.column | Digest |
|---|---|
| `api_keys.key_hash` | HMAC-SHA256, peppered (`API_KEY_PEPPER`); plain SHA-256 if the pepper is unset |
| `mfa_recovery_codes.code_hash` | SHA-256 |
| `passport_claim_tokens.token_hash` | SHA-256 |
| `passport_claim_attempts.token_hash` / `.source_hash` | SHA-256; the source hash is salted |
| `owner_nodes.linkage_hash` | Salted SHA-256 (`PASSPORT_LINKAGE_SALT`) — see [[garment-passport-privacy]] |
| `share_events.sharer_hash`, `badge_click_events.visitor_hash` | Salted SHA-256 (`SHARE_FINGERPRINT_SALT`) |
| `grade_reports.content_hash` / `.content_signature` | SHA-256, then HMAC-SHA256 over it (`CERT_SIGNING_KEY`) — integrity, not confidentiality |

Preview, extension and email-engagement tokens are stateless HMACs verified on
presentation and stored nowhere at all.

`ai_usage_events.prompt_hash` is **not** a security hash — its own migration
calls it a fast non-cryptographic fingerprint. Do not cite it as one.

## What is NOT encrypted at the column level

Stated deliberately. An omission a reviewer discovers themselves costs far more
than one disclosed up front, and the honest version is defensible: the volume is
the control, and the volume is currently the gap.

- **Postal addresses, partly** — `measure_card_requests.state` and `.country`
  only. The other five (`ship_name`, `address_line1`, `address_line2`, `city`,
  `postal_code`) moved to AES-GCM under `EDGE_ENCRYPTION_KEY` in US-2417; `state`
  and `country` stay plaintext **on purpose**, because the fulfilment export
  filters by region and encrypting them would make that a full-table decrypt.
- **Phone numbers** — `consignors.contact_phone`. (`users.business_phone` is
  encrypted, US-2417.)
- **Identity and contact** — `users.email` / `full_name` / `business_name`,
  `consignors.name` / `contact_email`, `guarantee_claims.claimant_*`,
  `sales.buyer_username` / `buyer_notes`, `workspace_invitations.email`,
  `google_connections.google_email`.
- **Some tokens that are neither encrypted nor hashed** —
  `workspace_invitations.token` (plaintext with a UNIQUE index, unlike every
  other single-use token in the codebase), `push_device_tokens.device_token`,
  `push_subscriptions.p256dh` / `.auth`, `users.google_purchase_token`,
  `google_oauth_states.state` (single-use, 10-minute TTL, deleted on use).
- **All uploaded imagery** — grading submissions, listing photos, avatars,
  certificate assets, authenticity references.

Closing the address and phone half is tracked; so is the volume. See
[[blocked-work-gates]] for how launch-blocking security work is sequenced.

### Why this is acceptable today, and where it stops being acceptable

Column-level encryption defends against a **database-only** disclosure: a SQL
injection, an over-broad service-role query, a leaked read replica. The OAuth
tokens get it because a stolen marketplace token lets an attacker act as the
seller on eBay — the damage happens somewhere we do not control and cannot
revoke ([[incident-response]] records that rotating `EDGE_ENCRYPTION_KEY` alone
does not invalidate the eBay tokens themselves).

It does **not** defend against physical or host-level access. That is the
volume's job, and the volume is unencrypted, so a reclaimed or pulled VPS disk
yields everything above in plaintext (US-2415, still open).

The offsite backups were the same gap and are **half closed**. US-2416 built the
mechanism: `backup-postgres.sh` encrypts the dump to an `age` recipient before
`rclone copy` and aborts rather than uploading plaintext, `backup-storage.sh`
refuses a non-`crypt` remote, and `restore-postgres.sh` plus the drill decrypt
and were verified end to end on 2026-08-08 (drill log in [[backups]]).

Be precise about what that does and does not change for a customer answer:
**production is still shipping plaintext** until somebody generates the keypair
and deploys the updated scripts to the DB host. The code cannot regress back to
plaintext; the running system has not moved yet. Describe it as in progress, not
as covered.

## Compliance posture — as it actually is

- **No SOC 2 attestation.** None in progress. Do not imply one.
- **No ISO 27001.**
- **No customer-managed keys / BYOK.** A single platform key per environment.
- **DPA published** at `/dpa`; **subprocessor list published** at
  `/subprocessors` (both shipped by US-523).
- **No public trust or security page** beyond `SECURITY.md` in the repo.

> [!warning] One published claim is broader than the evidence
> `SECURITY.md` states the truth precisely: "Marketplace OAuth tokens are
> encrypted at rest (AES-256-GCM)." The privacy policy's "encryption at rest for
> sensitive fields" is defensible. The **DPA**'s unqualified "encryption in
> transit/at rest" is not — it rests entirely on a host disk this repo cannot
> evidence is encrypted. Either narrow that sentence or close the volume gap;
> leaving both is the version that is hard to defend.

## Related

- [[key-rotation]] — the encryption key itself: env vars, formats, rotation
- [[backups]] — what is backed up, where it goes, and the restore drill
- [[data-retention]] — how long data lives and how erasure works
- [[qa-photo-access]] — reaching private-bucket images without breaking the rule
- [[env-reference]] — the env var index, including every key named here
- [[incident-response]] — breach containment, including token-rotation limits
- [[garment-passport-privacy]] — the salted linkage hash in context
- [[INDEX]]
