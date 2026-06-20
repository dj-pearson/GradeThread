// US-930: unit tests for the pure newsletter issue lifecycle + render helpers.
import { assert, assertEquals } from "@std/assert";
import {
  canTransition,
  escapeHtml,
  isEditable,
  isNewsletterStatus,
  nextScheduledRun,
  renderNewsletterHtml,
  runIssueQa,
} from "../lib/newsletter-issue.ts";

Deno.test("status machine: valid + invalid transitions", () => {
  assert(canTransition("draft", "ready_for_qa"));
  assert(canTransition("ready_for_qa", "awaiting_review"));
  assert(canTransition("awaiting_review", "approved"));
  assert(canTransition("approved", "sending"));
  assert(canTransition("sending", "sent"));
  // kill-switch / reject reaches blocked from any live state
  assert(canTransition("draft", "blocked"));
  assert(canTransition("approved", "blocked"));
  assert(canTransition("blocked", "draft"));

  // illegal jumps
  assert(!canTransition("draft", "sent"));
  assert(!canTransition("draft", "approved"));
  assert(!canTransition("sent", "draft")); // terminal
  assert(!canTransition("sent", "sending"));
  assert(!canTransition("awaiting_review", "sending")); // must approve first
});

Deno.test("isEditable: only pre-send states", () => {
  assert(isEditable("draft"));
  assert(isEditable("ready_for_qa"));
  assert(isEditable("awaiting_review"));
  assert(isEditable("approved"));
  assert(!isEditable("sending"));
  assert(!isEditable("sent"));
  assert(!isEditable("blocked"));
});

Deno.test("isNewsletterStatus guards unknown values", () => {
  assert(isNewsletterStatus("draft"));
  assert(!isNewsletterStatus("queued"));
  assert(!isNewsletterStatus(42));
});

Deno.test("render: full document with sections, escaping, footer + unsubscribe", () => {
  const html = renderNewsletterHtml(
    {
      subject: "Hello",
      preheader: "Peek <inside>",
      sections: [
        { heading: "A & B", body: "<p>Body html stays</p>", ctaLabel: "Grade now", ctaUrl: "https://x.test/go?a=1&b=2" },
        { body: "Second block" },
      ],
    },
    {
      unsubscribeUrl: "https://functions.test/unsub?u=1&t=abc",
      postalAddress: "Pearson Media LLC, Iowa, USA",
    },
  );
  assert(html.startsWith("<!DOCTYPE html>"));
  // heading is escaped, body html is preserved verbatim
  assert(html.includes("A &amp; B"));
  assert(html.includes("<p>Body html stays</p>"));
  // CTA present + url attribute-escaped
  assert(html.includes("Grade now"));
  assert(html.includes("https://x.test/go?a=1&amp;b=2"));
  // footer + unsubscribe
  assert(html.includes("Pearson Media LLC, Iowa, USA"));
  assert(html.includes("Unsubscribe from this newsletter"));
  // preheader escaped
  assert(html.includes("Peek &lt;inside&gt;"));
});

Deno.test("render: omits unsubscribe + postal when not supplied (raw preview)", () => {
  const html = renderNewsletterHtml({ subject: "s", sections: [{ body: "x" }] });
  assert(!html.includes("Unsubscribe from this newsletter"));
});

Deno.test("escapeHtml escapes the dangerous five", () => {
  assertEquals(escapeHtml(`<a href="x" foo='y'>&`), "&lt;a href=&quot;x&quot; foo=&#39;y&#39;&gt;&amp;");
});

Deno.test("QA flags missing subject / content / cta", () => {
  const ok = runIssueQa({ subject: "Subject", sections: [{ body: "hi", ctaLabel: "Go", ctaUrl: "https://x" }] });
  assert(ok.passed);

  const noSubject = runIssueQa({ subject: "  ", sections: [{ body: "hi" }] });
  assert(!noSubject.passed);
  assert(noSubject.checks.find((c) => c.id === "subject")?.passed === false);

  const noContent = runIssueQa({ subject: "s", sections: [] });
  assert(!noContent.passed);

  const danglingCta = runIssueQa({ subject: "s", sections: [{ body: "hi", ctaLabel: "Go" }] });
  assert(!danglingCta.passed);
  assert(danglingCta.checks.find((c) => c.id === "cta_urls")?.passed === false);
});

Deno.test("nextScheduledRun returns earliest future queued issue", () => {
  const now = Date.parse("2026-06-19T00:00:00Z");
  const next = nextScheduledRun(
    [
      { status: "sent", scheduledFor: "2026-06-25T00:00:00Z" }, // ignored (sent)
      { status: "approved", scheduledFor: "2026-06-20T00:00:00Z" },
      { status: "draft", scheduledFor: "2026-06-22T00:00:00Z" },
      { status: "approved", scheduledFor: "2026-06-10T00:00:00Z" }, // past → ignored
      { status: "blocked", scheduledFor: "2026-06-19T06:00:00Z" }, // ignored (blocked)
    ],
    now,
  );
  assertEquals(next, "2026-06-20T00:00:00.000Z");
});

Deno.test("nextScheduledRun null when nothing queued", () => {
  const now = Date.parse("2026-06-19T00:00:00Z");
  assertEquals(nextScheduledRun([{ status: "sent", scheduledFor: "2026-07-01T00:00:00Z" }], now), null);
  assertEquals(nextScheduledRun([{ status: "draft", scheduledFor: null }], now), null);
});
