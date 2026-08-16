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
import { inertLocalGates, LOCAL_GATES, onPath } from "./lib/inert-gates.mjs";

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
