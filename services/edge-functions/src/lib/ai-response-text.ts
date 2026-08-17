// Pull the text block out of a Messages API response, and say WHY when there
// isn't one.
//
// WHAT THIS REPLACES AND WHY IT MATTERS. Six generators each inlined:
//
//     const textBlock = response.content.find((b) => b.type === "text");
//     if (!textBlock || textBlock.type !== "text") {
//       throw new Error("AI response contained no text block");
//     }
//
// The find() is correct — it does not assume content[0], so a leading thinking
// block never broke it. The throw is the problem: it reports the SYMPTOM and
// discards the field that names the cause. `content_scheduler_runs` recorded
// five hourly failures reading "social generation failed: AI response contained
// no text block", which is true and tells an operator nothing. `stop_reason` was
// sitting on the same object the whole time.
//
// THE CAUSE IT WAS HIDING, traced from this repo's own history:
//
//   2026-06-13 f8504d7a  content-ai-social sets max_tokens: 3072, sized for SIX
//                        platform variants on the then-default claude-sonnet-4-6.
//   2026-07-02 5e034f66  DEFAULTS.model flips sonnet-4-6 -> sonnet-5.
//   2026-07-17 4bc9ab30  a SEVENTH platform (tiktok) joins SOCIAL_PLATFORMS.
//
// The middle commit is the one that bites. On Sonnet 4.6 a request that omits
// `thinking` runs with no thinking at all; on Sonnet 5 the same request runs
// ADAPTIVE THINKING, and max_tokens is a hard cap on thinking PLUS response
// text. Sonnet 5 also tokenizes ~30% denser. So a budget tuned for "text only,
// six variants, old tokenizer" now has to cover "thinking + text, seven
// variants, denser tokenizer". It stopped fitting.
//
// That is why the two observed messages come in the ratio they do. When
// thinking consumes the whole budget the response carries a thinking block and
// no text block at all -> "contained no text block". When text starts and is
// cut off mid-object -> "AI returned invalid JSON". Same single cause, two
// faces, and neither string said "truncated".
//
// So this helper leads with stop_reason. A future budget overrun names itself
// on the first failed run instead of after an archaeology session.
import type Anthropic from "@anthropic-ai/sdk";

type MessageLike = {
  content: Array<{ type: string; text?: string }>;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
};

/**
 * Returns the first text block's text, or throws an error that names the cause.
 *
 * `label` is the generator's name and rides in the message, because these
 * errors are read in `content_scheduler_runs` rows where nothing else says
 * which surface produced them.
 */
export function extractTextBlock(
  response: Anthropic.Message | MessageLike,
  label: string,
): string {
  const msg = response as MessageLike;
  const block = msg.content.find((b) => b.type === "text");
  if (block && typeof block.text === "string" && block.text.length > 0) {
    return block.text;
  }

  const stop = msg.stop_reason ?? "unknown";
  const out = msg.usage?.output_tokens;
  const kinds = msg.content.map((b) => b.type).join(", ") || "(empty)";

  if (stop === "max_tokens") {
    // The one that was actually happening. Named explicitly because the fix is
    // a specific number in a specific file, not a retry.
    throw new Error(
      `${label}: hit max_tokens before emitting any text (output_tokens=${out}, ` +
        `blocks=[${kinds}]). On Sonnet 5 max_tokens covers thinking AND text, ` +
        `so raise max_tokens at this call site — retrying will not help.`,
    );
  }
  if (stop === "refusal") {
    throw new Error(
      `${label}: the model declined this request (stop_reason=refusal). ` +
        `The prompt needs changing; retrying will not help.`,
    );
  }
  throw new Error(
    `${label}: no text block in the response (stop_reason=${stop}, ` +
      `blocks=[${kinds}], output_tokens=${out}).`,
  );
}

/**
 * Build the error for a failed JSON.parse of a model response.
 *
 * Separate from extractTextBlock because a truncated response has TWO faces and
 * only one of them reaches that function. If the cut lands before any text, the
 * response has no text block. If it lands mid-object, there IS text and it is
 * unparseable. Same cause, and until this existed the second face threw
 * "AI returned invalid JSON", which reads like a prompt or model problem and
 * sends you to rewrite the prompt instead of raising max_tokens.
 */
export function jsonParseError(
  response: Anthropic.Message | MessageLike,
  label: string,
  text: string,
): Error {
  const msg = response as MessageLike;
  if (msg.stop_reason === "max_tokens") {
    return new Error(
      `${label}: response was cut off at max_tokens mid-JSON ` +
        `(output_tokens=${msg.usage?.output_tokens}, chars=${text.length}). ` +
        `This is a budget problem, not a prompt problem — raise max_tokens.`,
    );
  }
  return new Error(
    `${label}: model returned unparseable JSON (stop_reason=${msg.stop_reason ?? "unknown"}, ` +
      `chars=${text.length}).`,
  );
}
