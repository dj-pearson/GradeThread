import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2532. The workspace 2FA requirement is owner-managed on the web and absent
// from iOS.
//
// Reading both sides (this checkout can READ Swift; it cannot compile it) shows
// the iOS half is purely UI: GET/PUT /api/workspace/mfa-policy are
// client-agnostic and the owner-only gate is enforced SERVER-side, so a phone
// screen adds no protocol and can grant nothing the endpoint would refuse.
//
// AC3 was the part that was not merely missing but IMPOSSIBLE. It asks that a
// blocked member "sees the same explanation on iOS as on web" — while the web
// threw the server's explanation away and hardcoded its own near-duplicate, any
// iOS screen would have had to invent a third. That is fixed here, which is
// what makes AC3 satisfiable at all.

const EDGE_FETCH = "src/lib/edge-fetch.ts";
const ROLES = "services/edge-functions/src/lib/workspace-roles.ts";
const WORKSPACE_ROUTE = "services/edge-functions/src/routes/workspace.ts";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("the block explanation has ONE author (US-2532 AC3)", () => {
  it("the server writes it", () => {
    const src = read(ROLES);
    expect(src).toContain('errorCode: "workspace_mfa_required"');
    expect(src).toMatch(
      /This workspace requires two-factor authentication for your role\./,
    );
  });

  it("it reaches the client on the wire, beside the code", () => {
    // A code alone would leave every client to compose its own sentence.
    const mw = read("services/edge-functions/src/middleware/workspace.ts");
    expect(mw).toContain("{ error: decision.error, error_code: decision.errorCode }");
  });

  it("the web renders THAT, not a local copy", () => {
    const src = read(EDGE_FETCH);
    const start = src.indexOf('data.error_code === "workspace_mfa_required"');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 1400);
    expect(block).toContain(
      'typeof data.error === "string" && data.error.trim()',
    );
    expect(block).toContain("? data.error");
  });

  it("and falls back rather than showing an empty toast", () => {
    // An older edge that sends only the code must degrade to the previous
    // wording, not to nothing.
    const src = read(EDGE_FETCH);
    const start = src.indexOf('data.error_code === "workspace_mfa_required"');
    const block = src.slice(start, start + 1400);
    expect(block).toMatch(/This workspace requires 2FA for your role\./);
  });
});

describe("the policy endpoints are client-agnostic (US-2532 AC2)", () => {
  const route = () => read(WORKSPACE_ROUTE);

  it("both verbs exist", () => {
    expect(route()).toContain('workspaceRoutes.get("/mfa-policy"');
    expect(route()).toContain('workspaceRoutes.put("/mfa-policy"');
  });

  it("the owner-only gate is enforced on the SERVER", () => {
    // So an iOS screen adds no new trust boundary: it cannot grant what the
    // endpoint would refuse, and a phone that shows the control to a
    // non-owner still gets a 403.
    const src = route();
    const start = src.indexOf('workspaceRoutes.put("/mfa-policy"');
    const block = src.slice(start, src.indexOf("await writeAuditLog", start));
    expect(block).toContain('if (role !== "owner")');
    expect(block).toContain(
      "Only the workspace owner can change the MFA requirement",
    );
  });

  it("reading is admin-or-above, which is a different bar from writing", () => {
    // Worth pinning: a client that showed the READ control to admins and the
    // WRITE control to owners is correct, and one that conflated them is not.
    const src = route();
    const start = src.indexOf('workspaceRoutes.get("/mfa-policy"');
    const block = src.slice(start, src.indexOf('workspaceRoutes.put("/mfa-policy"'));
    expect(block).toContain('roleAtLeast(role, "admin")');
  });

  it("the value is validated against a fixed set", () => {
    // A native client sending a role the server does not know must get a 400,
    // never a silently-stored value.
    expect(route()).toContain("MFA_THRESHOLD_ROLES.includes(raw as WorkspaceRole)");
    expect(route()).toContain("required_role must be null or one of");
  });

  it("a change is audited", () => {
    expect(route()).toContain('action: "workspace.mfa_policy.change"');
  });
});

describe("what this slice does NOT claim (US-2532)", () => {
  it("no iOS MFA-policy screen is asserted to exist", () => {
    // AC2's iOS control is Swift that cannot be compiled or run here. When it
    // lands it reads the same endpoint and shows the same server-authored
    // sentence, with no new copy to keep in step.
    const swift = read("ios/GradeThread/Team/TeamView.swift");
    expect(
      /mfa|two-factor/i.test(swift),
      "an iOS MFA control appeared — extend this guard to assert it reads " +
        "/api/workspace/mfa-policy and renders the server's error string",
    ).toBe(false);
    const tracker = read("docs/reviews/full-surface-2026-08/FIX-PROGRESS.md");
    expect(tracker).toContain("US-2532");
  });
});
