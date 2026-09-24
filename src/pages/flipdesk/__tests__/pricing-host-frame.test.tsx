// Pricing plan P13: the Pricing host owns the frame. One width for all three
// tabs, a picker instead of a strip on a phone, and a nudge count on Repricing.
import { act } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-repricing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-repricing")>()),
  useRepricingSuggestions: () => ({ data: [{ id: "a" }, { id: "b" }, { id: "c" }] }),
}));
vi.mock("@/pages/flipdesk/repricing", () => ({ FlipdeskRepricingPage: () => <p>repricing body</p> }));
vi.mock("@/pages/flipdesk/bulk-pricing", () => ({ FlipdeskBulkPricingPage: () => <p>bulk body</p> }));
vi.mock("@/pages/flipdesk/automations", () => ({ FlipdeskAutomationsPage: () => <p>automations body</p> }));
vi.mock("@/components/help/page-help", () => ({ PageHelp: () => null }));

const { FlipdeskPricingPage } = await import("@/pages/flipdesk/pricing");
const { PRICING_TABS, PRICING_TAB_LABELS } = await import("@/pages/flipdesk/nav-tabs");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the Pricing host", () => {
  it("labels every tab once, for the strip and the picker alike", () => {
    expect(Object.keys(PRICING_TAB_LABELS).sort()).toEqual([...PRICING_TABS].sort());
  });

  it("renders a phone picker and a nudge count on Repricing", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter initialEntries={["/dashboard/flipdesk/pricing?tab=repricing"]}>
            <FlipdeskPricingPage />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    const label = host.querySelector('label[for="pricing-tab"]');
    expect(label?.textContent).toBe("Which part of Pricing");
    const trigger = [...host.querySelectorAll('[role="tab"]')].find((t) =>
      t.textContent?.startsWith("Repricing")
    );
    expect(trigger?.textContent).toContain("3");
    expect(trigger?.textContent).toContain("nudges");
  });

  it("sets one width for every tab, and the children drop theirs when embedded", () => {
    const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");
    expect(read("src/pages/flipdesk/pricing.tsx")).toContain('"mx-auto w-full max-w-5xl space-y-6"');
    for (const child of ["repricing", "automations", "bulk-pricing"]) {
      const src = read(`src/pages/flipdesk/${child}.tsx`);
      expect(src, child).toMatch(/!embedded && "mx-auto/);
    }
  });
});
