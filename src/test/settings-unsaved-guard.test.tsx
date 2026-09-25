// ACC-13: typing in Business and then switching Settings tab, or following
// any other in-app link, opens the unsaved-changes dialog; Cancel keeps the
// typed value where it was.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryRouter, Link } from "react-router";
import { typeInto, flush } from "./profile-settings-harness";

const USER = { id: "user-1", email: "me@example.com" };
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: USER,
    profile: { id: USER.id, full_name: "Pat", avatar_url: null, updated_at: "x", created_at: "2025-01-01" },
    refreshProfile: async () => {},
  }),
}));
vi.mock("@/lib/supabase", () => ({ supabase: { from: () => ({}), storage: { from: () => ({}) } } }));
vi.mock("@/lib/shipping-profile", () => ({
  SHIPPING_PROFILE_QUERY_KEY: ["account", "shipping-profile"],
  fetchShippingProfile: async () => ({ business_name: "Stored", business_phone: null, ship_from_address: null }),
  saveShippingProfile: vi.fn(),
}));
vi.mock("@/lib/image-utils", () => ({ compressImage: vi.fn() }));
vi.mock("@/lib/media-intake", () => ({ isHeicFile: () => false, normalizeToImageFile: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
for (const [mod, name] of [
  ["@/components/settings/security-settings-tab", "SecuritySettingsTab"],
  ["@/components/settings/notifications-settings-tab", "NotificationsSettingsTab"],
  ["@/components/settings/ai-settings-tab", "AiSettingsTab"],
  ["@/components/settings/flipdesk-settings-tab", "FlipdeskSettingsTab"],
  ["@/components/settings/data-settings-tab", "DataSettingsTab"],
  ["@/components/settings/photo-archive-card", "PhotoArchiveCard"],
  ["@/components/settings/danger-zone-card", "DangerZoneCard"],
] as const) {
  vi.doMock(mod, () => ({ [name]: () => <p>section:{name}</p> }));
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let router: ReturnType<typeof createMemoryRouter> | null = null;

beforeEach(async () => {
  const { SettingsPage } = await import("@/pages/settings");
  router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <>
            <Link to="/dashboard/flipdesk">sidebar-link</Link>
            <SettingsPage />
          </>
        ),
      },
    ],
    { initialEntries: ["/dashboard/settings?tab=profile"] },
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router!} />
      </QueryClientProvider>,
    );
  });
  await flush();
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
});

const businessName = () => container!.querySelector<HTMLInputElement>("#businessName")!;
const dialogText = () => document.body.querySelector('[role="alertdialog"]')?.textContent ?? "";
function saveBusiness() {
  return [...container!.querySelectorAll("button")].find((b) =>
    /save business details/i.test(b.textContent ?? ""),
  ) as HTMLButtonElement;
}

describe("Settings unsaved-changes guard", () => {
  it("Save business details is disabled until the form is dirty", () => {
    expect(businessName().value).toBe("Stored");
    expect(saveBusiness().disabled).toBe(true);
    typeInto(businessName(), "Typed");
    expect(saveBusiness().disabled).toBe(false);
  });

  it("switching Settings tab while dirty asks first, and Cancel keeps the typing", async () => {
    typeInto(businessName(), "Typed");
    const aiTab = [...container!.querySelectorAll('[role="tab"]')].find((t) =>
      /^AI$/.test(t.textContent?.trim() ?? ""),
    ) as HTMLElement;
    await act(async () => {
      aiTab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    await flush();
    expect(dialogText()).toMatch(/leave without saving/i);
    expect(router!.state.location.search).toBe("?tab=profile");
    const cancel = [...document.body.querySelectorAll('[role="alertdialog"] button')].find((b) =>
      /stay|cancel|keep/i.test(b.textContent ?? ""),
    ) as HTMLButtonElement;
    await act(async () => {
      cancel.click();
    });
    await flush();
    expect(router!.state.location.search).toBe("?tab=profile");
    expect(businessName().value).toBe("Typed");
  });

  it("a sidebar link while dirty asks first", async () => {
    typeInto(businessName(), "Typed");
    const link = [...container!.querySelectorAll("a")].find((a) => a.textContent === "sidebar-link")!;
    await act(async () => {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
    });
    await flush();
    expect(dialogText()).toMatch(/leave without saving/i);
    expect(router!.state.location.pathname).toBe("/dashboard/settings");
  });

  it("lets the held navigation through once the section is clean again", async () => {
    // The AI cap's blur-save path: the dirty flag clears while the dialog is
    // up, and the click that asked to leave should then take effect.
    typeInto(businessName(), "Typed");
    const link = [...container!.querySelectorAll("a")].find((a) => a.textContent === "sidebar-link")!;
    await act(async () => {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
    });
    await flush();
    expect(dialogText()).toMatch(/leave without saving/i);
    typeInto(businessName(), "Stored");
    await flush();
    expect(router!.state.location.pathname).toBe("/dashboard/flipdesk");
  });

  it("does not ask when nothing is dirty", async () => {
    const link = [...container!.querySelectorAll("a")].find((a) => a.textContent === "sidebar-link")!;
    await act(async () => {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
    });
    await flush();
    expect(dialogText()).toBe("");
    expect(router!.state.location.pathname).toBe("/dashboard/flipdesk");
  });
});
