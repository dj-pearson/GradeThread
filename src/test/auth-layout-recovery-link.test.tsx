// A signed-in Google/Apple user who presses "Set a password" in Settings gets a
// recovery link in the same browser. AuthLayout sent every signed-in visitor
// to /dashboard, so that link never reached the password form.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    session: { access_token: "t" },
    profile: { is_seller: true, is_buyer: false },
    isLoading: false,
  }),
}));

import { AuthLayout } from "@/layouts/auth-layout";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
});

function renderAt(url: string): string {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route element={<AuthLayout />}>
          <Route path="/login" element={<p>login form</p>} />
          <Route path="/auth/reset-password" element={<p>reset form</p>} />
        </Route>
        <Route path="/dashboard" element={<p>dashboard</p>} />
      </Routes>
    </MemoryRouter>,
  ));
  return container.textContent ?? "";
}

describe("AuthLayout with a signed-in session", () => {
  it("lets a token_hash recovery link reach the reset form", () => {
    expect(renderAt("/auth/reset-password?token_hash=abc&type=recovery")).toBe(
      "reset form",
    );
  });

  it("still sends a bare reset-password visit to the dashboard", () => {
    expect(renderAt("/auth/reset-password")).toBe("dashboard");
  });

  it("still sends /login to the dashboard", () => {
    expect(renderAt("/login")).toBe("dashboard");
  });
});
