// US-3497: web sign-in asks for the second factor. ProtectedRoute holds an
// AAL1 session whose user has a verified TOTP factor on a code screen, lets an
// AAL2 session through, and lets a user with no factor through with no extra
// screen. Rendered through the REAL ProtectedRoute and a real router, so a
// regression that drops the gate from the route (not just from the component)
// turns this red.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement as h, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const getAal = vi.fn();
const listFactors = vi.fn();
const refreshSession = vi.fn();
const challengeAndVerifyTotp = vi.fn();
const edgeFetch = vi.fn();
const signOut = vi.fn();

const authState = {
  session: { access_token: "tok-1" } as { access_token: string } | null,
  user: { id: "u1", email: "seller@example.com", email_confirmed_at: "2026-01-01" },
  isLoading: false,
};

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => authState }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: () => getAal(),
        listFactors: () => listFactors(),
      },
      refreshSession: () => refreshSession(),
    },
  },
}));
vi.mock("@/lib/mfa", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mfa")>()),
  challengeAndVerifyTotp: (id: string, code: string) => challengeAndVerifyTotp(id, code),
}));
vi.mock("@/lib/edge-fetch", () => ({
  edgeFetch: (path: string, opts: unknown) => edgeFetch(path, opts),
}));
vi.mock("@/lib/auth", () => ({ signOut: () => signOut() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/toast-error", () => ({ toastError: vi.fn() }));
// The other gates behind MFA are not under test; pass-through keeps them from
// making their own requests.
vi.mock("@/components/auth/legal-gate", () => ({
  LegalGate: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/ui/confirm-dialog", () => ({
  ConfirmProvider: ({ children }: { children: ReactNode }) => children,
}));

import { ProtectedRoute } from "@/components/auth/protected-route";
import { decideSignInGate } from "@/lib/mfa";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AAL1_WITH_FACTOR = { currentLevel: "aal1", nextLevel: "aal2", currentAuthenticationMethods: [] };
const AAL2 = { currentLevel: "aal2", nextLevel: "aal2", currentAuthenticationMethods: [] };
const NO_FACTOR = { currentLevel: "aal1", nextLevel: "aal1", currentAuthenticationMethods: [] };
const FACTORS = { totp: [{ id: "factor-1", status: "verified" }], all: [] };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      {
        element: h(ProtectedRoute),
        children: [
          { path: "/dashboard", element: h("p", null, "DASHBOARD HOME") },
          { path: "/dashboard/inventory", element: h("p", null, "INVENTORY PAGE") },
        ],
      },
      { path: "/login", element: h("p", null, "LOGIN PAGE") },
    ],
    { initialEntries: [path] },
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(h(RouterProvider, { router }));
  });
  await flush();
  return router;
}

function text() {
  return container?.textContent ?? "";
}

function input(): HTMLInputElement {
  return container!.querySelector("#signin-mfa-code") as HTMLInputElement;
}

