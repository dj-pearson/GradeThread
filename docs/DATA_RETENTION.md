# Data Retention & Deletion

How GradeThread handles user data lifecycle for GDPR / CCPA (US-275).

## Export (right to portability)

A signed-in user can export their own data via `GET /api/account/export`
(`services/edge-functions/src/routes/account.ts`): profile, submissions, grade
reports, inventory items, listings, sales, and sources, scoped to their
`user_id`. Returned as a downloadable JSON attachment.

## Deletion (right to erasure)

`delete_account()` RPC (migration `00043`) deletes the caller's `auth.users`
row; the `ON DELETE CASCADE` chain rooted at `public.users` wipes all
DB-resident user data (submissions, grade_reports, inventory_items, listings,
sales, sources, item_photos, marketplace_connections, api_keys, …).

### Not covered by the cascade — must be handled before/with deletion

These live outside the Postgres FK graph and need explicit cleanup (tracked as
remaining US-275 work):

- **Storage objects** — Supabase Storage (`submission-images`, `item-photos`
  per-user folders) is NOT FK-cascaded. Delete the user's folders.
- **Stripe customer** — delete or anonymize the `stripe_customer_id` customer
  in Stripe.
- **Marketplace OAuth tokens** — revoke at the source (eBay) before deleting
  the `marketplace_connections` row, so the grant doesn't linger on eBay's side
  (see `docs/INCIDENT_RESPONSE.md` for the revoke step).

The recommended implementation is an authed `POST /api/account/delete` edge
endpoint that performs the external cleanup (storage + Stripe + marketplace
revoke) and THEN calls `delete_account()` — so the cascade only runs after the
external side effects succeed.

## Retention

- **Active account data** is retained while the account exists.
- **On deletion**, DB data is removed immediately via the cascade; external
  cleanup (above) should run in the same flow.
- **Backups**: any database backups age out per the backup rotation policy;
  deleted data is purged from backups on that cycle.
- **A minimal, non-PII record of the deletion request** (timestamp + opaque
  id) may be retained for compliance evidence.

Link this from the public privacy policy when the deletion UI ships.
