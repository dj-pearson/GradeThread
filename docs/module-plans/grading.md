# Grading engine & certificates

Health: **ok**

The module is heavily hardened. There are about 80 grading and certificate test files, confidence caps compose through a ceiling, the tamper-proof certificate seal is recomputed on human adjustments, and the certificate page tells a missing photo apart from a failed read. The biggest new finding is a real math bug. Both overall-score calculators round with plain floating-point math, so some exact .x5 midpoints round down. Example: factors 9/6/8/9/8 work out to exactly 7.95, and the certificate reads 7.9 Very Good instead of 8.0 Excellent. The rest of the risk is in the prompt-change pipeline: an evaluated prompt can be edited after it passes, and shadow runs cannot be started from the admin tools.

## Actions

### 1. Fix floating-point midpoint rounding in the weighted overall (grades and tiers shift at exact .x5)

Impact: high | Effort: M | Story: none

**Why:** services/edge-functions/src/lib/ai-grading.ts:2492 roundToTenth, human-review.ts:66 and src/lib/weighted-grade.ts:63-66 all compute sum(factor*weight) in floats, then Math.round(x*10)/10. I checked every 0.5-step factor combination in node against exact integer math. 72,858 of 2,476,099 combinations land on an exact .x5 midpoint that floats store as .x4999 and round DOWN, while other midpoints round up. In the 6.0-10.0 range, 4,011 of 161,051 combinations are wrong and 5 of them cross a tier line. Example: 9,6,8,9,8 = exactly 7.95, stored as 7.9 (Very Good) instead of 8.0 (Excellent). The three sites agree with each other, so the lockstep guard passes. The shared fixture src/test/fixtures/weighted-grade-cases.json has no midpoint case.

**Steps:**
- Compute in integer units in all three sites in one commit: sum(round(factor*2) * weightPer400), then round-half-up on the integer. Or add a Number.EPSILON-scaled nudge before rounding. Pick one and write the reason in vault/20-domain/weighted-overall-lockstep.md
- Add midpoint cases to weighted-grade-cases.json (9,6,8,9,8 -> 8.0; 5,5,5,9,5.5 -> 5.7) so the web and edge suites both assert them
- Add an exhaustive property test (19^5 combinations, under 1s) that compares each implementation to an integer reference
- Before shipping, count affected prod rows with a read-only query (grade_reports where the exact weighted sum ends in .x5 and the stored overall is 0.1 low). Owner decides whether to reseal them through the human-review reseal path or to change only new grades
- Grep ios/ and android/ for any client-side overall computation and align it if one exists

### 2. Reset eval_passed when a prompt version's text or scope is edited after it passed

Impact: high | Effort: S | Story: none

**Why:** The PATCH /prompts/:id route (admin-grading.ts:598-661) refuses text edits only on ACTIVE rows (:632-638). It will edit prompt_text or garment_scope of an inactive row that already passed the eval, and it never clears eval_passed, qualified_model or eval_run_id. activatePromptVersion (grading-eval.ts:816-836) and the canary path (admin-grading.ts:1847) trust eval_passed as it stands. So a prompt can be evaluated, edited, then activated with no eval of the text that actually serves. checkPromptServingEligibility (grading-eval.ts:775-805) blocks a model change after eval (US-2036) but not a text change. No DB trigger resets it either (checked 00050, 00480, 00563).

**Steps:**
- In PATCH /prompts/:id, when prompt_text or garment_scope changes, also set eval_passed=null, qualified_model=null, eval_run_id=null
- Better: store a hash of the evaluated prompt_text on the eval run and have checkPromptServingEligibility refuse on a mismatch. That also covers direct SQL edits
- Apply the same rule to block-version rows (00563 per-block overrides)
- Add a test: evaluate, edit, then activate must return 422

### 3. Finish the golden-set eval gate: CI run, real rows for live prompts, non-empty set

Impact: high | Effort: M | Story: US-2301

**Why:** US-2301 notes confirm the live code-default prompts have no ai_prompt_versions row and were never evaluated, and no code path had inserted a golden case. runEval throws on an empty set (grading-eval.ts:322-328) but nothing in CI calls it. Every other safeguard in this module (activation gate, shadow, canary) is only as good as this set.

**Steps:**
- Close US-2301's operator reads (prod-diagnostics §15) and record the golden-set count
- Promote real corrected reviews into grading_eval_cases through the existing /eval/cases/promote-batch route (admin-grading.ts:2291)
- Seed rows for the live code-default versions and run the eval once so they carry eval_passed and qualified_model
- Add a scheduled CI job that fails on regression or on an empty set

### 4. Stop FlipDesk grading from charging, calling the AI, then abstaining on a missing label photo

Impact: high | Effort: M | Story: US-2304

**Why:** US-2304: flipdesk-grading.ts requires only front and back, while image-quality.ts:91 requires label and blocks on it. Prod diagnostics recorded 8 such refunds (June 2, July 6) with credits_returned 0. Customers were charged and got nothing back. This is money, not just UX.

**Steps:**
- Decide between requiring the label in FlipDesk and adding an explicit carve-out; record the reason
- Make REQUIRED_GRADING_PHOTO_TYPES and image-quality REQUIRED_IMAGE_TYPES one source, or pin them with a test
- Investigate why credits_returned was 0 on those 8 refunds and make those customers whole
- Add a pre-upload check on web, iOS and Android

### 5. Serve stable photo URLs in the certificate SSR gallery, not 15-minute signed URLs under a day-long cache

