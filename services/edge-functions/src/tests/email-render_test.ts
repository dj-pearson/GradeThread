// US-919: render-snapshot + invariants test for the email-safe modular rendering
// engine. Asserts stable, valid HTML for a sample issue and that no relative URL
// or <script> survives, plus the email-client-safety guarantees (inline CSS, MSO
// buttons, dark-mode, absolute links, alt text, compliance footer, plaintext).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  absolutizeUrl,
  type EmailDocument,
  isAbsoluteUrl,
  renderEmailDocument,
  renderEmailText,
  renderNewsletterEmail,
} from "../lib/email-render.ts";

function sampleDoc(): EmailDocument {
  return {
    subject: "5 grading wins this week",
    preheader: "Peek <inside> the latest",
    blocks: [
      {
        kind: "hero",
        image: { url: "/img/hero.png", alt: "Editorial flat-lay", width: 1536, height: 1024 },
        eyebrow: "This week",
        headline: "Grade faster & sell more",
        subtext: "The autonomous condition report, explained.",
      },
      {
        kind: "article",
        heading: "Batch your intake",
        bodyHtml: "<p>Upload front, back & label — the grader does the rest.</p>",
        cta: { label: "Read the guide", url: "https://gradethread.com/blog/intake?a=1&b=2" },
      },
      { kind: "tip", heading: "Pro tip", bodyHtml: "<p>Shoot tags on a flat, even surface.</p>" },
      { kind: "divider" },
      { kind: "cta", label: "Start grading", url: "/dashboard" },
    ],
  };
}

const OPTS = {
  siteUrl: "https://gradethread.com",
  unsubscribeUrl: "https://functions.gradethread.com/api/notifications/unsubscribe?u=1&t=abc",
  preferenceCenterUrl: "https://gradethread.com/account/email",
  postalAddress: "Pearson Media LLC, Iowa, USA",
};

Deno.test("URL helpers: absolute detection + relative resolution", () => {
  assert(isAbsoluteUrl("https://x.test/y"));
  assert(isAbsoluteUrl("mailto:a@b.com"));
  assert(!isAbsoluteUrl("/dashboard"));
  assert(!isAbsoluteUrl("img/x.png"));
  assertEquals(absolutizeUrl("/dashboard", "https://gradethread.com"), "https://gradethread.com/dashboard");
  assertEquals(absolutizeUrl("img/x.png", "https://gradethread.com/"), "https://gradethread.com/img/x.png");
  assertEquals(absolutizeUrl("https://other.test/z", "https://gradethread.com"), "https://other.test/z");
});

Deno.test("snapshot: render is deterministic + valid HTML shell", () => {
  const a = renderEmailDocument(sampleDoc(), OPTS).html;
  const b = renderEmailDocument(sampleDoc(), OPTS).html;
  assertEquals(a, b); // stable
  assert(a.startsWith("<!DOCTYPE html>"));
  assertStringIncludes(a, "</html>");
  // preheader is escaped, never raw
  assertStringIncludes(a, "Peek &lt;inside&gt; the latest");
  assert(!a.includes("undefined"));
});

