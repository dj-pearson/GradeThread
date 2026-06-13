-- US-850: seed the content knowledge base so AI generation stays on-brand.
--
-- The blog/social/research generators (content-ai-blog.ts, content-ai-social.ts,
-- content-ai-research.ts) load six content_knowledge keys into every prompt:
--   brand.voice, blog.gradethread.style, blog.flipdesk.style,
--   social.long.style, social.short.style, seo.pillars
-- (verified: the keys are read verbatim via `.in("key", [...])` in each loader).
--
-- Migration 00041 seeded baseline versions with `ON CONFLICT (key) DO NOTHING`,
-- which is idempotent but CANNOT refresh a row once it exists — so a prod
-- instance that received the thin baseline (or a drifted manual edit) never
-- gets the enriched corpus. This migration replaces all six bodies with the
-- canonical, substantive on-brand reference docs and uses
-- `ON CONFLICT (key) DO UPDATE` so re-running refreshes content WITHOUT
-- duplicating keys (key is UNIQUE). Admins can still edit them afterward in
-- /admin/content/knowledge; a later run of THIS migration is a no-op on an
-- already-up-to-date row but will overwrite admin edits — which is the intended
-- "restore canonical seed" behavior for a versioned migration.
--
-- Aggregate brand config, no PII / no tenant data.

INSERT INTO public.content_knowledge (key, title, body_md, token_count_est) VALUES

('brand.voice',
 'Brand Voice & Persona',
 E'# GradeThread Brand Voice\n\n'
 '## Who we are\nGradeThread brings standardized, AI-powered condition grading to pre-owned clothing — a numerical '
 '1.0–10.0 grade, a detailed condition report, and a buyer-verifiable certificate. We exist to take the guesswork '
 '(and the arguments) out of "what condition is this, really?"\n\n'
 '## Persona\nWe write like a seasoned reseller who is also a fabric nerd. We have moved real volume, eaten real '
 'returns, and learned the difference between "Excellent" and "Very Good" the hard way. Direct, evidence-led, '
 'never hypey. We respect the reader''s time and assume they are smart.\n\n'
 '## Tone\n- Plain English; short sentences when possible.\n- "We" and "you", never "the user" or "one".\n'
 '- Confident, never apologetic. No "in this article we will explore".\n- Concrete numbers beat vague claims '
 '("cuts not-as-described disputes" > "improves trust").\n- Teach first, sell second. Earn the CTA.\n\n'
 '## Banned phrases\n- "game-changer", "revolutionize", "synergy", "in today''s fast-paced world", '
 '"unlock the power of", "elevate your", "supercharge", "seamless", "leverage" (as a verb), "delve".\n'
 '- No fake urgency, no "act now". No exclamation-point stacking.\n- Em-dashes are fine — used sparingly, not as '
 'a tic.\n\n'
 '## Always\n- Lead with a specific scenario, number, or stat.\n- Cite real marketplace mechanics (eBay '
 'item specifics, Poshmark offers, Mercari ratings, return windows) when relevant.\n'
 '- Name the failure mode you are fixing (returns, low price realization, slow sell-through).\n'
 '- End with a clear, low-pressure CTA — try grading one garment, not "sign up today".\n\n'
 '## Never\n- Overpromise grade accuracy or guarantee a sale.\n- Disparage other tools by name.\n'
 '- Use stock-photo language ("vibrant", "stunning") about clothing condition.\n'
 '- Invent stats. If we cite a number, it is real or clearly framed as an example.\n',
 470),

