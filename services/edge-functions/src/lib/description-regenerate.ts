// US-2958: rewrite ONE description block.
//
// The point of the whole epic is that fixing one sentence should not rewrite
// the facts a seller already corrected. So this asks for one field, gets one
// field back, and the caller swaps exactly one entry in the block array.
//
// The prompt is deliberately narrow. It is told what the block IS, given the
// item's real attributes as CONTEXT, and forbidden from restating them —
// because brand, size, colour, material, measurements and the grade are all
// rendered by their own blocks, and a sentence repeating them is precisely the
// stale duplicate this epic exists to remove. scrubRestatedFacts at the call
// site is the backstop for when the model does it anyway.
//
// Text in, text out, one small call. No tool schema: a single string does not
// need one, and tool_choice on a one-field response costs tokens for nothing.

import { getAnthropicClient, getDefaultModel, getAiTemperature } from "./ai-config.ts";
import { enterAiFeature } from "./ai-feature-context.ts";
import { withRetry } from "./retry.ts";
import type { DescriptionBlockKey } from "./description-blocks.ts";
import type { RenderContext } from "./description-blocks.ts";
import type { OwnedListing } from "./description-render.ts";

/** What each regenerable block is for, in the model's words. */
const BLOCK_BRIEF: Record<string, string> = {
  intro:
    "One or two sentences opening the listing. Name the garment and the single " +
    "thing that makes it worth buying. No greeting, no sales pitch, no emoji.",
  features:
    "Two to four sentences on construction and styling that the photos show: " +
    "closure, pockets, trim, cuffs, lining, hardware, drape, pattern.",
  condition:
    "Two to three sentences of honest condition narrative. Say plainly what is " +
    "worn or flawed. Never upgrade the condition; over-promising causes returns.",
};

const SYSTEM = [
  "You write ONE section of a second-hand clothing listing for a reseller tool.",
  "",
  "Return ONLY that section's prose. No heading, no label, no bullet list, no",
  "markdown, no quotes around it.",
  "",
  "NEVER state brand, size, colour, material, condition grade, or any",
  "measurement as a labelled fact. Those are rendered separately from the",
  "item's own data, and repeating them creates a contradiction the seller",
  "cannot fix. Describe the garment; do not list it.",
  "",
  "Never mention a price tag, price sticker, or any original price visible in a",
  "photo. Never compare the item to another brand.",
].join("\n");

/**
 * Rewrite one AI block. Returns null on any failure, which the route turns into
 * a 502 — a failed rewrite must leave the stored description untouched rather
 * than blanking the section.
 */
export async function regenerateDescriptionBlock(
  key: DescriptionBlockKey,
  listing: OwnedListing,
  ctx: RenderContext,
): Promise<string | null> {
  const brief = BLOCK_BRIEF[key];
  if (!brief) return null;

  enterAiFeature("autolister"); // US-894 spend attribution
  const client = getAnthropicClient();
  const temperature = getAiTemperature();

  // Context, NOT content. The model needs to know it is describing a black
  // size-8 jogger to write about it truthfully; it is told above not to say so.
  const context = {
    brand: listing.item.brand,
    size: listing.item.size,
    color: listing.item.color,
    material: listing.item.material,
    style: listing.item.style,
    condition_grade: ctx.grade?.overall_score ?? null,
    existing_condition_notes: listing.ebay_condition_description,
  };

  const user = [
    `SECTION TO WRITE: ${key}`,
    brief,
    "",
    "ITEM CONTEXT (for accuracy only — do not restate these as facts):",
    JSON.stringify(context, null, 2),
  ].join("\n");

  try {
    const response = await withRetry(
      () =>
        client.messages.create({
          model: getDefaultModel(),
          max_tokens: 512,
          ...(temperature !== undefined ? { temperature } : {}),
          system: [{ type: "text", text: SYSTEM }],
          messages: [{ role: "user", content: [{ type: "text", text: user }] }],
        }),
      {
        onRetry: ({ attempt, delayMs }: { attempt: number; delayMs: number }) =>
          console.warn(
            `[description] regenerate ${key} retry #${attempt} after ${delayMs}ms`,
          ),
      },
    );

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("")
      .trim();
    return text || null;
  } catch (err) {
    console.error(`[description] regenerate ${key} failed:`, err);
    return null;
  }
}
