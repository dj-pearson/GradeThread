// US-924: Autonomous pre-send QA / guardrail gate — PURE logic.
//
// Before any newsletter issue can send, it must clear an automated quality +
// safety gate so a fully autonomous pipeline never ships a broken, off-brand, or
// non-compliant email. This module is the deterministic, dependency-free core
// (no supabase / env / network) so the gate is unit-testable against a seed
// corpus of known-bad issues and reusable from both the admin console route and
// the autonomous engine.
//
// Two halves:
//   • runGuardrailQa()  — structural/compliance checks over the issue + its
//                         rendered context (links, images+alt, unsubscribe +
//                         preference-center + postal, plaintext, subject/preheader
//                         length, spam score, leftover placeholders).
//   • decideGateOutcome() — folds the structural result + the AI-editor verdict +
//                         the require-approval toggle into the next status.
//
// The AI "editor" pass (brand-voice + factual grounding) lives in
// newsletter-ai-editor.ts (it touches the model); its verdict is fed into
// decideGateOutcome() here so the policy stays pure + testable.

import type { NewsletterSection, RenderableIssue } from "./newsletter-issue.ts";

// ── Thresholds (operator-tunable via the settings registry; seeded 00284) ─────

export interface QaThresholds {
  /** Cumulative spam score above which the issue is blocked. */
  spamScoreMax: number;
  /** Subject longer than this (chars) is blocked. */
  subjectMaxLength: number;
  /** Preheader longer than this (chars) is blocked. */
  preheaderMaxLength: number;
  /** Require a preference-center link in addition to unsubscribe. */
  requirePreferenceCenter: boolean;
}

export const DEFAULT_QA_THRESHOLDS: QaThresholds = {
  spamScoreMax: 5,
  subjectMaxLength: 120,
  preheaderMaxLength: 150,
  requirePreferenceCenter: true,
};

// ── Report shape (kept backward-compatible with the console's QaCheck) ────────

export type QaSeverity = "hard" | "soft";

export interface GuardrailCheck {
  id: string;
  label: string;
  passed: boolean;
  /** hard → a failure blocks send; soft → recorded as a warning only. */
  severity: QaSeverity;
  detail?: string;
}

export interface GuardrailReport {
  /** True when no HARD check failed. */
  passed: boolean;
  checks: GuardrailCheck[];
  spamScore: number;
  /** Human-readable reasons for the hard failures (for block_reason / alerts). */
  failureReasons: string[];
  ranAt?: string;
}

/**
 * What the gate needs to know about the issue's RENDERED form. The route/engine
 * renders the issue with its real footer (unsubscribe + preference-center +
 * postal) and a plaintext alternative, then hands the booleans + html here so
 * the scanning logic stays pure.
 */
export interface QaContext {
  /** The fully-rendered HTML body (used to scan links + images). */
  html: string;
  /** A non-empty plaintext alternative was produced. */
  plaintext: string;
  hasUnsubscribe: boolean;
  hasPreferenceCenter: boolean;
  hasPostalAddress: boolean;
  /**
   * Live link-resolution results, when the impure caller ran them. Map of url →
   * "ok" | "broken" | "inconclusive". Omitted entries are treated as unchecked.
   * Only a CONFIRMED "broken" (4xx/5xx) blocks; network errors are inconclusive.
   */
  linkStatuses?: Record<string, "ok" | "broken" | "inconclusive">;
}

// ── HTML scanning helpers (pure) ──────────────────────────────────────────────

