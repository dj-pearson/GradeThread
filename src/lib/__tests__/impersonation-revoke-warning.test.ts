// US-3378: exiting an impersonation must produce THREE distinguishable answers,
// not two.
//
// The stop endpoint answers `{ ok: true, revoked }`. `revoked: false` means the
// target's own sessions are still live after the admin exited, and the admin who
// just clicked Exit is the only person placed to act on it. The handoff is a
// sessionStorage key because the exit is a full page load.
//
// THE BUG this file was written to reproduce: stopImpersonation() acted only on
// an explicit `revoked === false`. edgeFetch does not throw on a non-2xx, so a
// 500 (or a 403, or an HTML error page from a proxy) produces a body with no
// `revoked` key at all, takes exactly the branch a clean success takes, and the
// warning never appears. A check that COULD NOT RUN was indistinguishable from a
// check that PASSED, and the failure direction is the unsafe one: the sessions
// may well still be live.
//
// So the assertions below are about what the ADMIN IS TOLD, not about whether a
// status code is read. Reading `res.ok` and then doing nothing with it would
// satisfy a "the status is inspected" test and would not fix anything.

import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyOtp = vi.fn();
const signOut = vi.fn();
const edgeFetch = vi.fn();

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      verifyOtp: (...a: unknown[]) => verifyOtp(...a),
      signOut: (...a: unknown[]) => signOut(...a),
      getSession: async () => ({ data: { session: null } }),
    },
  },
}));

vi.mock("@/lib/query-client", () => ({
  queryClient: { clear: vi.fn() },
}));

vi.mock("@/lib/edge-fetch", () => ({
  edgeFetch: (...a: unknown[]) => edgeFetch(...a),
}));

import { revokeWarningToast, stopImpersonation, takeRevokeWarning } from "@/lib/impersonation";
import { useImpersonationStore } from "@/stores/impersonation-store";

const TARGET_EMAIL = "seller@example.test";

