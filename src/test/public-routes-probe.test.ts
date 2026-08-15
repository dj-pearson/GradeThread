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
