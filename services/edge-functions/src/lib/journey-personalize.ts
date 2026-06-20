// US-929: optional AI personalization for a lifecycle-journey step.
//
// A step with ai_personalize=true gets one friendly, on-brand opening sentence
// generated for the recipient (injected via the {{aiIntro}} token). This is
// strictly BEST-EFFORT: it is gated by the content_ai kill-switch, bounded by
// the configured AI timeout, and returns null on ANY failure so the step always
// falls back to its static template. Token usage is recorded (US-894) for the
// AI-spend view.
//
// Kept OUT of the pure planner (lib/email-journey.ts) because it touches the
// Anthropic client + supabase — the pure module stays env/network-free.

import { getAnthropicClient, getAiTimeoutMs, getLightweightModel } from "./ai-config.ts";
import { recordAiUsage } from "./ai-usage.ts";

export interface PersonalizeInput {
  journeyKey: string;
  stepOrder: number;
  firstName: string | null;
  /** A short brief describing the step's intent (e.g. its subject line). */
  context: string;
  userId: string | null;
}

/** Minimal HTML-escape — the model output is interpolated into an email. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;");
}

/**
 * Generate one personalized opening sentence wrapped in a <p>, or null if AI is
 * unavailable / errors / times out. Never throws.
 */
export async function personalizeJourneyIntro(
  input: PersonalizeInput,
): Promise<string | null> {
  const name = (input.firstName ?? "").trim();
  const prompt =
    `Write ONE warm, concise opening sentence (max 22 words) for a GradeThread ` +
    `lifecycle email. GradeThread is an AI clothing-condition grading + reselling ` +
    `tool. Address the reader as "${name || "there"}". Email intent: ${input.context}. ` +
    `Return ONLY the sentence — no greeting prefix, no quotes, no markdown.`;

  try {
    const client = getAnthropicClient();
    const model = getLightweightModel();
    const timeoutMs = getAiTimeoutMs();

    const response = await Promise.race([
      client.messages.create({
        model,
        max_tokens: 120,
        messages: [{ role: "user", content: prompt }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("ai-personalize timeout")), timeoutMs)
      ),
    ]);

    const block = response.content.find((b) => b.type === "text");
    const text = block && block.type === "text" ? block.text.trim() : "";
    if (!text) return null;

    // Record spend (best-effort).
    void recordAiUsage({
      userId: input.userId,
      submissionId: null,
      feature: "lifecycle_journey",
      usages: [{
        phase: `journey:${input.journeyKey}:${input.stepOrder}`,
        usage: {
          model,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      }],
    });

    // Single sentence, trimmed of any stray surrounding quotes.
    const sentence = text.replace(/^["'\s]+|["'\s]+$/g, "").split("\n")[0]!.slice(0, 280);
    if (!sentence) return null;
    return `<p style="margin:0 0 16px;color:#666;font-size:15px;line-height:1.5;">${escapeHtml(sentence)}</p>`;
  } catch (e) {
    console.warn(
      "[journey-personalize] fell back to template:",
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}
