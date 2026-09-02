---
title: Accessibility conformance report (VPAT 2.5)
aliases: [VPAT, WCAG, Section 508]
type: contract
status: current
source_of_truth: code
code_refs:
  - src/components/breadcrumbs.tsx
  - src/lib/seo/public-routes.ts
reviewed: 2026-09-02
tags: [accessibility, compliance, wcag, vpat]
summary: WCAG 2.1 AA, Section 508 and EN 301 549 conformance claims — a published artifact that must stay true, not a snapshot.
---

> [!important] NOT archived — this is a live compliance artifact
> US-2057 listed this for the archive; it was routed to `20-domain` as
> `status: current` instead, deliberately.
>
> A VPAT is **published to customers and procurement** and asserts conformance
> with WCAG 2.1 AA, Section 508 and EN 301 549. Unlike an audit snapshot it must
> describe the product **as it is today** — a stale VPAT is not merely outdated,
> it is a misrepresentation to the people relying on it.
>
> It is therefore `source_of_truth: code` with `code_refs`, so the drift guard
> flags it when the accessibility surface changes. It should be re-reviewed on
> any a11y-affecting change, not on a schedule.
# Accessibility Conformance Report — GradeThread & FlipDesk

> **Re-reviewed 2026-09-02.** Drift flagged `public-routes.ts` for seventeen new
> indexable pages (fourteen marketplace pair pages, two switch-from pages,
> `/partners`). They are prose pages built from the same marketing layout the
> conformance claims below already cover: no new widget, no new interaction
> pattern, no canvas or drag surface. The claim set is unchanged; the page COUNT
> in any external VPAT copy is not restated here for exactly this reason.


> **Re-reviewed 2026-08-31.** Drift flagged `src/lib/seo/public-routes.ts` for US-9033, which registers one
> new public route (`/tools/rn-lookup`) and its lastmod. It adds no component,
> no interaction pattern and no markup, so nothing this note claims about
> conformance moves. The new page uses the same MarketingLayout, Input, Label
> and Button primitives already audited here.

### Voluntary Product Accessibility Template® (VPAT®) — Version 2.5 (INT)

**Based on the ITI VPAT® 2.5 INT** — covering, in a single report:

- **WCAG 2.1** Level A and Level AA
- **Revised Section 508 standards** (U.S. — 36 CFR Part 1194, Appendix A, ICT)
- **EN 301 549** (EU — Accessibility requirements for ICT products and services, V3.2.1)

---

## Name of Product/Version

**GradeThread** (web application) and **GradeThread for iOS** (native iOS application), including the embedded **FlipDesk** reseller-management surface.

- Web application version: 1.0.0
- iOS application version: 1.0.1

## Report Date

July 2, 2026

## Product Description

GradeThread is a SaaS platform for standardized, AI-powered condition grading of pre-owned clothing. Sellers upload garment photos and receive a numerical condition grade (1.0–10.0), a condition report, and a shareable certificate. **FlipDesk** is the integrated reseller-management surface (full eBay listing lifecycle: source → catalog → measure → photograph → grade → comp → draft → list → sell → ship → reconcile). The product is delivered as a responsive web application (React) and a native iOS application (SwiftUI).

## Contact Information

Pearson Media LLC — accessibility@gradethread.com

## Notes

**Regulatory status (internal record).** Pearson Media LLC is a microenterprise (fewer than 10 employees and under €2M annual turnover) and, as a service provider, qualifies for the microenterprise exemption under the European Accessibility Act (Directive (EU) 2019/882). Notwithstanding that exemption, GradeThread **voluntarily** targets and self-reports WCAG 2.1 Level AA conformance, both as a matter of policy and because other applicable frameworks — notably the U.S. Americans with Disabilities Act (Title III), which contains no small-business exemption for web accessibility — are unaffected by the EAA microenterprise status. This report is maintained as evidence of that voluntary conformance; the exemption is not asserted publicly.

