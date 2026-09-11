// US-3409: a failed automatic capture has to reach the seller and reach Sentry.
//
// The old code was `if (!wb.ok) return;` on the AUTOMATIC path. A test that
// asserts the check exists would have PASSED against that line, which is why
// every case below drives a real non-2xx through the real writeback function
// and then renders the real component the panel renders, rather than grepping
// for a string.
//
// The one thing that cannot be driven here is the panel itself: PlatformPanel is
// built on useQueryClient, supabase and six hooks, and this repo deliberately
// carries no @testing-library/react (see the note in vitest.config.ts). So the
// two halves the panel composes are driven for real and the COMPOSITION is read
// off the source, the same split photos-witness.test.tsx uses and with the same
// honesty about what a green here means.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ListingCaptureNotice } from "@/components/flipdesk/listing-kit";
import {
  CAPTURE_MAX_ATTEMPTS,
  recordExtensionCapture,
} from "@/lib/extension-capture";

const KIT = "src/components/flipdesk/listing-kit.tsx";

/** An edge answer, in the shape edgeFetch hands back. */
const answer = (status: number, body: Record<string, unknown> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/**
 * The writeback endpoint, scripted. Each call takes the next entry; a `null`
 * entry throws, which is what a dead connection looks like from edgeFetch.
 */
function scripted(answers: Array<Response | null>) {
  const calls: Array<{ path: string; body: unknown }> = [];
  let i = 0;
  const post = vi.fn(async (path: string, opts?: { json?: unknown }) => {
    calls.push({ path, body: opts?.json });
    const next = answers[Math.min(i, answers.length - 1)];
    i++;
    if (next === null || next === undefined) throw new Error("network down");
    // A Response body can be read once. Handing the same object back three
    // times made attempt 3 see an empty body and lose the error code, which is
    // a fake failure the retry path would never produce against a real edge.
    return next.clone();
  });
  return { post, calls };
}

/**
 * What the panel does, in the order the panel does it: run the capture, and if
 * it failed, render the notice. A recorded capture renders nothing — that is
 * the "surface changes" this story is about, and it is asserted in both
 * directions below.
 */
async function surfaceFor(answers: Array<Response | null>, report = vi.fn()) {
  const { post, calls } = scripted(answers);
  const outcome = await recordExtensionCapture({
    itemId: "11111111-2222-3333-4444-555555555555",
    platform: "poshmark",
    listingUrl: "https://poshmark.com/listing/abc123",
    post: post as never,
    sleep: async () => {},
    report: report as never,
  });
  const html =
    outcome.kind === "failed"
      ? renderToStaticMarkup(
          <ListingCaptureNotice
            platformLabel="Poshmark"
            failure={outcome}
            retrying={false}
            onRetry={() => {}}
          />,
        )
      : "";
  return { outcome, html, post, calls, report };
}

describe("US-3409 AC4: a non-2xx writeback changes what the seller sees", () => {
  it("a 200 leaves the panel silent", async () => {
    const { outcome, html, post } = await surfaceFor([answer(200, { ok: true })]);
    expect(outcome).toEqual({ kind: "recorded", attempts: 1 });
    expect(html).toBe("");
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("THE BIG ONE: a 500 puts a message on screen where there used to be none", async () => {
    const { outcome, html } = await surfaceFor([
      answer(500, { error: "Could not record the cross-listing.", code: "WRITEBACK_INSERT" }),
    ]);
    expect(outcome.kind).toBe("failed");
    // Not empty, which is exactly what `if (!wb.ok) return;` produced.
    expect(html).not.toBe("");
    expect(html).toContain("Your Poshmark listing is live. FlipDesk could not record it.");
    // The ref a support ticket quotes, which only existed in a container log.
    expect(html).toContain("WRITEBACK_INSERT");
  });

  it("the wording matches what the seller can actually do", async () => {
    const { html } = await surfaceFor([answer(500, { code: "WRITEBACK_INSERT" })]);
    // The listing is live. Telling them to post it again is the one instruction
    // that makes this worse, and a duplicate listing costs real money.
    expect(html).toContain("you do not need to post it again");
    // The ONLY time reposting is mentioned is to rule it out. Two mentions
    // would mean the notice both forbids and implies it.
    expect(html.match(/post it again/gi) ?? []).toHaveLength(1);
    expect(html).not.toMatch(/list it again|try listing/i);
    // It says what is lost, so "record it" is not busywork.
    expect(html).toContain("will not show this item as live");
    expect(html).toContain("when the item sells");
    // And it carries the button that fixes it.
    expect(html).toContain("Record it again");
    expect(html).toContain("Record the Poshmark listing in FlipDesk again");
  });

  it("it is not an alarm, because nothing the seller made is broken", async () => {
    const { html } = await surfaceFor([answer(500, { code: "WRITEBACK_INSERT" })]);
    // The repo's red. Reserved for "your thing is wrong"; this one is ours.
    expect(html).not.toContain("text-brand-red-text");
    expect(html).not.toContain("bg-brand-red");
    // shadcn's Button ships `aria-invalid:*-destructive` in its base classes,
    // so the assertion is on the VARIANT this notice chose, not on the word.
    expect(html).not.toContain('data-variant="destructive"');
    // It reassures BEFORE it reports, in that order.
    const safe = html.indexOf("Nothing is wrong with the listing itself");
    expect(safe).toBeGreaterThan(-1);
    expect(safe).toBeLessThan(html.indexOf("Record it again"));
  });

  it("it stays on screen rather than being announced and lost", async () => {
    const { html } = await surfaceFor([answer(500)]);
    // A toast would be gone before the seller finishes on the marketplace tab.
    // This is panel markup, and it names itself to a screen reader.
    expect(html).toContain('role="status"');
  });
});

describe("US-3409: what gets retried, and what does not", () => {
  it("a 5xx is tried three times before the seller hears about it", async () => {
    const { outcome, post } = await surfaceFor([answer(503), answer(503), answer(503)]);
    expect(post).toHaveBeenCalledTimes(CAPTURE_MAX_ATTEMPTS);
    expect(outcome).toMatchObject({ kind: "failed", attempts: 3, status: 503 });
  });

  it("a transient 500 that clears is never shown at all", async () => {
    const { outcome, html, post } = await surfaceFor([answer(500), answer(200)]);
    expect(post).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ kind: "recorded", attempts: 2 });
    expect(html).toBe("");
  });

  it("a 4xx is NOT retried — the same bytes get the same answer", async () => {
    const { outcome, post } = await surfaceFor([answer(422, { code: "BAD_PLATFORM" })]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ kind: "failed", attempts: 1, status: 422, ref: "BAD_PLATFORM" });
  });

  it("a 429 is not retried either, because hammering a limiter is not a fix", async () => {
    const { post } = await surfaceFor([answer(429)]);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("a dead connection is retried and then reported as no answer", async () => {
    const { outcome, html, post } = await surfaceFor([null, null, null]);
    expect(post).toHaveBeenCalledTimes(CAPTURE_MAX_ATTEMPTS);
    expect(outcome).toMatchObject({ kind: "failed", status: null, ref: "no answer" });
    expect(html).toContain("no answer");
  });

  it("every attempt sends the captured URL, not a blank confirmation", async () => {
    const { calls } = await surfaceFor([answer(500), answer(500), answer(500)]);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.path).toBe("/api/flipdesk/listings/extension-writeback");
      expect(c.body).toMatchObject({
        platform: "poshmark",
        published: true,
        listing_url: "https://poshmark.com/listing/abc123",
      });
    }
  });
});