('blog.gradethread.style',
 'Blog Style — GradeThread (condition grading)',
 E'# Blog Articles: GradeThread Focus\n\n'
 '## What GradeThread is\nAI-powered, standardized condition grading for pre-owned clothing on a 1.0–10.0 scale '
 '(half-point increments). It outputs a numerical grade, a detailed condition report across five weighted factors '
 '(fabric, structure, cosmetic, function, odor/cleanliness), and a shareable certificate buyers can verify. '
 'Tiers: NWT (10), NWOT (9), Excellent (8), Very Good (7), Good (6), Fair (5), Poor (3–4).\n\n'
 '## Target reader\nResellers on eBay/Poshmark/Mercari/Whatnot, thrift-store flippers, vintage and denim sellers, '
 'consignment shops. Intermediate-to-advanced — they already list; they want fewer returns, higher trust, and '
 'better price realization on their best items.\n\n'
 '## Article shape\n- 1500–2200 words.\n- One H1 (= title). 4–7 H2s. H3s sparingly.\n'
 '- Open with a specific reseller pain (a "not as described" return on an item you thought was mint; an Excellent '
 'jacket that sold for Good money).\n- At least one numbered list or comparison table.\n'
 '- Ground claims in the five grading factors and the tier vocabulary above.\n'
 '- Close with a CTA to grade a single garment and see the report.\n\n'
 '## Pillar topic clusters (ladder every post to one)\n'
 '1. Condition vocabulary — what NWT/NWOT/Excellent/Good actually mean, by category\n'
 '2. Category-specific grading — denim, knits, leather, vintage tees, suits, shoes, outerwear\n'
 '3. Defect taxonomy — pilling, fading, fabric integrity, seam wear, odor, repairs\n'
 '4. Trust & buyer psychology — why standardized grades reduce returns and disputes\n'
 '5. Grading photography — lighting, angles, defect shots, label shots\n'
 '6. Pricing strategy by grade tier\n\n'
 '## Keyword strategy\nOne primary buyer-intent keyword per post, 3–5 secondary. Primary is a specific phrase '
 '("how to grade a vintage band tee", "what does NWOT mean on Poshmark"), not a head term ("clothing grading"). '
 'Put the primary in the H1, first 100 words, and one H2.\n\n'
 '## E-E-A-T\nShow hands-on experience: reference real defect calls, real category quirks, real marketplace '
 'policies. Prefer "here is the seam-slippage test" over abstract advice.\n',
 560),

('blog.flipdesk.style',
 'Blog Style — FlipDesk (reseller management)',
 E'# Blog Articles: FlipDesk Focus\n\n'
 '## What FlipDesk is\nThe reseller-management surface inside GradeThread. It runs the full eBay lifecycle: '
 'source → catalog → measure → photograph → grade → comp → draft → list → sell → ship → reconcile. '
 'Built for solo and small-team flippers who outgrew spreadsheets and want accurate per-item P&L.\n\n'
 '## Target reader\nFull-time and serious side-hustle resellers, mostly on eBay (also Poshmark/Mercari/Whatnot/'
 'Shopify), doing 50–2000 items/month. They care about throughput, true cost basis, and not letting COGS or '
 'fees slip through the cracks.\n\n'
 '## Article shape\n- 1500–2200 words.\n- Open with a workflow problem ("Why your eBay drafts pile up at 47 '
 'unposted items", "Where your real margin disappears between sale and payout").\n'
 '- Numbered checklists and step-by-step workflows are gold for this audience.\n'
 '- Use screenshot/mockup placeholders where a workflow step is described.\n'
 '- Show the math: example P&L lines, fee breakdowns, throughput-per-hour.\n'
 '- Close with a CTA to try the relevant FlipDesk module (Scout, AutoLister, Reconcile).\n\n'
 '## Pillar topic clusters (ladder every post to one)\n'
 '1. eBay listing optimization — titles, item specifics, photos, store strategy\n'
 '2. Thrift sourcing — route planning, ROI per stop, category mixing\n'
 '3. Reseller finances — P&L per item, cost basis, taxes, 1099-K\n'
 '4. Inventory operations — SKU systems, location bins, throughput math\n'
 '5. Multi-platform crosslisting — Poshmark ↔ Mercari ↔ eBay rules and economics\n'
 '6. Tooling & automation — when to graduate from spreadsheets\n'
 '7. Returns & reconciliation — payout matching, partial refunds, INR handling\n\n'
 '## Keyword strategy\nLong-tail, operator-intent phrases ("how to track eBay COGS across 500 items", '
 '"reconcile Mercari payouts to a P&L"). Avoid head terms. Primary keyword in H1, intro, and one H2.\n\n'
 '## Tie-in\nWhere natural, connect operations back to condition grading: accurate grades reduce returns, which '
 'is a line item in the reconciliation story. Do not force it.\n',
 580),

('social.long.style',
 'Social Style — Long format (LinkedIn / Facebook)',
 E'# Long-Format Social Posts (LinkedIn, Facebook)\n\n'
 '## Audience\nLinkedIn skews to "I am turning my reselling into a business" — small operators with a B2B-adjacent '
 'mindset. Facebook skews to reseller-group communities; more peer-to-peer, less polished.\n\n'
 '## Shape\n- 800–1500 characters.\n- Hook line on its own (one short sentence, no greeting, no "Excited to share").\n'
 '- One blank line between paragraphs.\n- A specific story or example in the middle (a real defect call, a real '
 'reconciliation surprise, a real price-realization win).\n- One concrete takeaway the reader can act on.\n'
 '- End with one CTA line that includes the cta_url.\n- 3–5 hashtags max, on their own line.\n\n'
 '## Voice\nFirst-person ("I graded a jacket that looked mint and the report flagged seam slippage..."). '
 'Specific numbers. No corporate-speak. Real punctuation only — no emoji bullets, at most one emoji if any.\n\n'
 '## Ladder to a pillar\nEvery post should map to a seo.pillars cluster (condition vocabulary, category grading, '
 'defect taxonomy, trust psychology, reseller finances, etc.) — that is how social reinforces topical authority.\n\n'
 '## Anti-patterns\n- Don''t lead with "Excited to share..." or "Thrilled to announce".\n'
 '- Don''t end with "What do you think?" unless you genuinely want answers.\n'
 '- Don''t list 15 hashtags. Don''t repost a naked link with no insight.\n',
 420),

