# GradeThread Compliance Audit — Legal Docs, Accessibility, Privacy

**Date:** 2026-07-23 · **Scope:** GradeThread web app (`src/`), edge functions (`services/edge-functions/`), and Supabase migrations. iOS app reviewed only where the web audit overlaps.
**Method:** static code/content review across three tracks — (1) required legal documents & pages, (2) ADA / WCAG 2.1 AA accessibility, (3) GDPR & US-state privacy law (CCPA/CPRA + VCDPA/CPA/CTDPA/UCPA).

---

## Executive summary

GradeThread's compliance posture is **strong and unusually mature** for a company of this size — this is a purpose-built compliance program, not boilerplate. All ten legal pages exist, are routed, linked, and prerendered; the privacy engineering (consent gating, DSAR, deletion, subprocessor scrubbing) is backed by regression tests; and there is a published WCAG 2.1 AA VPAT plus a candid `/accessibility` statement.

The residual risk is concentrated in three themes, none of which is a data-leak or a missing document:

| Theme | Where | Severity |
|---|---|---|
| **Content drift** — policy text edited without the enforcement/metadata systems being updated | Legal (Privacy/DPA re-acceptance, sitemap `lastmod`, subprocessor list) | CRITICAL (process) |
| **Tooling blind spot** — `jsx-a11y` lint matches raw DOM tags, not the app's shadcn wrapper components, so admin/FlipDesk surfaces slipped through | Accessibility | HIGH (systemic) |
| **Demonstrability gaps** — controls work but aren't independently provable/configured-in-code | Privacy (cookie-consent record, PostHog masking) | MEDIUM |

**This pass fixed the safe, unambiguous items** (see §5). The remaining items either need a **legal/business decision** (forcing re-acceptance) or a **coordinated remediation with visual/CI verification** (the a11y lint mapping + admin form labels + contrast token) and are listed as a prioritized backlog in §6.

**Overall ratings:** Legal docs **A-** · Accessibility **B+** (customer-facing A; admin surfaces C) · Privacy **A-**.

---

## 1. Legal documents & pages

### Inventory — no structural gaps
All 10 legal pages (`privacy, terms, cookies, acceptable-use, refund, imprint, dpa, subprocessors, dmca, accessibility`) exist, are wired to public SPA routes (`src/routes/index.tsx:370-379`), linked from the marketing footer (`src/components/marketing/marketing-layout.tsx:182-219`) and the dedicated legal side-nav (`src/components/legal/legal-layout.tsx:18-29`), and prerendered for SEO (`src/lib/seo/public-routes.ts` + `src/prerender/entry-server.tsx`). No orphaned/unlinked page. Terms coverage is complete (arbitration + class waiver + 30-day opt-out, liability cap, AI-output disclaimer, governing law, termination). No placeholder text anywhere; entity name, governing law (Iowa), address, and 18+ age floor are consistent across all docs.

### Findings

| ID | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| **L-C1** | CRITICAL | Privacy Policy materially updated to **June 12, 2026** (added EXIF/GPS metadata collection, Verified-Capture device fingerprinting, human-QA reviewer photo access, browser-extension telemetry) but the `legal_documents` table that drives US-904 forced re-acceptance was only ever seeded at `2026-04-01`. **Users who accepted the April policy have never been asked to re-consent to the new data-collection categories.** | `privacy.tsx:10`; `supabase/migrations/00226_legal_documents.sql:75-79`; `src/components/auth/legal-gate.tsx:20-32` | **FLAG — needs legal decision** |
| **L-C2** | CRITICAL | The DPA also drifted to **June 12** (added the human-review-minimization bullet) but `DocKind` in the admin legal manager is only `"tos" \| "privacy"` — the DPA has **no versioning / change-notice mechanism at all**, despite being the document B2B/GDPR-processor customers rely on for change notice. | `dpa.tsx:10,34`; `src/pages/admin/legal.tsx:41` | **FLAG — needs decision** |
| **L-H1** | HIGH | Sitemap `<lastmod>` for `/privacy` and `/dpa` was stuck at `2026-04-01`, contradicting the pages' own rendered June 12 date and telling crawlers nothing changed. | `src/lib/seo/public-routes.ts:173,179` | ✅ **FIXED** |
| **L-H2** | HIGH | Privacy §7 subprocessor list omitted **OpenAI, eBay, and the VPS host** that the canonical `/subprocessors` page discloses, and read as exhaustive. | `privacy.tsx:338-371` vs `subprocessors.tsx:15-24` | ✅ **FIXED** |
| **L-M1** | MED | No **VCDPA/CPA/CTDPA/UCPA** state-rights section, even though the cookie-consent system already treats ~20 states as an opt-out regime. | `privacy.tsx §9`; `src/lib/consent-regime.ts:7-9` | ✅ **FIXED** |
| **L-M2** | MED | Privacy §14 contact block lacked the physical mailing address GDPR Art. 13(1)(a) expects (available on Imprint). | `privacy.tsx:522-529` | ✅ **FIXED** |
| **L-M3** | MED | Only ToS/Privacy have versioning; the other 8 docs (incl. Refund & Cookies, which have consumer-material terms) have no change-tracking. | `src/pages/admin/legal.tsx:41` | **FLAG — confirm scope** |
| **L-M4** | MED | Accessibility page showed two inconsistent freshness dates ("April 1" effectiveDate vs imprecise "June 2026"). | `accessibility.tsx:10,27` | ✅ **FIXED** (now "Last conformance review: June 12, 2026") |
| **L-L1** | LOW | No literal "Do Not Sell or Share My Personal Information" link — **acceptable**: satisfied by the CPRA-recognized "Your Privacy Choices" control + automatic GPC honoring + persistent footer reopener. | `cookie-consent.tsx:137`, `consent-regime.ts:53-62` | No action |