/** Every href in the HTML plus the issue's CTA urls, deduped, in order. */
export function extractLinks(html: string, ctaUrls: string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (u: string) => {
    const t = u.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  const re = /href\s*=\s*["']([^"']*)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) push(m[1] ?? "");
  for (const u of ctaUrls) push(u);
  return out;
}

export interface ExtractedImage {
  src: string;
  alt: string | null;
}

/** Every <img> in the HTML with its src + alt (alt null when the attr is absent). */
export function extractImages(html: string): ExtractedImage[] {
  const out: ExtractedImage[] = [];
  const re = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const src = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
    const altMatch = /\balt\s*=\s*["']([^"']*)["']/i.exec(tag);
    out.push({ src, alt: altMatch ? altMatch[1] ?? "" : null });
  }
  return out;
}

/** A link is acceptable if it's an absolute http(s)/mailto url (never relative). */
export function isAbsoluteLink(url: string): boolean {
  const u = url.trim();
  if (!u) return false;
  if (u.startsWith("mailto:")) return /^mailto:[^@\s]+@[^@\s]+\.[^@\s]+/i.test(u);
  if (!/^https?:\/\//i.test(u)) return false;
  // Reject obvious placeholders sneaking into an absolute-looking url.
  if (/example\.(com|org)\b/i.test(u)) return false;
  try {
    const parsed = new URL(u);
    return Boolean(parsed.hostname) && parsed.hostname.includes(".");
  } catch {
    return false;
  }
}

// Leftover unrendered template / merge-field placeholders. Catches handlebars
// ({{x}}), liquid/jinja ({% x %} / {{ x }}), ${x}, [BRACKET] tokens, and the
// classic "lorem ipsum" / TODO copy markers.
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /\{\{[^}]*\}\}/g, // {{merge_field}}
  /\{%[^%]*%\}/g, // {% block %}
  /\$\{[^}]*\}/g, // ${interpolation}
  /\[[A-Z][A-Z0-9 _-]{2,}\]/g, // [PLACEHOLDER]
  /\blorem ipsum\b/gi,
  /\bTODO\b|\bFIXME\b|\bTBD\b/g,
  /\bXXXX+\b/g,
];

export function findPlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const re of PLACEHOLDER_PATTERNS) {
    const matches = text.match(re);
    if (matches) for (const x of matches) found.add(x.trim());
  }
  return [...found];
}

// ── Spam scoring (pure) ───────────────────────────────────────────────────────

// Phrases that disproportionately trip spam filters. Weighted by how strongly
// they signal junk. Matched case-insensitively as whole words/phrases.
const SPAM_PHRASES: Array<{ re: RegExp; weight: number }> = [
  { re: /\bfree\b/gi, weight: 1 },
  { re: /\bact now\b/gi, weight: 2 },
  { re: /\bbuy now\b/gi, weight: 1 },
  { re: /\bclick here\b/gi, weight: 1 },
  { re: /\blimited time\b/gi, weight: 1 },
  { re: /\border now\b/gi, weight: 1 },
  { re: /\b100% free\b/gi, weight: 3 },
  { re: /\brisk[- ]free\b/gi, weight: 2 },
  { re: /\bguarantee(d|e)?\b/gi, weight: 1 },
  { re: /\bcash\b/gi, weight: 1 },
  { re: /\bwinner\b/gi, weight: 2 },
  { re: /\bcongratulations\b/gi, weight: 1 },
  { re: /\bno obligation\b/gi, weight: 2 },
  { re: /\bthis is not spam\b/gi, weight: 4 },
  { re: /\bviagra\b/gi, weight: 5 },
  { re: /\b\$\$\$/g, weight: 3 },
  { re: /\bearn money\b/gi, weight: 2 },
  { re: /\bdouble your\b/gi, weight: 2 },
];

/** All-caps words of length ≥ 3 (excluding common acronyms that are fine). */
const CAPS_ALLOWLIST = new Set(["NWT", "NWOT", "USA", "AI", "PSA", "BGS", "GT"]);

export interface SpamScore {
  score: number;
  reasons: string[];
}

/**
 * Compute an additive spam score over the subject (weighted ×2 — the subject is
 * the loudest deliverability signal), preheader, and body text. Penalizes spammy
 * phrases, excessive ALL-CAPS, and runaway punctuation.
 */
