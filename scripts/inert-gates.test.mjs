// US-2655: the summary must name a local gate that is running and doing nothing.
//
// THE CASE THAT PROMPTED IT. `.githooks/pre-commit` scans staged changes with
// gitleaks, and when gitleaks is absent it prints three lines and exits 0. Those
// three lines land inside the commit output and scroll past. An entire session
// of commits went out with no local secret scan, and no summary anywhere said
// so — the hook reported success every time, truthfully, about a scan it never
// ran.
//
// Not a failure: CI runs the scan on push and again weekly over full history, so
// nothing is unguarded. What is lost is the LOCAL catch, the one that saves you
// before the thing leaves the machine. Worth a line; not worth failing a run.
//
// The lookup is INJECTED in these cases on purpose. A test that asked the real
// PATH would assert whatever happens to be installed on the machine running it,
// which is the very thing the check exists to vary — it would pass on a laptop
// with gitleaks and fail on one without, teaching nobody anything.

import { describe, expect, it } from "vitest";
import {
  inertLocalGates,
  inertRepoGates,
  isShallowClone,
  LOCAL_GATES,
  onPath,
} from "./lib/inert-gates.mjs";

const has = (...installed) => (tool) => installed.includes(tool);

describe("US-2655: verify reports local gates whose tool is missing", () => {
  it("names the gate and what stops working, not just the tool", () => {
    const [line] = inertLocalGates(has("trivy"));
    expect(line).toMatch(/^gitleaks not installed/);
    // "gitleaks is missing" is a fact about a laptop. "the pre-commit secret
    // scan exits 0 without it" is the consequence, and the consequence is the
    // part that makes someone act.
    expect(line).toMatch(/pre-commit secret scan/);
    expect(line).toMatch(/exits 0/);
  });

  it("says nothing when every tool is present", () => {
    expect(inertLocalGates(has(...LOCAL_GATES.map(([t]) => t)))).toEqual([]);
  });

  it("reports every missing tool, not just the first", () => {
    expect(inertLocalGates(() => false)).toHaveLength(LOCAL_GATES.length);
  });

  it("covers the two tools this repo's own docs tell you to install", () => {
    // CLAUDE.md: "gitleaks + trivy via scoop install gitleaks trivy". Both back
    // a gate that silently degrades, which is why they are the two listed.
    expect(LOCAL_GATES.map(([t]) => t).sort()).toEqual(["gitleaks", "trivy"]);
  });

  it("guard-the-guard: the real lookup answers a definite boolean", () => {
    // Every case above injects, so a broken onPath would go unnoticed. This one
    // exercises it for real — on a tool that certainly exists (node itself) and
    // one that certainly does not.
    expect(onPath("node")).toBe(true);
    expect(onPath("a-tool-that-does-not-exist-anywhere")).toBe(false);
  });
});

// US-2965: the second way a gate goes inert — the CLONE, not a missing tool.
//
// The vault drift check compares a note's `reviewed` date against the commits
// that touched its `code_refs`, which needs per-file git history. A shallow
// clone has none, so vault-lint prints one warning and checks nothing while the
// lane around it reports a green tick. That is not hypothetical: a whole session
// of `npm run verify` passed the vault lane in a shallow clone while four
// contract notes drifted, and the red only appeared in CI, which uses
// fetch-depth 0.
describe("US-2965: verify reports a gate made inert by the clone", () => {
  it("names the consequence, not just the clone depth", () => {
    const [line] = inertRepoGates(() => true);
    // "shallow clone" is a fact about a checkout. "vault: lint passes without
    // comparing any note" is what makes someone act on it.
    expect(line).toMatch(/^shallow clone/);
    expect(line).toMatch(/vault: lint/);
    expect(line).toMatch(/without comparing/);
  });

  it("tells you how to fix it", () => {
    expect(inertRepoGates(() => true)[0]).toMatch(/git fetch --unshallow/);
  });

  it("says nothing on a full clone", () => {
    expect(inertRepoGates(() => false)).toEqual([]);
  });

  it("guard-the-guard: the real check answers a definite boolean", () => {
    // Every case above injects, so a broken isShallowClone would go unnoticed.
    expect(typeof isShallowClone()).toBe("boolean");
    expect(isShallowClone(() => "true")).toBe(true);
    // git prints "false" on a full clone, and an empty string when the command
    // fails outright — neither of which may be read as shallow, or a machine
    // without git would grow a permanent warning it cannot act on.
    expect(isShallowClone(() => "false")).toBe(false);
    expect(isShallowClone(() => "")).toBe(false);
  });
});
