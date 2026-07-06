-- US-1663: add 'vinted' to the listing_platform enum.
--
-- Vinted is a large secondhand marketplace with NO public listing API, so it
-- joins FlipDesk as an EXTENSION-mechanism channel (like Poshmark/Mercari/
-- Grailed, US-716): listed from the seller's own logged-in tab via the
-- GradeThread Lister extension — there is NO edge OAuth connector. But the enum
-- value is still required so listings.platform can carry 'vinted' and the
-- Listing Kit / cross-list surfaces can map a Vinted sibling.
--
-- Idempotent (US-1108): ADD VALUE IF NOT EXISTS is safe to re-run. NOT wrapped
-- in a transaction (an enum value added inside a transaction cannot be used in
-- that same transaction; this migration never uses it). Depends on 00002 (enum).

ALTER TYPE public.listing_platform ADD VALUE IF NOT EXISTS 'vinted';

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00377')
ON CONFLICT (version) DO NOTHING;
