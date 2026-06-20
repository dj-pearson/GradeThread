// US-924: seed-corpus regression test for the autonomous pre-send QA / guardrail
// gate. Feeds known-bad issues (broken/relative link, missing unsubscribe,
// missing alt text, leftover placeholder, spammy subject, hallucinated feature)
// and asserts each is caught — the gate must never let a broken/off-brand/
// non-compliant issue through. All pure (no DB / model), so it's deterministic.
import { assert, assertEquals } from "@std/assert";
import type { RenderableIssue } from "../lib/newsletter-issue.ts";
import {
  computeSpamScore,
  decideGateOutcome,
  DEFAULT_QA_THRESHOLDS,
  extractImages,
  extractLinks,
  findPlaceholders,
  isAbsoluteLink,
  type QaContext,
  runGuardrailQa,
} from "../lib/newsletter-qa.ts";
import { parseEditorResult } from "../lib/newsletter-ai-editor.ts";

// A clean, compliant issue + rendered context the gate should PASS.
function goodIssue(): RenderableIssue {
  return {
    subject: "5 ways to grade faster this week",
    preheader: "Practical tips for resellers who move volume.",
    sections: [
      {
        heading: "Speed up your intake",
        body: '<p>Batch your photos and let the grader do the rest. ' +
          '<img src="https://gradethread.com/img/intake.png" alt="Batch intake screen" /></p>',
        ctaLabel: "Read the guide",
        ctaUrl: "https://gradethread.com/blog/intake",
      },
    ],
  };
}

function goodCtx(extra: Partial<QaContext> = {}): QaContext {
  return {
    html:
      '<a href="https://gradethread.com/blog/intake">Read</a> ' +
      '<img src="https://gradethread.com/img/intake.png" alt="Batch intake screen">',
    plaintext: "5 ways to grade faster this week\nBatch your photos...",
    hasUnsubscribe: true,
    hasPreferenceCenter: true,
    hasPostalAddress: true,
    ...extra,
  };
}

function failed(report: ReturnType<typeof runGuardrailQa>): string[] {
  return report.checks.filter((c) => c.severity === "hard" && !c.passed).map((c) => c.id);
}

Deno.test("gate PASSES a clean compliant issue", () => {
  const report = runGuardrailQa(goodIssue(), goodCtx());
  assert(report.passed, `expected pass, failed: ${failed(report).join(", ")}`);
});

Deno.test("seed corpus: relative/placeholder link is blocked", () => {
  const issue = goodIssue();
  issue.sections[0]!.ctaUrl = "/blog/intake"; // relative — not allowed
  const report = runGuardrailQa(issue, goodCtx({ html: '<a href="/blog/intake">Read</a>' }));
  assert(!report.passed);
  assert(failed(report).includes("links_absolute"));
});

Deno.test("seed corpus: confirmed 404 link is blocked", () => {
  const report = runGuardrailQa(
    goodIssue(),
    goodCtx({
      linkStatuses: { "https://gradethread.com/blog/intake": "broken" },
    }),
  );
  assert(!report.passed);
  assert(failed(report).includes("links_resolve"));
});

Deno.test("seed corpus: missing unsubscribe is blocked", () => {
  const report = runGuardrailQa(goodIssue(), goodCtx({ hasUnsubscribe: false }));
  assert(!report.passed);
  assert(failed(report).includes("unsubscribe"));
});

Deno.test("seed corpus: missing postal address is blocked", () => {
  const report = runGuardrailQa(goodIssue(), goodCtx({ hasPostalAddress: false }));
  assert(!report.passed);
  assert(failed(report).includes("postal_address"));
});

Deno.test("seed corpus: missing preference center is blocked (when required)", () => {
  const report = runGuardrailQa(goodIssue(), goodCtx({ hasPreferenceCenter: false }));
  assert(!report.passed);
  assert(failed(report).includes("preference_center"));
});

Deno.test("seed corpus: image missing alt text is blocked", () => {
  const html = '<a href="https://gradethread.com/x">x</a> <img src="https://gradethread.com/i.png">';
  const report = runGuardrailQa(goodIssue(), goodCtx({ html }));
  assert(!report.passed);
  assert(failed(report).includes("images_alt"));
});

Deno.test("seed corpus: relative image src is blocked", () => {
  const html = '<a href="https://gradethread.com/x">x</a> <img src="/i.png" alt="i">';
  const report = runGuardrailQa(goodIssue(), goodCtx({ html }));
  assert(!report.passed);
  assert(failed(report).includes("images_absolute"));
});

Deno.test("seed corpus: leftover merge-field placeholder is blocked", () => {
  const issue = goodIssue();
  issue.sections[0]!.body = "<p>Hi {{first_name}}, here is your update. TODO finish this.</p>";
  const report = runGuardrailQa(issue, goodCtx());
  assert(!report.passed);
  assert(failed(report).includes("no_placeholders"));
});

Deno.test("seed corpus: spammy ALL-CAPS subject with punctuation is blocked", () => {
  const issue = goodIssue();
  issue.subject = "ACT NOW!!! 100% FREE CASH GUARANTEED — CLICK HERE";
  const report = runGuardrailQa(issue, goodCtx());
  assert(!report.passed);
  assert(failed(report).includes("spam_score"));
});

