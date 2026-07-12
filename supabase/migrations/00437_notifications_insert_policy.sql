-- US-1926: remove the over-broad notifications INSERT policy.
--
-- 00007 created an INSERT policy labelled "Service role can insert notifications"
-- with `WITH CHECK (true)`. But the service-role client BYPASSES RLS entirely,
-- so that policy only ever governed anon/authenticated — meaning any logged-in
-- user could `POST /rest/v1/notifications` with an arbitrary user_id/title/
-- message/link and inject spam/phishing into ANY user's feed. Because the table
-- is on the supabase_realtime publication, injected rows push to the victim live.
--
-- Notifications are written exclusively by the service-role edge (which bypasses
-- RLS), so no client-facing INSERT policy is needed. Dropping it makes INSERT
-- deny-all for anon/authenticated while leaving the owner SELECT/UPDATE policies
-- and all service-role writes unchanged.

drop policy if exists "Service role can insert notifications" on public.notifications;

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00437') ON CONFLICT DO NOTHING;
