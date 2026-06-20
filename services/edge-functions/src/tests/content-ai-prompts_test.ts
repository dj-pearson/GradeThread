// Unit tests for the pure content prompt builders + title normalizer
// (US-251 / US-252 / US-254). content-ai-prompts.ts has only type imports, so
// this runs with no fixtures:
//   deno test src/tests/content-ai-prompts_test.ts

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  BLOG_ARTICLE_PROMPT_VERSION,
  buildBlogArticleUserPrompt,
  buildBlogComposeStreamUserPrompt,
  buildEmailIssueSystemPrompt,
  buildEmailIssueUserPrompt,
  buildSectionRegenStreamUserPrompt,
  buildSocialPostUserPrompt,
  buildStreamSystemPrompt,
  EMAIL_ISSUE_PROMPT_VERSION,
  isGroundedEmailLink,
  normalizeEmailIssue,
  normalizeTitleSuggestions,
  parseEmailIssue,
  SOCIAL_POST_PROMPT_VERSION,
} from "../lib/content-ai-prompts.ts";

Deno.test("US-254: article prompt requests 3-style title_suggestions (v3)", () => {
  assertEquals(BLOG_ARTICLE_PROMPT_VERSION, "blog_article_v3");
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

Deno.test("US-878: article prompt nudges answer-first + HowTo steps + canonical vocab", () => {
  const p = buildBlogArticleUserPrompt({
    title: "How to grade a thrifted jacket",
    angle: null,
    primary_keyword: "how to grade clothing",
    secondary_keywords: [],
    search_intent: "informational",
    product_focus: "gradethread",
  });
  assert(p.includes("ANSWER-FIRST"));
  assert(p.includes("<ol><li>"));
  assert(p.includes("NWT"));
  assert(p.includes("Fabric Condition"));
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

Deno.test("US-870: social prompt is v2 and asks for per-platform variants", () => {
  assertEquals(SOCIAL_POST_PROMPT_VERSION, "social_post_v2");
  const topic = {
    title: "How to grade vintage denim",
    angle: null,
    primary_keyword: "grade vintage denim",
    product_focus: "gradethread" as const,
    cta_url: "https://gradethread.com/?utm_source=social",
  };
  // No platforms → legacy long/short schema only, no variants block.
  const base = buildSocialPostUserPrompt(topic);
  assert(base.includes("long_body"));
  assert(!base.includes('"variants"'));

  // With platforms → variants object + each platform's rules appear.
  const withVariants = buildSocialPostUserPrompt(topic, [
    { platform: "x", rules: "<=280 chars" },
    { platform: "linkedin", rules: "800-1500 chars professional" },
  ]);
  assert(withVariants.includes('"variants"'));
  assert(withVariants.includes("x:"));
  assert(withVariants.includes("linkedin:"));
  assert(withVariants.includes("800-1500 chars professional"));
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

// ── US-918: email newsletter copywriter ──────────────────────────────────────

const emailTopic = {
  label: "How to grade fading on dark denim",
  pillar: "grading",
  angle: "fabric-condition",
};

Deno.test("US-918: email system prompt assembles knowledge + inputs + history", () => {
  assertEquals(EMAIL_ISSUE_PROMPT_VERSION, "email_issue_v1");
  const sys = buildEmailIssueSystemPrompt({
    emailVoice: "VOICE_DOC",
    emailStructure: "STRUCTURE_DOC",
    valueProps: "VALUE_PROPS_DOC",
    historyContext: "- prior issue about zippers",
    topic: emailTopic,
    changelogLines: ['2026-06-10 "New AI comp engine"'],
    kbTip: "Always shoot tags in natural light.",
    productFocus: "flipdesk",
  });
  assert(sys.includes("VOICE_DOC"));
  assert(sys.includes("STRUCTURE_DOC"));
  assert(sys.includes("VALUE_PROPS_DOC"));
  assert(sys.includes("prior issue about zippers"));
  assert(sys.includes("New AI comp engine"));
  assert(sys.includes("Always shoot tags in natural light"));
  assert(sys.includes(emailTopic.label));
  assert(sys.includes("resellers")); // flipdesk audience
  assert(sys.includes("Do NOT invent")); // grounding rule
});

Deno.test("US-918: email system prompt leans evergreen with no changelog", () => {
  const sys = buildEmailIssueSystemPrompt({
    emailVoice: "",
    emailStructure: "",
    valueProps: "",
    historyContext: "",
    topic: emailTopic,
    changelogLines: [],
    productFocus: "gradethread",
  });
  assert(sys.includes("no fresh product updates"));
  assert(sys.includes("grading")); // gradethread audience
});

Deno.test("US-918: email user prompt carries the JSON schema + length caps", () => {
  const p = buildEmailIssueUserPrompt({
    topic: emailTopic,
    changelogLines: [],
    productFocus: "both",
    maxSections: 4,
  });
  assert(p.includes("subject_variants"));
  assert(p.includes("preheader"));
  assert(p.includes("image_prompt"));
  assert(p.includes("footer_note"));
  assert(p.includes("summary_one_line"));
  assert(p.includes("60")); // subject cap
  assert(p.includes("110")); // preheader cap
});

Deno.test("US-918: normalizeEmailIssue validates, caps lengths, dedups variants", () => {
  const longSubject = "x".repeat(80);
  const longPre = "y".repeat(140);
  const issue = normalizeEmailIssue({
    subject: longSubject,
    subject_variants: ["Alt one", "alt one", "Alt two", "Alt three", "Alt four"],
    preheader: longPre,
    intro: "<p>Hello</p>",
    sections: [
      { heading: "Teach", body_html: "<p>Body</p>" },
      {
        heading: "CTA",
        body_html: "<p>Go</p>",
        cta_label: "Open",
        cta_url: "https://gradethread.com/dashboard",
      },
    ],
    footer_note: "Happy reselling",
    summary_one_line: "An issue about denim fading.",
  }, { changelogLines: [], maxSections: 5 });

  assertEquals(issue.subject.length, 60);
  assertEquals(issue.preheader.length, 110);
  // "Alt one" dedup (case-insensitive) → 3 distinct, capped at 3.
  assertEquals(issue.subjectVariants, ["Alt one", "Alt two", "Alt three"]);
  assertEquals(issue.sections.length, 2);
  assertEquals(issue.sections[1].ctaUrl, "https://gradethread.com/dashboard");
  assertEquals(issue.footerNote, "Happy reselling");
});

Deno.test("US-918: normalizeEmailIssue sanitizes unsafe HTML", () => {
  const issue = normalizeEmailIssue({
    subject: "S",
    sections: [{ body_html: '<p onclick="x()">Hi</p><script>alert(1)</script>' }],
  }, { changelogLines: [], maxSections: 3 });
  assert(!issue.sections[0].body.includes("<script"));
  assert(!issue.sections[0].body.includes("onclick"));
});

Deno.test("US-918: normalizeEmailIssue throws on no subject / no usable section", () => {
  assertThrows(() =>
    normalizeEmailIssue({ sections: [{ body_html: "<p>x</p>" }] }, { changelogLines: [], maxSections: 3 })
  );
  assertThrows(() =>
    normalizeEmailIssue({ subject: "S", sections: [] }, { changelogLines: [], maxSections: 3 })
  );
});

// AC4 negative test: the copy is grounded strictly in the inputs. A CTA that
// links to an invented FEATURE page (not on the evergreen allowlist and not
// present in the changelog inputs) is stripped — the model can't smuggle in a
// feature that doesn't exist via a fabricated link.
Deno.test("US-918: fabricated feature link is rejected (grounding)", () => {
  const invented = "https://gradethread.com/features/auto-magic-autograder";
  // The link is NOT grounded when it's absent from the inputs...
  assertEquals(isGroundedEmailLink(invented, []), false);
  // ...and normalize strips the CTA entirely.
  const issue = normalizeEmailIssue({
    subject: "Big news",
    sections: [{
      heading: "Try our brand-new auto-grader",
      body_html: "<p>We just launched magical auto-grading.</p>",
      cta_label: "Try Auto-Grader",
      cta_url: invented,
    }],
  }, { changelogLines: [], maxSections: 3 });
  assertEquals(issue.sections[0].ctaUrl, undefined);
  assertEquals(issue.sections[0].ctaLabel, undefined);

  // The SAME link IS grounded once it appears verbatim in a provided input line.
  assertEquals(
    isGroundedEmailLink(invented, [`2026-06-10 "Launched auto-grader" ${invented}`]),
    true,
  );
});

Deno.test("US-918: isGroundedEmailLink allowlist + host rules", () => {
  assert(isGroundedEmailLink("https://gradethread.com/", []));
  assert(isGroundedEmailLink("https://gradethread.com/pricing", []));
  assert(isGroundedEmailLink("https://www.gradethread.com/blog/some-post", []));
  assert(!isGroundedEmailLink("http://gradethread.com/pricing", [])); // not https
  assert(!isGroundedEmailLink("https://evil.com/pricing", [])); // wrong host
  assert(!isGroundedEmailLink("not-a-url", []));
});

Deno.test("US-918: parseEmailIssue strips ```json fences", () => {
  const raw = "```json\n" +
    JSON.stringify({ subject: "S", sections: [{ body_html: "<p>x</p>" }] }) +
    "\n```";
  const issue = parseEmailIssue(raw, { changelogLines: [], maxSections: 3 });
  assertEquals(issue.subject, "S");
  assertThrows(() => parseEmailIssue("not json", { changelogLines: [], maxSections: 3 }));
});