export function computeSpamScore(parts: {
  subject: string;
  preheader: string;
  body: string;
}): SpamScore {
  const reasons: string[] = [];
  let score = 0;

  const scanPhrases = (text: string, multiplier: number, where: string) => {
    for (const { re, weight } of SPAM_PHRASES) {
      const matches = text.match(re);
      if (matches && matches.length > 0) {
        const pts = weight * matches.length * multiplier;
        score += pts;
        reasons.push(`${where}: spammy phrase "${matches[0]}" (+${pts})`);
      }
    }
  };

  scanPhrases(parts.subject, 2, "subject");
  scanPhrases(parts.preheader, 1, "preheader");
  scanPhrases(parts.body, 1, "body");

  // ALL-CAPS words.
  const capsWords = (text: string): string[] =>
    (text.match(/\b[A-Z]{3,}\b/g) ?? []).filter((w) => !CAPS_ALLOWLIST.has(w));
  const subjCaps = capsWords(parts.subject);
  if (subjCaps.length > 0) {
    const pts = subjCaps.length * 2;
    score += pts;
    reasons.push(`subject: ${subjCaps.length} ALL-CAPS word(s) (+${pts})`);
  }
  const bodyCaps = capsWords(parts.body);
  if (bodyCaps.length > 2) {
    const pts = bodyCaps.length - 2;
    score += pts;
    reasons.push(`body: ${bodyCaps.length} ALL-CAPS word(s) (+${pts})`);
  }

  // Excessive punctuation (!!, ???, !?!).
  const punct = (text: string): number =>
    (text.match(/[!?]{2,}/g) ?? []).reduce((n, run) => n + run.length, 0);
  const subjPunct = punct(parts.subject);
  if (subjPunct > 0) {
    const pts = subjPunct * 2;
    score += pts;
    reasons.push(`subject: excessive punctuation (+${pts})`);
  }
  const bodyPunct = punct(parts.body);
  if (bodyPunct > 0) {
    score += bodyPunct;
    reasons.push(`body: excessive punctuation (+${bodyPunct})`);
  }

  return { score, reasons };
}

// ── The guardrail gate (pure) ─────────────────────────────────────────────────

