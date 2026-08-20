-- 00639 — remove the names derived from listing TITLES (US-2751)
--
-- Until now, a `consensus` row in style_code_names was the run of words that
-- most eBay listing TITLES shared for a code. The owner rejected that method,
-- correctly:
--
--   A title is marketing text. A seller who bought the garment with no tag
--   beyond a size dot writes "Lululemon Align Legging 25 Black Size 6" because
--   that is their best guess, and a consensus over guesses is a confident
--   guess. And our OWN sellers publish to eBay with titles our AI wrote, so
--   reading them back counted our guesses as independent corroboration —
--   three copies of one guess, agreeing because they share an author.
--
-- The sweep now learns only from listings that DECLARE the style code in a
-- structured field (Style Code / MPN) and name a product in one (Model). Those
-- rows carry the same `consensus` source, because the source is still "the
-- marketplace"; what changed is what counts as evidence from it.
--
-- ── WHY DELETE RATHER THAN KEEP AND RE-DERIVE OVER THE TOP ──────────────────
--
-- The two generations are indistinguishable by source alone, so leaving them
-- means a name a reseller sees might be either, and nobody can tell which. The
-- whole point of this change is that the index stops holding answers we do not
-- stand behind.
--
-- Nothing is lost that cannot be regained: the sweep re-derives a code once it
-- is below the confirmation floor, and 00627's cooldown lets a code that
-- previously resolved be re-asked. A code whose name disappears today comes
-- back when a listing actually declares it — and if none ever does, we did not
-- know it in the first place.
--
-- Deliberately narrow: `seller`, `admin`, `official` and `public` rows are
-- untouched. Those came from people, not from prose.

DELETE FROM public.style_code_names WHERE source = 'consensus';

-- The observation rows in 00503 are NOT deleted. A title is still evidence —
-- weak evidence, correctly labelled — and an admin looking at a code should be
-- able to see what the market called it even when that is not good enough to
-- publish. They simply no longer become names on their own.

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00639') on conflict do nothing;
