// US-3151: the schemas are the contract, and the request cannot silently drop
// half of it.
//
// The production failure this fixes was 349 of 402 content-scheduler errors in
// the 30 days to 2026-09-08: the model returning JSON the hand-parser could not
// read. The schema makes that impossible. These tests guard the two ways the
// fix could be present in the code and absent in the request.

import "./_env.ts";

import { assert, assertEquals } from "@std/assert";
import { parseSafetyVerdict } from "../lib/content-safety.ts";
import {
  AD_COPY_APPLE_SCHEMA,
  AD_COPY_GOOGLE_SCHEMA,
  BLOG_ARTICLE_SCHEMA,
  BLOG_REFRESH_SCHEMA,
  NEWSLETTER_COPY_SCHEMA,
  NEWSLETTER_REVIEW_SCHEMA,
  NEWSLETTER_TOPIC_REFILL_SCHEMA,
  SAFETY_REVIEW_SCHEMA,
  SOCIAL_POST_SCHEMA,
  TOPIC_RESEARCH_SCHEMA,
} from "../lib/content-output-schemas.ts";
import {
  CONTENT_MODEL_ALLOWLIST_FOR_TESTS,
  effortParams,
  outputConfigParams,
} from "../lib/ai-config.ts";

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

// ── The last two callers, and the AC5 grep ────────────────────────────
// Added 2026-09-10. The 2026-09-08 pass named content-safety.ts and
// ad-copy-ai.ts as the complete remaining list and left them asking in prose.
// A list of remaining work in a note is not a guard; these are.


Deno.test("the last two JSON callers send a schema and strip no fences", async () => {
  for (
    const f of ["src/lib/content-safety.ts", "src/lib/ad-copy-ai.ts"]
  ) {
    const src = await Deno.readTextFile(f);
    assert(!src.includes("stripCodeFence"), `${f} still hand-strips code fences`);
    assert(
      src.includes("outputConfigParams("),
      `${f} hand-parses a reply it never constrained - the parse below it is unguarded`,
    );
  }
});

Deno.test("US-3151 AC5: every surviving JSON-in-prose rule is named and explained", async () => {
  // The AC verbatim: a grep for these phrases across services/edge-functions/src
  // returns only the sites this story deliberately kept, each with a comment
  // saying why. The allowlist is the "deliberately kept" set; a NEW site cannot
  // join it without an entry here, and a kept site that loses its US-3151
  // comment fails too - which is the half that rots silently.
  const KEPT: Record<string, string> = {
    "src/lib/ai-grading.ts":
      "redundant against an output_config.format already being sent; removal is a " +
      "grading prompt change and rides US-3150's shadow/eval/canary lane",
    "src/lib/ai-authenticity.ts":
      "NOT redundant - this call sends no schema yet, so the rule is load-bearing; " +
      "converting it needs two schemas (grounded/ungrounded) and the grading gate",
    "src/lib/content-ai-prompts.ts":
      "the streaming path emits insertable HTML, not a JSON envelope, so " +
      "output_config.format does not apply and the rule is the only guard",
    "src/lib/garment-baselines.ts":
      "a prose-output brief; 'no preamble' here is not a JSON rule at all",

    // ── Found by this guard, not by the story ─────────────────────────
    // The AC's grep was three literal phrases. These three say the same thing
    // in different words ("Return ONLY a JSON object", "no prose, no code
    // fence") and were invisible to it. They are NOT converted; each carries
    // its blocker in the file, and each fails soft today, which is why none of
    // them shows up in the content_scheduler_runs error counts.
    "src/lib/ads-analysis.ts":
      "projected_impact and payload are open maps by design, and a closed schema " +
      "cannot express one; fails soft (returns [])",
    "src/lib/receipt-extract.ts":
      "half the fields are nullable by design, and nullable is outside the schema " +
      "subset proven in production; fails soft (retry prompt)",
    "src/lib/support-abuse.ts":
      "nearly a drop-in, blocked only on `boolean` being unproven here, and it " +
      "FAILS OPEN so a 400 would disarm it silently",
  };
  const RULE = /ONLY with valid JSON|no markdown fences|no preamble|ONLY a JSON object|ONLY the JSON object/i;

  const offenders: string[] = [];
  for await (
    const entry of Deno.readDir("src/lib")
  ) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    const path = `src/lib/${entry.name}`;
    const lines = (await Deno.readTextFile(path)).split("\n");
    for (const [i, line] of lines.entries()) {
      if (line.trimStart().startsWith("//")) continue; // the notes explaining it
      if (!RULE.test(line)) continue;
      if (!(path in KEPT)) {
        offenders.push(
          `${path}:${i + 1} asks in prose for what output_config.format enforces. ` +
            `Send a schema, or add it to KEPT with the reason. Line: ${line.trim().slice(0, 80)}`,
        );
      }
    }
  }
  assertEquals(offenders, [], "\n" + offenders.join("\n"));

  // And every kept file must actually carry the reason, in the file, near the
  // rule - not only in this test and not only in a prd note.
  for (const file of Object.keys(KEPT)) {
    const src = await Deno.readTextFile(file);
    assert(src.includes("US-3151"), `${file} is on the keep list with no US-3151 comment in it`);
  }
});