Deno.test("no relative URLs and no <script> survive", () => {
  const { html } = renderEmailDocument(sampleDoc(), OPTS);
  // Relative links/images would have been absolutized.
  assert(!/href="\/(?!\/)/.test(html), "relative href leaked");
  assert(!/src="\/(?!\/)/.test(html), "relative src leaked");
  assert(!/href="#/.test(html), "anchor-only href leaked");
  assert(!/<script/i.test(html), "<script> leaked");
  // The relative CTA + hero image got resolved against the site origin.
  assertStringIncludes(html, "https://gradethread.com/dashboard");
  assertStringIncludes(html, "https://gradethread.com/img/hero.png");
});

Deno.test("email-client safety: MSO buttons, dark-mode, responsive, fonts", () => {
  const { html } = renderEmailDocument(sampleDoc(), OPTS);
  assertStringIncludes(html, "v:roundrect"); // MSO bulletproof button
  assertStringIncludes(html, "<!--[if mso]>");
  assertStringIncludes(html, "prefers-color-scheme: dark");
  assertStringIncludes(html, "max-width: 600px"); // responsive media query
  assertStringIncludes(html, "max-width:600px"); // inline container cap
  assertStringIncludes(html, "'Inter'"); // web-safe Inter-fallback stack
  assertStringIncludes(html, 'name="color-scheme"');
});

Deno.test("every image has alt text + explicit width/height", () => {
  const { html } = renderEmailDocument(sampleDoc(), OPTS);
  const imgs = html.match(/<img\b[^>]*>/gi) ?? [];
  assert(imgs.length >= 1);
  for (const tag of imgs) {
    assert(/\balt\s*=\s*"/.test(tag), `img missing alt: ${tag}`);
    assert(/\bwidth\s*=\s*"\d/.test(tag), `img missing width: ${tag}`);
    assert(/\bheight\s*=\s*"\d/.test(tag), `img missing height: ${tag}`);
  }
});

Deno.test("compliance footer: postal + unsubscribe + preference center always present", () => {
  const { html, unsubscribeUrl } = renderEmailDocument(sampleDoc(), OPTS);
  assertStringIncludes(html, "Pearson Media LLC, Iowa, USA");
  assertStringIncludes(html, "Unsubscribe from this newsletter");
  assertStringIncludes(html, "Manage email preferences");
  assertEquals(unsubscribeUrl, OPTS.unsubscribeUrl);
  // raw preview (no compliance URLs) omits the unsubscribe link
  const raw = renderEmailDocument({ subject: "s", blocks: [{ kind: "text", bodyHtml: "x" }] }).html;
  assert(!raw.includes("Unsubscribe from this newsletter"));
});

Deno.test("plaintext multipart alternative is generated from the document", () => {
  const text = renderEmailText(sampleDoc(), OPTS);
  assertStringIncludes(text, "5 grading wins this week");
  assertStringIncludes(text, "Batch your intake");
  assertStringIncludes(text, "Read the guide: https://gradethread.com/blog/intake?a=1&b=2");
  assertStringIncludes(text, "Start grading: https://gradethread.com/dashboard");
  assert(!text.includes("<")); // no tags survive
});

Deno.test("render-time click tracking wraps links + injects an open pixel", () => {
  const { html } = renderEmailDocument(sampleDoc(), {
    ...OPTS,
    tracking: { baseUrl: "https://functions.gradethread.com", token: "tok123" },
  });
  // A normal link is rewritten through the click redirect...
  assertStringIncludes(html, "/api/drip-track/c/tok123?u=");
  // ...the unsubscribe link is left direct (one-click must always work)...
  assertStringIncludes(html, "api/notifications/unsubscribe");
  // ...and the open pixel is injected.
  assertStringIncludes(html, "/api/drip-track/o/tok123");
});

Deno.test("bridge: legacy newsletter issue renders through the new engine", () => {
  const html = renderNewsletterEmail(
    {
      subject: "Hello",
      preheader: "Peek <inside>",
      sections: [
        { heading: "A & B", body: "<p>Body html stays</p>", ctaLabel: "Grade now", ctaUrl: "https://x.test/go?a=1&b=2" },
        { body: "Second block" },
      ],
    },
    { unsubscribeUrl: "https://functions.test/unsub?u=1&t=abc", postalAddress: "Pearson Media LLC, Iowa, USA" },
  );
  assert(html.startsWith("<!DOCTYPE html>"));
  assertStringIncludes(html, "A &amp; B"); // heading escaped
  assertStringIncludes(html, "<p>Body html stays</p>"); // body preserved verbatim
  assertStringIncludes(html, "Grade now");
  assertStringIncludes(html, "https://x.test/go?a=1&amp;b=2"); // url attr-escaped, not wrapped
  assertStringIncludes(html, "Pearson Media LLC, Iowa, USA");
  assertStringIncludes(html, "Unsubscribe from this newsletter");
  assertStringIncludes(html, "Peek &lt;inside&gt;");
});
