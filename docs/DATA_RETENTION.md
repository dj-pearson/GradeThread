# Data Retention & Deletion

How GradeThread handles user data lifecycle for GDPR / CCPA (US-275).

## Export (right to portability)

A signed-in user can export their own data via `GET /api/account/export`
(`services/edge-functions/src/routes/account.ts`): profile, submissions, grade
reports, inventory items, listings, sales, and sources, scoped to their
`user_id`. Returned as a downloadable JSON attachment.

## Deletion (right to erasure)

The authed **`POST /api/account/delete`** edge endpoint (`routes/account.ts`)
performs the full teardown. The Settings page exposes it via a "Delete account"
card requiring the user to type `DELETE MY ACCOUNT`. The endpoint:

1. Removes the user's Supabase Storage objects (`submission-images`,
   `item-photos`) — derived from the owned DB rows before the cascade runs.
2. Deletes the Stripe customer (which also cancels any active subscription).
3. Deletes the `auth.users` row via the admin API; the `ON DELETE CASCADE`
   chain rooted at `public.users` then wipes all DB-resident user data
   (submissions, grade_reports, inventory_items, listings, sales, sources,
   item_photos, marketplace_connections, api_keys, …).

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

## Retention

- **Active account data** is retained while the account exists.
- **On deletion**, DB data is removed immediately via the cascade; external
  cleanup (above) should run in the same flow.
- **Backups**: database and storage backups age out per the retention policy
  in `BACKUPS.md` (7 days local, 30 days offsite); deleted data is therefore
  purged from all backups within 30 days.
- **A minimal, non-PII record of the deletion request** (timestamp + opaque
  id) may be retained for compliance evidence.

Link this from the public privacy policy when the deletion UI ships.
