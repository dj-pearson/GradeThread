// US-924: AI "editor" pass for the newsletter pre-send gate.
//
// A cheap-model pass that reads the issue's own content and checks two things the
// structural QA can't: (1) brand voice (is this on-tone for GradeThread?), and
// (2) factual grounding — does the copy assert concrete claims (stats, features,
// guarantees) that aren't supported by the issue's own inputs? An unsupported
// concrete claim is a HARD flag and blocks the send; an off-tone-but-honest issue
// is a SOFT flag (recorded, not blocking).
//
// The prompt builders + response parser are PURE (exported for the seed-corpus
// regression test); only runAiEditorPass() touches the model. It runs on the
// lightweight model through the shared limiter and is fail-safe: a model/parse
// error returns { ran: false }, which the gate treats as "inconclusive" and
// routes to human review rather than auto-approving an unverified issue.

import type { NewsletterSection, RenderableIssue } from "./newsletter-issue.ts";

// NOTE: ai-config.ts / ai-feature-context.ts are imported DYNAMICALLY inside
// runAiEditorPass (they chain into lib/supabase.ts, which throws at import when
// SUPABASE_URL is unset). Keeping them out of the module's static graph lets the
// pure prompt builders + parser be unit-tested without the env/DB dance.

export type AiEditorFlagType = "hallucination" | "factual" | "brand_voice";

export interface AiEditorFlag {
  type: AiEditorFlagType;
  severity: "hard" | "soft";
  detail: string;
}

export interface AiEditorResult {
  /** The model produced a usable verdict. False on model/parse error. */
  ran: boolean;
  /** A hard flag (hallucinated/unsupported concrete claim) is present. */
  hardFlag: boolean;
  brandVoiceOk: boolean;
  flags: AiEditorFlag[];
  summary: string;
  /** Populated when ran === false. */
  error?: string;
  meta?: { model: string; latencyMs: number };
}

export const NEWSLETTER_EDITOR_PROMPT_VERSION = "newsletter.editor.v1";

export function buildEditorSystemPrompt(): string {
  return [
    "You are GradeThread's editorial QA reviewer for outbound marketing email.",
    "GradeThread is an AI-powered condition-grading SaaS for pre-owned clothing;",
    "FlipDesk is its eBay reseller-management surface. Brand voice: clear,",
    "trustworthy, practical, benefit-led — never hypey, never making promises a",
    "grading tool can't keep.",
    "",
    "You are given ONLY the draft issue's own content (subject, preheader,",
    "sections). Judge it on two axes:",
    "  1. brand_voice — is the tone on-brand (not spammy/hypey/off-topic)?",
    "  2. factual grounding — does it assert CONCRETE claims (specific numbers,",
    "     statistics, named features, integrations, guarantees, awards, prices)",
    "     that are NOT supported by the issue's own content and are likely",
    "     fabricated? Treat an invented feature / made-up stat / false guarantee",
    "     as a HALLUCINATION.",
    "",
    "Severity: a hallucinated or unsupported concrete claim is severity \"hard\".",
    "A merely off-tone but honest issue is severity \"soft\". Vague aspirational",
    "language is NOT a hallucination.",
    "",
    "Respond with ONLY a JSON object, no markdown:",
    '{"brandVoiceOk": boolean, "flags": [{"type": "hallucination"|"factual"|"brand_voice", "severity": "hard"|"soft", "detail": string}], "summary": string}',
  ].join("\n");
}

function sectionToText(s: NewsletterSection): string {
  const parts: string[] = [];
  if (s.heading) parts.push(`## ${s.heading}`);
  if (s.body) parts.push(s.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  if (s.ctaLabel) parts.push(`[CTA: ${s.ctaLabel}]`);
  return parts.join("\n");
}

export function buildEditorUserPrompt(issue: RenderableIssue): string {
  const sections = (issue.sections ?? []).map(sectionToText).join("\n\n");
  return [
    `Subject: ${issue.subject ?? ""}`,
    `Preheader: ${issue.preheader ?? ""}`,
    "",
    "Sections:",
    sections || "(none)",
  ].join("\n");
}

function stripCodeFence(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
}

/**
 * Parse the editor model's JSON response into a normalized result. Defensive:
 * coerces missing/odd shapes and derives `hardFlag` from any hard-severity flag.
 * Throws only on unparseable JSON (the runner converts that to ran:false).
 */
export function parseEditorResult(text: string): AiEditorResult {
  const parsed = JSON.parse(stripCodeFence(text)) as Record<string, unknown>;
  const rawFlags = Array.isArray(parsed.flags) ? parsed.flags : [];
  const flags: AiEditorFlag[] = [];
  for (const f of rawFlags) {
    if (!f || typeof f !== "object") continue;
    const obj = f as Record<string, unknown>;
    const type = obj.type;
    const severity = obj.severity === "hard" ? "hard" : "soft";
    const detail = typeof obj.detail === "string" ? obj.detail : "";
    if (type === "hallucination" || type === "factual" || type === "brand_voice") {
      flags.push({ type, severity, detail });
    }
  }
  const hardFlag = flags.some((f) => f.severity === "hard");
  return {
    ran: true,
    hardFlag,
    brandVoiceOk: parsed.brandVoiceOk !== false && !flags.some((f) => f.type === "brand_voice" && f.severity === "hard"),
    flags,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
  };
}

export interface AiEditorOptions {
  userId?: string | null;
  model?: string;
}

/**
 * Run the AI editor pass on an issue. Fail-safe: any model/parse error returns
 * `{ ran: false }` so the gate routes the issue to human review rather than
 * silently auto-approving an unverified one.
 */
export async function runAiEditorPass(
  issue: RenderableIssue,
  opts: AiEditorOptions = {},
): Promise<AiEditorResult> {
  const { getAiTemperature, getAnthropicClient, getLightweightModel } = await import("./ai-config.ts");
  const { enterAiFeature } = await import("./ai-feature-context.ts");
  enterAiFeature("newsletter_editor", opts.userId ?? null); // spend attribution

  const model = opts.model ?? getLightweightModel();
  const temperature = getAiTemperature();
  const startedAt = Date.now();
  try {
    const client = getAnthropicClient();
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      ...(temperature !== undefined ? { temperature } : {}),
      system: buildEditorSystemPrompt(),
      messages: [{ role: "user", content: buildEditorUserPrompt(issue) }],
    });
    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") {
      return failSafe(model, startedAt, "no text block in editor response");
    }
    const result = parseEditorResult(block.text);
    result.meta = { model, latencyMs: Date.now() - startedAt };
    return result;
  } catch (err) {
    return failSafe(model, startedAt, err instanceof Error ? err.message : String(err));
  }
}

function failSafe(model: string, startedAt: number, error: string): AiEditorResult {
  console.warn(`[newsletter-ai-editor] inconclusive: ${error}`);
  return {
    ran: false,
    hardFlag: false,
    brandVoiceOk: true,
    flags: [],
    summary: "",
    error,
    meta: { model, latencyMs: Date.now() - startedAt },
  };
}
