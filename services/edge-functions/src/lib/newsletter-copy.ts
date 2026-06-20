// US-922: Autonomous newsletter copywriter ("content-ai-email").
//
// Given the chosen educational topic, subject style, and the unsent "what's new"
// context, it produces the issue's subject + preheader + educational sections.
// The PURE prompt builders / parser / evergreen fallback unit-test with no env;
// the single impure `generateNewsletterCopy` routes through getAnthropicClient
// (the ai-limiter is already applied there, so every call counts toward AI
// spend/budget — AC5) and ALWAYS resolves to usable copy: on any model/parse
// failure it degrades to the deterministic evergreen copy rather than skipping
// the issue or inventing content (AC3).

import type { NewsletterSection } from "./newsletter-issue.ts";
import type { NewsletterTopic, SubjectStyle } from "./newsletter-tuning.ts";

export interface NewsletterCopyInput {
  topic: NewsletterTopic;
  style: SubjectStyle;
  /** Compact "what's new" lines (may be empty → lean evergreen). */
  changelogLines: string[];
  /** Audience/product the issue leans toward, for tone. */
  productFocus: "gradethread" | "flipdesk" | "both";
  /** Max educational sections to request. */
  maxSections: number;
  /** Optional brand-voice knowledge doc (empty string when unavailable). */
  brandVoice?: string;
  /** US-917: approved value-props/capabilities the copy may cite (email.value_props). */
  valueProps?: string;
  /** US-917: one-line lesson summary for the chosen evergreen topic. */
  topicSummary?: string;
  /** US-917: real-capability hints for the topic — grounds claims, prevents invention. */
  topicKeyPoints?: string[];
}

export interface NewsletterCopy {
  subject: string;
  preheader: string;
  sections: NewsletterSection[];
  /** True when the AI pass failed and the evergreen fallback was used. */
  degraded: boolean;
}

const SUBJECT_MAX = 120;
const PREHEADER_MAX = 150;

const PRODUCT_AUDIENCE: Record<string, string> = {
  gradethread: "sellers grading pre-owned clothing condition",
  flipdesk: "resellers running the full eBay listing lifecycle",
  both: "pre-owned clothing sellers and resellers",
};

// ── Pure prompt builders ─────────────────────────────────────────────────────

export function buildCopySystemPrompt(input: {
  brandVoice?: string;
  valueProps?: string;
  productFocus: NewsletterCopyInput["productFocus"];
}): string {
  const audience = PRODUCT_AUDIENCE[input.productFocus] ?? PRODUCT_AUDIENCE.both;
  const voice = input.brandVoice?.trim()
    ? `\n\nBrand voice:\n${input.brandVoice.trim()}`
    : "";
  const claims = input.valueProps?.trim()
    ? `\n\nApproved capabilities you may cite (do NOT claim anything beyond these or ` +
      `the inputs):\n${input.valueProps.trim()}`
    : "";
  return (
    `You are the email copywriter for GradeThread, an AI-powered clothing ` +
    `condition grading platform (gradethread.com). You write a weekly educational ` +
    `newsletter for ${audience}. Be concise, concrete, and genuinely useful — no ` +
    `hype, no fabricated statistics, no fake urgency. Never invent product ` +
    `features, prices, or facts you weren't given. Every educational claim must ` +
    `reference a REAL GradeThread capability from the approved list or the inputs — ` +
    `when in doubt, teach the general principle instead of asserting a feature.` +
    `${voice}${claims}\n\n` +
    `Respond with ONLY a JSON object (no markdown fences) of the form:\n` +
    `{"subject": string, "preheader": string, "sections": ` +
    `[{"heading": string, "body_html": string, "cta_label"?: string, "cta_url"?: string}]}\n` +
    `body_html is a short run of <p>/<ul>/<li>/<strong>/<em> only. Only include a ` +
    `cta_url you are certain is a real gradethread.com URL; otherwise omit both cta fields.`
  );
}

export function buildCopyUserPrompt(input: NewsletterCopyInput): string {
  const sections = Math.max(1, Math.min(10, Math.floor(input.maxSections)));
  const whatsNew = input.changelogLines.length
    ? `Recent product updates you may reference (do NOT fabricate beyond these):\n` +
      input.changelogLines.join("\n") + "\n\n"
    : `There are no fresh product updates this week — lean fully on evergreen ` +
      `educational value.\n\n`;
  const summary = input.topicSummary?.trim()
    ? `Lesson summary: ${input.topicSummary.trim()}\n`
    : "";
  const points = (input.topicKeyPoints ?? []).map((p) => p.trim()).filter(Boolean);
  const grounding = points.length
    ? `Grounding facts (only cite real capabilities — these or the approved list):\n` +
      points.map((p) => `- ${p}`).join("\n") + "\n\n"
    : "";
  return (
    `Write this week's issue.\n\n` +
    `Educational focus: ${input.topic.label} (pillar: ${input.topic.pillar}, ` +
    `angle: ${input.topic.angle}).\n` +
    summary +
    `Subject-line style: ${input.style.label} — ${input.style.guidance}\n\n` +
    grounding +
    whatsNew +
    `Produce up to ${sections} focused educational section(s) teaching something ` +
    `actionable about the focus topic. Keep the subject under ${SUBJECT_MAX} ` +
    `characters and the preheader under ${PREHEADER_MAX}.`
  );
}

