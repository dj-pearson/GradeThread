-- The cross-channel matches a human has to decide (US-3197 AC4/AC7).
--
-- Universal Import joins a Poshmark listing and an eBay listing of ONE
-- physical garment onto one item. `cross-channel-link.ts` decides a pair and
-- `cross-channel-link-plan.ts` decides which joins happen; both are pure and
-- unit-tested, and both deliberately refuse more than they accept. What they
-- refuse has to go somewhere, and this is it.
--
-- WHY A TABLE AND NOT A RECOMPUTE. The queue is a screen a seller works
-- through over days, and the decision depends on rows that change under them:
-- a listing sells, a price moves, the importer runs again. Recomputing the
-- list on every open would reshuffle it, resurrect pairs they already split,
-- and lose the reasons they were shown when they made the call. A resolved
-- row is also the only record that a human said no -- without it the next
-- import proposes the same merge forever.
--
-- NOTHING MERGES WITHOUT A CONFIRMATION, which is the whole of AC4. A row
-- here is a QUESTION, never a pending action: no job drains this table, and
-- `status` moves off 'pending' only when a person answers.
--
-- THE PAIR IS CANONICAL, so a second import run cannot ask twice. The unique
-- index is on the ORDER-INDEPENDENT pair, because the plan's keeper-first
-- ordering is stable today and a uniqueness rule that depends on that would
-- silently start duplicating if the anchor rule ever changed.
--
-- THE UNDO LIVES ON THE ROW, and that is a granularity decision rather than a
-- convenience. flipdesk_import_effects reverses a whole RUN; a seller who
-- confirms twenty joins and regrets one wants THAT ONE back, not the scan.
-- So a confirmed row keeps the writes it made, with the values they
-- overwrote, and splitting an already-linked pair replays them backwards.
--
-- Deny-all RLS, service-role only, registered in SERVICE_ROLE_ONLY in
-- rls-guard_test.ts. A readable row names two of the seller's listings and a
-- similarity score, which is theirs; a WRITABLE one would let a caller
-- manufacture a merge question against another tenant's listings, and the
-- confirm route acts on what this row names.

CREATE TABLE IF NOT EXISTS public.flipdesk_cross_channel_link_reviews (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The workspace owner. Every read and write is scoped on this (US-268).
  owner_user_id  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Keeper first, in the plan's own ordering: the older item anchors a join,
  -- so `a` is the row that would keep its inventory item if confirmed.
  listing_a_id   uuid NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  listing_b_id   uuid NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  item_a_id      uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  item_b_id      uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  -- 0..1 from decideLink. Stored so the queue can rank, and so a later change
  -- to the weights is visible as a disagreement rather than as a silent shift.
  score          numeric(4,3) NOT NULL,
  -- The words the seller was shown, frozen. Re-deriving them later would
  -- describe rows that have since changed.
  reasons        jsonb NOT NULL DEFAULT '[]'::jsonb,
  status         text NOT NULL DEFAULT 'pending',
  -- What a confirmation CHANGED, with the values it overwrote, exactly as
  -- cross-channel-link-writes.ts emits them. This is where the unmerge button
  -- comes from, and it is per PAIR rather than per run on purpose: a seller
  -- who confirms twenty joins and regrets one wants that one back, and
  -- flipdesk_import_effects' undo reverses a whole run. Null until confirmed.
  applied_writes jsonb,
  resolved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.flipdesk_cross_channel_link_reviews
  DROP CONSTRAINT IF EXISTS flipdesk_cross_channel_link_reviews_status_check;
ALTER TABLE public.flipdesk_cross_channel_link_reviews
  ADD CONSTRAINT flipdesk_cross_channel_link_reviews_status_check
  CHECK (status IN ('pending', 'linked', 'split'));

-- A pair of one row with itself is not a question, it is a bug upstream.
ALTER TABLE public.flipdesk_cross_channel_link_reviews
  DROP CONSTRAINT IF EXISTS flipdesk_cross_channel_link_reviews_distinct_check;
ALTER TABLE public.flipdesk_cross_channel_link_reviews
  ADD CONSTRAINT flipdesk_cross_channel_link_reviews_distinct_check
  CHECK (listing_a_id <> listing_b_id);

-- ORDER-INDEPENDENT, deliberately. least/greatest rather than (a, b), so the
-- same pair asked the other way round collides instead of creating a second
-- question. This is what makes a re-import idempotent at the review layer,
-- the way (platform, platform_listing_id) already is at the import layer.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cross_channel_link_reviews_pair
  ON public.flipdesk_cross_channel_link_reviews (
    owner_user_id,
    least(listing_a_id, listing_b_id),
    greatest(listing_a_id, listing_b_id)
  );

-- The queue read: this seller's open questions, best match first.
CREATE INDEX IF NOT EXISTS idx_cross_channel_link_reviews_open
  ON public.flipdesk_cross_channel_link_reviews (owner_user_id, status, score DESC);

ALTER TABLE public.flipdesk_cross_channel_link_reviews ENABLE ROW LEVEL SECURITY;
-- No policy in either direction. The seller reads and answers through an
-- authenticated edge route that scopes by owner; a policy here would add a
-- second path to the same rows with its own drift.

-- US-3355: RLS is not the only layer, and a deny-all table with a wide-open
-- grant is one `create policy` away from being readable. The REVOKE makes the
-- privilege match the intent rather than relying on the absence of a policy.
REVOKE ALL ON public.flipdesk_cross_channel_link_reviews FROM anon, authenticated;

DROP TRIGGER IF EXISTS set_cross_channel_link_reviews_updated_at
  ON public.flipdesk_cross_channel_link_reviews;
CREATE TRIGGER set_cross_channel_link_reviews_updated_at
  BEFORE UPDATE ON public.flipdesk_cross_channel_link_reviews
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00808') on conflict do nothing;
