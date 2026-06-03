// Unit tests for the pure content prompt builders + title normalizer
// (US-251 / US-252 / US-254). content-ai-prompts.ts has only type imports, so
// this runs with no fixtures:
//   deno test src/tests/content-ai-prompts_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  BLOG_ARTICLE_PROMPT_VERSION,
  buildBlogArticleUserPrompt,
  buildBlogComposeStreamUserPrompt,
  buildSectionRegenStreamUserPrompt,
  buildStreamSystemPrompt,
  normalizeTitleSuggestions,
} from "../lib/content-ai-prompts.ts";

Deno.test("US-254: article prompt requests 3-style title_suggestions (v2)", () => {
  assertEquals(BLOG_ARTICLE_PROMPT_VERSION, "blog_article_v2");
  const p = buildBlogArticleUserPrompt({
    title: "T",
    angle: null,
    primary_keyword: "k",
    secondary_keywords: [],
    search_intent: null,
    product_focus: "gradethread",
  });
  assert(p.includes("title_suggestions"));
  assert(p.includes("question"));
  assert(p.includes("listicle"));
  assert(p.includes("contrarian"));
});

Deno.test("US-254: normalizeTitleSuggestions coerces, dedups, caps, falls back", () => {
  const ok = normalizeTitleSuggestions(
    [
      { style: "question", title: "A?" },
      { style: "listicle", title: "B" },
      { style: "contrarian", title: "C" },
    ],
    "fb",
  );
  assertEquals(ok.map((x) => x.style), ["question", "listicle", "contrarian"]);

  const messy = normalizeTitleSuggestions(
    [
      { style: "weird", title: "A" },
      { style: "listicle", title: "A" }, // dup
      { style: "listicle", title: "B" },
      { style: "contrarian", title: "C" },
      { style: "question", title: "D" }, // capped out
    ],
    "fb",
  );
  assertEquals(messy.length, 3);
  assertEquals(messy[0].style, "question"); // 'weird' coerced
  assertEquals(messy.map((x) => x.title), ["A", "B", "C"]);

  assertEquals(normalizeTitleSuggestions(undefined, "Fallback"), [
    { style: "question", title: "Fallback" },
  ]);
});

Deno.test("US-251/252: stream system prompt is HTML-only (no JSON envelope)", () => {
  const sys = buildStreamSystemPrompt({
    brandVoice: "v",
    surfaceStyle: "s",
    pillarMap: "p",
    task: "compose-article",
  });
  assert(sys.includes("ONLY the HTML"));
  assert(!sys.includes("valid JSON"));
});

Deno.test("US-251: compose stream prompt carries topic + extra direction", () => {
  const p = buildBlogComposeStreamUserPrompt({
    title: "How to grade denim",
    angle: "beginner",
    primary_keyword: "grade denim jacket",
    secondary_keywords: ["fades"],
    search_intent: "informational",
    product_focus: "gradethread",
    instruction: "keep it punchy",
  });
  assert(p.includes("grade denim jacket"));
  assert(p.includes("keep it punchy"));
  assert(p.includes("<h2>")); // starts at H2, title is the page H1
});

Deno.test("US-252: section regen stream prompt per mode", () => {
  const rk = buildSectionRegenStreamUserPrompt({
    mode: "rewrite-for-keyword",
    selection_html: "<p>x</p>",
    primary_keyword: "vintage levis",
  });
  assert(rk.includes("vintage levis"));
  assert(rk.includes("Return ONLY the replacement HTML"));

  const ex = buildSectionRegenStreamUserPrompt({
    mode: "expand",
    selection_html: "<p>x</p>",
  });
  assert(ex.toLowerCase().includes("expand"));
});