Impact: medium | Effort: S | Story: none

**Why:** functions/cert/[id].ts:265-272 writes cert.images[].url (signed, CERT_IMAGE_TTL = 15*60 at content-public.ts:1174) straight into the gallery HTML. That HTML is served with SSR_CACHE_CONTROL 'max-age=300, s-maxage=3600, stale-while-revalidate=86400' (functions/_shared/blog-render.ts:210) and stored by withEdgeCache. Any cached render older than 15 minutes shows 403 images to crawlers, no-JS viewers and the pre-hydration paint. The same file already knows this and uses stable /cert-photo/:id/:n URLs for the JSON-LD (:465-471 via certGalleryImageUrls). The gallery was just never switched.

**Steps:**
- Build the gallery img src and href from certGalleryImageUrls(base, cert.id, n) instead of img.url
- Check that the SPA certificate.tsx hydration does not reintroduce signed URLs into cached markup
- Add a render test with a stubbed upstream asserting no 'token=' or signed query string appears in the SSR body

### 6. Make shadow runs startable from the admin tools, including per-image prompts

Impact: medium | Effort: M | Story: US-3321

**Why:** PATCH /prompts/:id/shadow refuses any non-composite row (admin-grading.ts:2045-2047, 'Only composite-stage prompts can be shadowed'), even though per-image shadow exists (grading-shadow-per-image.ts, US-2443) and vault/20-domain/grading-prompt-channels.md:256 says a per-image candidate needs shadow_sample_rate and shadow_daily_cap set. No frontend file calls the shadow PATCH route at all (grep of src/ finds only reads). Yet the Shadow tab's empty state says 'start a shadow run from a draft prompt version' (grading-accuracy-panel.tsx:493). Today shadow is enabled only by hand-written SQL (US-2810's scripts/shadow-footwear-criteria.sql). US-3321's per-image prompt fix is required to go through shadow and has no supported way to do it.

**Steps:**
- Allow stage='per_image' in the shadow PATCH route. Require PER_IMAGE_SHADOW_DAILY_VISION_CAP to be set and cap sample_rate low for that stage, and add step-up since it spends vision calls
- Add a start/stop shadow control with rate and cap fields to the prompt-version admin UI
- Fix the empty-state copy to match what the UI can do
- Add a route test for both stages

### 7. Fix unreadable-label handling: redefine 'legible' and run the label re-read before the cap

Impact: medium | Effort: M | Story: US-3321, US-3322

**Why:** US-3321: the per-image prompt defines legible as brand+size+care, so a Lululemon size dot scores illegible on a sharp photo and picks up ILLEGIBLE_LABEL_CONFIDENCE_CAP. US-3322: runRereadPass runs after evaluateImageQuality and only on paid Forensic, so the recovery path never clears the flag. Together they push tagless garments into human review with a capped confidence.

**Steps:**
- Ship the new legible definition as a new PER_IMAGE_PROMPT_VERSION through shadow (needs the action above), then eval, then canary
- Move the re-read ahead of the cap, or allow it on standard grades when legible=false is the only trigger, and compute the cap from the merged read
- Add the three tagless golden cases US-3321 names

### 8. Make the grading prompt cache actually pay off

Impact: medium | Effort: S | Story: US-3345, US-3150

**Why:** US-3345: every photo's per-image call fires at once (grading-pipeline.ts perImagePromises + Promise.allSettled). Photos 2..N pay the 1.25x cache-write premium and never read the cache. US-3150 moved schema and rules into a cached block that cannot be read back inside the same submission until this lands.

**Steps:**
- Measure cache_creation_tokens against cache_read_tokens in ai_usage_events (US-3345 AC1)
- Stagger only the first per-image call, then fan out the rest; measure the added latency on a real submission
- If the latency is not worth it, turn the cache flags off and record why

### 9. Clean up stale references and unpinned copies of the required-photo list

Impact: low | Effort: S | Story: none

**Why:** The grading-engine skill names src/pages/admin/reviews.tsx as a rounding site (.claude/skills/grading-engine/SKILL.md:3 and :39-44), but that file was deleted in US-2505 (vault/20-domain/weighted-overall-lockstep.md:47). The same stale reference is in ai-grading.ts:2490-2491. The admin/grading.tsx:163 and disputes.tsx:186 wrappers correctly delegate. REQUIRED_IMAGE_TYPES is copied in grade.ts:119 and api-v1.ts:114 alongside image-quality.ts:91 and api-grade-ingest.ts:38. grading-readiness-parity_test.ts:25 pins only the image-quality copy, and garment-taxonomy-copies.test.ts covers garment types, not required photos.

**Steps:**
- Update SKILL.md and the ai-grading.ts comment to name admin/grading.tsx and disputes.tsx as delegating consumers
- Have grade.ts and api-v1.ts import REQUIRED_IMAGE_TYPES from lib/image-quality.ts instead of keeping local copies
- Run vault:lint after the note edits

## Risks

- The rounding fix changes certified numbers. Resealing old certificates rewrites their tamper-proof hashes and could move a public grade. That needs the owner's call, not a silent backfill.
- Most open grading stories (US-2301, US-3345, US-3321) are blocked on operator reads of prod or on a golden set that is still close to empty. Code changes alone will not close them.
- Anything that changes prompt text must go through shadow, then eval, then canary. With no golden cases, the eval gate cannot tell a good prompt from a bad one.
- I did not run the edge test suite. Every finding comes from reading the code plus one numeric check in node.