('social.short.style',
 'Social Style — Short format (X / Threads)',
 E'# Short-Format Social Posts (X, Threads)\n\n'
 '## Audience\nResellers, sneakerheads, vintage flippers. Fast-takes and sharp observations. Pro-banter, '
 'low tolerance for marketing voice.\n\n'
 '## Shape\n- ≤280 characters including the link.\n- One thought. No threads in v1.\n'
 '- Hook + sharp insight + link.\n- 1–2 hashtags max, often zero.\n\n'
 '## Voice\nPunchy, opinionated, true. Reads like a person, not a brand. A specific number beats an adjective; '
 'a real example beats a claim. A grade ("that ''mint'' tee graded 7.5 — pinholes at the collar") lands harder '
 'than a slogan.\n\n'
 '## Ladder to a pillar\nEven a one-liner should reflect a seo.pillars theme (a condition-vocabulary myth, a '
 'defect tell, a pricing-by-grade truth). Keep the territory consistent.\n\n'
 '## Anti-patterns\n- No "🧵" thread starters in v1.\n- No "Day 1/30" gimmicks.\n'
 '- No clickbait — the link must deliver on the hook.\n',
 280),

('seo.pillars',
 'SEO Pillar Topic Map',
 E'# Pillar Topic Map\n\n'
 'The canonical map of "territory we cover". When researching new topics, pick subtopics that ladder up to one '
 'of these pillars. Avoid horizontal sprawl — depth in these clusters is how we build topical authority and '
 'win GEO/AI-engine citations.\n\n'
 '## GradeThread pillars (condition grading)\n'
 '- **condition-vocabulary** — what NWT/NWOT/Excellent/Very Good/Good/Fair/Poor mean by category and marketplace\n'
 '- **category-grading** — denim, knits, leather, vintage tees, suits, shoes, outerwear, activewear\n'
 '- **defect-taxonomy** — pilling, fading, fabric integrity, seam wear, odor, stains, repairs, shrinkage\n'
 '- **trust-psychology** — buyer trust, return rates, dispute reduction, standardized grades vs. seller adjectives\n'
 '- **grading-photography** — lighting, angles, defect shots, label/tag shots, flatlay vs. on-form\n'
 '- **price-by-grade** — pricing strategy and price realization per condition tier; resale value by condition\n\n'
 '## FlipDesk pillars (reseller operations)\n'
 '- **ebay-listing-optimization** — titles, item specifics, photos, store strategy\n'
 '- **thrift-sourcing** — route planning, ROI per stop, category mixing\n'
 '- **reseller-finances** — P&L per item, cost basis, taxes, 1099-K\n'
 '- **inventory-ops** — SKU systems, location bins, throughput math\n'
 '- **crosslisting** — Poshmark ↔ Mercari ↔ eBay rules and economics\n'
 '- **tooling-automation** — when to graduate from spreadsheets\n'
 '- **returns-reconciliation** — payout matching, partial refunds, INR handling\n\n'
 '## The four strategic themes (anchor messaging to these)\n'
 '1. **Condition grading** — the core product and category we are defining.\n'
 '2. **Return reduction** — standardized grades cut "not as described" disputes.\n'
 '3. **Reselling authority** — we are the credible, experience-led voice in pre-owned condition.\n'
 '4. **Resale value-by-condition** — what condition is actually worth, with data.\n\n'
 '## Rules\n- Every new blog topic must declare a pillar in its `angle` field.\n'
 '- Aim for ~40/60 split between condition-vocabulary and category-grading on the GT side.\n'
 '- Aim for ~30/30/20/20 across ebay-listing / thrift-sourcing / reseller-finances / inventory-ops on the FD side.\n'
 '- Interlink new posts to the cornerstone pillar page for their cluster.\n',
 560)

ON CONFLICT (key) DO UPDATE SET
  title           = EXCLUDED.title,
  body_md         = EXCLUDED.body_md,
  token_count_est = EXCLUDED.token_count_est,
  updated_at      = now();