This report covers two distinct platforms with separate conformance characteristics. Where a criterion's conformance differs between the **Web** and **iOS** platform, both are stated in the *Remarks and Explanations* column. Criteria relating to pre-recorded and live time-based media (audio/video) are marked **Not Applicable**: neither platform ships pre-recorded audio or video content. The only media surfaces are live device-camera viewfinders (barcode and photo capture), which are muted, carry no audio track, and present no synchronized pre-recorded content.

## Evaluation Methods Used

- **Web:** Automated testing with `axe-core` (jsdom unit suites in Vitest) and `eslint-plugin-jsx-a11y` (build-blocking lint rules), supplemented by manual code review of semantic structure, keyboard operation, focus management, and color-contrast ratio computation (`src/lib/a11y/contrast.ts` + `contrast.test.ts`). Brand color tokens are verified against WCAG AA ratios in both light and dark themes (`docs/ACCESSIBILITY_CONTRAST.md`).
- **iOS:** Manual source review (SwiftUI accessibility modifiers, Dynamic Type, asset-catalog color appearances, Reduce Motion handling) plus an automated `XCUIApplication.performAccessibilityAudit()` UI-test pass (iOS 17+) on the primary reachable screens, run on macOS CI.

---

## Applicable Standards/Guidelines

| Standard/Guideline | Included in Report |
| --- | --- |
| Web Content Accessibility Guidelines 2.1 | Level A (Yes) · Level AA (Yes) · Level AAA (No) |
| Revised Section 508 standards (2017, as amended) | Yes |
| EN 301 549 Accessibility requirements for ICT products and services — V3.2.1 | Yes |

## Terms

The terms used in the Conformance Level column are defined as follows:

- **Supports:** The functionality of the product has at least one method that meets the criterion without known defects, or meets with equivalent facilitation.
- **Partially Supports:** Some functionality of the product does not meet the criterion.
- **Does Not Support:** The majority of product functionality does not meet the criterion.
- **Not Applicable:** The criterion is not relevant to the product.
- **Not Evaluated:** The product has not been evaluated against the criterion. (Used only for WCAG 2.1 Level AAA in this report, which is out of scope.)

---

# WCAG 2.1 Report

Tables 1 and 2 document conformance with WCAG 2.1 Level A and Level AA. The Section 508 and EN 301 549 chapters that follow reference WCAG by these tables where their requirements incorporate WCAG by reference.

## Table 1: Success Criteria, Level A

