# Agent & Codebase Level-Up Roadmap

What to install, build, and wire so agents working on GradeThread get materially
better — plus the promo-video pipeline and the grading-moat items that keep the
grading system ahead of imitators. Ordered by leverage within each section; a
suggested sequencing is at the end. Items are written so they can be dropped
into `prd.json` as stories (use `nextId`).

---

## 1. Skills to use today (already available — zero build cost)

These exist in the current Claude Code environment; the win is *using them
consistently*, ideally baked into the Ralph loop prompt and CLAUDE.md.
**Status 2026-07-03 (US-1555):** the supabase skills are installed in
`.claude/skills/` and a permission allowlist already exists
(`.claude/settings.local.json`) — remaining from this table: the one-time
SessionStart hook, and wiring `/verify`, `/code-review`, `/security-review`
into the loop prompts.

| Skill | When |
|---|---|
| `supabase` + `supabase-postgres-best-practices` | Already installed in `.claude/skills/`. Any migration, RLS, or query work. |
| `/verify` | Before committing any nontrivial change — drives the affected flow end-to-end, not just tests. |
| `/code-review` | On every substantive diff; `--fix` mode applies findings. |
| `/security-review` | Before pushing anything touching auth, storage, edge routes, or payments. |
| `/simplify` | Periodic debt pass over recently-changed code. |
| `dataviz` | Any admin analytics/chart work (accuracy dashboards, IRR reports). |
| `deep-research` | Competitor/market research (grading competitors, eBay policy changes). |
| `session-start-hook` | One-time: set up a SessionStart hook so remote/web sessions can run `npm ci` + `deno cache` and immediately lint/test. |
| `fewer-permission-prompts` | One-time: generate an allowlist so agents stop stalling on prompts. |

## 2. Custom project skills to BUILD (highest-leverage item in this doc)

Skills in `.claude/skills/<name>/SKILL.md` load on demand, so deep domain
contracts stop bloating CLAUDE.md and stop getting missed. Each below encodes a
rule set that agents currently either re-derive or violate:

1. ✅ **`grading-engine`** (DONE 2026-07-03, US-1553 — `.claude/skills/grading-engine/`) — the grading domain contract: 5 factors + weights, the
   three rounding sites that must stay in lockstep, prompt-version lifecycle
   (draft → shadow → eval gate → activate), golden-set growth rules, exemplar
   privacy rules (US-1067), review-threshold semantics. Trigger: any edit under
   `services/edge-functions/src/lib/{ai-grading,grading-*,accuracy-*,human-review}*`.
2. ✅ **`migrations`** (DONE 2026-07-03, US-1554 — `.claude/skills/migrations/`) — US-1108 checklist as an executable procedure: idempotency
   patterns, `EXPECTED_SCHEMA_VERSION` bump in same commit, self-record footer,
   `scripts/apply-prod-migrations.sh`, the throwaway-local-stack caveat.
3. ✅ **`tenant-isolation`** (DONE 2026-07-03, US-1554 — `.claude/skills/tenant-isolation/`) — US-268: the explicit-scoping rule, the
   `loadListingOwned`-style ownership-via-parent pattern, and "every new edge
   route needs a case in `tenant-isolation_test.ts`."
4. **`flipdesk-ebay`** — OAuth/refresh + AES-GCM key handling, provenance model
   and field-ownership rules (condense `SYNC_SOURCE_OF_TRUTH.md` into a
   procedure), publish pipeline (`assemblePublishContext`), sandbox testing.
5. **`seo-prerender`** — the `PUBLIC_ROUTES` + `entry-server.tsx` dual
   registration, the react-helmet-async gotcha, JSON-LD mirroring in
   `head-builder.ts`.
6. **`prd-ralph`** — how to pick stories, `nextId` discipline, archive rules,
   stop-the-loop-before-rewrite.
7. **`promo-video`** — see §5; the brand + Higgsfield production procedure.

Rule of thumb: each skill ≤ ~150 lines with references/ for depth; move the
matching CLAUDE.md sections into them and leave one-line pointers behind
(CLAUDE.md is loaded every turn — skills only when relevant).

## 3. Subagents to define (`.claude/agents/*.md`)

- **`tenant-auditor`** — read-only agent whose whole prompt is US-268; sweeps
  edge routes for unscoped service-role queries. Run via a Workflow fan-out
  (one agent per route file) monthly and before launch.
- **`migration-reviewer`** — checks a migration diff against the US-1108
  triple (idempotent / version bump / footer) + destructive-change flags.
- **`grading-eval-analyst`** — reads `accuracy-tracking` outputs + shadow
  results and writes a human-readable "what regressed, what to promote" memo.
- **`pr-shepherd`** — babysits CI on pushed branches (post-launch, once the
  branch-and-PR workflow is restored).

## 4. Hooks & automation (`.claude/settings.json`)

- ✅ **PreToolUse guard** (DONE 2026-07-03, US-1555): `.claude/settings.json`
  + `.claude/hooks/write-guard.mjs` block Edit/Write/NotebookEdit to
  `src/components/ui/**` and `prd.archive.json` with actionable messages.
- **SessionStart hook:** install deps + `deno cache` so web/remote agents are
  productive from turn one (use the `session-start-hook` skill).
- ~~PostToolUse async tsc~~ — REJECTED (2026-07-03 review): `tsc -b` is too
  slow per-edit on this repo; the pre-push hook stays the wall.
