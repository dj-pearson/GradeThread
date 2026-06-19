# Garment Passport — Privacy & Data-Classification Model (US-1090)

The Garment Passport (CARFAX-for-clothing, epic US-1089→US-1106) captures a
garment's condition + ownership chain across grades and sales. It is built
**pseudonymous-by-default** so we get the resale chain **without holding
buyer/seller PII** — keeping the platform defensible and compliant. This is the
authoritative data-classification note for the epic (AC#1).

Pairs with: the US-268 tenant-isolation rule, US-276 upload hardening, and the
platform [`DATA_RETENTION.md`](DATA_RETENTION.md) / [`SECURITY.md`](SECURITY.md).

## Tables & classification (migration `00256_garment_passport_core.sql`)

| Table | Holds | PII? | Access |
|---|---|---|---|
| `garments` | passport identity: slug, `sku_class` (brand/model/size/colorway), status, `created_by` | **No** PII (sku_class is product, not person) | owner reads own via `created_by`; writes service-role only |
| `owner_nodes` | pseudonymous participants: `pseudonymous_label`, `kind`, `linked_user_id` (NULL) | **No** PII by design | **service-role only** (deny-all to anon/authenticated) |
| `garment_events` | append-only ledger: `event_type`, `actor_node_id`, `payload`, `confidence`, `source` | **No** PII (payloads are condition/listing facts) | owner reads via parent garment; **append-only** (no update/delete policy) |

## The rules

1. **Pseudonymous by default.** `owner_nodes` carry no name, email, address, or
   marketplace handle — only a stable label (`pseudonymousLabel()` →
   "Seller A", "Buyer B", "Owner 2", "System") and an enum `kind`.
2. **Identity linkage is opt-in and deferred.** `owner_nodes.linked_user_id` is
   nullable and stays unset until the explicit opt-in identity-reveal story
   (**US-1105**). Nothing in this epic writes it before then.
3. **Public surfaces expose ONLY pseudonymous labels** (AC#2). Never a user id,
   email, address, or handle. `isPseudonymousLabel()`
   (`services/edge-functions/src/lib/garment-passport.ts`) is the guard a public
   surface (passport page US-1093, "scan before you buy" US-1106) calls before
   rendering any label.
4. **Tenant-scoping (US-268).** All edge reads/writes on the three tables go
   through the **service-role client** and MUST be scoped to the workspace owner
   (`workspaceOwnerId ?? userId`), keyed off `garments.created_by`
   (`PASSPORT_TENANT_COLUMN`). RLS is the second line of defense: owner-scoped
   SELECT on `garments`/`garment_events`, deny-all on `owner_nodes`. The
   cross-tenant regression case for the passport endpoints lands with the edge
   API (US-1092) in `tenant-isolation_test.ts`.
5. **Retention / minimization of linkage inputs (AC#4).** Matching a garment
   across a sold→bought handoff sometimes needs a transient external identifier
   (e.g. an eBay order id). We **never store the raw value** — we store a
   **salted SHA-256** of it via `minimizeLinkageRef()` (salt =
   `PASSPORT_LINKAGE_SALT`). The digest lets us dedupe/match the handoff; the raw
   id (which can be correlated back to a person) is discarded. Raw marketplace
   order payloads are processed in-memory only and not persisted to passport
   rows. This follows the minimization posture in `DATA_RETENTION.md`.

## Why this is defensible

We can answer "what happened to this garment" (graded → listed → sold →
re-graded …) as a pseudonymous chain, but we **cannot** be compelled to reveal
who a buyer/seller was, because we never stored it — unless that person later
opts in (US-1105). The append-only ledger means history can be added to but not
silently rewritten.
