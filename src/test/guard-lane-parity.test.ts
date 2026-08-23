import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Every scripts/check-*.mjs gate runs in BOTH `npm run verify` and CI.
//
// THE FAILURE THIS PREVENTS HAPPENED THE DAY IT WAS WRITTEN, in the other
// direction from the one anyone guards against. check-ios-orphans.mjs ran in
// both — and passed here while failing in CI, because its comment stripper is a
// no-op on CRLF and this tree's ios/ is CRLF. Thirty-two commits went up on a
// green local run and the build went red (US-2794 has that story).
//
// This file cannot catch that one. What it catches is the cheaper, commoner
// version: a NEW gate wired into one place and not the other. A gate only CI
// runs fails after the push instead of before it, and a gate only verify runs
// is a gate the merge does not have to satisfy. src/test/ios-guard-lane.test.ts
// makes the same assertion for the Python guards under ios/Scripts; this is the
// Node half, and four gates were added in one afternoon without either.
//
// KEYED ON THE FILENAME APPEARING SOMEWHERE, not on parsing the invocation.
// Deliberately crude: verify.mjs calls them through `run("label", "node
// scripts/x.mjs")` and the workflows through `run:` blocks, sometimes several,
// and a parser for both would be more likely to break than the thing it checks.
// A mention is enough to prove somebody wired it up; whether it is wired
// CORRECTLY is what the gate's own tests are for.

const ROOT = process.cwd();
const SCRIPTS = resolve(ROOT, "scripts");
const VERIFY = resolve(ROOT, "scripts/verify.mjs");
const WORKFLOWS = resolve(ROOT, ".github/workflows");

/**
 * Gates that are NOT lane checks, with the reason.
 *
 * Shrink-only in spirit: an entry that starts appearing in both fails, because
 * an excuse that has outlived its reason starts covering whatever next takes
 * that filename.
 */
const NOT_A_LANE_CHECK: Record<string, string> = {
  "check-close-claims.mjs":
    "a commit-msg HOOK (.githooks/commit-msg), not a lane check. It reads the " +
    "message being written, which neither verify nor CI has.",
  "check-ui-browser.mjs":
    "NOT A GATE, DECIDED. US-2833 AC1 was answered by the owner on 2026-08-23: " +
    "keep it as a tool that is run deliberately, out of verify and out of CI. " +
    "It drives a real browser over nine LIVE pages, so it is slower and flakier " +
    "than reading files and needs a URL that is up. The deciding fact is that " +
    "it reports counts it cannot LOCATE - the tool gives nested-cards no " +
    "selector, no line and the snippet 'Card inside card', and a reconstruction " +
    "from the rendered HTML disagreed with it in both directions, so it is not " +
    "even a superset to filter. Production carries 32 findings that can only be " +
    "triaged by opening the pages, so gating on it would redden every push " +
    "against a backlog nobody can work from the output. Run it with " +
    "`node scripts/check-ui-browser.mjs` when you are changing one of those " +
    "pages; `--enforce` makes it fail if you want that locally.",
};

function guards(): string[] {
  return readdirSync(SCRIPTS)
    .filter((f) => f.startsWith("check-") && f.endsWith(".mjs"))
    .filter((f) => !f.endsWith(".test.mjs"));
}

const workflowText = readdirSync(WORKFLOWS)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => readFileSync(join(WORKFLOWS, f), "utf8"))
  .join("\n");

describe("every check-*.mjs gate runs in both places", () => {
  const all = guards();

  it("finds a real set of gates", () => {
    // Guards the guard: an empty list makes every assertion below vacuous, and
    // a rename of the check- prefix would empty it silently.
    expect(all.length).toBeGreaterThanOrEqual(8);
    expect(all).toContain("check-ui-antipatterns.mjs");
  });

  it("each one is invoked by scripts/verify.mjs", () => {
    const verify = readFileSync(VERIFY, "utf8");
    const missing = all.filter((g) => !NOT_A_LANE_CHECK[g] && !verify.includes(g));
    expect(
      missing,
      `these are in scripts/ and not in the verify lanes: ${missing.join(", ")}. ` +
        `A gate only CI runs fails AFTER the push instead of before it. Add it ` +
        `to verify.mjs, or to NOT_A_LANE_CHECK with the reason it is not one.`,
    ).toEqual([]);
  });

  it("each one is invoked by a workflow", () => {
    const missing = all.filter((g) => !NOT_A_LANE_CHECK[g] && !workflowText.includes(g));
    expect(
      missing,
      `these run locally and in no workflow: ${missing.join(", ")}. A gate the ` +
        `merge does not have to satisfy is a gate whoever skips the hook does ` +
        `not have to satisfy either.`,
    ).toEqual([]);
  });

  it("the exemptions still describe something true", () => {
    // The other direction, and the one that rots: an entry excusing a gate that
    // has since been wired into both is an excuse with nothing behind it.
    const verify = readFileSync(VERIFY, "utf8");
    for (const [g, why] of Object.entries(NOT_A_LANE_CHECK)) {
      expect(all, `${g} is exempted but no longer exists`).toContain(g);
      // EITHER, not both. The exemption claims the gate is not a lane check AT
      // ALL, so one appearance already falsifies it — and a gate wired into
      // verify alone is precisely the half-state this file exists to reject.
      // The first version of this assertion required BOTH, which let a sabotage
      // adding it to verify only pass unnoticed.
      expect(
        verify.includes(g) || workflowText.includes(g),
        `${g} now runs in a lane — drop its exemption. It said: ${why}`,
      ).toBe(false);
    }
  });
});
