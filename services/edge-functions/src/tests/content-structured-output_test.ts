// US-3151: the schemas are the contract, and the request cannot silently drop
// half of it.
//
// The production failure this fixes was 349 of 402 content-scheduler errors in
// the 30 days to 2026-09-08: the model returning JSON the hand-parser could not
// read. The schema makes that impossible. These tests guard the two ways the
// fix could be present in the code and absent in the request.

import "./_env.ts";

import { assert, assertEquals } from "@std/assert";
import {
  BLOG_ARTICLE_SCHEMA,
  BLOG_REFRESH_SCHEMA,
  NEWSLETTER_COPY_SCHEMA,
  NEWSLETTER_REVIEW_SCHEMA,
  NEWSLETTER_TOPIC_REFILL_SCHEMA,
  SOCIAL_POST_SCHEMA,
  TOPIC_RESEARCH_SCHEMA,
} from "../lib/content-output-schemas.ts";
import { effortParams, outputConfigParams } from "../lib/ai-config.ts";

// deno-lint-ignore no-explicit-any
type Schema = any;

const ALL: Array<[string, Schema]> = [
  ["BLOG_ARTICLE_SCHEMA", BLOG_ARTICLE_SCHEMA],
  ["BLOG_REFRESH_SCHEMA", BLOG_REFRESH_SCHEMA],
  ["SOCIAL_POST_SCHEMA", SOCIAL_POST_SCHEMA],
  ["TOPIC_RESEARCH_SCHEMA", TOPIC_RESEARCH_SCHEMA],
  ["NEWSLETTER_COPY_SCHEMA", NEWSLETTER_COPY_SCHEMA],
  ["NEWSLETTER_REVIEW_SCHEMA", NEWSLETTER_REVIEW_SCHEMA],
  ["NEWSLETTER_TOPIC_REFILL_SCHEMA", NEWSLETTER_TOPIC_REFILL_SCHEMA],
];

/** Every object node in a schema, including nested array items. */
function objects(node: Schema, path = "$"): Array<[string, Schema]> {
  const out: Array<[string, Schema]> = [];
  if (!node || typeof node !== "object") return out;
  if (node.type === "object") {
    out.push([path, node]);
    for (const [k, v] of Object.entries(node.properties ?? {})) {
      out.push(...objects(v, `${path}.${k}`));
    }
  }
  if (node.type === "array") out.push(...objects(node.items, `${path}[]`));
  return out;
}

Deno.test("every object is closed and every property is required", () => {
  // Structured-output mode rejects a schema missing either. And a property
  // absent from `required` is a property the model may omit, which puts the
  // caller back to defensive coding - the thing this story removes.
  for (const [name, schema] of ALL) {
    for (const [path, node] of objects(schema)) {
      assertEquals(
        node.additionalProperties,
        false,
        `${name} ${path}: additionalProperties must be false`,
      );
      const props = Object.keys(node.properties ?? {}).sort();
      const required = [...(node.required ?? [])].sort();
      assertEquals(required, props, `${name} ${path}: required must list every property`);
    }
  }
});

Deno.test("the schemas match the interfaces the callers normalize into", () => {
  // Field names are the whole contract: a schema that says `title_suggestions`
  // while the parser reads `titleSuggestions` produces a valid object that
  // normalizes to nothing, which is worse than a parse error because it
  // publishes.
  assertEquals(Object.keys(BLOG_ARTICLE_SCHEMA.properties).sort(), [
    "body_html",
    "excerpt",
    "hero_image_alt",
    "hero_image_caption",
    "hero_prompt",
    "primary_keyword",
    "reading_time_min",
    "secondary_keywords",
    "seo_description",
    "seo_title",
    "slug",
    "summary_one_line",
    "tags",
    "title",
    "title_suggestions",
  ]);
  assertEquals(Object.keys(SOCIAL_POST_SCHEMA.properties).sort(), [
    "hashtags",
    "long_body",
    "short_body",
    "variants",
  ]);
  assertEquals(Object.keys(BLOG_REFRESH_SCHEMA.properties).sort(), [
    "body_html",
    "change_summary",
    "excerpt",
    "faqs",
    "key_takeaways",
    "seo_description",
    "summary_one_line",
  ]);
  assertEquals(Object.keys(TOPIC_RESEARCH_SCHEMA.properties), ["candidates"]);
});

Deno.test("reading_time_min is an integer, not a string", () => {
  // The normalizer coerced this because the model used to return "9 min" as
  // often as 9. The schema is what stops that at the source.
  assertEquals(
    (BLOG_ARTICLE_SCHEMA.properties as Schema).reading_time_min.type,
    "integer",
  );
});

