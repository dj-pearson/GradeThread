// US-876: hero image alt-text generation.
//
// The common path is free: the blog article generator returns `hero_image_alt`
// in the same JSON call, and content-blog.ts stores it before the hero is even
// generated. This module is the FALLBACK for heroes whose post has no stored alt
// (manual posts, or posts generated before US-876):
//   - generateHeroAltText() makes ONE cheap Anthropic call to describe the hero
//     from the post topic + the resolved image prompt (best-effort).
//   - buildHeroAltFallback() is a pure, deterministic last resort so we ALWAYS
//     end up with a non-empty alt — the SSR must never ship an empty one.
//
// Kept separate from openai-images.ts (image bytes) so the text-model dependency
// (Anthropic) stays out of the image pipeline's import surface.

import { getAnthropicClient, getDefaultModel } from "./ai-config.ts";

// Strip a leading "image of"/"photo of"/"picture of" and surrounding quotes the
// model sometimes adds, collapse whitespace, and cap to a sane SEO/a11y length.
export function normalizeAltText(raw: string, maxLen = 160): string {
  let s = (raw ?? "").trim().replace(/^["'\s]+|["'\s]+$/g, "");
  s = s.replace(/^(?:an?\s+)?(?:image|photo|picture|illustration|graphic)\s+of\s+/i, "");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > maxLen) s = s.slice(0, maxLen).replace(/\s+\S*$/, "").trim();
  return s;
}

// Deterministic, no-AI alt text. Always non-empty when given a title. Used as the
// floor under generateHeroAltText so a failed/absent AI call never yields "".
export function buildHeroAltFallback(
  title: string | null | undefined,
  primaryKeyword?: string | null,
): string {
  const t = (title ?? "").trim();
  const kw = (primaryKeyword ?? "").trim();
  if (t) {
    return normalizeAltText(`Hero illustration for ${t}`);
  }
  if (kw) return normalizeAltText(`Hero illustration about ${kw}`);
  return "GradeThread blog hero illustration";
}

// One cheap Anthropic call to author concise, keyword-aware hero alt text from
// the article topic + the image prompt. Returns the deterministic fallback on
// ANY failure (no key, network, empty output) so callers can treat it as
// best-effort and never have to handle an error.
export async function generateHeroAltText(input: {
  title?: string | null;
  primaryKeyword?: string | null;
  heroPrompt?: string | null;
}): Promise<string> {
  const fallback = buildHeroAltFallback(input.title, input.primaryKeyword);
  try {
    const title = (input.title ?? "").trim();
    if (!title && !(input.heroPrompt ?? "").trim()) return fallback;

    const client = getAnthropicClient();
    const userPrompt = [
      "Write ONE concise alt-text description for a blog hero image.",
      "",
      title ? `Article title: ${title}` : "",
      input.primaryKeyword ? `Primary keyword: ${input.primaryKeyword}` : "",
      input.heroPrompt ? `Image prompt used to generate it: ${input.heroPrompt}` : "",
      "",
      "Rules:",
      "- Describe what the image depicts, for a screen-reader user and for SEO.",
      "- ≤125 characters. One sentence, no trailing period needed.",
      "- Naturally include the primary keyword if it fits; never keyword-stuff.",
      "- Do NOT begin with \"image of\"/\"photo of\"/\"picture of\".",
      "- Output ONLY the alt text — no quotes, no label, no commentary.",
    ]
      .filter(Boolean)
      .join("\n");

    const response = await client.messages.create({
      model: getDefaultModel(),
      max_tokens: 120,
      messages: [{ role: "user", content: userPrompt }],
    });
    const textBlock = response.content.find((b) => b.type === "text");
    const text = textBlock && textBlock.type === "text" ? textBlock.text : "";
    const alt = normalizeAltText(text, 125);
    return alt || fallback;
  } catch (e) {
    console.warn(
      `[content-image-alt] alt generation failed; using fallback: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return fallback;
  }
}

// Parse a gpt-image-1 size token ("1536x1024") into { width, height }. Returns
// nulls for an unrecognized token so the ImageObject simply omits dimensions.
export function parseImageDimensions(
  size: string | null | undefined,
): { width: number | null; height: number | null } {
  const m = (size ?? "").match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  if (!m) return { width: null, height: null };
  const width = Number.parseInt(m[1] ?? "", 10);
  const height = Number.parseInt(m[2] ?? "", 10);
  return {
    width: Number.isFinite(width) ? width : null,
    height: Number.isFinite(height) ? height : null,
  };
}