Deno.test("seed corpus: over-long subject is blocked", () => {
  const issue = goodIssue();
  issue.subject = "x".repeat(DEFAULT_QA_THRESHOLDS.subjectMaxLength + 1);
  const report = runGuardrailQa(issue, goodCtx());
  assert(!report.passed);
  assert(failed(report).includes("subject_length"));
});

Deno.test("seed corpus: empty subject + no content is blocked", () => {
  const report = runGuardrailQa({ subject: "", preheader: "", sections: [] }, goodCtx());
  assert(!report.passed);
  const f = failed(report);
  assert(f.includes("subject_present"));
  assert(f.includes("has_content"));
});

Deno.test("seed corpus: missing plaintext alternative is blocked", () => {
  const report = runGuardrailQa(goodIssue(), goodCtx({ plaintext: "" }));
  assert(!report.passed);
  assert(failed(report).includes("plaintext"));
});

// ── spam scorer ───────────────────────────────────────────────────────────────

Deno.test("computeSpamScore: clean copy scores low, junk scores high", () => {
  const clean = computeSpamScore({
    subject: "Your weekly grading digest",
    preheader: "What moved this week",
    body: "Here are a few practical tips for your intake workflow.",
  });
  assert(clean.score <= DEFAULT_QA_THRESHOLDS.spamScoreMax);

  const junk = computeSpamScore({
    subject: "FREE CASH!!! ACT NOW",
    preheader: "100% free, risk-free, guaranteed",
    body: "Click here to WIN. This is not spam.",
  });
  assert(junk.score > DEFAULT_QA_THRESHOLDS.spamScoreMax, `junk score ${junk.score}`);
});

// ── helpers ───────────────────────────────────────────────────────────────────

Deno.test("isAbsoluteLink: absolute vs relative vs placeholder", () => {
  assert(isAbsoluteLink("https://gradethread.com/x"));
  assert(isAbsoluteLink("mailto:hi@gradethread.com"));
  assert(!isAbsoluteLink("/relative/path"));
  assert(!isAbsoluteLink("relative"));
  assert(!isAbsoluteLink("#anchor"));
  assert(!isAbsoluteLink("{{cta_url}}"));
  assert(!isAbsoluteLink("https://example.com/x")); // placeholder host
  assert(!isAbsoluteLink(""));
});

Deno.test("extractLinks + extractImages parse HTML", () => {
  const html =
    '<a href="https://a.com">a</a><a href="https://b.com">b</a>' +
    '<img src="https://a.com/i.png" alt="hi"><img src="/x.png">';
  const links = extractLinks(html, ["https://c.com"]);
  assertEquals(links, ["https://a.com", "https://b.com", "https://c.com"]);
  const imgs = extractImages(html);
  assertEquals(imgs.length, 2);
  assertEquals(imgs[0]!.alt, "hi");
  assertEquals(imgs[1]!.alt, null);
});

Deno.test("findPlaceholders catches templating + copy markers", () => {
  assert(findPlaceholders("Hi {{name}}").length > 0);
  assert(findPlaceholders("{% if x %}").length > 0);
  assert(findPlaceholders("price: ${amount}").length > 0);
  assert(findPlaceholders("[INSERT LINK]").length > 0);
  assert(findPlaceholders("Lorem ipsum dolor").length > 0);
  assertEquals(findPlaceholders("Totally clean copy."), []);
});

// ── AI editor parse + gate decision ────────────────────────────────────────────

Deno.test("seed corpus: AI editor hallucination → hard flag → blocked", () => {
  // A cheap-model verdict that flags a hallucinated feature.
  const result = parseEditorResult(JSON.stringify({
    brandVoiceOk: true,
    flags: [{
      type: "hallucination",
      severity: "hard",
      detail: "Claims a 'lifetime authentication guarantee' that does not exist.",
    }],
    summary: "Unsupported guarantee.",
  }));
  assert(result.ran);
  assert(result.hardFlag);

  const decision = decideGateOutcome({
    qaPassed: true,
    aiHardFlag: result.hardFlag,
    aiInconclusive: false,
    requireApproval: false,
  });
  assertEquals(decision.outcome, "blocked");
});

Deno.test("AI editor: soft brand-voice flag does not hard-block", () => {
  const result = parseEditorResult(JSON.stringify({
    brandVoiceOk: false,
    flags: [{ type: "brand_voice", severity: "soft", detail: "A bit hypey." }],
    summary: "Tone could be tightened.",
  }));
  assert(result.ran);
  assert(!result.hardFlag);
});

Deno.test("decideGateOutcome: routing matrix", () => {
  // Clean + no approval required → auto-approve.
  assertEquals(
    decideGateOutcome({ qaPassed: true, aiHardFlag: false, aiInconclusive: false, requireApproval: false }).outcome,
    "approved",
  );
  // Clean + approval required → human review.
  assertEquals(
    decideGateOutcome({ qaPassed: true, aiHardFlag: false, aiInconclusive: false, requireApproval: true }).outcome,
    "awaiting_review",
  );
  // AI inconclusive (model error) → human review, never auto-approve.
  assertEquals(
    decideGateOutcome({ qaPassed: true, aiHardFlag: false, aiInconclusive: true, requireApproval: false }).outcome,
    "awaiting_review",
  );
  // QA failure → blocked regardless of approval toggle.
  assertEquals(
    decideGateOutcome({ qaPassed: false, aiHardFlag: false, aiInconclusive: false, requireApproval: false }).outcome,
    "blocked",
  );
});