| Criteria | Conformance Level | Remarks and Explanations |
| --- | --- | --- |
| **1.1.1 Non-text Content** (A) | Supports | **Web:** All meaningful images carry descriptive `alt`; decorative images use `alt=""`; icon-only controls carry `aria-label`. The `jsx-a11y/alt-text` lint rule is build-blocking. The `responsive-image` component makes `alt` a required prop. **iOS:** Meaningful images/`Image(systemName:)` carry `.accessibilityLabel`; decorative symbols use `.accessibilityHidden(true)`. **Note:** User-generated garment photos may lack uploader-supplied descriptions; the platform supplies type labels (front/back/label/detail) as accessible names. |
| **1.2.1 Audio-only and Video-only (Prerecorded)** (A) | Not Applicable | Neither platform contains pre-recorded audio-only or video-only content. Camera viewfinders are live, muted, and carry no audio. |
| **1.2.2 Captions (Prerecorded)** (A) | Not Applicable | No pre-recorded synchronized media. |
| **1.2.3 Audio Description or Media Alternative (Prerecorded)** (A) | Not Applicable | No pre-recorded synchronized media. |
| **2.1.1 Keyboard** (A) | Supports | **Web:** All interactive elements are native controls or Radix-backed components operable by keyboard; the single custom clickable element implements `role`, `tabIndex`, and key handlers; `jsx-a11y/click-events-have-key-events` and `interactive-supports-focus` are build-blocking. **iOS:** Operable via VoiceOver, Full Keyboard Access, and Switch Control through standard SwiftUI controls and accessibility traits. |
| **2.1.2 No Keyboard Trap** (A) | Supports | **Web:** Modal focus traps (Radix dialogs and the custom `focus-trap` library) restore focus to the opener and release on Escape/close. **iOS:** Standard navigation; no trapping. |
| **2.1.4 Character Key Shortcuts** (A) | Supports | No single-character key shortcuts are implemented without modifier or focus scoping. |
| **2.2.1 Timing Adjustable** (A) | Supports | No time limits are imposed on user interactions. Session token refresh is automatic and non-disruptive. |
| **2.2.2 Pause, Stop, Hide** (A) | Supports | **Web:** No auto-updating/blinking content other than loading indicators (which expose `role="status"`); the marketing motion backdrop is disabled under `prefers-reduced-motion`. **iOS:** Animations honor Reduce Motion. |
| **2.3.1 Three Flashes or Below Threshold** (A) | Supports | No flashing content above threshold on either platform. |
| **2.4.1 Bypass Blocks** (A) | Supports | **Web:** "Skip to content" links target the `<main>` landmark in both authenticated layouts; semantic landmarks present. **iOS:** Rotor and landmark navigation via standard navigation containers. |
| **2.4.2 Page Titled** (A) | Supports | **Web:** Each route sets a descriptive document title (`<SEO>` / head-builder); prerendered pages emit titled `<head>`. **iOS:** Screens carry navigation titles. |
| **2.4.3 Focus Order** (A) | Supports | **Web:** DOM order is logical; only `tabIndex={-1}` (skip targets) and `tabIndex={0}` (one keyboard-enabled cell) are used; no positive tabindex (`tabindex-no-positive` is build-blocking). **iOS:** Standard reading order; grouped accessibility elements where appropriate. |
| **2.4.4 Link Purpose (In Context)** (A) | Supports | **Web:** Links have discernible text or `aria-label`; image-only links carry accessible names. **iOS:** Tappable rows expose descriptive labels. |
| **3.1.1 Language of Page** (A) | Supports | **Web:** `<html lang="en">` is set. **iOS:** Localized strings under the app's base localization. |
| **3.2.1 On Focus** (A) | Supports | No context change occurs on focus on either platform. |
| **3.2.2 On Input** (A) | Supports | Form inputs do not trigger unexpected context changes; submission is explicit. |
| **3.3.1 Error Identification** (A) | Supports | **Web:** Errors identified in text and programmatically via `aria-invalid` + `aria-describedby` (`FieldError`/`FormErrorSummary` with `role="alert"`). **iOS:** Validation errors surfaced in text with VoiceOver announcement (`A11yAnnounce`). |
| **3.3.2 Labels or Instructions** (A) | Supports | **Web:** Inputs are labeled via `<Label htmlFor>`; `jsx-a11y/label-has-associated-control` is build-blocking. **iOS:** Controls carry accessibility labels matching visible text. |
| **4.1.1 Parsing** (A) | Supports | (Obsolete/removed in WCAG 2.2; retained here for 2.1.) Markup is generated by React with valid, non-duplicate IDs. |
| **4.1.2 Name, Role, Value** (A) | Supports | **Web:** Radix primitives expose correct name/role/value; custom controls supply ARIA; expanded jsx-a11y rule set is build-blocking; axe suites assert no serious/critical violations on covered surfaces. **iOS:** Standard controls + explicit traits/labels; an automated `performAccessibilityAudit()` pass runs in CI. |

## Table 2: Success Criteria, Level AA