Deno.test("outputConfigParams carries effort AND format in one object", () => {
  // THE BUG THIS EXISTS TO PREVENT. Spreading effortParams and then setting
  // output_config separately compiles, runs, and silently drops the effort -
  // the second key wins. One object, built once.
  const cfg = outputConfigParams(
    "claude-sonnet-5",
    "content_blog",
    "medium",
    BLOG_ARTICLE_SCHEMA,
  );
  assertEquals(cfg.output_config.effort, "medium");
  assertEquals((cfg.output_config.format as Schema).type, "json_schema");
  assertEquals((cfg.output_config.format as Schema).schema, BLOG_ARTICLE_SCHEMA);
  // No `name` key: output_config.format takes only { type, schema }, and an
  // extra key 400s every call (ai-provider-anthropic.ts learned this the hard way).
  assertEquals(Object.keys(cfg.output_config.format as Schema).sort(), ["schema", "type"]);
});

Deno.test("a model without effort still gets the schema", () => {
  // Structured outputs and effort are independent. Haiku takes the first and
  // rejects the second, and content DOES run on Haiku (CONTENT_MODEL_SOCIAL).
  // Dropping the schema there would leave the exact path that fails unprotected.
  const cfg = outputConfigParams(
    "claude-haiku-4-5-20251001",
    "content_social",
    "medium",
    SOCIAL_POST_SCHEMA,
  );
  assertEquals(cfg.output_config.effort, undefined);
  assertEquals((cfg.output_config.format as Schema).schema, SOCIAL_POST_SCHEMA);
  // And the effort-only helper stays a no-op there, as US-3146 established.
  assertEquals(effortParams("claude-haiku-4-5-20251001", "content_social", "medium"), {});
});

Deno.test("no content generator asks in prose for what the API enforces", async () => {
  // The two rules that were deleted. Leaving them would not break anything, but
  // a prompt that repeats a guarantee teaches the next reader that the
  // guarantee is not trusted - and this pair is specifically the text that did
  // not work for three weeks of production runs.
  const offenders: string[] = [];
  for (
    const f of [
      "src/lib/content-ai-prompts.ts",
      "src/lib/content-ai-blog.ts",
      "src/lib/content-ai-social.ts",
      "src/lib/content-ai-refresh.ts",
      "src/lib/content-ai-research.ts",
    ]
  ) {
    const src = await Deno.readTextFile(f);
    for (const [i, line] of src.split("\n").entries()) {
      if (line.trimStart().startsWith("//")) continue; // the notes explaining the removal
      if (/Respond with ONLY valid JSON|no markdown fences/i.test(line)) {
        offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 90)}`);
      }
    }
  }
  assertEquals(offenders, [], offenders.join("\n"));
});

Deno.test("the fence-stripping and its callers are gone together", async () => {
  // A removal is complete only when everything referencing it goes too. A dead
  // stripCodeFence left behind is the invitation to wire it back in.
  //
  // The map is parser -> the file that SENDS the schema, because they are not
  // always the same file: newsletter-topic-bank.ts owns the prompt and the
  // parse while newsletter-topic-bank-job.ts owns the request. Asserting the
  // parser sends its own schema would have been a wrong test that looked right.
  const SENDER: Record<string, string> = {
    "src/lib/content-ai-blog.ts": "src/lib/content-ai-blog.ts",
    "src/lib/content-ai-social.ts": "src/lib/content-ai-social.ts",
    "src/lib/content-ai-refresh.ts": "src/lib/content-ai-refresh.ts",
    "src/lib/content-ai-research.ts": "src/lib/content-ai-research.ts",
    "src/lib/newsletter-copy.ts": "src/lib/newsletter-copy.ts",
    "src/lib/newsletter-ai-editor.ts": "src/lib/newsletter-ai-editor.ts",
    "src/lib/newsletter-topic-bank.ts": "src/lib/newsletter-topic-bank-job.ts",
  };
  for (const [parser, sender] of Object.entries(SENDER)) {
    const src = await Deno.readTextFile(parser);
    assert(!src.includes("stripCodeFence"), `${parser} still has stripCodeFence`);
    const sendSrc = parser === sender ? src : await Deno.readTextFile(sender);
    assert(
      sendSrc.includes("outputConfigParams("),
      `${parser} parses a reply that ${sender} must enforce with a schema, and ` +
        `${sender} sends none - the parse below it is unguarded`,
    );
  }
});
