// US-2611: the production route probe, and the two things about it that are
// easy to get wrong later.
//
// The probe itself talks to production, so it cannot run here. What CAN be
// checked offline is the wiring, and the wiring is where this kind of check
// dies: pointed at a pull request it fails on correct unshipped code, and
// parsed with a regex that stops matching it reports a healthy zero routes.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const SCRIPT = "scripts/probe-public-routes.mjs";
const WORKFLOW = ".github/workflows/public-routes.yml";

describe("US-2611: the probe cannot silently check nothing", () => {
  it("asserts a floor on the number of routes it parsed", () => {
    // The registry is TypeScript and this reads it with a regex. A regex that
    // stops matching returns an empty list, every URL in it passes trivially,
    // and the job goes green while checking nothing — the exact shape of
    // failure that makes a guard worse than no guard.
    const src = read(SCRIPT);
    expect(src).toContain("MIN_EXPECTED_ROUTES");
    expect(src).toMatch(/parser\s*\n?\s*\*?\s*broke|parser ` \+\n\s*`broke|the parser \+?\s*`?broke/i);
  });

  it("exits non-zero on a failure, so the schedule can actually fail", () => {
    const src = read(SCRIPT);
    expect(src).toContain("process.exitCode = 1");
  });

  it("checks the junk path too, not only the routes that should exist", () => {
    // Half the deploy runbook's diagnostic. A catch-all that stopped returning
    // 404 means every typo serves the app shell and Google indexes soft-404s —
    // and nothing else in the repo would notice.
    const src = read(SCRIPT);
    expect(src).toContain("JUNK");
    expect(src).toMatch(/must 404/);
  });
});

describe("US-2611: it runs against a deploy, never against a pull request", () => {
  const wf = read(WORKFLOW);

  it("is scheduled and manually dispatchable", () => {
    expect(wf).toMatch(/^on:/m);
    expect(wf).toContain("schedule:");
    expect(wf).toContain("workflow_dispatch:");
  });

  it("has no pull_request or push trigger", () => {
    // THE LOAD-BEARING ASSERTION. On a PR this fails for code that is correct
    // and simply not shipped yet — a red check the author cannot fix, which is
    // how a guard gets switched off. US-1927's notes record exactly that
    // happening, and db-denied-rpc-crash-check.mjs is advisory for the same
    // reason.
    expect(wf).not.toMatch(/^\s*pull_request:/m);
    expect(wf).not.toMatch(/^\s*push:/m);
  });

  it("checks out the registry, not just the script", () => {
    // The script reads src/lib/seo/public-routes.ts. A sparse checkout of
    // scripts/ alone would make it throw on a missing file — which reads as a
    // broken probe rather than a broken deploy.
    expect(wf).toContain("src/lib/seo");
  });
});

describe("US-2618: an index that links to nothing", () => {
  const src = read(SCRIPT);

  it("checks that /help and /blog actually link to their content", () => {
    // A status code cannot see this. /help served 200 at 15KB with zero article
    // links while 83 written articles sat in content/help/ and the loader was
    // wired to nothing. Every check we had said the page was fine.
    expect(src).toContain("mustLink");
    // Substring rather than a regex-of-a-regex: escaping a pattern that is
    // itself a pattern is how this assertion stops meaning anything.
    expect(src).toContain('mustLink: /href="\\/help\\/[^"]+"/');
    expect(src).toContain('mustLink: /href="\\/blog\\/[^"]+"/');
  });

  it("keeps known-empty indexes as a named, shrink-only exception", () => {
    // Reported rather than failed, because the condition is true today and a
    // check that is red on the day it ships gets ignored before it earns any
    // authority. The entry has to name the work that removes it.
    expect(src).toContain("KNOWN_EMPTY_INDEXES");
    expect(src).toContain("SHRINK-ONLY");
    expect(src).toMatch(/US-2618/);
    expect(src).toMatch(/help:seed/);
  });

  it("prints known gaps before the verdict, not only on a green run", () => {
    // A gap that shows up only when everything else passes is invisible on
    // exactly the runs where it is the whole story.
    const printOrder = src.indexOf("known gap(s), reported not failed");
    const verdict = src.indexOf("all clear —");
    expect(printOrder).toBeGreaterThan(0);
    expect(printOrder).toBeLessThan(verdict);
  });
});

describe("US-2619: an OG image that is 200 but not a render", () => {
  const src = read(SCRIPT);

  it("rejects a zero-byte image", () => {
    // /og/social/card returns 200, image/png, and nothing. workers-og streams,
    // so the raster fails after the Response is built — the endpoint's own
    // try/catch never fires and its branded fallback never runs.
    expect(src).toContain("OG_MIN_BYTES");
    expect(src).toMatch(/a blank preview/);
  });

  it("rejects the branded fallback masquerading as a render", () => {
    // The sharper half. /og/help and /og/verified both returned 133915 bytes —
    // byte-for-byte /og-image.png — and read as perfectly healthy. Comparing
    // against the fallback's own measured size is the only way to tell, and it
    // is measured at run time rather than hardcoded, so the check survives a
    // new fallback image.
    expect(src).toContain("OG_FALLBACK_PATH");
    expect(src).toMatch(/byte-identical to \$\{OG_FALLBACK_PATH\}/);
    expect(src).toContain("fallbackBytes");
  });

  it("keeps a working renderer in the list, not only the broken one", () => {
    // Guard-the-guard: a list containing only known-broken entries would pass
    // forever on its exceptions and never prove the check can see a good render.
    expect(src).toContain('"/og/grade-check"');
  });
});

describe("US-2619: the fallback announces itself", () => {
  const src = read(SCRIPT);

  it("trusts the X-GT-Fallback header over a byte comparison", () => {
    // brandedFallbackResponse sets it, so the endpoint says outright that its
    // render threw. Better than the size check in three ways: explicit, it
    // survives replacing the fallback image, and it tells the branded card apart
    // from the transparent pixel. The size check stays as a backstop for a
    // response that serves those bytes without going through the helper.
    expect(src).toContain("x-gt-fallback");
    expect(src).toMatch(/the fallback fired, so the render threw/);
  });

  it("probes a REAL verified handle, not a made-up one", () => {
    // /og/verified/nobody takes the not-found branch and serves the fallback for
    // a completely different reason — which is exactly how that endpoint read as
    // healthy while its render had never once succeeded.
    expect(src).toContain('path: "/og/verified/pearson"');
    // Anchored to the USAGE, not the file. A bare substring check also matched
    // the comment right above it explaining why the made-up handle is wrong,
    // which would have made this assertion permanently unsatisfiable.
    expect(src).not.toMatch(/path:\s*"\/og\/verified\/nobody"/);
  });
});