---

## 2. Accessibility (WCAG 2.1 AA)

### Context
The codebase is meaningfully more a11y-mature than a typical target: `eslint-plugin-jsx-a11y` with a broad ruleset, `axe-core` tests, a documented contrast-token system (`src/lib/a11y/contrast.ts`), working skip-links, correct `prefers-reduced-motion`, and a published VPAT 2.5 (`vault/20-domain/accessibility-conformance-vpat.md`). Images (54 `<img>` surveyed — all correctly `alt`'d), `lang="en"`, non-zoom-blocking viewport, landmarks, headings, and toasts (sonner live region) all audited **clean**. The gaps below are what survives that tooling — and they survive largely because of a single root cause.

### Findings

| ID | Sev | Finding | WCAG | Evidence | Status |
|---|---|---|---|---|---|
| **A-H6** | HIGH | **Root cause:** `jsx-a11y` rules match literal DOM tags (`input`/`label`/`button`), but the app almost universally uses the shadcn wrappers `<Input>`/`<Label>`/`<Button>`. No `settings.components` mapping exists, so `label-has-associated-control`, `control-has-associated-label`, etc. **never reach real usage** — the enforcement claimed in `eslint.config.js:50-54` is largely inert. This is why A-C1/A-H3 slipped through a lint-gated CI. | — | `eslint.config.js`; `src/components/ui/{input,button,label}.tsx` | **FLAG — see §6** |
| **A-C1** | CRITICAL | Admin/FlipDesk dialogs pair `<Label>`+`<Input>` with **no `htmlFor`/`id`** — screen readers announce no field name. Customer-facing flows (login, signup, settings, garment-info) do this correctly; internal tooling frequently does not. | 1.3.1, 3.3.2, 4.1.2 | `admin/pricing.tsx:157-186`, `admin/coupons.tsx:154-205`, `admin/config-pricing.tsx`, `admin/growth/campaigns.tsx`, `admin/growth/announcements.tsx`, `admin/condition-index.tsx`, `admin/brand-knowledge.tsx:254` | **FLAG — see §6** |
| **A-H2** | HIGH | `buyer/portfolio.tsx:242-244` — three inputs with placeholder-only, no per-field label. | 1.3.1, 3.3.2 | `buyer/portfolio.tsx:242` | **FLAG** |
| **A-H3** | HIGH | Icon-only buttons with no accessible name (edit/delete/view/remove). | 4.1.2, 1.1.1 | `brand-knowledge.tsx:368,371`, `ops-dead-letters.tsx:412`, `drip.tsx:779` | ✅ **FIXED** (4 buttons; `aria-label` added) |
| **A-H4** | HIGH | Hover-reveal controls (`opacity-0 group-hover:opacity-100`) with no `focus-visible` counterpart — **invisible to sighted keyboard users** when focused. | 2.4.7, 2.1.1 | `photo-upload.tsx:598` (core submission flow), `flipdesk/photo-uploader.tsx:575`, `flipdesk/pipeline.tsx:993`, `flipdesk/autolister.tsx` (8 controls), `admin/task-board.tsx:734` | ✅ **FIXED** (12 controls; `focus-visible:opacity-100` added) |
| **A-H5** | HIGH | `text-muted-foreground` (#64748b) on `bg-muted` (#f0f4f8) = **4.31:1**, below the 4.5:1 AA threshold, at full opacity in avatar fallback + several FlipDesk badges. Light-theme only (dark passes at 5.64:1). | 1.4.3 | `src/index.css:142-143`; `avatar.tsx:47,92` + FlipDesk cards | **FLAG — design-token change, see §6** |
| **A-M7** | MED | Command-palette search inputs use `outline-none` with no focus-ring replacement. Low impact (auto-focused, sole control in dialog). | 2.4.7 | `admin/command-palette.tsx:190`, `flipdesk/command-palette.tsx:633` | No action (noted) |
| **A-M8** | MED | `axe-core` page tests cover only 3 of ~229 pages (landing/login/signup) — the admin/FlipDesk surfaces where the real gaps live are untested. | — | `src/pages/__tests__/page-a11y-axe.test.tsx:24-26` | **FLAG — see §6** |
| **A-L9** | LOW | Required custom `<Select>` fields marked with visual `*` only, no `aria-required`. | 3.3.2 | `garment-info-form.tsx:143-182` | **FLAG** |
| **A-L10** | LOW | `<main id="main-content">` skip-link target uses `outline-none` with no visible-focus substitute (the skip link itself is correct). | 2.4.7 | `dashboard-layout.tsx:41`, `buyer-layout.tsx:38`, `admin-layout.tsx:622` | **FLAG** |

### ⚠️ VPAT accuracy risk
The published VPAT (`vault/20-domain/accessibility-conformance-vpat.md`) claims **"Supports"** for 1.1.1, 1.3.1, 3.3.2, 4.1.2, and 1.4.3 — but A-C1/A-H3/A-H5 are real defects against exactly those criteria on admin/FlipDesk surfaces. The VPAT is `source_of_truth: code` and "must stay true" — a stale VPAT is a **misrepresentation to procurement**. Notably the customer-facing `/accessibility` statement is honest (claims only "partial conformance" and names the bulk-editor gap). **Action:** after remediating §6, re-review the VPAT; until then, either scope its claims to the customer-facing surface or downgrade the affected rows to "Partially Supports." (Editing that note requires the `vault` skill's same-commit rule.)

---

## 3. Privacy mechanics (GDPR / CCPA-CPRA)

Genuinely mature and mostly test-backed. Summary:

| Area | Status | Note |
|---|---|---|
| Cookie consent — Consent Mode v2 default-denied, PostHog dynamically imported only post-consent, geo-aware opt-in/opt-out regime, GPC honored, granular + revocable | ✅ IMPLEMENTED | `src/index.html` consent bootstrap; `src/lib/analytics.ts:153-197`; `consent-regime.ts`; `cookie-consent.tsx` |
| DSAR — self-serve export (`GET /api/account/export`) + delete (`POST /api/account/delete`, requires typed confirmation, MFA step-up, owner-with-members guard) + audited operator queue (US-903) | ✅ IMPLEMENTED | `services/edge-functions/src/routes/account.ts`, `admin-compliance.ts`, `migrations/00225_data_requests.sql` |
| Deletion completeness — cascades incl. **email-keyed** PII (US-2005), storage originals with GPS (US-1637/US-339), Stripe customer, passport re-pseudonymization; non-PII proof-of-deletion log | ✅ IMPLEMENTED | `account.ts:437-624` |
| ToS/Privacy versioned acceptance + append-only audit table; marketing consent umbrella+granular; double opt-in newsletter; one-click RFC 8058 unsubscribe | ✅ IMPLEMENTED | `migrations/00142_legal_acceptance.sql`; `email-consent.ts`; `unsubscribe.ts` |
| Subprocessor scrubbing — Sentry `sendDefaultPii:false` + hard IP strip; PostHog URL-token redaction | ✅ IMPLEMENTED | `src/lib/sentry.ts:22-58`; `analytics.ts:163-180` |
| Private buckets/signed URLs (≤900s) + EXIF stripping, enforced by static-analysis test | ✅ IMPLEMENTED | `private-bucket-access_test.ts`; `image-metadata.ts` |
| Age gate 18+ (self-attestation, both email & OAuth) | ✅ IMPLEMENTED | `signup.tsx:450-474` |

### Findings

| ID | Sev | Finding | Requirement | Status |
|---|---|---|---|---|
| **P-M1** | MED | Cookie-consent decision is stored **only client-side** (`localStorage: gt_cookie_consent`); no server-side timestamped record. GDPR Art. 7(1) requires the controller to be able to **demonstrate** consent. Low leakage risk (nothing non-essential fires without it) but a demonstrability gap — unlike ToS acceptance, which is server-recorded. | GDPR Art. 7(1) | **FLAG** |
| **P-M2** | MED | PostHog `init` sets `sanitize_properties` (URL-token redaction) but does **not** set `autocapture:false` / `disable_session_recording` / `mask_all_text`. SDK defaults autocapture ON; forms include name/address fields. Session recording is gated by the PostHog project dashboard (not in repo), so this may be inert — but there's no in-code defense-in-depth, unlike Sentry. | GDPR data minimization | **FLAG** |
| **P-L3** | LOW | eBay OAuth tokens destroyed locally on account deletion but not revoked at eBay's servers (relies on short TTL). | — | Confirm TTL |

---

## 4. Incidental (out of audit scope, noted)
- **Pre-existing lint error:** `src/lib/safe-url.ts:14` fails `no-control-regex` under the pinned ESLint 9.39.2 (`\x00` in a URL sanitizer, likely needs an `eslint-disable-next-line` with a rationale). Not touched by this audit; flagged because it would block the `pre-push` verify hook.

---

## 5. What this pass changed (all build-verified: `npm run build` green, 0 new lint errors)

| File | Change | Finding |
|---|---|---|
| `src/lib/seo/public-routes.ts` | `/privacy` & `/dpa` `lastmod` → `2026-06-12`; comment tightened to a sync rule | L-H1 |
| `src/pages/legal/privacy.tsx` | §7: added OpenAI/eBay/VPS-host, marked list non-exhaustive; §9: added multi-state rights paragraph + GPC/opt-out note in CA para; §14: added mailing address + Imprint link | L-H2, L-M1, L-M2 |
| `src/pages/legal/accessibility.tsx` | Reconciled freshness dates | L-M4 |
| `src/components/submission/photo-upload.tsx` | Remove-photo button: `aria-label` + `focus-visible` | A-H3/A-H4 |
| `src/components/flipdesk/photo-uploader.tsx`, `pages/flipdesk/pipeline.tsx`, `pages/flipdesk/autolister.tsx` (8), `pages/admin/task-board.tsx` | `focus-visible:opacity-100` on keyboard-invisible hover controls (12 total) | A-H4 |
| `src/pages/admin/{brand-knowledge,ops-dead-letters,drip}.tsx` | `aria-label` on 4 icon-only buttons | A-H3 |

---

## 6. Prioritized remediation backlog (not done — needs decision or coordinated work)

**P0 — Legal, needs a business/counsel decision (highest exposure):**
1. **L-C1/L-C2:** Publish `2026-06-12` `privacy` (and extend versioning to `dpa`) rows via `/admin/legal` with `requires_reacceptance=true`, since the new data categories (biometric-adjacent device fingerprinting, human photo review, extension telemetry) are material. Then **add a CI guard** tying each `effectiveDate` literal in `src/pages/legal/*.tsx` to the `legal_documents` "current" version so they cannot silently drift again. *(Migration work → load the `migrations` skill; forcing re-acceptance of the whole user base is a policy call, not a code call — do not do it unilaterally.)*

**P1 — Accessibility, systemic (fixes the root cause + the CRITICAL surface together):**
2. **A-H6 + A-C1:** Add `settings: { "jsx-a11y": { components: { Input: "input", Label: "label", Button: "button", Textarea: "textarea", Select: "select" } } }` to `eslint.config.js`, then fix every violation it surfaces (add `htmlFor`/`id` to the admin/FlipDesk dialog label-input pairs in the ~7 files under A-C1). Do these **together** — enabling the mapping without fixing the violations turns them into build-breaking lint errors. Budget for a full pass, not a sample.
3. **A-M8:** Extend `axe-core` coverage to representative admin + FlipDesk pages so these regress loudly.
4. **A-H5 (contrast):** Darken `--muted-foreground` to **`#5b6674`** (verified 5.28:1 on `--muted`, 5.84:1 on card — passes AA with margin, modest visual change). App-wide design token → wants a quick visual QA; not changed here for that reason. Validate with `src/lib/a11y/contrast.ts`.
5. **A-H2 / A-L9 / A-L10:** per-field labels on `buyer/portfolio.tsx`; `aria-required` on required Selects; visible-focus on `<main>` targets.
6. **VPAT:** re-review `accessibility-conformance-vpat.md` after the above (see §2 warning).

**P2 — Privacy demonstrability:**
7. **P-M1:** Persist cookie-consent decisions server-side (timestamp + regime + choices) for Art. 7(1) demonstrability.
8. **P-M2:** Set PostHog `autocapture:false` (or `ph-no-capture` on sensitive form fields) + explicit `disable_session_recording`/masking in code as defense-in-depth.

**P3 — Housekeeping:** confirm L-M3 (versioning scope for the other 8 docs) is intentional; fix the incidental `safe-url.ts` lint error (§4).