function beginImpersonation() {
  useImpersonationStore.getState().begin({
    target: { id: "11111111-1111-4111-8111-111111111111", email: TARGET_EMAIL, name: "A Seller" },
    adminUserId: "22222222-2222-4222-8222-222222222222",
    adminEmail: "admin@example.test",
    adminResumeTokenHash: "resume-hash",
    startedAt: new Date().toISOString(),
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  verifyOtp.mockResolvedValue({ error: null });
  signOut.mockResolvedValue({ error: null });
  useImpersonationStore.getState().clear();
});

describe("US-3378: a stop that could not be checked is its own answer", () => {
  it("a clean revoke tells the admin nothing (there is nothing to say)", async () => {
    beginImpersonation();
    edgeFetch.mockResolvedValue(jsonResponse(200, { ok: true, revoked: true }));

    await stopImpersonation();

    expect(takeRevokeWarning()).toBeNull();
  });

  it("revoked:false warns that the seller is still signed in", async () => {
    beginImpersonation();
    edgeFetch.mockResolvedValue(jsonResponse(200, { ok: true, revoked: false }));

    await stopImpersonation();

    const warning = takeRevokeWarning();
    expect(warning).not.toBeNull();
    expect(warning?.email).toBe(TARGET_EMAIL);
    expect(warning?.status).toBe("not-revoked");
  });

  // THE REPRODUCTION. Before the fix this returned null, byte-identical to the
  // clean-revoke case above.
  it("a non-2xx stop tells the admin the check DID NOT RUN", async () => {
    beginImpersonation();
    edgeFetch.mockResolvedValue(jsonResponse(500, { error: "boom" }));

    await stopImpersonation();

    const warning = takeRevokeWarning();
    expect(
      warning,
      "a 500 from /api/admin/impersonation/stop must not read as a clean revoke",
    ).not.toBeNull();
    expect(warning?.email).toBe(TARGET_EMAIL);
    expect(warning?.status).toBe("unknown");
  });

  it("a 403 is the same third answer, not a silent success", async () => {
    beginImpersonation();
    edgeFetch.mockResolvedValue(jsonResponse(403, { error: "Forbidden" }));

    await stopImpersonation();

    expect(takeRevokeWarning()?.status).toBe("unknown");
  });

  it("a 200 whose body is not JSON is also unknown, not clean", async () => {
    beginImpersonation();
    edgeFetch.mockResolvedValue(
      new Response("<html>gateway</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
    );

    await stopImpersonation();

    expect(takeRevokeWarning()?.status).toBe("unknown");
  });

  it("a 200 with no `revoked` key is unknown, not clean", async () => {
    beginImpersonation();
    edgeFetch.mockResolvedValue(jsonResponse(200, { ok: true }));

    await stopImpersonation();

    expect(takeRevokeWarning()?.status).toBe("unknown");
  });

  it("a network failure is unknown rather than swallowed", async () => {
    beginImpersonation();
    edgeFetch.mockRejectedValue(new Error("Failed to fetch"));

    await stopImpersonation();

    expect(takeRevokeWarning()?.status).toBe("unknown");
  });

  // The warning is a handoff across a hard page load, so it has to survive
  // exactly one read. A warning that reappears on every later visit to the page
  // stops being read, which is how the signal dies a second way.
  it("the warning is consumed once", async () => {
    beginImpersonation();
    edgeFetch.mockResolvedValue(jsonResponse(500, { error: "boom" }));

    await stopImpersonation();

    expect(takeRevokeWarning()).not.toBeNull();
    expect(takeRevokeWarning()).toBeNull();
  });

  // AC4 proper: drive the non-2xx path to the SENTENCE the admin reads. A test
  // that only asserted `res.ok` gets inspected would pass against a fix that
  // inspects it and then throws the answer away, which is the bug it replaced.
  it("a 500 puts a different warning in front of the admin than a clean exit", async () => {
    beginImpersonation();
    edgeFetch.mockResolvedValue(jsonResponse(200, { ok: true, revoked: true }));
    await stopImpersonation();
    expect(takeRevokeWarning()).toBeNull();

    beginImpersonation();
    edgeFetch.mockResolvedValue(jsonResponse(500, { error: "boom" }));
    await stopImpersonation();

    const warning = takeRevokeWarning();
    expect(warning).not.toBeNull();
    const { title, description } = revokeWarningToast(warning!);
    expect(title).toBe("We could not confirm they were signed out");
    expect(description).toContain(TARGET_EMAIL);
    expect(description).toContain("HTTP 500");
    expect(description).toContain("treat their sessions as still live");
  });

  it("the two warnings do not read the same", () => {
    const notRevoked = revokeWarningToast({
      email: TARGET_EMAIL,
      status: "not-revoked",
      detail: "",
    });
    const unknown = revokeWarningToast({
      email: TARGET_EMAIL,
      status: "unknown",
      detail: "the server answered HTTP 500",
    });
    expect(notRevoked.title).not.toBe(unknown.title);
    expect(notRevoked.description).not.toBe(unknown.description);
    // Both still have to send the admin somewhere useful.
    expect(notRevoked.description).toContain("sign out everywhere");
    expect(unknown.description).toContain("sign out everywhere");
  });

  // Nothing about the third answer may change what the admin can DO. The stop
  // still ends the impersonation locally in every branch; failing to reach the
  // audit endpoint must never strand the browser in the target's session.
  it("the impersonation record is cleared on every branch", async () => {
    for (const response of [
      jsonResponse(200, { ok: true, revoked: true }),
      jsonResponse(500, { error: "boom" }),
    ]) {
      beginImpersonation();
      edgeFetch.mockResolvedValue(response);
      await stopImpersonation();
      expect(useImpersonationStore.getState().record).toBeNull();
      sessionStorage.clear();
    }
  });
});
