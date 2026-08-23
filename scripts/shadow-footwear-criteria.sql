-- US-2810 — shadow the footwear category criteria on live traffic.
--
-- WHY THIS EXISTS. US-2222 wrote category criteria for sneakers, boots and
-- sandals behind GRADING_CATEGORY_CRITERIA_V2, and that flag cannot be turned
-- on because the golden-set eval gate has no human-corrected footwear cases to
-- judge it with. Shadow is the way out of that bootstrap: it measures a
-- candidate on live traffic and publishes nothing, so it runs BEFORE the gate
-- rather than after, and the divergences it records are the raw material for
-- the cases the gate is missing.
--
-- NOTHING HERE FLIPS GRADING_CATEGORY_CRITERIA_V2. No published grade moves.
-- The shadow path writes to grading_shadow_results and touches neither
-- grade_reports nor submissions, which is asserted in
-- services/edge-functions/src/tests/grading-shadow-per-image_test.ts and
-- sabotage-verified rather than left as a comment.
--
-- ⚠ THIS SQL ALONE DOES NOTHING. PER_IMAGE_SHADOW_DAILY_VISION_CAP is the hard
-- stop and it is OFF by default: unset, non-numeric and negative all read as 0,
-- and 0 means no shadow run happens at all. Set it to your chosen daily ceiling
-- in Coolify FIRST, or every query in §3 will correctly report nothing and you
-- will not know why.
--
-- COST, so §1 is a decision and not a default. Each sampled submission costs one
-- vision call PER PHOTO plus one composite. At four photos that is five calls a
-- submission, so a 200-call day is roughly 40 sampled submissions. Sample rate
-- and daily cap multiply: the cap is what actually bounds the bill.
--
-- Run order: §1 (set the rows) → wait a sampling window → §2 (did it run) →
-- §3 (if not, which of the two reasons) → §4 (what it cost and found).

-- ─────────────────────────────────────────────────────────────────────────
-- §1  The candidate rows. Idempotent: re-running updates the rate and cap
--     rather than creating a second candidate per category.
-- ─────────────────────────────────────────────────────────────────────────
--
-- block_text is EMPTY ON PURPOSE. Empty means "use the code default text but
-- attribute the run to this version_name", which is exactly what is wanted here
-- — the V2 criteria already live in code and duplicating them into a row would
-- create a second copy to keep in step.
--
-- block_key is COPIED, not typed. The vocabulary is closed and lives in
-- prompt-blocks.ts PROMPT_BLOCK_KEYS; a row naming a key the code does not know
-- is INERT, never an error. That is the failure §3 exists to detect.
--
-- shadow_sample_rate: 0.05 = five percent of footwear submissions. Change it
-- here before running if you want a different slice; it is deliberately not a
-- default anywhere.

insert into public.ai_prompt_block_versions
  (version_name, stage, block_key, garment_scope, block_text,
   is_shadow, shadow_sample_rate, shadow_daily_cap, notes)
values
  ('category_criteria_sneakers_v2', 'per_image', 'category_criteria',
   'sneakers', '', true, 0.05, 60,
   'US-2810 shadow only. Attributes the code-default V2 text; publishes nothing.'),
  ('category_criteria_boots_v2', 'per_image', 'category_criteria',
   'boots', '', true, 0.05, 60,
   'US-2810 shadow only. Attributes the code-default V2 text; publishes nothing.'),
  ('category_criteria_sandals_v2', 'per_image', 'category_criteria',
   'sandals', '', true, 0.05, 60,
   'US-2810 shadow only. Attributes the code-default V2 text; publishes nothing.')
on conflict do nothing;

-- Re-running should not silently keep an old rate, so set them explicitly. This
-- is also the lever for turning the sampling DOWN without deleting the rows.
update public.ai_prompt_block_versions
   set is_shadow          = true,
       shadow_sample_rate = 0.05,
       shadow_daily_cap   = 60,
       -- Belt and braces: a shadow candidate must never be the champion, and
       -- these two columns are what would make it one.
       is_active          = false,
       is_canary          = false
 where block_key = 'category_criteria'
   and stage     = 'per_image'
   and garment_scope in ('sneakers', 'boots', 'sandals');

