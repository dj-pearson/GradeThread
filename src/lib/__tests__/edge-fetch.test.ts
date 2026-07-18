// edgeFetch: the wrapper every authenticated call to the Hono edge goes through.
//
// It was at 2% coverage despite carrying auth, tenant scoping, and three
// response-gate behaviours. These are the paths where a regression is
// user-visible rather than cosmetic: a dropped workspace header writes to the
// wrong tenant, a missing 401 retry dead-ends an active user at the one-hour
// token boundary, and consuming the 402 body would leave callers unable to read
// their own error.
import { beforeEach, describe, expect, it, vi } from "vitest";

const getFreshAccessToken = vi.fn();
const forceRefreshAccessToken = vi.fn();
const toastError = vi.fn();
const toastWarning = vi.fn();
const showUpgrade = vi.fn();
const showPlanPicker = vi.fn();
let authState: { activeWorkspaceOwnerId: string | null; user: { id: string } | null } = {
  activeWorkspaceOwnerId: null,
  user: { id: "user-1" },
};

vi.mock("@/lib/auth-token", () => ({
  getFreshAccessToken: (...a: unknown[]) => getFreshAccessToken(...a),
  forceRefreshAccessToken: (...a: unknown[]) => forceRefreshAccessToken(...a),
}));
vi.mock("@/lib/edge-api", () => ({ edgeApiUrl: () => "https://edge.test" }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("sonner", () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    warning: (...a: unknown[]) => toastWarning(...a),
  },
}));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: { getState: () => authState },
}));
vi.mock("@/stores/upgrade-dialog-store", () => ({
  useUpgradeDialogStore: { getState: () => ({ show: showUpgrade }) },
}));
vi.mock("@/stores/plan-picker-store", () => ({
  usePlanPickerStore: { getState: () => ({ show: showPlanPicker }) },
}));

const { edgeFetch, edgeAuthHeaders } = await import("@/lib/edge-fetch");

function reply(init: { status?: number; headers?: Record<string, string>; body?: unknown } = {}) {
  return new Response(JSON.stringify(init.body ?? {}), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  authState = { activeWorkspaceOwnerId: null, user: { id: "user-1" } };
  getFreshAccessToken.mockResolvedValue("tok-1");
  forceRefreshAccessToken.mockResolvedValue("tok-2");
  fetchMock = vi.fn().mockResolvedValue(reply());
  vi.stubGlobal("fetch", fetchMock);
});

describe("edgeFetch: auth + addressing", () => {
  it("attaches the bearer token and resolves a relative path against the edge base", async () => {
    await edgeFetch("/api/thing");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://edge.test/api/thing");
    expect((init.headers as Headers).get("Authorization")).toBe("Bearer tok-1");
  });

  it("leaves an absolute URL alone", async () => {
    await edgeFetch("https://elsewhere.test/x");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://elsewhere.test/x");
  });

  it("throws rather than calling the edge unauthenticated when there is no token", async () => {
    // Silently dropping the header would produce a confusing 401 from the
    // server instead of an actionable client error.
    getFreshAccessToken.mockResolvedValue(null);
    await expect(edgeFetch("/api/thing")).rejects.toThrow(/signed in/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips auth entirely when unauthenticated is set", async () => {
    getFreshAccessToken.mockResolvedValue(null);
    await edgeFetch("/api/public", { unauthenticated: true });
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init.headers as Headers).has("Authorization")).toBe(false);
  });
});

describe("edgeFetch: workspace scoping", () => {
  it("sends the ACTIVE workspace owner, not the caller, when acting in a workspace", async () => {
    // This header decides which tenant the edge writes to. Sending the caller's
    // own id while they act inside someone else's workspace writes to the wrong
    // tenant — the failure this header exists to prevent.
    authState = { activeWorkspaceOwnerId: "owner-9", user: { id: "user-1" } };
    await edgeFetch("/api/thing");
    expect((fetchMock.mock.calls[0]![1].headers as Headers).get("X-Workspace-Owner")).toBe("owner-9");
  });

  it("falls back to the caller's own id when no workspace is active", async () => {
    await edgeFetch("/api/thing");
    expect((fetchMock.mock.calls[0]![1].headers as Headers).get("X-Workspace-Owner")).toBe("user-1");
  });

  it("omits the header when skipWorkspaceHeader is set", async () => {
    authState = { activeWorkspaceOwnerId: "owner-9", user: { id: "user-1" } };
    await edgeFetch("/api/workspaces", { skipWorkspaceHeader: true });
    expect((fetchMock.mock.calls[0]![1].headers as Headers).has("X-Workspace-Owner")).toBe(false);
  });

  it("does not override a header the caller set explicitly", async () => {
    authState = { activeWorkspaceOwnerId: "owner-9", user: { id: "user-1" } };
    await edgeFetch("/api/thing", { headers: { "X-Workspace-Owner": "explicit" } });
    expect((fetchMock.mock.calls[0]![1].headers as Headers).get("X-Workspace-Owner")).toBe("explicit");
  });
});

