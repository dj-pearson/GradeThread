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

describe("the iOS control reads the same endpoint and the same sentence (US-2532)", () => {
  // This block used to assert the OPPOSITE — that no iOS MFA control existed —
  // and its own failure message said what to do when one appeared: "extend this
  // guard to assert it reads /api/workspace/mfa-policy and renders the server's
  // error string". That is exactly what it now does. The point of the original
  // was never that iOS should stay empty; it was that nobody should be able to
  // close US-2532 believing Swift had landed when it had not.

  it("the iOS Team screen has an MFA policy control", () => {
    expect(/two-factor/i.test(read("ios/GradeThread/Team/TeamView.swift"))).toBe(true);
  });

  it("it reads the same endpoint, not a Swift copy of the rule", () => {
    // The whole reason the endpoint is client-agnostic. A native reimplementation
    // of the threshold logic would drift from the web the first time either side
    // changed, and nothing would be red.
    expect(read("ios/GradeThread/Team/TeamService.swift")).toContain(
      "/api/workspace/mfa-policy",
    );
  });

  it("a failed read is not rendered as 'not required'", () => {
    // The load-bearing behaviour, and the one a naive port gets wrong. On a
    // security control, "we could not tell" must not render as an explicit, safe
    // setting. US-2185 made the same point on the web card.
    expect(read("ios/GradeThread/Team/TeamStore.swift")).toContain("mfaLoadFailed");
  });

  it("a blocked member gets the SERVER's sentence, not a third copy of it", () => {
    // Web renders `data.error` from the edge; iOS surfaces the same string
    // through a typed error case rather than a local literal. Three clients
    // writing their own wording is how one of them ends up out of step.
    const swift = read("ios/GradeThread/Networking/EdgeAPIError.swift");
    expect(swift).toContain("workspace_mfa_required");
    expect(swift).toContain("workspaceMfaRequired");
  });

  it("still tracks the story", () => {
    const tracker = read("docs/reviews/full-surface-2026-08/FIX-PROGRESS.md");
    expect(tracker).toContain("US-2532");
  });
});