async function type(value: string) {
  const el = input();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(label: RegExp): HTMLButtonElement {
  const found = Array.from(container!.querySelectorAll("button")).find((b) =>
    label.test(b.textContent ?? ""),
  );
  if (!found) throw new Error(`no button matching ${label}; saw: ${text()}`);
  return found as HTMLButtonElement;
}

async function click(label: RegExp) {
  await act(async () => {
    button(label).click();
  });
  await flush();
}

beforeEach(() => {
  getAal.mockReset();
  listFactors.mockReset().mockResolvedValue({ data: FACTORS, error: null });
  refreshSession.mockReset().mockResolvedValue({ data: {}, error: null });
  challengeAndVerifyTotp.mockReset();
  edgeFetch.mockReset();
  signOut.mockReset().mockResolvedValue(undefined);
  authState.session = { access_token: "tok-1" };
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("decideSignInGate (US-3497)", () => {
  it("holds only an aal1 session whose next level is aal2", () => {
    expect(decideSignInGate(AAL1_WITH_FACTOR)).toBe("challenge");
    expect(decideSignInGate(AAL2)).toBe("pass");
    expect(decideSignInGate(NO_FACTOR)).toBe("pass");
  });
});

describe("ProtectedRoute holds a password-only session on the code screen (US-3497)", () => {
  it("aal1 with a verified factor: code screen, and no dashboard route renders", async () => {
    getAal.mockResolvedValue({ data: AAL1_WITH_FACTOR, error: null });
    await renderAt("/dashboard/inventory?tab=active");
    expect(text()).toContain("Enter your sign-in code");
    expect(text()).not.toContain("INVENTORY PAGE");
    expect(text()).not.toContain("DASHBOARD HOME");
    // Sign-out stays reachable from the hold.
    expect(button(/Sign out/)).toBeTruthy();
  });

  it("aal2: the dashboard renders", async () => {
    getAal.mockResolvedValue({ data: AAL2, error: null });
    await renderAt("/dashboard");
    expect(text()).toContain("DASHBOARD HOME");
    expect(text()).not.toContain("Enter your sign-in code");
  });

  it("no factor: the dashboard renders with no extra screen and no factor lookup", async () => {
    getAal.mockResolvedValue({ data: NO_FACTOR, error: null });
    await renderAt("/dashboard");
    expect(text()).toContain("DASHBOARD HOME");
    expect(text()).not.toContain("Enter your sign-in code");
    expect(listFactors).not.toHaveBeenCalled();
  });

  it("a correct code opens the route the user was heading for, query string intact", async () => {
    getAal.mockResolvedValueOnce({ data: AAL1_WITH_FACTOR, error: null });
    const router = await renderAt("/dashboard/inventory?tab=active");
    challengeAndVerifyTotp.mockResolvedValue(undefined);
    getAal.mockResolvedValue({ data: AAL2, error: null });
    await type("123456");
    await click(/^Verify$/);
    expect(challengeAndVerifyTotp).toHaveBeenCalledWith("factor-1", "123456");
    expect(text()).toContain("INVENTORY PAGE");
    expect(router.state.location.pathname + router.state.location.search).toBe(
      "/dashboard/inventory?tab=active",
    );
  });

  it("a wrong code keeps the user on the code screen", async () => {
    getAal.mockResolvedValue({ data: AAL1_WITH_FACTOR, error: null });
    await renderAt("/dashboard");
    challengeAndVerifyTotp.mockRejectedValue(new Error("Invalid TOTP code entered"));
    await type("000000");
    await click(/^Verify$/);
    expect(text()).toContain("Invalid TOTP code entered");
    expect(text()).not.toContain("DASHBOARD HOME");
  });

  it("an unreadable assurance level fails closed", async () => {
    getAal.mockResolvedValue({ data: null, error: new Error("session unreadable") });
    await renderAt("/dashboard");
    expect(text()).toContain("session unreadable");
    expect(text()).not.toContain("DASHBOARD HOME");
    expect(button(/Sign out/)).toBeTruthy();
  });

  it("sign out works from the code screen", async () => {
    getAal.mockResolvedValue({ data: AAL1_WITH_FACTOR, error: null });
    await renderAt("/dashboard");
    await click(/Sign out/);
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});

describe("recovery code on the code screen (US-3497 AC2)", () => {
  const ok = () =>
    new Response(JSON.stringify({ ok: true, factors_removed: 1 }), { status: 200 });
  const refused = () =>
    new Response(JSON.stringify({ error: "Invalid or already-used recovery code." }), {
      status: 400,
    });

  it("a good code is consumed on the edge, the session is refreshed, and the dashboard opens", async () => {
    getAal.mockResolvedValueOnce({ data: AAL1_WITH_FACTOR, error: null });
    await renderAt("/dashboard");
    await click(/Use a recovery code/);
    edgeFetch.mockResolvedValue(ok());
    // After the edge removed the factor, the refreshed session has none.
    getAal.mockResolvedValue({ data: NO_FACTOR, error: null });
    await type("abcd-2345");
    await click(/Use recovery code/);
    expect(edgeFetch).toHaveBeenCalledWith("/api/account/mfa/recovery-codes/consume", {
      method: "POST",
      json: { code: "abcd-2345" },
      skipWorkspaceHeader: true,
    });
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(text()).toContain("DASHBOARD HOME");
  });

  it("a code the edge refuses (used or wrong) keeps the user held and says why", async () => {
    getAal.mockResolvedValue({ data: AAL1_WITH_FACTOR, error: null });
    await renderAt("/dashboard");
    await click(/Use a recovery code/);
    edgeFetch.mockResolvedValue(refused());
    await type("ABCD-2345");
    await click(/Use recovery code/);
    expect(text()).toContain("Invalid or already-used recovery code.");
    expect(refreshSession).not.toHaveBeenCalled();
    expect(text()).not.toContain("DASHBOARD HOME");
  });

  it("the edge burns a code with a conditional update, so a second use is refused", () => {
    // The single-use guarantee lives in the edge route, not in the SPA. Pin the
    // shape that makes it atomic: the UPDATE matches only an UNUSED row for the
    // CALLER, and no row back means refuse.
    const src = readFileSync(
      resolve(__dirname, "../../../../services/edge-functions/src/routes/account.ts"),
      "utf8",
    );
    const start = src.indexOf('accountRoutes.post("/mfa/recovery-codes/consume"');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("function getStripe", start));
    expect(body).toMatch(
      /\.update\(\{ used_at:[^}]*\}\)\s*\.eq\("user_id", userId\)\s*\.eq\("code_hash", codeHash\)\s*\.is\("used_at", null\)/,
    );
    expect(body).toMatch(/if \(!burned\) \{\s*return c\.json\(\{ error: "Invalid or already-used recovery code\." \}, 400\)/);
  });
});

describe("MfaCard copy matches what web sign-in does (US-3497 AC4)", () => {
  it("says the website asks for the code at sign-in", () => {
    const src = readFileSync(
      resolve(__dirname, "../../settings/mfa-card.tsx"),
      "utf8",
    ).replace(/\s+/g, " ");
    expect(src).toContain("the website asks for a code every time you sign in with your password");
  });
});