describe("edgeFetch: json shorthand", () => {
  it("stringifies and sets the content type", async () => {
    await edgeFetch("/api/thing", { method: "POST", json: { a: 1 } });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Headers).get("Content-Type")).toBe("application/json");
  });
});

describe("edgeFetch: 401 refresh-and-retry", () => {
  it("force-refreshes once and retries with the new token", async () => {
    // The SDK's refresh timer is suspended while a tab is backgrounded, so an
    // active user hits a lapsed token at the 1h boundary. Without this they are
    // dead-ended on "session expired".
    fetchMock.mockResolvedValueOnce(reply({ status: 401 })).mockResolvedValueOnce(reply({ status: 200 }));
    const res = await edgeFetch("/api/thing");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1]![1].headers as Headers).get("Authorization")).toBe("Bearer tok-2");
  });

  it("retries only ONCE, never loops", async () => {
    fetchMock.mockResolvedValue(reply({ status: 401 }));
    const res = await edgeFetch("/api/thing");
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the refresh fails", async () => {
    fetchMock.mockResolvedValue(reply({ status: 401 }));
    forceRefreshAccessToken.mockResolvedValue(null);
    await edgeFetch("/api/thing");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry an unauthenticated request", async () => {
    fetchMock.mockResolvedValue(reply({ status: 401 }));
    await edgeFetch("/api/public", { unauthenticated: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(forceRefreshAccessToken).not.toHaveBeenCalled();
  });
});

describe("edgeFetch: response gates", () => {
  it("leaves the 402 body readable by the caller", async () => {
    // The gate handler parses the body to build the upgrade dialog. If it read
    // the original instead of a clone, the caller's own res.json() would throw
    // "body already consumed" — a bug that only shows up in the caller.
    fetchMock.mockResolvedValue(reply({ status: 402, body: { code: "PAYMENT_REQUIRED", cap: "activeListings" } }));
    const res = await edgeFetch("/api/thing");
    await expect(res.json()).resolves.toMatchObject({ code: "PAYMENT_REQUIRED" });
  });

  it("leaves the 403 body readable by the caller", async () => {
    fetchMock.mockResolvedValue(reply({ status: 403, body: { error_code: "workspace_mfa_required" } }));
    const res = await edgeFetch("/api/thing");
    await expect(res.json()).resolves.toMatchObject({ error_code: "workspace_mfa_required" });
  });

  it("raises the 2FA prompt on workspace_mfa_required", async () => {
    fetchMock.mockResolvedValue(reply({ status: 403, body: { error_code: "workspace_mfa_required" } }));
    await edgeFetch("/api/thing");
    expect(toastError).toHaveBeenCalledWith(
      "Two-factor authentication required",
      expect.objectContaining({ id: "workspace_mfa_required" }),
    );
  });

  it("stays silent on every gate when silentGate is set", async () => {
    // Used where the caller does its own messaging; a duplicate toast/dialog
    // there is worse than none.
    fetchMock.mockResolvedValue(
      reply({ status: 402, headers: { "X-Plan-Warning": "CAP_80;kind=activeListings;used=200;limit=250" } }),
    );
    await edgeFetch("/api/thing", { silentGate: true });
    expect(toastWarning).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(showUpgrade).not.toHaveBeenCalled();
  });

  it("warns once per cap on X-Plan-Warning, with a dedup id", async () => {
    fetchMock.mockResolvedValue(
      reply({ headers: { "X-Plan-Warning": "CAP_80;kind=activeListings;used=200;limit=250" } }),
    );
    await edgeFetch("/api/thing");
    expect(toastWarning).toHaveBeenCalledWith(
      expect.stringContaining("80%"),
      expect.objectContaining({ id: "plan_warning_activeListings" }),
    );
  });

  it("ignores a malformed X-Plan-Warning instead of showing a broken toast", async () => {
    fetchMock.mockResolvedValue(reply({ headers: { "X-Plan-Warning": "garbage" } }));
    await edgeFetch("/api/thing");
    expect(toastWarning).not.toHaveBeenCalled();
  });
});

describe("edgeAuthHeaders", () => {
  it("returns bearer, content type and workspace owner", async () => {
    authState = { activeWorkspaceOwnerId: "owner-9", user: { id: "user-1" } };
    await expect(edgeAuthHeaders()).resolves.toEqual({
      Authorization: "Bearer tok-1",
      "Content-Type": "application/json",
      "X-Workspace-Owner": "owner-9",
    });
  });

  it("omits Content-Type when asked (multipart uploads set their own boundary)", async () => {
    const h = await edgeAuthHeaders(null);
    expect(h["Content-Type"]).toBeUndefined();
    expect(h.Authorization).toBe("Bearer tok-1");
  });

  it("throws when signed out", async () => {
    getFreshAccessToken.mockResolvedValue(null);
    await expect(edgeAuthHeaders()).rejects.toThrow(/signed in/i);
  });
});