-- ─────────────────────────────────────────────────────────────────────────
-- §2  Did it run? (AC3)
-- ─────────────────────────────────────────────────────────────────────────

-- (a) The rows as the database now holds them. Read block_key with your eyes:
--     it must be exactly `category_criteria`. Anything else is inert.
select version_name,
       stage,
       block_key,
       garment_scope,
       block_text = '' as uses_code_default,
       is_shadow,
       shadow_sample_rate,
       shadow_daily_cap,
       is_active,
       is_canary,
       created_at
  from public.ai_prompt_block_versions
 where block_key = 'category_criteria'
   and garment_scope in ('sneakers', 'boots', 'sandals')
 order by garment_scope;

-- (b) Shadow runs recorded in the last 7 days, per candidate. Rows here mean
--     the whole chain works. No rows means §3.
select shadow_prompt_version_name,
       count(*)                                  as runs,
       sum(vision_calls)                         as vision_calls,
       count(*) filter (where tier_agreement)    as tier_agreed,
       count(*) filter (where not tier_agreement) as tier_diverged,
       count(*) filter (where error is not null) as errored,
       min(created_at)                           as first_run,
       max(created_at)                           as last_run
  from public.grading_shadow_results
 where created_at >= now() - interval '7 days'
   and stage = 'per_image'
   and shadow_prompt_version_name like 'block:category_criteria%'
 group by shadow_prompt_version_name
 order by shadow_prompt_version_name;

-- ─────────────────────────────────────────────────────────────────────────
-- §3  Nothing ran. Which of the two reasons? (AC3)
-- ─────────────────────────────────────────────────────────────────────────
--
-- THIS IS THE QUERY THE STORY IS REALLY ABOUT. "No shadow rows" has two causes
-- that look identical from grading_shadow_results: the candidate rows are inert
-- (wrong block_key, is_shadow false, rate 0, cap 0, or the env var unset), or
-- no footwear was graded at all in the window. One is a bug to fix and the
-- other is a reason to wait, and telling them apart from the results table is
-- impossible because both produce zero rows.
--
-- So count the TRAFFIC instead. If this returns real numbers and §2(b) returned
-- nothing, the candidates are inert. If this is also zero, there was nothing to
-- sample and the setup may be perfectly fine.

select s.garment_category,
       count(*)                                            as graded_submissions,
       count(*) filter (where s.created_at >= now() - interval '24 hours')
                                                           as last_24h,
       min(s.created_at)                                   as first,
       max(s.created_at)                                   as last
  from public.submissions s
 where s.created_at >= now() - interval '7 days'
   and s.garment_category in ('sneakers', 'boots', 'sandals')
 group by s.garment_category
 order by s.garment_category;

-- ─────────────────────────────────────────────────────────────────────────
-- §4  What it cost against what it found (AC6)
-- ─────────────────────────────────────────────────────────────────────────
--
-- The point of the run is divergences worth turning into golden cases (AC5).
-- A candidate that agreed on everything cost money and taught nothing, which is
-- a reason to stop rather than to extend the window.

select shadow_prompt_version_name,
       count(*)                                            as runs,
       sum(vision_calls)                                   as vision_calls,
       round(avg(abs(score_delta))::numeric, 3)          as mean_abs_score_delta,
       count(*) filter (where not tier_agreement)          as tier_disagreements,
       count(*) filter (where abs(score_delta) >= 0.5)   as moved_half_point_or_more
  from public.grading_shadow_results
 where created_at >= now() - interval '7 days'
   and stage = 'per_image'
   and shadow_prompt_version_name like 'block:category_criteria%'
 group by shadow_prompt_version_name
 order by tier_disagreements desc;

-- The individual divergences to review, worst first. These are AC5's input:
-- a reviewer correcting one of these produces exactly the human-corrected
-- footwear grade the eval gate does not have.
select id,
       submission_id,
       shadow_prompt_version_name,
       score_delta,
       tier_agreement,
       per_factor_deltas,
       created_at
  from public.grading_shadow_results
 where created_at >= now() - interval '7 days'
   and stage = 'per_image'
   and shadow_prompt_version_name like 'block:category_criteria%'
   and (not tier_agreement or abs(score_delta) >= 0.5)
 order by abs(score_delta) desc
 limit 100;
