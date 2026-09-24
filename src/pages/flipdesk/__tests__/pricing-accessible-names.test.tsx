// Pricing plan P14: every icon button in the queue has a name, and a rule
// summary never prints a raw status or marketplace slug.
import { act } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
const rows = Array.from({ length: 25 }, (_, i) => ({
  id: `s${i}`,
  inventory_item_id: `i${i}`,
  listing_id: `l${i}`,
  current_price_cents: 5000,
  suggested_price_cents: 4200,
  comp_median_cents: 4000,
  comp_count: 9,
  condition_id: "3000",
  reason_code: "OVERPRICED",
  message: "Priced above comparable items.",
  confidence: 0.8,
  status: "pending",
  updated_at: "2026-09-01T00:00:00Z",
  inventory_items: { title: `Coat ${i}`, brand: null, grade_value: 8, grade_label: "Excellent" },
  listings: { listing_status: "active", listing_url: null },
}));

vi.mock("@/hooks/use-repricing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-repricing")>()),
  useRepricingSuggestions: () => ({ data: rows, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() }),
  useRepriceRules: () => ({ data: [], isLoading: false, isError: false, isFetching: false, refetch: vi.fn() }),
  useRepriceActions: () => ({ data: [] }),
  useScanRepricing: () => idle,
  useApplyReprice: () => idle,
  useBulkRepriceApply: () => idle,
  useDismissReprice: () => idle,
  useRestoreReprice: () => idle,
  useRunRepriceRules: () => idle,
  useCreateRepriceRule: () => idle,
  useUpdateRepriceRule: () => idle,
  useToggleRepriceRule: () => idle,
  useDeleteRepriceRule: () => idle,
}));

const { FlipdeskRepricingPage } = await import("@/pages/flipdesk/repricing");
const { ConfirmProvider } = await import("@/components/ui/confirm-dialog");
const { platformLabel, statusLabel } = await import("@/pages/flipdesk/automation-labels");

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

function buttonsNamed(re: RegExp): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].filter((b) =>
    re.test(b.getAttribute("aria-label") ?? b.textContent ?? "")
  );
}

describe("the Repricing queue", () => {
  it("names every row's Dismiss button after its item, and the pager", () => {
    act(() => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter>
            <ConfirmProvider>
              <FlipdeskRepricingPage />
            </ConfirmProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    const dismiss = buttonsNamed(/^Dismiss suggestion for /);
    expect(dismiss).toHaveLength(20); // one page
    expect(dismiss[0]!.getAttribute("aria-label")).toBe("Dismiss suggestion for Coat 0");
    expect(buttonsNamed(/^Previous page$/)).toHaveLength(1);
    expect(buttonsNamed(/^Next page$/)).toHaveLength(1);
  });
});

describe("rule summaries use labels, not slugs", () => {
  it("maps statuses and marketplaces", () => {
    expect(statusLabel("photographed")).toBe("Photographed");
    expect(platformLabel("ebay")).toBe("eBay");
    expect(statusLabel("not-a-status")).toBe("not-a-status");
  });

  it("every place automations.tsx prints a status or platform goes through them", () => {
    const src = readFileSync(resolve(process.cwd(), "src/pages/flipdesk/automations.tsx"), "utf8");
    expect(src).not.toMatch(/moved to \$\{t\.status\}/);
    expect(src).not.toMatch(/to \$\{a\.platform\}/);
    expect(src).not.toMatch(/item to \$\{a\.status\}/);
    expect(src).not.toMatch(/String\(a\.(before|after)_json\?\.status/);
    expect(src).toMatch(/aria-label=\{`Edit rule: \$\{rule\.name\}`\}/);
    expect(src).toMatch(/aria-label=\{`Delete rule: \$\{rule\.name\}`\}/);
    expect(src).toContain('aria-label="Maximum grade to include in the markdown"');
  });
});