// ── Pure parsing ─────────────────────────────────────────────────────────────

function stripCodeFence(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
}

function isLikelyUrl(v: unknown): v is string {
  return typeof v === "string" && /^https?:\/\//i.test(v.trim());
}

/**
 * Validate + normalize the model's JSON into clean NewsletterSections. Throws on
 * unusable output (no subject / no section with a body) so the caller falls back
 * to evergreen. Caps sections at `maxSections`. Pure.
 */
export function parseNewsletterCopy(raw: string, maxSections: number): Omit<NewsletterCopy, "degraded"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new Error("copy JSON parse failed");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("copy not an object");
  const p = parsed as Record<string, unknown>;

  const subject = String(p.subject ?? "").trim().slice(0, SUBJECT_MAX);
  if (!subject) throw new Error("copy missing subject");
  const preheader = String(p.preheader ?? "").trim().slice(0, PREHEADER_MAX);

  const rawSections = Array.isArray(p.sections) ? p.sections : [];
  const sections: NewsletterSection[] = [];
  for (const s of rawSections) {
    if (!s || typeof s !== "object") continue;
    const sec = s as Record<string, unknown>;
    const body = String(sec.body_html ?? sec.body ?? "").trim();
    if (!body) continue;
    const section: NewsletterSection = { body };
    const heading = String(sec.heading ?? "").trim();
    if (heading) section.heading = heading;
    const ctaLabel = String(sec.cta_label ?? "").trim();
    if (ctaLabel && isLikelyUrl(sec.cta_url)) {
      section.ctaLabel = ctaLabel;
      section.ctaUrl = (sec.cta_url as string).trim();
    }
    sections.push(section);
    if (sections.length >= maxSections) break;
  }
  if (sections.length === 0) throw new Error("copy produced no usable sections");

  return { subject, preheader, sections };
}

// ── Pure evergreen fallback ──────────────────────────────────────────────────

/**
 * Deterministic, always-valid educational copy from the topic alone. Used when
 * the AI pass fails OR is disabled — the issue still ships meaningful evergreen
 * content rather than being skipped or fabricated (AC3). Pure.
 */
export function evergreenCopy(topic: NewsletterTopic, style: SubjectStyle): Omit<NewsletterCopy, "degraded"> {
  const subject = topic.label.slice(0, SUBJECT_MAX);
  const preheader = `A quick, practical read on ${topic.label.toLowerCase()}.`.slice(0, PREHEADER_MAX);
  const sections: NewsletterSection[] = [
    {
      heading: topic.label,
      body:
        `<p>This week we're focusing on <strong>${escapeText(topic.label)}</strong>. ` +
        `Getting this right is one of the highest-leverage habits for anyone ` +
        `working with pre-owned clothing — it protects your margins and builds ` +
        `buyer trust.</p>` +
        `<p>Take five minutes this week to review your current approach to ` +
        `${escapeText(topic.angle.replace(/-/g, " "))} and tighten one part of it.</p>`,
      ctaLabel: "Open GradeThread",
      ctaUrl: "https://gradethread.com/dashboard",
    },
  ];
  // style is referenced so callers can keep the chosen dimension meaningful even
  // on the fallback path (the subject_style is still stamped on the issue).
  void style;
  return { subject, preheader, sections };
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Impure AI call ───────────────────────────────────────────────────────────

/**
 * Generate the issue copy via the configured Claude model. NEVER throws — on any
 * failure it returns the evergreen fallback with `degraded: true`. Dynamic-imports
 * ai-config (which chains into lib/supabase.ts → throws on unset SUPABASE_URL) so
 * the pure builders/parser above unit-test without the env dance.
 */
export async function generateNewsletterCopy(input: NewsletterCopyInput): Promise<NewsletterCopy> {
  try {
    const { getAiTemperature, getAnthropicClient, getDefaultModel } = await import("./ai-config.ts");
    const { enterAiFeature } = await import("./ai-feature-context.ts");
    enterAiFeature("content"); // US-894 spend attribution (counts toward AI budget)

    const system = buildCopySystemPrompt({
      brandVoice: input.brandVoice,
      valueProps: input.valueProps,
      productFocus: input.productFocus,
    });
    const user = buildCopyUserPrompt(input);
    const temperature = getAiTemperature();

    const response = await getAnthropicClient().messages.create({
      model: getDefaultModel(),
      max_tokens: 2048,
      ...(temperature !== undefined ? { temperature } : {}),
      system,
      messages: [{ role: "user", content: user }],
    });
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") throw new Error("no text block");
    const copy = parseNewsletterCopy(textBlock.text, input.maxSections);
    return { ...copy, degraded: false };
  } catch (e) {
    console.error(`[newsletter-copy] generation failed, using evergreen: ${
      e instanceof Error ? e.message : String(e)
    }`);
    return { ...evergreenCopy(input.topic, input.style), degraded: true };
  }
}