Deno.test("content-safety's fail-closed guard is still reachable and still holds", () => {
  // ⚠ THE POINT OF THIS TEST. Every other converted caller deleted its recovery
  // path because a schema makes the failure impossible. content-safety did not,
  // because its recovery path is a SAFETY DEFAULT: an unreadable verdict holds
  // the post. A schema that stops the reply being unreadable does not make
  // "hold on anything ambiguous" wrong - it makes it untested, which is how a
  // safe change takes a feature down. So it stays exercised.
  assertEquals(parseSafetyVerdict("not json at all"), {
    verdict: "hold",
    reasons: ["reviewer returned invalid JSON"],
  });
  assertEquals(parseSafetyVerdict("[1,2,3]").verdict, "hold");
  assertEquals(parseSafetyVerdict('{"verdict":"hold","reasons":["fabricated stat"]}'), {
    verdict: "hold",
    reasons: ["fabricated stat"],
  });
  // A pass is the ONLY thing that passes, and it must be unambiguous.
  assertEquals(parseSafetyVerdict('{"verdict":"pass","reasons":[]}'), {
    verdict: "pass",
    reasons: [],
  });
  assertEquals(parseSafetyVerdict('{"verdict":"approved","reasons":[]}').verdict, "hold");
  // The schema is what makes the first two branches unreachable in production.
  // If it ever stops being an enum, "approved" becomes reachable again.
  assertEquals(
    (SAFETY_REVIEW_SCHEMA.properties.verdict as Schema).enum,
    ["pass", "hold"],
  );
});

Deno.test("ad-copy sends the schema for the platform it asked for", () => {
  // Two shapes, one call site. Sending the Google schema on an Apple request
  // would constrain the model to fields the normalizer never reads, and the
  // result is an empty ad set rather than an error.
  assertEquals(Object.keys(AD_COPY_GOOGLE_SCHEMA.properties).sort(), [
    "descriptions",
    "headlines",
  ]);
  assertEquals(Object.keys(AD_COPY_APPLE_SCHEMA.properties).sort(), ["creative", "keywords"]);
  assertEquals(
    Object.keys((AD_COPY_APPLE_SCHEMA.properties.keywords as Schema).properties).sort(),
    ["broad", "exact"],
  );
});

Deno.test("every model an operator can route content to still gets the schema", () => {
  // THE FALLBACK, MADE REACHABLE. getContentModel() refuses an unknown
  // CONTENT_MODEL_* override and falls back to the default model - so the set
  // of models that can receive these requests is exactly the allowlist plus
  // that default. If one of them ever took `format` differently, the schema
  // would have to be conditional; this pins that none of them is special, and
  // it fails loudly the day a model is added to the allowlist without checking.
  for (const model of CONTENT_MODEL_ALLOWLIST_FOR_TESTS) {
    const cfg = outputConfigParams(model, "content_blog", "medium", BLOG_ARTICLE_SCHEMA);
    assertEquals(
      (cfg.output_config.format as Schema).schema,
      BLOG_ARTICLE_SCHEMA,
      `${model} would be sent no schema`,
    );
  }
  assert(CONTENT_MODEL_ALLOWLIST_FOR_TESTS.length >= 4);
});
