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
2. **Identity linkage is private; reveal is opt-in (US-1105).**
   `owner_nodes.linked_user_id` is a nullable **uuid linkage only** — set when a
   signed-in user claims/buys a garment (US-1094/1096/1100) so we can offer them
   reveal — and is **NEVER exposed on any public surface** (the passport read
   selects only `pseudonymous_label`/reveal fields, never the uuid). A hop stays
   pseudonymous unless its owner explicitly opts in: see "Opt-in identity reveal"
   below.
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

## Opt-in identity reveal (US-1105, migration `00265`)

A seller who wants public credit may **reveal their identity on a passport hop**
— but only ever their **own already-public GradeThread Verified handle**, never
an id, email, or address. The design makes an accidental PII leak structurally
impossible:

| Property | How it's enforced |
|---|---|
| **Off by default** | `owner_nodes.identity_revealed boolean NOT NULL DEFAULT false`. New nodes are pseudonymous. |
| **Double opt-in** | A reveal is the AND of (a) the per-hop `identity_revealed` flag and (b) the linked user's Verified profile being **public** (`verified_enabled` + handle). `effectiveRevealedIdentity()` (`garment-passport.ts`, pure + unit-tested) is the single gate; disabling **either** opt-in instantly re-pseudonymizes the hop. |
| **Per-hop** | Consent lives on each `owner_nodes` row (one per chain position), toggled independently via `POST /api/passport-identity/nodes/:id/reveal`. |
| **Reversible** | Setting `revealed:false` clears the flag + `identity_revealed_at` immediately. |
| **Only public fields** | The reveal surfaces `verified_handle` + `verified_display_name` — the same fields US-1101 already exposes for the origin seller. `linked_user_id` is never returned. |
| **Tenant-scoped** | Management routes scope every read/write to `linked_user_id = userId` (US-268). A caller can never reveal or read another account's nodes. |
| **Honored on export/delete (AC#3)** | `/api/account/export` includes the user's linked nodes + reveal flags. `/api/account/delete` explicitly clears `identity_revealed` + `linked_user_id` before the cascade (on top of the `ON DELETE SET NULL` FK), so no revealed handle can resolve after erasure. |

The management surface is the Verified page (`/dashboard/flipdesk/verified`),
under "Reveal your identity on passports" — disabled until the Verified profile
is public, since that's the handle a reveal shows.

## Why this is defensible

We can answer "what happened to this garment" (graded → listed → sold →
re-graded …) as a pseudonymous chain, but we **cannot** be compelled to reveal
who a buyer/seller was, because we never stored it — unless that person later
opts in (US-1105). The append-only ledger means history can be added to but not
silently rewritten.
