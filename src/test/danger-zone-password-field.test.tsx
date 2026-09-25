// ACC-1: the delete form must ask for a password exactly when the server will
// (services/edge-functions/src/routes/account.ts: any "email" identity), and
// must send it. A Google-first user who later added a password used to see no
// password box and got 400 password_required; an Apple user saw one they did
// not need.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let currentUser: unknown = null;
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: currentUser }) }));
vi.mock("@/lib/edge-api", () => ({ edgeApiUrl: () => "https://edge.test" }));
vi.mock("@/lib/edge-fetch", () => ({ edgeAuthHeaders: async () => ({}) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase", () => ({ supabase: { auth: { signOut: vi.fn(async () => ({ error: null })) } } }));

import { DangerZoneCard } from "@/components/settings/danger-zone-card";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(
      <MemoryRouter>
        <DangerZoneCard />
      </MemoryRouter>,
    );
  });
}
function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function deleteButton(): HTMLButtonElement {
  return [...container!.querySelectorAll("button")].find((b) =>
    /permanently delete/i.test(b.textContent ?? ""),
  ) as HTMLButtonElement;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("DangerZoneCard password field", () => {
  it("Google-first user with an email identity is asked for, and sends, the password", async () => {
    currentUser = {
      id: "u1",
      app_metadata: { provider: "google", providers: ["google", "email"] },
    };
    const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    mount();
    const pw = container!.querySelector<HTMLInputElement>("#delete-reauth");
    expect(pw).not.toBeNull();
    type(container!.querySelector<HTMLInputElement>("#delete-confirm")!, "DELETE MY ACCOUNT");
    expect(deleteButton().disabled).toBe(true);
    type(pw!, "hunter2");
    expect(deleteButton().disabled).toBe(false);
    await act(async () => {
      deleteButton().click();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body))).toEqual({
      confirm: "DELETE MY ACCOUNT",
      password: "hunter2",
    });
  });

  it("Apple-only user sees no password field and can delete with the phrase alone", () => {
    currentUser = { id: "u2", app_metadata: { provider: "apple", providers: ["apple"] } };
    mount();
    expect(container!.querySelector("#delete-reauth")).toBeNull();
    expect(container!.textContent).toContain("You sign in with Apple");
    type(container!.querySelector<HTMLInputElement>("#delete-confirm")!, "DELETE MY ACCOUNT");
    expect(deleteButton().disabled).toBe(false);
  });
});