- Keep gitleaks/verify git hooks as the hard gate; the Claude hooks are the
  fast inner loop.

## 5. Promo-video pipeline (screenshot → professional video)

The Higgsfield MCP server is already connected to Claude sessions. It covers
this end-to-end: image gen, video gen (`generate_video`), motion transfer
(`motion_control`), ad/explainer **workflow templates**
(`get_workflow_instructions` — always check the catalog first), dubbing/voice,
`reframe` (per-platform aspect ratios), `upscale_video` (2K/4K), and
`virality_predictor` for pre-flight scoring.

Build the **`promo-video` skill** so any session produces on-brand output:

1. **Brand block:** Navy `#0F3460`, Red `#E94560`, Night `#1A1A2E`, Soft Gray
   `#F5F5F5`, Inter 400/500/700; tone (trust/standards/authentication);
   logo + certificate visual references.
2. **Screenshot capture procedure:** Playwright script (Chromium is
   pre-installed in remote envs) that boots `npm run dev` seeded with demo
   data and captures hero screens — grade report, certificate, FlipDesk
   pipeline — at 2× for use as style/inspiration frames.
3. **Production procedure:** upload screenshots (`media_upload`) → style
   frames (`generate_image`, brand-locked prompts) → clips (`generate_video`
   / workflow template for ads) → voiceover/dub → `virality_predictor` gate →
   `reframe` to 16:9 / 9:16 / 1:1 → `upscale_video` → deliver.
4. **Reusable prompt library** in `references/` for the recurring formats:
   product launch, feature spotlight (FlipDesk), certificate explainer,
   seller-onboarding shorts.

## 6. Grading moat — build on what already exists

Already built (do NOT re-propose; this is ahead of any imitator's v1):
prompt-version accuracy tracking (MAE/agreement/correlation per factor and
category), golden eval set with growth test, shadow A/B on live traffic
(US-330), eval-gated promotion, few-shot exemplar mining from corrections
(US-1067), Krippendorff-alpha IRR baseline (US-334), manipulation detection,
photo QA, authenticity signals, SNAD-claim feedback (`claim-accuracy.ts`),
garment baselines, model allowlist + comparison.

The moat is the **correction-data flywheel** — every human review makes the
system better in a way competitors can't copy without the volume. Next layers:

1. **Confidence calibration (highest ROI).** Reliability curves of
   `confidence_score` vs realized error from accuracy-tracking data; replace
   the flat 0.75 review threshold with per-category calibrated thresholds that
   target a chosen error rate. Fewer wasted reviews AND fewer bad grades
   shipped — directly monetizable as review-queue cost.
2. **Selective second-opinion ensemble.** For borderline-confidence or
   high-value items, re-run the composite stage with a second allowlisted
   model (infra exists in `model-comparison` + shadow); disagreement > ε →
   human review. Ensemble-on-disagreement beats always-ensemble on cost.
3. **Active-learning review routing.** Rank the review queue by information
   value (novel category/defect combos, calibration-gap regions), not FIFO —
   each human hour grows the golden set and exemplar pool fastest.
4. ✅ **Verifiable certificates — BUILT** (corrected 2026-07-03, US-1555):
   cert-integrity v3 already ships canonical-hash sealing + optional HMAC
   signing, the public /verify page with printable certificate numbers
   (US-00307) and QR, and the guarantee coverage scope sealed into the hash
   (US-1279). The only unbuilt slice is a cross-certificate transparency
   chain (each cert hashing the previous) — low value until someone disputes
   the append-only property; don't build speculatively.
5. **Outcome-grounded truth.** Extend claim-accuracy beyond SNAD: FlipDesk
   knows sale price, returns, and disputes — regress realized outcomes against
   grades to prove (and publish) that grade ↔ price/return-rate correlation.
   That dataset is the durable moat.
6. **Publish the benchmark.** Public methodology page + periodic accuracy/IRR
   report ("our AI agrees with expert consensus within 0.5 on X% of items;
   human-vs-human baseline is Y%"). Credibility compounds; a copycat without
   the data can't publish comparable numbers. (SEO/GEO win too.)
7. **Capture guidance loop.** Use photo-QA failure stats to drive in-app
   guided capture (per-category overlay prompts); better inputs → higher
   confidence → fewer reviews. Hardware-free version of what grading
   incumbents (PSA etc.) get from controlled capture.

## 7. Multi-agent workflows (Workflow tool / ultracode)

Once §2–3 exist, run these as fan-out workflows on demand:
- **Tenant-isolation audit:** one `tenant-auditor` per edge route file →
  adversarial verify pass on findings → report.
- **Pre-launch sweep:** parallel agents over LAUNCH_CHECKLIST.md sections.
- **Prompt-version regression triage:** per-category analysis agents feeding
  the `grading-eval-analyst` synthesis.

## 8. Suggested sequence

1. §2.1–2.3 skills (grading-engine, migrations, tenant-isolation) + §4 hooks — a week of work, immediately raises every agent-hour.
2. §6.1 calibration + §6.3 review routing — direct cost/quality win from data you already collect.
3. §5 promo-video skill + first launch video — marketing-ready before launch.
4. §6.4 verifiable certificates + §6.6 published benchmark — the public moat.
5. §3 subagents + §7 workflows — scale the auditing once skills encode the rules.
