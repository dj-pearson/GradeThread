-- Seed the content topic bank (2026-06-12).
--
-- 12 SEO blog topics per product + 10 social hooks per product, all
-- status='queued' so the scheduler pulls them oldest-first. Safe to re-run:
-- rows are skipped when a topic with the same (surface, product_focus,
-- lower(primary_keyword)) already exists — mirrors the /topics/bulk dedup.
--
-- Run in Supabase Studio (SQL editor) on the self-hosted instance, or:
--   psql "$DATABASE_URL" -f scripts/seed-topic-bank.sql

WITH candidates (surface, product_focus, title, angle, primary_keyword, secondary_keywords, search_intent) AS (
  VALUES

  -- ══════════════ BLOG · GRADETHREAD (SEO) ══════════════
  ('blog'::public.content_surface, 'gradethread'::public.content_product,
   'NWT vs NWOT vs EUC: Every Clothing Condition Abbreviation, Decoded',
   'Definitive glossary post targeting the highest-volume condition query. Define each abbreviation, show where buyers and platforms disagree, and position a numeric 1.0–10.0 grade as the fix for ambiguity. Include a comparison table for featured-snippet capture.',
   'nwt vs nwot meaning',
   ARRAY['euc meaning clothes','clothing condition abbreviations','gug vguc meaning'],
   'informational'),

  ('blog'::public.content_surface, 'gradethread'::public.content_product,
   'How to Grade Used Clothes Before Selling: The 5-Factor Condition Checklist',
   'Walk the exact 5 factors (fabric 30%, structure 25%, cosmetic 20%, functional 15%, odor/cleanliness 10%) as a printable checklist. Practical, photo-driven, ends with how AI grading automates the same rubric.',
   'how to grade used clothes',
   ARRAY['clothing condition checklist','used clothing inspection','grading clothes for resale'],
   'informational'),

  ('blog'::public.content_surface, 'gradethread'::public.content_product,
   'The Clothing Condition Grading Scale Explained: What 1.0–10.0 Actually Means',
   'Pillar page for the brand''s core concept. Map each grade band to tier names (NWT=10, Excellent=8, Good=6…) with real garment examples per band. Internal-link target for every other condition article.',
   'clothing condition grading scale',
   ARRAY['clothing grade chart','garment condition rating','condition tiers clothing'],
   'informational'),

  ('blog'::public.content_surface, 'gradethread'::public.content_product,
   'How to Describe Clothing Flaws on eBay So You Never Eat a Return',
   'Returns-prevention angle: the vocabulary of flaws (pilling vs fuzzing, run vs pull, fading vs sun bleach), where to measure them, and disclosure phrasing that protects sellers in INAD disputes.',
   'how to describe clothing flaws ebay',
   ARRAY['item not as described clothing','disclosing defects reselling','ebay clothing returns'],
   'informational'),

  ('blog'::public.content_surface, 'gradethread'::public.content_product,
   'Poshmark vs eBay vs Mercari Condition Guidelines: One Garment, Three Rulebooks',
   'Comparison post for crossposters: how the same hoodie gets labeled differently per platform, with a mapping table from a numeric grade to each platform''s condition field.',
   'poshmark condition guidelines',
   ARRAY['ebay item condition clothing','mercari condition guide','crossposting condition'],
   'commercial'),

  ('blog'::public.content_surface, 'gradethread'::public.content_product,
   'How to Photograph Clothing Defects: Lighting, Angles, and the Shots Buyers Trust',
   'Tactical photo guide keyed to the required shot list (front, back, label, detail, defect). Covers raking light for pilling, scale references for holes, and why honest defect photos raise sell-through.',
   'how to photograph clothing flaws',
   ARRAY['clothing defect photos','reselling photography tips','ebay clothing photos'],
   'informational'),

  ('blog'::public.content_surface, 'gradethread'::public.content_product,
   'Vintage Clothing Condition: Why "Good for Its Age" Isn''t a Grade',
   'Vintage-niche post: as-made vs acquired defects (distressing by design vs damage), single-stitch tees, and how a standardized grade handles 40-year-old garments fairly.',
   'vintage clothing condition grading',
   ARRAY['grading vintage t shirts','vintage condition guide','as-made vs damage'],
   'informational'),

  ('blog'::public.content_surface, 'gradethread'::public.content_product,
   'What Is a Clothing Condition Certificate (and When Is It Worth It)?',
   'Bottom-funnel explainer: what a shareable graded certificate contains, how buyers verify it, and which price points justify grading (designer, vintage band tees, streetwear).',
   'clothing condition certificate',
   ARRAY['garment authentication report','graded clothing resale','condition report clothes'],
   'transactional'),

  ('blog'::public.content_surface, 'gradethread'::public.content_product,
   'How to Reduce Returns When Selling Clothes Online: A Condition-First Playbook',
   'Problem-aware post for volume sellers: the top return reasons that trace back to condition mismatch and the disclosure workflow that prevents each one. Honest about what disclosure can''t fix (fit).',
   'how to reduce returns selling clothes',
   ARRAY['ebay returns clothing','poshmark case lost','item not as described prevention'],
   'informational'),

  ('blog'::public.content_surface, 'gradethread'::public.content_product,
   'Does Condition Actually Change What Used Clothes Sell For?',
   'Data-minded pricing post: how each condition tier typically moves price and sell-through on the secondary market, why under-grading is as costly as over-grading. Use only verifiable/illustrative figures, no invented stats.',
   'used clothing resale value by condition',
   ARRAY['how condition affects resale price','grading and resale value','price used clothes condition'],
   'commercial'),

  ('blog'::public.content_surface, 'gradethread'::public.content_product,
   'AI Clothing Inspection: How Computer Vision Grades a Garment From Photos',
   'Technical-curiosity post that earns trust: what the model looks at per factor, why confidence scores below 0.75 go to human review, and what AI grading can''t see (odor) and how that''s handled.',
   'ai clothing inspection',
   ARRAY['ai grading clothes','computer vision fashion resale','automated condition report'],
   'informational'),

  ('blog'::public.content_surface, 'gradethread'::public.content_product,
   'The Underarm Check and 9 Other Spots Sellers Miss When Grading Clothes',
   'Listicle with high snippet potential: underarms, collar interior, cuffs, hem stitching, zipper tape, crotch seam, elbow wear, pit-to-pit stress, button shanks, interior labels. One photo + one-line check each.',
   'clothing inspection checklist resale',
   ARRAY['where to check used clothes','hidden flaws used clothing','thrift inspection tips'],
   'informational'),

  -- ══════════════ BLOG · FLIPDESK (SEO) ══════════════
  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   'Reseller Inventory Spreadsheet vs Software: When to Graduate (With a Free Template)',
   'Meet spreadsheet-searchers where they are: give a genuinely useful free template, then show the exact breakpoints (SKU count, crossposting, COGS tracking) where a spreadsheet starts costing money.',
   'reseller inventory spreadsheet',
   ARRAY['reseller spreadsheet template','inventory tracking reselling','reseller software vs spreadsheet'],
   'commercial'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   'How to Track Reselling Profit: COGS, Fees, and the Numbers That Actually Matter',
   'Finance fundamentals for resellers: cost of goods, platform fees, shipping deltas, true hourly rate. Worked example from one thrifted jacket sourced → sold with every line item.',
   'how to track reselling profits',
   ARRAY['reseller profit calculator','ebay fees explained','cogs for resellers'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   'Why Are My eBay Sales Slow? A 12-Point Listing Quality Audit',
   'Targets a huge evergreen panic query. Diagnostic checklist: item specifics coverage, photo count, title keyword order, pricing vs comps, promoted rate, sell-through ratio. Each point links to a fix.',
   'why are my ebay sales slow',
   ARRAY['ebay sales dropped','ebay listing audit','improve ebay sell through'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   'eBay Item Specifics That Actually Drive Search (And the Ones You Can Skip)',
   'Cassini-focused deep dive: required vs recommended aspects, how buyers filter, and how AI aspect autofill removes the tedium. Category examples from clothing.',
   'ebay item specifics best practices',
   ARRAY['ebay item specifics clothing','ebay search optimization','cassini seo'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   'From Death Pile to Cash Flow: A 30-Day Plan to Clear Your Reseller Backlog',
   'Names the pain every reseller jokes about. Day-by-day batching plan (photograph in bulk, draft with AI, list daily), with realistic throughput math instead of hustle-culture promises.',
   'reseller death pile',
   ARRAY['clear ebay backlog','bulk listing clothes','reseller motivation system'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   'How to Price Used Clothes on eBay: Reading Sold Comps Like a Pro',
   'Comp-reading tutorial: sold vs active listings, filtering by condition, when to undercut vs hold, and how automated comp pulls compress the research to seconds.',
   'how to price used clothes on ebay',
   ARRAY['ebay sold comps','pricing strategy reselling','ebay pricing tool'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   'How Many eBay Listings Per Day Do You Need to Grow? The Consistency Math',
   'Answers a forum-favorite question with actual math: listings/day × sell-through × ASP = revenue, with three seller archetypes (side hustle, part-time, full-time) modeled honestly.',
   'how many ebay listings per day',
   ARRAY['ebay listing consistency','grow ebay store','ebay momentum'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   'What Sells on eBay From the Thrift Store: A Sourcing Guide for Clothing Resellers',
   'Top-funnel sourcing magnet: bolo brands by tier, fabric/construction tells worth flipping, and how to check comps from the rack before buying.',
   'what sells on ebay thrift store',
   ARRAY['thrift store bolo list','sourcing clothes to resell','best brands to flip'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   'AI eBay Listing Generators: What They Get Right, Wrong, and How to Use Them Well',
   'Honest category review (we are one): where AI titles/descriptions/aspects shine, where a human must verify (brand, size, flaws), and a photos-to-published walkthrough.',
   'ai ebay listing generator',
   ARRAY['ai listing tool ebay','bulk listing software','photo to listing ai'],
   'commercial'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   'Reseller Taxes 101: 1099-Ks, Deductions, and Clean Books Without the Panic',
   'Calm, factual explainer of current 1099-K reporting thresholds and common deductible expenses, with a record-keeping workflow. Explicit "not tax advice" framing; cite IRS sources only.',
   'reseller taxes 1099-k',
   ARRAY['ebay 1099-k threshold','reseller tax deductions','bookkeeping for resellers'],
   'informational'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   'The Complete eBay Workflow for Clothing Resellers: Source → List → Sell → Ship → Reconcile',
   'Pillar page mirroring the FlipDesk pipeline stages. Each stage gets the goal, the common bottleneck, and the tooling that removes it. Internal-link hub for the FlipDesk cluster.',
   'ebay reselling workflow',
   ARRAY['reseller pipeline','ebay listing process','reseller operations'],
   'commercial'),

  ('blog'::public.content_surface, 'flipdesk'::public.content_product,
   'Bulk Listing on eBay: How to Photograph Once and List Everything Same-Day',
   'Batching masterclass: photo-station setup, shooting 30 items in a session, AI drafting from photo dumps, and a same-day publish cadence that keeps the death pile at zero.',
   'bulk listing on ebay',
   ARRAY['batch photography reselling','list faster on ebay','ebay listing speed'],
   'informational'),

  -- ══════════════ SOCIAL · GRADETHREAD (hooks) ══════════════
  ('social'::public.content_surface, 'gradethread'::public.content_product,
   '"Excellent condition" means nothing — and it''s costing you returns',
   'Contrarian hook: every seller writes EUC, every buyer reads it differently, and the gap becomes a return. Land on what a numeric grade communicates instead. Confident, slightly spicy, no invented stats.',
   'excellent condition means nothing',
   ARRAY['condition mismatch returns','euc problem'],
   'engagement'),

  ('social'::public.content_surface, 'gradethread'::public.content_product,
   'POV: the buyer opens an "item not as described" case — and your condition report ends it',
   'Mini-story format resellers feel in their bones: the INAD case, the dread, then the receipts — a timestamped graded report with defect photos. Trust-as-armor framing.',
   'inad case condition report',
   ARRAY['item not as described','seller protection'],
   'engagement'),

  ('social'::public.content_surface, 'gradethread'::public.content_product,
   'The flaw 90% of sellers miss is under the arms',
   'Curiosity-gap hook with instant payoff: raking-light underarm check for discoloration and thinning. One actionable tip → save/share bait. Invite followers to reply with the flaw THEY always catch.',
   'underarm check used clothes',
   ARRAY['hidden clothing flaws','inspection tip'],
   'engagement'),

  ('social'::public.content_surface, 'gradethread'::public.content_product,
   'What separates a 7.5 hoodie from a 9.0? Let''s grade one together',
   'Interactive grading walkthrough: describe the same hoodie at two grades, factor by factor. Ends asking the audience to grade an item from their own pile and comment the number.',
   'grade a hoodie 7.5 vs 9',
   ARRAY['grading example','condition tiers'],
   'engagement'),

  ('social'::public.content_surface, 'gradethread'::public.content_product,
   'Stop writing paragraph condition descriptions. Buyers don''t read them.',
   'Pattern-interrupt: the wall-of-text condition blurb vs a grade + 3 disclosed flaws. Skimmability sells. Before/after listing copy as the visual.',
   'condition description buyers skim',
   ARRAY['listing description tips','skimmable listings'],
   'engagement'),

  ('social'::public.content_surface, 'gradethread'::public.content_product,
   'Your "great condition" and my "great condition" are different garments',
   'Relatable two-panel premise: seller''s mental image vs buyer''s expectation of the same phrase. Humor-forward, ends with the case for a shared scale.',
   'great condition is subjective',
   ARRAY['condition subjectivity','buyer expectations'],
   'engagement'),

  ('social'::public.content_surface, 'gradethread'::public.content_product,
   'I let AI inspect my listing photos before publishing. Here''s what it caught.',
   'First-person demo narrative: the pulled thread on a cuff the seller missed, the confidence score, the regrade. Show-don''t-tell product proof with a real-feel voice.',
   'ai caught flaw in listing photo',
   ARRAY['ai inspection demo','defect detection'],
   'engagement'),

  ('social'::public.content_surface, 'gradethread'::public.content_product,
   'Vintage sellers: distressing is a feature. Damage is a defect. Know the difference.',
   'Niche flex for the vintage crowd: as-made vs acquired condition on distressed denim and single-stitch tees. Positions the grading system as vintage-literate.',
   'distressing vs damage vintage',
   ARRAY['vintage grading','as-made condition'],
   'engagement'),

  ('social'::public.content_surface, 'gradethread'::public.content_product,
   'The 5 things worth checking before you hit "list" (60-second routine)',
   'Speed-run checklist content: fabric, structure, cosmetic, functional, smell — one beat each. Save-worthy, loops back to the full blog checklist as CTA.',
   '60 second condition check',
   ARRAY['pre-listing routine','quick inspection'],
   'engagement'),

  ('social'::public.content_surface, 'gradethread'::public.content_product,
   'Would a condition certificate make you pay more for a used jacket? Be honest.',
   'Pure engagement-bait question post aimed at both buyers and sellers; the comments do the marketing. Follow-up post can synthesize the answers.',
   'pay more for condition certificate',
   ARRAY['certificate value question','buyer trust poll'],
   'engagement'),

  -- ══════════════ SOCIAL · FLIPDESK (hooks) ══════════════
  ('social'::public.content_surface, 'flipdesk'::public.content_product,
   'I photographed 30 items, walked away, and came back to 30 drafted eBay listings',
   'The AutoLister money-shot demo: photo dump in, drafted listings out (titles, item specifics, prices from comps). First-person, screen-recording energy, no overclaiming — drafts still get reviewed.',
   'photo dump to ebay drafts',
   ARRAY['bulk ai listing demo','autolister'],
   'engagement'),

  ('social'::public.content_surface, 'flipdesk'::public.content_product,
   'Your death pile isn''t a discipline problem. It''s a workflow problem.',
   'Reframe-the-shame hook — the most relatable phrase in reselling. Listing friction (photos, specifics, pricing research) is the villain; batching + automation is the arc.',
   'death pile workflow problem',
   ARRAY['death pile reframe','listing friction'],
   'engagement'),

  ('social'::public.content_surface, 'flipdesk'::public.content_product,
   'Spreadsheet resellers, how''s the SKU column doing? (asking with love)',
   'Gentle roast of the inventory spreadsheet life: the broken formula, the "where is bin 14" panic, the unlogged fees. Community-humor tone that earns the pitch.',
   'reseller spreadsheet roast',
   ARRAY['spreadsheet pain','inventory chaos'],
   'engagement'),

  ('social'::public.content_surface, 'flipdesk'::public.content_product,
   'The item specific you''re leaving blank is the filter buyers are using',
   'One-fact post with teeth: buyers filter by size/color/material; blank aspects mean invisible listings. Show the before/after of a fully-specified listing.',
   'blank item specifics invisible',
   ARRAY['ebay filters','aspect coverage'],
   'engagement'),

  ('social'::public.content_surface, 'flipdesk'::public.content_product,
   'Comps in 30 seconds or 30 minutes — your choice',
   'Speed contrast demo: manually digging sold listings vs an automated comp pull on one vintage tee. Respect the craft, sell the shortcut.',
   'comps in 30 seconds',
   ARRAY['pricing research speed','sold comps'],
   'engagement'),

  ('social'::public.content_surface, 'flipdesk'::public.content_product,
   'What would 10 listings a day, every day, do to your store? Run the math with me.',
   'Math-as-content: 10/day × realistic sell-through × your ASP, shown honestly for 30/60/90 days. Ends asking followers their daily listing number — comment-driver.',
   'ten listings a day math',
   ARRAY['listing consistency math','ebay growth'],
   'engagement'),

  ('social'::public.content_surface, 'flipdesk'::public.content_product,
   'Sourced at 9am, listed by noon: the same-day pipeline, start to finish',
   'Day-in-the-life format: thrift haul → photo station → AI drafts → publish before lunch. Aspirational but reproducible; the pipeline IS the product placement.',
   'same day sourcing to listing',
   ARRAY['day in the life reseller','pipeline demo'],
   'engagement'),

  ('social'::public.content_surface, 'flipdesk'::public.content_product,
   'Fees took HOW much? Find your real profit per item, not your gross',
   'Wake-up-call hook on gross vs net: platform fees, shipping deltas, COGS. One worked example with honest numbers, then the case for automatic reconciliation.',
   'real profit after fees',
   ARRAY['gross vs net reselling','fee awareness'],
   'engagement'),

  ('social'::public.content_surface, 'flipdesk'::public.content_product,
   'Hot take: you don''t need more inventory. You need to list what you already own.',
   'Contrarian sourcing-addiction call-out — every reseller knows the haul high with an unlisted closet. Empathetic roast → batching CTA. High share potential in reseller groups.',
   'list what you already own',
   ARRAY['sourcing addiction','backlog first'],
   'engagement'),

  ('social'::public.content_surface, 'flipdesk'::public.content_product,
   'Reply with your oldest unlisted item. No judgment. (Some judgment.)',
   'Pure community-engagement prompt that weaponizes death-pile guilt with humor. The replies become source material for a follow-up death-pile-clearing series.',
   'oldest unlisted item prompt',
   ARRAY['community prompt','death pile confession'],
   'engagement')
)
INSERT INTO public.content_topics
  (surface, product_focus, title, angle, primary_keyword, secondary_keywords,
   search_intent, status, generated_by, source)
SELECT
  c.surface, c.product_focus, c.title, c.angle, c.primary_keyword,
  c.secondary_keywords::text[], c.search_intent,
  'queued'::public.topic_status,
  'human'::public.content_generated_by,
  'manual'::public.content_topic_source
FROM candidates c
WHERE NOT EXISTS (
  SELECT 1 FROM public.content_topics t
  WHERE t.surface = c.surface
    AND t.product_focus = c.product_focus
    AND lower(t.primary_keyword) = lower(c.primary_keyword)
);

-- Expected on first run: 44 rows inserted (12+12 blog, 10+10 social).
SELECT surface, product_focus, count(*) AS queued
FROM public.content_topics
WHERE status = 'queued'
GROUP BY surface, product_focus
ORDER BY surface, product_focus;
