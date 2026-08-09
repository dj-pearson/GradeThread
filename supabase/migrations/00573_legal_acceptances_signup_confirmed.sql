-- US-2116 AC4: name the confirmation method in the schema itself.
--
-- COMMENT ONLY. No table, column, constraint, index, policy or function
-- changes. `method` has always been plain text with no CHECK, so the new value
-- writes today without this file — what it fixes is that 00142:44 documents
-- three values and the code now writes four, and an applied migration cannot be
-- edited to say otherwise.
--
-- Why bother for a comment: this column is the answer to "what did this user
-- agree to, and how do you know?". Whoever asks that will be reading the table
-- directly, in an incident or a request, not reading TypeScript. A comment that
-- lists three of four values tells them the fourth is unexpected data.
--
-- The two rows, and why there are two:
--   signup_clickwrap            written by handle_new_user (00142:119-127), a
--                               Postgres trigger, so no IP and no user-agent —
--                               and its versions and timestamp come from
--                               raw_user_meta_data, i.e. from the browser.
--                               GUARANTEED but WEAK.
--   signup_clickwrap_confirmed  written by POST /api/legal/confirm-signup on
--                               the first authenticated session, with the IP
--                               and user-agent the edge observed itself, and
--                               the versions COPIED off the row above.
--                               BEST-EFFORT but STRONG.
--
-- Read them as a pair. The second is NOT a claim about the signup request: it
-- says the holder of this account was authenticated from this address at this
-- time, corroborating the clickwrap beside it. Its accepted_at is when the
-- server observed the session, not when consent was given. Conflating those is
-- the one way this row could overstate what we know, which is why the method
-- values are different strings rather than one value with a null IP.
--
-- Rules: services/edge-functions/src/lib/signup-consent-evidence.ts.

COMMENT ON COLUMN public.legal_acceptances.method IS
  'US-377 / US-2116: how consent was captured. signup_clickwrap (email signup, '
  'written by the handle_new_user trigger — no IP or user-agent, because a '
  'trigger has no request) | signup_clickwrap_confirmed (first authenticated '
  'session after that signup, with server-observed IP and user-agent and the '
  'versions copied off the clickwrap row; accepted_at is when the server '
  'OBSERVED the session, not when consent was given) | oauth_clickwrap (legal '
  'gate, first access) | reacceptance (legal gate, version bump). The first two '
  'are a pair: one is guaranteed and weak, the other best-effort and strong.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00573') on conflict do nothing;
