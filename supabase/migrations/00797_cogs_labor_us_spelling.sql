-- US-3256: the seeded cogs_labor row is spelled the British way and the form it
-- names is American.
--
-- 00684 seeded this account as "Labour that went into the goods". The line it
-- maps to is Schedule C Part III line 37, whose own label is "Cost of labor",
-- so the US spelling is the correct one and the TypeScript chart
-- (src/lib/chart-of-accounts.ts) has always had it right. 00684 is applied and
-- immutable, so the seed is corrected here.
--
-- Nothing in src/ or services/edge-functions/src/ reads ledger_accounts.name
-- today, so no seller has ever seen the wrong word. The cost was that
-- src/lib/chart-of-accounts.test.ts -- whose whole job is keeping the shipped
-- chart and the seeded chart in lockstep -- was failing on this one field, and
-- a guard that is red is a guard that is checking nothing.
--
-- WHY THIS IS AN UPSERT AND NOT THE OBVIOUS ONE-LINE UPDATE. That test reads
-- the seeded chart by parsing the seed blocks out of the migrations, later
-- files winning. A bare UPDATE is invisible to that parse, so it would have
-- corrected production and left the guard red forever, which is the worst of
-- both. 00691 already extends the chart this way.
--
-- Keyed on ledger_accounts_system_code_idx, the partial unique index over
-- (code) WHERE user_id IS NULL, so a seller's own sub-account sharing this code
-- is untouched. Re-running is a no-op: the row is written to the value it
-- already holds.

INSERT INTO public.ledger_accounts
  (code, name, flow, schedule_c_part, schedule_c_line, schedule_c_label,
   no_line_reason, is_system, sort_order)
VALUES
  ('cogs_labor', 'Labor that went into the goods', 'cogs', 'III', '37',
   'Cost of labor', NULL, true, 220)
ON CONFLICT (code) WHERE user_id IS NULL DO UPDATE SET
  name             = EXCLUDED.name,
  flow             = EXCLUDED.flow,
  schedule_c_part  = EXCLUDED.schedule_c_part,
  schedule_c_line  = EXCLUDED.schedule_c_line,
  schedule_c_label = EXCLUDED.schedule_c_label,
  no_line_reason   = EXCLUDED.no_line_reason,
  sort_order       = EXCLUDED.sort_order,
  updated_at       = now();

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00797') on conflict do nothing;