describe("US-3409 AC2: the failure reaches Sentry", () => {
  it("reports once, with the ref and the platform", async () => {
    const report = vi.fn();
    await surfaceFor([answer(500, { code: "WRITEBACK_INSERT" })], report);
    expect(report).toHaveBeenCalledTimes(1);
    const [err, ctx] = report.mock.calls[0] as [
      Error,
      { tags: Record<string, string>; extra: Record<string, unknown> },
    ];
    expect(String(err)).toContain("WRITEBACK_INSERT");
    expect(ctx.tags.surface).toBe("flipdesk.extension-capture");
    expect(ctx.tags.capture_ref).toBe("WRITEBACK_INSERT");
    expect(ctx.extra.platform).toBe("poshmark");
    expect(ctx.extra.status).toBe(500);
    expect(ctx.extra.attempts).toBe(3);
  });

  it("a recorded capture reports nothing", async () => {
    const report = vi.fn();
    await surfaceFor([answer(200)], report);
    expect(report).not.toHaveBeenCalled();
  });

  it("the real reporter is this repo's lazy Sentry facade, not a third way", () => {
    const src = readFileSync("src/lib/extension-capture.ts", "utf8");
    expect(src).toContain('import { captureException } from "@/lib/sentry"');
    // Not a console.log, which is the Coolify container log the story is about.
    expect(src).not.toMatch(/console\.(log|error|warn)\(/);
  });
});

describe("US-3409: the panel composes the two halves", () => {
  // THE WEAKER CHECK, here because the strong one is unavailable (see the file
  // header). Everything this catches is a deletion. A green here means the call
  // site exists, not that it ran.
  const src = readFileSync(KIT, "utf8");

  it("the automatic path goes through recordExtensionCapture", () => {
    expect(src).toContain("recordExtensionCapture({");
    expect(src).toContain("void runCapture(e.listingUrl);");
  });

  it("the bare early return is gone from the automatic path", () => {
    expect(src).not.toContain("if (!wb.ok) return;");
  });

  it("a failure sets the state the notice renders from", () => {
    expect(src).toContain("setCaptureFailure({ failure: outcome, listingUrl });");
    expect(src).toContain("<ListingCaptureNotice");
    // And the manual fallback is made reachable, because a failed INSERT leaves
    // the server with no row to derive a "prefilled" status from.
    expect(src).toContain("setPrefilled(true);");
  });

  it("the retry sends the captured URL", () => {
    expect(src).toContain("void runCapture(pending.listingUrl)");
  });
});

// ── AC3: every other bare `if (!x.ok) return;` in src/ ──────────────────────
//
// This one was found by accident while reading a different story, so the list
// is derived rather than eyeballed. Fixing them is out of scope; NAMING them is
// the deliverable, and pinning the list means the next one has to be named too.
//
// Two shapes, because they fail differently:
//   TIER 1  `return;`            — an action silently does nothing.
//   TIER 2  `return null/[]/{}`  — a read silently becomes empty, which usually
//                                 renders as "you have none of these".
// Pinned by FILE and count, not by line, so an unrelated edit above one of them
// does not fail this.

// The braced and unbraced forms are separate alternatives, NOT one optional
// `{` with one optional `}`. The optional-pair version had a hole this story's
// own sabotage found: `if (!res.ok) return;` as the LAST statement of a block
// let the trailing `}` group swallow the block's closing brace, so the pair
// looked mismatched and the offender was skipped. A scanner that silently
// misses a shape reads exactly like a clean codebase.
const VALUE = String.raw`(\s+(?:null|undefined|false|\[\]|\{\}(?:\s+as\s+[^;]+)?))?`;
const OK_CHECK = new RegExp(
  String.raw`if\s*\(\s*!\s*([A-Za-z_$][\w$]*)\s*\.ok\s*\)\s*` +
    String.raw`(?:\{\s*return${VALUE}\s*;\s*\}|return${VALUE}\s*;)`,
  "g",
);

/** The returned expression, whichever of the two alternatives matched. */
const returnedValue = (m: RegExpMatchArray) => ((m[2] ?? m[3]) ?? "").trim();

/**
 * Comments out, code in. A file that DOCUMENTS the shape (this repo's notes
 * quote it constantly, including in the two files this story touched) must not
 * read as an offender. Only whole-line `//` comments and block comments are
 * removed, so a `//` inside a string literal — a URL — is never touched.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

function srcFiles(dir = "src"): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...srcFiles(p));
    else if (/\.tsx?$/.test(p)) out.push(p.replace(/\\/g, "/"));
  }
  return out;
}

const isTestFile = (f: string) =>
  f.startsWith("src/test/") || f.includes("__tests__/") || /\.(test|spec)\.tsx?$/.test(f);

function bareOkReturns() {
  const tier1: string[] = [];
  const tier2: string[] = [];
  for (const f of srcFiles()) {
    if (isTestFile(f)) continue; // string fixtures, not live code
    for (const m of stripComments(readFileSync(f, "utf8")).matchAll(OK_CHECK)) {
      (returnedValue(m) === "" ? tier1 : tier2).push(f);
    }
  }
  const tally = (xs: string[]) =>
    Object.fromEntries(
      [...new Set(xs)].sort().map((f) => [f, xs.filter((x) => x === f).length]),
    );
  return { tier1: tally(tier1), tier2: tally(tier2) };
}

describe("US-3409 AC3: the rest of the bare `if (!res.ok) return` family", () => {
  it("TIER 1 — an action that silently does nothing: 5 left, all named", () => {
    // listing-kit.tsx is absent from this list because THIS story fixed it.
    expect(bareOkReturns().tier1).toEqual({
      // A measurement-overlay rebuild that did not happen: the caches are left
      // alone, which is correct, and nobody is told the overlay is stale.
      "src/components/flipdesk/measurement-photo-editor.tsx": 1,
      // The description blocks never load; the editor shows an empty preview.
      "src/hooks/use-description-blocks.ts": 1,
      // The suggested eBay ad rate never seeds. Cosmetic, and the seller has
      // their own box.
      "src/pages/flipdesk/composer.tsx": 1,
      // The import poller stops updating; the run looks stuck at "running".
      "src/pages/flipdesk/import.tsx": 1,
      // A retake's reusable photo is dropped from the seeded slots. A raw
      // fetch of a signed URL, not edgeFetch.
      "src/pages/new-submission.tsx": 1,
    });
  });

  it("TIER 2 — a read that silently becomes empty: 19 of them", () => {
    const tier2 = bareOkReturns().tier2;
    expect(tier2).toEqual({
      "src/components/flipdesk/inventory-equity-card.tsx": 1,
      // The kit's own second one, deliberately left: a per-platform field map
      // that falls back to empty is the same as "not generated yet".
      "src/components/flipdesk/listing-kit.tsx": 1,
      "src/hooks/use-condition-index.ts": 1,
      "src/hooks/use-description-blocks.ts": 2,
      "src/hooks/use-ebay.ts": 5,
      "src/hooks/use-grade-ranges.ts": 1,
      "src/hooks/use-grade-turnaround.ts": 1,
      "src/hooks/use-title-conflicts.ts": 1,
      "src/hooks/use-waitlist-gating.ts": 1,
      "src/lib/cloud-folder-import.ts": 1,
      "src/lib/extension-token-handoff.ts": 1,
      "src/lib/impact.ts": 1,
      "src/lib/web-push-client.ts": 1,
      "src/pages/admin/audit-log.tsx": 1,
    });
    expect(Object.values(tier2).reduce((a, b) => a + b, 0)).toBe(19);
  });

  it("the scanner finds the shape it is looking for", () => {
    // The guard's own guard. A regex that matches nothing reads exactly like a
    // clean codebase, which is how a rule gets disarmed by a rename.
    const sample = [
      "if (!res.ok) return;",
      "if (!wb.ok) { return; }",
      "if (!res.ok) return null;",
      // The one the first draft of this regex missed: last statement in a
      // block, so the closing brace belongs to the FUNCTION.
      "function f() {\n  if (!upload.ok) return;\n}",
      'if (!res.ok) { toast.error("x"); return; }',
      'if (!res.ok) throw new Error("x");',
      "if (!res.ok) return await other();",
    ].join("\n");
    const found = [...sample.matchAll(OK_CHECK)];
    // Four: the three bare ones plus the `return null`. A handled branch, a
    // throw and a real return value are not this shape.
    expect(found).toHaveLength(4);
    expect(found.filter((m) => returnedValue(m) === "")).toHaveLength(3);
    expect(found.map((m) => m[1])).toContain("upload");
  });

  it("the comment stripper is not a no-op, on LF and on CRLF", () => {
    // The failure mode this repo has already been bitten by: a stripper that
    // quietly does nothing, and a guard that therefore passes for the wrong
    // reason. Both line endings, because that is how it did nothing last time.
    for (const nl of ["\n", "\r\n"]) {
      const src = [
        "// if (!res.ok) return;",
        "/* if (!res.ok) return null; */",
        "if (!res.ok) return;",
      ].join(nl);
      expect([...stripComments(src).matchAll(OK_CHECK)]).toHaveLength(1);
      expect([...src.matchAll(OK_CHECK)]).toHaveLength(3);
    }
    // And it leaves a `//` that is part of a string alone.
    expect(stripComments('const u = "https://x.test/a";')).toContain("https://x.test/a");
  });
});
