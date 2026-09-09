import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// US-3246. edgeFetch refreshes once and retries on a 401 from an authed
// request. When the REFRESH itself fails -- token expired, revoked, or the
// account signed out elsewhere -- the original 401 went back to the caller and
// toastError said the right words: "You were signed out. Sign in again."
//
// Nothing had actually signed them out of the SPA. The store still held a
// session, so ProtectedRoute kept rendering the dashboard, the sidebar kept
// their name, and there was no Sign in button anywhere, because as far as the
// app was concerned they were signed in. Correct advice, no way to follow it.
//
// Three branches, and getting the second and third wrong is worse than the bug:
// signing a user out because ONE endpoint refused them would be a new defect.

const refreshSession = vi.fn();
const signOut = vi.fn();

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { refreshSession: () => refreshSession(), signOut: (o: unknown) => signOut(o) } },
}));
vi.mock("@/lib/step-up-request", () => ({ requestStepUp: vi.fn() }));
vi.mock("@/lib/edge-api", () => ({ edgeApiUrl: () => "https://edge.test" }));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  refreshSession.mockReset();
  signOut.mockReset().mockResolvedValue({ error: null });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const unauthorized = () =>
  new Response(JSON.stringify({ error: "nope" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });

describe("a session the server rejected stops looking signed in (US-3246)", () => {
  it("clears the local session when the refresh fails", async () => {
    refreshSession.mockResolvedValue({ data: { session: null }, error: new Error("bad token") });
    fetchMock.mockResolvedValue(unauthorized());

    const { abandonDeadSession, forceRefreshAccessToken } = await import("@/lib/auth-token");
    expect(await forceRefreshAccessToken()).toBeNull();

    await abandonDeadSession();
    // LOCAL, not global: the token is already dead, so there is nothing to
    // revoke, and a network sign-out would hang if the refresh failed because
    // the user is offline.
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("does not sign out when the refresh succeeds", async () => {
    refreshSession.mockResolvedValue({
      data: { session: { access_token: "fresh-token" } },
      error: null,
    });

    const { forceRefreshAccessToken } = await import("@/lib/auth-token");
    expect(await forceRefreshAccessToken()).toBe("fresh-token");
    // A retry that still 401s means the endpoint refused THIS USER. Signing
    // them out for that would be a worse bug than the one being fixed.
    expect(signOut).not.toHaveBeenCalled();
  });

  it("swallows a throwing sign-out rather than raising", async () => {
    signOut.mockRejectedValue(new Error("network down"));
    const { abandonDeadSession } = await import("@/lib/auth-token");
    // Replacing a recoverable dead-end with an unhandled rejection would be a
    // straight downgrade.
    await expect(abandonDeadSession()).resolves.toBeUndefined();
  });

  it("edgeFetch only reaches for it on an AUTHED request", async () => {
    // Source-level, because the unauthenticated path never touches auth-token
    // at all and there is nothing to observe at runtime.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(process.cwd(), "src/lib/edge-fetch.ts"), "utf8");
    const at = src.indexOf("abandonDeadSession()");
    expect(at).toBeGreaterThan(-1);
    const guard = src.lastIndexOf("res.status === 401 && authed", at);
    expect(guard, "the call must sit inside the authed 401 branch").toBeGreaterThan(-1);
    // ...and in the else, i.e. only when the refresh returned nothing.
    expect(src.slice(guard, at)).toContain("} else {");
  });
});