| Criteria | Conformance Level | Remarks and Explanations |
| --- | --- | --- |
| **1.2.4 Captions (Live)** (AA) | Not Applicable | No live synchronized audio content. |
| **1.2.5 Audio Description (Prerecorded)** (AA) | Not Applicable | No pre-recorded video content. |
| **1.3.1 Info and Relationships** (A)¹ | Supports | **Web:** Semantic HTML, landmarks, programmatic label/error associations; lint enforces structural rules. **iOS:** Accessibility grouping (`.accessibilityElement(children:)`) and explicit labels on composite views. |
| **1.3.2 Meaningful Sequence** (A)¹ | Supports | Reading/DOM order is meaningful on both platforms. |
| **1.3.3 Sensory Characteristics** (A)¹ | Supports | Instructions do not rely solely on shape, size, or position. |
| **1.3.4 Orientation** (AA) | Supports | **Web:** Responsive; no orientation lock. **iOS:** Supports portrait and landscape where applicable; content not locked to a single orientation except where essential. |
| **1.3.5 Identify Input Purpose** (AA) | Supports | **Web:** Inputs use appropriate `type`/`autocomplete` attributes for common fields. **iOS:** `textContentType` set on auth fields. |
| **1.4.1 Use of Color** (A)¹ | Supports | **Web:** Status/state conveyed with text/icons in addition to color (verified by axe primitive tests). **iOS:** Status badges, dispute/sync/grade states pair color with icon shape and text; grade tier now carries a non-color (symbol/text) cue, and `accessibilityDifferentiateWithoutColor` strengthens shape cues when enabled. |
| **1.4.2 Audio Control** (A)¹ | Not Applicable | No auto-playing audio. |
| **1.4.3 Contrast (Minimum)** (AA) | Supports | **Web:** Brand tokens remediated to ≥4.5:1 normal / ≥3:1 large in both themes; ratios documented and asserted by `contrast.test.ts` (e.g., white-on-red 5.48:1, red text 5.26–6.36:1). **iOS:** Asset-catalog colors ship dark and high-contrast variants (including a dark variant for the previously light-only brand red); contrast-sensitive tinted badges reviewed against AA. |
| **1.4.4 Resize Text** (AA) | Supports | **Web:** Layout reflows; text scales to 200% via browser zoom without loss of content. **iOS:** Dynamic Type via semantic text styles; no `dynamicTypeSize` caps below AX5; raw fixed-size text converted to scale relative to a text style. |
| **1.4.5 Images of Text** (AA) | Supports | Text is real text; images of text are not used for UI copy. |
| **1.4.10 Reflow** (AA) | Supports | **Web:** Responsive layout reflows to 320 CSS px without two-dimensional scrolling for primary content. **iOS:** Native adaptive layout. |
| **1.4.11 Non-text Contrast** (AA) | Supports | **Web:** UI component boundaries and focus indicators meet ≥3:1. **iOS:** Control affordances and icons meet ≥3:1 with high-contrast asset variants. |
| **1.4.12 Text Spacing** (AA) | Supports | **Web:** No loss of content with user text-spacing overrides; no fixed line-height truncation on body copy. **iOS:** Dynamic Type accommodates spacing. |
| **1.4.13 Content on Hover or Focus** (AA) | Supports | **Web:** Tooltips/popovers (Radix) are dismissable, hoverable, and persistent. **iOS:** No hover-dependent content. |
| **2.4.5 Multiple Ways** (AA) | Supports | **Web:** Navigation menu, in-app search, sitemap, and direct links provide multiple ways to locate pages. **iOS:** Tab bar + search. |
| **2.4.6 Headings and Labels** (AA) | Supports | **Web:** Descriptive headings and labels; `heading-has-content` enforced; hierarchy verified on representative + audited pages. **iOS:** Descriptive screen titles and control labels. |
| **2.4.7 Focus Visible** (AA) | Supports | **Web:** Systematic `focus-visible` ring styling (shadcn inputs, global `outline-ring`, skip links, dialog close). **iOS:** System focus ring under Full Keyboard Access. |
| **3.1.2 Language of Parts** (AA) | Supports | Content is single-language (English); no mixed-language passages requiring `lang` on parts. |
| **3.2.3 Consistent Navigation** (AA) | Supports | Navigation is consistent across pages/screens within each platform. |
| **3.2.4 Consistent Identification** (AA) | Supports | Components with the same function are identified consistently. |
| **3.3.3 Error Suggestion** (AA) | Supports | **Web:** Validation messages suggest corrections where known. **iOS:** Inline guidance on invalid input. |
| **3.3.4 Error Prevention (Legal, Financial, Data)** (AA) | Supports | Reversible/confirmable flows for payments and destructive actions (confirmation dialogs); submissions are reviewable before commit. |
| **4.1.3 Status Messages** (AA) | Supports | **Web:** `role="status"`/`aria-live`/`role="alert"` regions announce async results and loading. **iOS:** `A11yAnnounce` posts VoiceOver announcements/screen-changed notifications for async results. |

¹ Level A criteria repeated here for completeness within the AA report context per VPAT template; their level is unchanged.

