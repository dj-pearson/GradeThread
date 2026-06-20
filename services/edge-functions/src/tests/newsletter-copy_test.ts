import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  buildCopySystemPrompt,
  buildCopyUserPrompt,
  evergreenCopy,
  parseNewsletterCopy,
} from "../lib/newsletter-copy.ts";
import { NEWSLETTER_TOPICS, SUBJECT_STYLES } from "../lib/newsletter-tuning.ts";

// US-922: the copywriter's prompt builders / parser / evergreen fallback are PURE
// (no supabase/env) so they unit-test directly.

const topic = NEWSLETTER_TOPICS[0];
const style = SUBJECT_STYLES[0];

Deno.test("buildCopyUserPrompt leans evergreen when no changelog", () => {
  const p = buildCopyUserPrompt({
    topic,
    style,
    changelogLines: [],
    productFocus: "gradethread",
    maxSections: 3,
  });
  assert(p.includes("no fresh product updates"));
  assert(p.includes(topic.label));
});

Deno.test("buildCopyUserPrompt surfaces changelog lines when present", () => {
  const p = buildCopyUserPrompt({
    topic,
    style,
    changelogLines: ["- 2026-06-01 \"New comp engine\""],
    productFocus: "flipdesk",
    maxSections: 2,
  });
  assert(p.includes("New comp engine"));
  assert(p.includes("do NOT fabricate"));
});

Deno.test("buildCopySystemPrompt tailors audience by product focus", () => {
  assert(buildCopySystemPrompt({ productFocus: "flipdesk" }).includes("resellers"));
  assert(buildCopySystemPrompt({ productFocus: "gradethread" }).includes("grading"));
});

Deno.test("parseNewsletterCopy validates + normalizes a good response", () => {
  const raw = JSON.stringify({
    subject: "Grade like a pro",
    preheader: "Five minutes to better grades",
    sections: [
      { heading: "Why it matters", body_html: "<p>Condition drives price.</p>" },
      { heading: "CTA", body_html: "<p>Try it.</p>", cta_label: "Open", cta_url: "https://gradethread.com/x" },
    ],
  });
  const copy = parseNewsletterCopy(raw, 5);
  assertEquals(copy.subject, "Grade like a pro");
  assertEquals(copy.sections.length, 2);
  assertEquals(copy.sections[1].ctaUrl, "https://gradethread.com/x");
});

Deno.test("parseNewsletterCopy strips markdown fences", () => {
  const raw = "```json\n" + JSON.stringify({ subject: "S", sections: [{ body_html: "<p>x</p>" }] }) + "\n```";
  const copy = parseNewsletterCopy(raw, 5);
  assertEquals(copy.subject, "S");
});

Deno.test("parseNewsletterCopy drops a CTA with a non-URL", () => {
  const raw = JSON.stringify({
    subject: "S",
    sections: [{ body_html: "<p>x</p>", cta_label: "Go", cta_url: "not-a-url" }],
  });
  const copy = parseNewsletterCopy(raw, 5);
  assertEquals(copy.sections[0].ctaUrl, undefined);
  assertEquals(copy.sections[0].ctaLabel, undefined);
});

Deno.test("parseNewsletterCopy caps sections at maxSections", () => {
  const raw = JSON.stringify({
    subject: "S",
    sections: Array.from({ length: 8 }, (_, i) => ({ body_html: `<p>${i}</p>` })),
  });
  assertEquals(parseNewsletterCopy(raw, 3).sections.length, 3);
});

Deno.test("parseNewsletterCopy throws on missing subject / no usable section", () => {
  assertThrows(() => parseNewsletterCopy(JSON.stringify({ sections: [{ body_html: "<p>x</p>" }] }), 5));
  assertThrows(() => parseNewsletterCopy(JSON.stringify({ subject: "S", sections: [] }), 5));
  assertThrows(() => parseNewsletterCopy("not json", 5));
});

Deno.test("evergreenCopy always yields a valid, sendable issue", () => {
  const copy = evergreenCopy(topic, style);
  assert(copy.subject.length > 0);
  assert(copy.sections.length > 0);
  assert(copy.sections.every((s) => s.body.trim().length > 0));
});