/** Strip tags + collapse whitespace from a section's HTML body to plain text. */
function sectionText(s: NewsletterSection): string {
  return (s.body ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Run the full pre-send guardrail QA. Every listed check is HARD (a failure
 * blocks the send) except where noted; the report's `passed` is true only when
 * no hard check failed.
 */
export function runGuardrailQa(
  issue: RenderableIssue,
  ctx: QaContext,
  thresholds: QaThresholds = DEFAULT_QA_THRESHOLDS,
): GuardrailReport {
  const sections = Array.isArray(issue.sections) ? issue.sections : [];
  const subject = (issue.subject ?? "").trim();
  const preheader = (issue.preheader ?? "").trim();
  const bodyText = sections.map(sectionText).join("\n");
  const checks: GuardrailCheck[] = [];

  const add = (
    id: string,
    label: string,
    passed: boolean,
    detail?: string,
    severity: QaSeverity = "hard",
  ) => checks.push({ id, label, passed, severity, detail });

  // 1. Subject + preheader.
  add("subject_present", "Subject line is present", subject.length > 0);
  add(
    "subject_length",
    `Subject within ${thresholds.subjectMaxLength} chars`,
    subject.length <= thresholds.subjectMaxLength,
    subject.length > thresholds.subjectMaxLength
      ? `Subject is ${subject.length} chars`
      : undefined,
  );
  add(
    "preheader_length",
    `Preheader within ${thresholds.preheaderMaxLength} chars`,
    preheader.length <= thresholds.preheaderMaxLength,
    preheader.length > thresholds.preheaderMaxLength
      ? `Preheader is ${preheader.length} chars`
      : undefined,
  );

  // 2. Content present.
  add("has_content", "Issue has at least one content section", sections.length > 0);
  add(
    "section_bodies",
    "Every section has body content",
    sections.every((s) => typeof s.body === "string" && s.body.trim().length > 0),
  );

  // 3. Links resolve (no relative / malformed; no confirmed 4xx/5xx).
  const ctaUrls = sections.map((s) => s.ctaUrl ?? "").filter(Boolean);
  const links = extractLinks(ctx.html, ctaUrls);
  const relativeLinks = links.filter((u) => !isAbsoluteLink(u));
  add(
    "links_absolute",
    "All links are absolute (no relative/placeholder URLs)",
    relativeLinks.length === 0,
    relativeLinks.length > 0
      ? `Bad: ${relativeLinks.slice(0, 5).join(", ")}`
      : undefined,
  );
  if (ctx.linkStatuses) {
    const broken = links.filter((u) => ctx.linkStatuses?.[u] === "broken");
    add(
      "links_resolve",
      "No links return 404/error",
      broken.length === 0,
      broken.length > 0 ? `Broken: ${broken.slice(0, 5).join(", ")}` : undefined,
    );
  }

  // 4. Images load + have alt text.
  const images = extractImages(ctx.html);
  const badImgSrc = images.filter((i) => !isAbsoluteLink(i.src));
  const missingAlt = images.filter((i) => i.alt === null || i.alt.trim() === "");
  add(
    "images_absolute",
    "All images use an absolute URL",
    badImgSrc.length === 0,
    badImgSrc.length > 0 ? `${badImgSrc.length} image(s) with bad src` : undefined,
  );
  add(
    "images_alt",
    "All images have alt text",
    missingAlt.length === 0,
    missingAlt.length > 0 ? `${missingAlt.length} image(s) missing alt text` : undefined,
  );

  // 5. CAN-SPAM compliance footer.
  add("unsubscribe", "Unsubscribe link present", ctx.hasUnsubscribe);
  add("postal_address", "Physical postal address present", ctx.hasPostalAddress);
  if (thresholds.requirePreferenceCenter) {
    add("preference_center", "Preference-center link present", ctx.hasPreferenceCenter);
  }

  // 6. Plaintext alternative.
  add(
    "plaintext",
    "Plaintext alternative exists",
    typeof ctx.plaintext === "string" && ctx.plaintext.trim().length > 0,
  );

  // 7. Spam score.
  const spam = computeSpamScore({ subject, preheader, body: bodyText });
  add(
    "spam_score",
    `Spam score ≤ ${thresholds.spamScoreMax}`,
    spam.score <= thresholds.spamScoreMax,
    spam.score > thresholds.spamScoreMax
      ? `Score ${spam.score}: ${spam.reasons.slice(0, 3).join("; ")}`
      : `Score ${spam.score}`,
  );

  // 8. No leftover template/merge-field placeholders.
  const placeholderScan = findPlaceholders(
    [subject, preheader, ...sections.flatMap((s) => [s.heading ?? "", s.body ?? "", s.ctaLabel ?? ""])].join(
      "\n",
    ),
  );
  add(
    "no_placeholders",
    "No leftover template/merge-field placeholders",
    placeholderScan.length === 0,
    placeholderScan.length > 0 ? `Found: ${placeholderScan.slice(0, 5).join(", ")}` : undefined,
  );

  const hardFailures = checks.filter((c) => c.severity === "hard" && !c.passed);
  return {
    passed: hardFailures.length === 0,
    checks,
    spamScore: spam.score,
    failureReasons: hardFailures.map((c) => c.detail ? `${c.label} — ${c.detail}` : c.label),
  };
}

// ── Gate outcome decision (pure) ──────────────────────────────────────────────

export type GateOutcome = "approved" | "awaiting_review" | "blocked";

export interface GateDecisionInput {
  /** The structural guardrail result. */
  qaPassed: boolean;
  /** AI editor raised a HARD flag (hallucination / hard brand violation). */
  aiHardFlag: boolean;
  /**
   * The AI editor was enabled but could not produce a verdict (model error).
   * Fail-safe: never auto-approve an unverified issue — route to human review.
   */
  aiInconclusive: boolean;
  /** The newsletter_require_approval master toggle. */
  requireApproval: boolean;
}

export interface GateDecision {
  outcome: GateOutcome;
  reasons: string[];
}

/**
 * Fold the structural QA result + AI-editor verdict + the require-approval toggle
 * into the issue's next status:
 *   • any hard failure (QA or AI)         → blocked
 *   • AI inconclusive OR require-approval  → awaiting_review (human gate)
 *   • otherwise                            → approved (autonomous auto-send)
 */
export function decideGateOutcome(input: GateDecisionInput): GateDecision {
  const reasons: string[] = [];
  if (!input.qaPassed) reasons.push("Automated QA checks failed");
  if (input.aiHardFlag) reasons.push("AI editor flagged a hard issue (brand/factual)");

  if (reasons.length > 0) {
    return { outcome: "blocked", reasons };
  }
  if (input.aiInconclusive) {
    return {
      outcome: "awaiting_review",
      reasons: ["AI editor could not verify the issue — routed to human review"],
    };
  }
  if (input.requireApproval) {
    return {
      outcome: "awaiting_review",
      reasons: ["Human approval is required before send"],
    };
  }
  return { outcome: "approved", reasons: ["Passed all automated gates"] };
}