> **WCAG 2.1 Level AAA:** Out of scope for this report (Not Evaluated).

---

# Revised Section 508 Report

**Notes:** Chapters 3–6 below. WCAG-incorporated criteria reference the WCAG 2.1 tables above.

## Chapter 3: Functional Performance Criteria (FPC)

| Criteria | Conformance Level | Remarks and Explanations |
| --- | --- | --- |
| 302.1 Without Vision | Supports | Full operation via VoiceOver (iOS) and screen readers (web): labeled controls, status announcements, logical reading order. |
| 302.2 With Limited Vision | Supports | Text resize/Dynamic Type to 200%+, AA contrast in light and dark themes, high-contrast asset variants (iOS). |
| 302.3 Without Perception of Color | Supports | Color is never the sole information channel; status/grade tiers carry text + icon shape; `differentiateWithoutColor` honored (iOS). |
| 302.4 Without Hearing | Supports | No information is conveyed by sound alone (no audio content). |
| 302.5 With Limited Hearing | Supports | No audio-dependent functionality. |
| 302.6 Without Speech | Supports | No speech-only operation is required. |
| 302.7 With Limited Manipulation | Supports | Keyboard/Switch/Full Keyboard Access operability; iOS controls meet a 44pt minimum hit target. |
| 302.8 With Limited Reach and Strength | Supports | No operation requires simultaneous actions or sustained physical effort. |
| 302.9 With Limited Language, Cognitive, and Learning Abilities | Supports | Consistent navigation/identification, clear labels, error suggestions, and reduced-motion options. |

## Chapter 4: Hardware

| Criteria | Conformance Level | Remarks and Explanations |
| --- | --- | --- |
| 4 Hardware | Not Applicable | GradeThread is software (web + iOS app); it includes no proprietary hardware. |

## Chapter 5: Software

| Criteria | Conformance Level | Remarks and Explanations |
| --- | --- | --- |
| 501.1 Scope — Incorporation of WCAG 2.1 AA | Supports | The iOS app and web app conform to WCAG 2.1 AA per the tables above. |
| 502 Interoperability with Assistive Technology | Supports | **iOS:** Uses platform accessibility APIs (UIAccessibility/SwiftUI traits); compatible with VoiceOver, Voice Control, Switch Control, Full Keyboard Access, Dynamic Type, Reduce Motion, Increase Contrast, Differentiate Without Color. **Web:** Standard ARIA/DOM exposed to AT. |
| 503 Applications | Supports | User preferences for platform accessibility (text size, contrast, motion, color scheme) are respected, not overridden. |
| 504 Authoring Tools | Not Applicable | The product is not an authoring tool that produces ICT content for others to publish (certificates are output artifacts, not third-party-authored content). |

## Chapter 6: Support Documentation and Services

| Criteria | Conformance Level | Remarks and Explanations |
| --- | --- | --- |
| 601.1 Scope | Supports | Support is provided accessibly (see below). |
| 602 Support Documentation | Supports | Documentation (web help, accessibility statement at `/accessibility`) is provided as accessible HTML. |
| 603 Support Services | Supports | Support via accessible web/email channels; accessibility feedback handled at accessibility@gradethread.com with a stated response SLA. |

---

# EN 301 549 Report (V3.2.1)

**Notes:** Only the chapters relevant to a web + mobile software product are completed; non-applicable hardware and two-way-communication chapters are marked accordingly.

## Chapter 4: Functional Performance — see Section 508 Chapter 3 (equivalent FPC). All: Supports / N.A. as above.

## Chapter 5: Generic Requirements

| Criteria | Conformance Level | Remarks and Explanations |
| --- | --- | --- |
| 5.1 Closed functionality | Not Applicable | The product is not closed functionality; it runs on general-purpose platforms with AT. |
| 5.2 Activation of accessibility features | Supports | Platform accessibility features (VoiceOver, Dynamic Type, etc.) are not disrupted. |
| 5.3 Biometrics | Not Applicable | No biometric-only identification is required (Face/Touch ID, where offered, is optional with passcode/password fallback). |
| 5.4 Preservation of accessibility information during conversion | Not Applicable | No format conversion of accessibility information. |
| 5.5 Operable parts | Supports | Operable parts are discernible and operable without vision; iOS meets minimum target size. |
| 5.6 Locking/toggle controls | Supports | Toggle states are exposed via accessible value/state. |
| 5.7 Key repeat / 5.8 Double-strike | Not Applicable | No proprietary keyboard; relies on platform input. |
| 5.9 Simultaneous user actions | Supports | No action requires simultaneous multi-point input. |

