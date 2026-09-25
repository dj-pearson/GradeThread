// ACC-11: the hub's pages are lazy chunks now. Each tab must still render its
// page when selected, through the Suspense boundary.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/hooks/use-workspace", () => ({ useWorkspace: () => ({ can: () => true }) }));
vi.mock("@/pages/settings", () => ({ SettingsPage: () => <p>page:settings</p> }));
vi.mock("@/pages/billing", () => ({ BillingPage: () => <p>page:billing</p> }));
vi.mock("@/pages/team", () => ({ TeamPage: () => <p>page:team</p> }));
vi.mock("@/pages/api-keys", () => ({ ApiKeysPage: () => <p>page:api-keys</p> }));
vi.mock("@/pages/referrals", () => ({ ReferralsPage: () => <p>page:referrals</p> }));

import { AccountPage } from "@/pages/account";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("AccountPage lazy tabs", () => {
  for (const tab of ["settings", "billing", "team", "api-keys", "referrals"]) {
    it(`renders the ${tab} page when ?tab=${tab}`, async () => {
      container = document.createElement("div");
      document.body.appendChild(container);
      await act(async () => {
        root = createRoot(container!);
        root.render(
          <MemoryRouter initialEntries={[`/dashboard/account?tab=${tab}`]}>
            <AccountPage />
          </MemoryRouter>,
        );
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(container.textContent).toContain(`page:${tab}`);
    });
  }
});
