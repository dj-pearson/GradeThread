-- Stop a signed-up stranger enumerating the five public buckets (US-3403).
--
-- READ vault/10-ops/storage-anon-enumeration.md FIRST. The fact people get
-- backwards, and the only reason this migration is safe: a public bucket's
-- read is served on a SUPERUSER connection after storage-api checks
-- buckets.public, so `GET /object/public/<bucket>/<path>` consults no policy
-- at all. The SELECT policy on storage.objects gates exactly three things --
-- POST /object/list, POST /object/sign, and metadata. So narrowing these
-- CANNOT take a listing image, an avatar, a certificate asset or a blog
-- image dark. It only stops someone walking the tree.
--
-- WHAT WAS WRONG. All five were written as `USING (bucket_id = '<name>')`
-- with no TO clause, and a policy with no TO applies to EVERY role including
-- anon. pg_policies shows `{public}`, which reads as "this is the public-read
-- policy, of course it says public". Measured against prod 2026-09-11: the
-- anon key that ships in the deployed frontend bundle listed 7,057 objects in
-- item-photos (3.5 GB), 124 in content-images and 44 in cert-assets.
--
-- IT DOES NOT ASSUME 00794 HAS RUN, and that is deliberate rather than
-- defensive. 00794 is on no remote branch and the directory jumps 00793 to
-- 00796. A file that only narrowed the four smaller buckets would have tidied
-- two EMPTY ones while leaving the 3.5 GB one open to anon. So this is
-- DROP IF EXISTS then CREATE for all five, correct whether 00794 ever lands
-- and a no-op to re-run.
--
-- THE DECISION FOR EACH BUCKET, because US-3397 declined to guess and the
-- answer is different per bucket:
--
--   item-photos     the seller who owns the folder, or a member of that
--                   seller's workspace. Enumeration by a stranger exposes
--                   another seller's whole catalogue shape, which is the
--                   3.5 GB finding.
--   avatars         the owner of the folder. Public display is unaffected;
--                   what goes away is listing every user id that has one.
--   cert-assets     admins only. A certificate is meant to be SHAREABLE, not
--                   DISCOVERABLE IN BULK -- a list is every certificate id we
--                   have ever issued. Nothing in the app lists or signs this
--                   bucket; the certificate page renders through
--                   /object/public.
--   content-images  admins only, which is who its INSERT, UPDATE and DELETE
--   content-videos  policies already name. Published marketing imagery is
--                   fetched by URL, never enumerated, and the admin content
--                   editor is the one caller that could ever want a list.
--
-- NOTHING IN THE APP LOSES A CAPABILITY, checked rather than assumed: the
-- only `.list()` in the tree is account-storage-purge.ts, which runs on the
-- service-role client and bypasses RLS, and every client-side
-- `createSignedUrl` targets `submission-images`, a private bucket with its
-- own owner policy. src/test/storage-public-read-scope.test.ts pins both.
--
-- `(select auth.uid())` rather than a bare call, so the planner hoists it to
-- an InitPlan and evaluates it once per query instead of once per candidate
-- row (US-1927).
--
-- THE FOLDER-SHAPE GUARD IS LOAD-BEARING. `((storage.foldername(name))[1])::uuid`
-- RAISES on a path whose first segment is not a uuid, and in a SELECT policy
-- that failure is not row-local: it fails the whole list for everybody. The
-- existing UPDATE and DELETE policies carry the same cast without a guard,
-- which is survivable there because they run against one named object. Here
-- it is not, so the cast happens only after the segment is known to look like
-- a uuid.

-- ── item-photos ────────────────────────────────────────────────────
DROP POLICY IF EXISTS "item-photos public read" ON storage.objects;
CREATE POLICY "item-photos public read"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'item-photos'
    AND (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    AND (
      (storage.foldername(name))[1] = (select auth.uid())::text
      OR public.is_workspace_member(((storage.foldername(name))[1])::uuid)
    )
  );

-- ── avatars ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "avatars public read" ON storage.objects;
CREATE POLICY "avatars public read"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- ── cert-assets ────────────────────────────────────────────────────
DROP POLICY IF EXISTS "cert-assets public read" ON storage.objects;
CREATE POLICY "cert-assets public read"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'cert-assets'
    AND public.is_admin()
  );

-- ── content-images ─────────────────────────────────────────────────
DROP POLICY IF EXISTS "content-images public read" ON storage.objects;
CREATE POLICY "content-images public read"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'content-images'
    AND public.is_admin()
  );

-- ── content-videos ─────────────────────────────────────────────────
DROP POLICY IF EXISTS "content-videos public read" ON storage.objects;
CREATE POLICY "content-videos public read"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'content-videos'
    AND public.is_admin()
  );

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00807') on conflict do nothing;
