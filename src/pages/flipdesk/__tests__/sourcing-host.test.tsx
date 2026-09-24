// SRC-10: the Sourcing host renders its tabs from one table, has a phone
// picker, and a tab whose chunk fails to load does not take the host with it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/pages/flipdesk/radar", () => {
  throw new Error("Failed to fetch dynamically imported module");
});
vi.mock("@/pages/flipdesk/scout", () => ({ FlipdeskScoutPage: () => <p>scout page</p> }));
vi.mock("@/pages/flipdesk/scout-buy", () => ({ FlipdeskScoutBuyPage: () => <p>buy page</p> }));
vi.mock("@/components/help/page-help", () => ({ PageHelp: () => null }));
vi.mock("@/components/flipdesk/phone-only-row", () => ({ PhoneOnlyRow: () => null }));

const { FlipdeskSourcingPage } = await import("@/pages/flipdesk/sourcing");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

async function render(url: string) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[url]}>
        <FlipdeskSourcingPage />
      </MemoryRouter>,
    );
  });
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("Sourcing host", () => {
  it("has a phone picker, and the strip is for md and up", async () => {
    await render("/dashboard/flipdesk/sourcing?tab=scout");
    expect(host.querySelector("#sourcing-tab")).not.toBeNull();
    expect(host.querySelector('label[for="sourcing-tab"]')?.textContent).toBe("Which part of Sourcing");
    const list = host.querySelector('[role="tablist"]')!;
    expect(list.className).toContain("hidden");
    expect(list.className).toContain("md:inline-flex");
    const triggers = Array.from(host.querySelectorAll('[role="tab"]')).map((t) => t.textContent);
    expect(triggers).toEqual(["Scout deals", "Buy decision", "Radar", "My stores", "Sources", "Buyer demand"]);
    expect(host.textContent).toContain("scout page");
  });

  it("a tab whose chunk fails shows the boundary while the strip stays", async () => {
    await render("/dashboard/flipdesk/sourcing?tab=radar");
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("This tab did not load");
    expect(alert?.textContent).toContain("Retry");
    expect(host.querySelectorAll('[role="tab"]').length).toBe(6);
  });
});