## Chapter 6: ICT with Two-Way Voice Communication

| Criteria | Conformance Level | Remarks and Explanations |
| --- | --- | --- |
| 6.x | Not Applicable | The product provides no two-way voice communication. |

## Chapter 7: ICT with Video Capabilities

| Criteria | Conformance Level | Remarks and Explanations |
| --- | --- | --- |
| 7.x | Not Applicable | The product provides no pre-recorded or broadcast video capabilities (camera viewfinder only; no captioned media). |

## Chapter 8: Hardware

| Criteria | Conformance Level | Remarks and Explanations |
| --- | --- | --- |
| 8.x | Not Applicable | No hardware component. |

## Chapter 9: Web (incorporates WCAG 2.1 A & AA)

| Criteria | Conformance Level | Remarks and Explanations |
| --- | --- | --- |
| 9.1–9.4 (WCAG 2.1 A/AA) | Supports | See WCAG 2.1 Tables 1 and 2 above for the web application. |
| 9.5 Non-interference | Supports | Content meets the non-interference criteria (no keyboard trap, no flashing, audio control N/A). |
| 9.6 WCAG conformance requirements | Supports | Conformance, full pages, complete processes, and accessibility-supported technologies are met. |

## Chapter 10: Non-web Documents

| Criteria | Conformance Level | Remarks and Explanations |
| --- | --- | --- |
| 10.x | Partially Supports | Generated condition-grade **certificate PDFs** are an output document type. They contain tagged text and meaningful image alternatives where structured; full PDF/UA tagging is on the remediation roadmap. The equivalent HTML certificate (SSR, public) is fully accessible and provides an accessible alternative. |

## Chapter 11: Software (incorporates WCAG 2.1 A & AA — applies to the iOS app)

| Criteria | Conformance Level | Remarks and Explanations |
| --- | --- | --- |
| 11.1–11.4 (WCAG 2.1 A/AA) | Supports | See WCAG 2.1 Tables 1 and 2 above for the iOS application. |
| 11.5 Interoperability with assistive technology | Supports | Uses iOS accessibility APIs; compatible with VoiceOver, Voice Control, Switch Control, Full Keyboard Access. |
| 11.6 Documented accessibility usage | Supports | Accessibility behavior follows iOS platform conventions; no undocumented gestures required. |
| 11.7 User preferences | Supports | Respects system text size, bold text, contrast, color scheme (Dark Interface), Differentiate Without Color, and Reduce Motion. |
| 11.8 Authoring tools | Not Applicable | Not an authoring tool. |

## Chapter 12: Documentation and Support Services

| Criteria | Conformance Level | Remarks and Explanations |
| --- | --- | --- |
| 12.1 Product documentation | Supports | Provided as accessible HTML. |
| 12.2 Support services | Supports | Accessible web/email support; documented accessibility feedback channel. |

## Chapter 13: ICT providing relay or emergency service access

| Criteria | Conformance Level | Remarks and Explanations |
| --- | --- | --- |
| 13.x | Not Applicable | The product does not provide relay or emergency services. |

---

## Legal Disclaimer

This document is provided for information purposes only and the contents are subject to change without notice. Pearson Media LLC makes no representations or warranties with respect to the accuracy or completeness of the contents and assumes no responsibility for errors or omissions. Conformance claims reflect good-faith evaluation as of the report date and are maintained alongside the product's ongoing accessibility program (see `/accessibility`, `docs/ACCESSIBILITY_CONTRAST.md`, and the automated test suites referenced above).

## Related

- [[seo-public-route-registry]] — the routes this conformance covers
- [[archive-semantics]] — why this is NOT archived despite its age
- [[INDEX]]
