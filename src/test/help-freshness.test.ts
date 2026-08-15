import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  renderHelpFeedback,
  renderUpdatedLine,
} from "../../functions/_shared/help-render";

// US-2591: does anybody still stand behind this article, and did it work?
//
// The two failures this guards are both silent. A stale article looks exactly
// like a fresh one, and a feedback widget that only works with JavaScript
// collects nothing from the readers least able to get an answer another way.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("the feedback widget", () => {
  it("is a plain HTML form with no JavaScript in it", () => {
    const html = renderHelpFeedback("your-first-grade", "getting-started", false);
    expect(html).toContain('action="/help/feedback"');
    expect(html).toContain('method="post"');
    expect(html).not.toMatch(/onclick|onsubmit|<script/i);
  });

  it("carries the slug and category so the redirect target is not a parameter", () => {
    // An open redirect on a form that appears on every public article is a
    // phishing primitive. The return URL is rebuilt from these two fields.
    const html = renderHelpFeedback("your-first-grade", "getting-started", false);
    expect(html).toContain('name="slug" value="your-first-grade"');
    expect(html).toContain('name="category" value="getting-started"');
  });

  it("offers both answers and an optional comment", () => {
    const html = renderHelpFeedback("x", "y", false);
    expect(html).toContain('value="yes"');
    expect(html).toContain('value="no"');
    expect(html).toContain("<textarea");
  });

  it("thanks them instead of asking again", () => {
    const html = renderHelpFeedback("x", "y", true);
    expect(html).toContain("Thanks");
    expect(html).not.toContain("<form");
  });

  it("escapes the slug into the hidden fields", () => {
    expect(renderHelpFeedback('"><script>x</script>', "y", false)).not.toContain("<script>x");
  });
});

describe("the ?thanks=1 render skips the edge cache", () => {
  it("because the cache key ignores the query string", () => {
    // Same trap as /help/search. Without this, one reader's thank-you would be
    // cached under the plain article URL and shown to everybody after them.
    const src = read("functions/help/[[path]].ts");
    const entry = src.slice(
      src.indexOf("export const onRequestGet"),
      src.indexOf("async function routeHelp"),
    );
    expect(entry).toContain('thanks');
    expect(entry).toContain("return routeHelp(context)");
  });
});

describe("the no-JS form target", () => {
  const src = read("functions/help/feedback.ts");

  it("rebuilds the return URL from validated fields, never from a parameter", () => {
    expect(src).toContain("/^[a-z0-9-]{1,80}$/.test(slug)");
    expect(src).toContain("/^[a-z0-9-]{1,80}$/.test(categorySlug)");
    expect(src).not.toMatch(/form\.get\(["']redirect/);
    expect(src).not.toMatch(/form\.get\(["']return/);
  });

  it("forwards to the anonymous endpoint only", () => {
    const calls = [...src.matchAll(/["'`][^"'`]*(\/api\/[^"'`]*)["'`]/g)].map((m) => m[1]!);
    expect(calls.length).toBeGreaterThan(0);
    for (const p of calls) expect(p.startsWith("/api/content/public/help")).toBe(true);
  });

  it("never fails loudly", () => {
    // Somebody was being helpful. An error page is a worse outcome than a lost
    // vote.
    expect(src).toContain("console.warn");
    expect(src).toContain("303");
  });
});

describe("updated is not the same as reviewed", () => {
  it("shows Updated when the article changed after publishing", () => {
    expect(
      renderUpdatedLine({
        published_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-08-10T00:00:00.000Z",
      }),
    ).toContain("Updated");
  });

  it("says nothing for a same-day edit to a fresh article", () => {
    // Editing an article the day it publishes is part of publishing it.
    expect(
      renderUpdatedLine({
        published_at: "2026-08-10T00:00:00.000Z",
        updated_at: "2026-08-10T09:00:00.000Z",
      }),
    ).toBe("");
  });

  it("says nothing when it was never published", () => {
    expect(renderUpdatedLine({ published_at: null, updated_at: "2026-08-10T00:00:00.000Z" })).toBe("");
  });

  it("the article page renders both lines", () => {
    // Reviewed means somebody re-read it and stands by it. Updated means the
    // words changed. Showing only one makes a corrected article and a
    // re-checked one indistinguishable.
    const src = read("functions/help/[[path]].ts");
    expect(src).toContain("renderReviewedLine(article)");
    expect(src).toContain("renderUpdatedLine(article)");
  });
});

describe("staleness flags, never hides", () => {
  const sql = read("supabase/migrations/00605_help_feedback_and_freshness.sql");

  it("is a view, not a stored flag", () => {
    // Staleness depends on now(), so a stored boolean is wrong within a day.
    expect(sql).toContain("create or replace view public.help_articles_stale");
    expect(sql).toContain("security_invoker = true");
  });

  it("nothing unpublishes or de-sitemaps a stale article", () => {
    // A page that vanishes for want of a review is worse than one slightly out
    // of date, and dropping URLs silently is how a section loses its ranking.
    expect(read("functions/_shared/sitemap.ts")).not.toContain("is_stale");
    expect(read("services/edge-functions/src/routes/help-center.ts")).not.toMatch(
      /is_stale[\s\S]{0,200}status/,
    );
  });

  it("feedback is recorded against the content version the reader saw", () => {
    // So a rewrite starts a clean record rather than inheriting old votes.
    expect(sql).toContain("content_version");
    expect(sql).toContain("bump_help_content_version");
    expect(read("services/edge-functions/src/routes/help-center.ts")).toContain(
      "content_version:",
    );
  });

  it("the version bumps on a body change only", () => {
    // Re-saving to fix a sort order must not reset the feedback history.
    expect(sql).toContain("if new.body_html is distinct from old.body_html then");
  });

  it("help_feedback is deny-all and classified", () => {
    expect(sql).toContain("alter table public.help_feedback enable row level security");
    expect(sql).not.toMatch(/create policy[^;]*help_feedback/);
    expect(read("services/edge-functions/src/tests/rls-guard_test.ts")).toContain(
      '"help_feedback"',
    );
  });
});

describe("screenshots carry the date they describe", () => {
  it("every marker is stamped, so a UI change can find the stale ones", () => {
    const dir = join(root, "content/help");
    const markers = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .flatMap((f) => [...readFileSync(join(dir, f), "utf8").matchAll(/<!--\s*SCREENSHOT:\s*(.+?)\s*-->/g)]
        .map((m) => ({ file: f, text: m[1]! })));
    expect(markers.length).toBeGreaterThan(0);
    for (const m of markers) {
      expect(m.text, `${m.file}: ${m.text}`).toMatch(/\(as of \d{4}-\d{2}-\d{2}\)$/);
    }
  });
});
