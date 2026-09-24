// MP-07: the connection summary has three honest answers per row. A failed
// read is "Couldn't check", not "Not connected", and a connected eBay account
// that cannot publish yet says how far through setup it is.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = {
  ebay: null as unknown,
  ebayError: false,
  shopifyError: false,
  policies: undefined as unknown,
  issue: null as unknown,
};

vi.mock("@/hooks/use-ebay", () => ({
  useEbayConnection: () => ({ data: state.ebay, isLoading: false, isError: state.ebayError }),
  useEbayConnectionIssue: () => ({ data: state.issue }),
  useEbayPolicies: () => ({ data: state.policies }),
}));
vi.mock("@/hooks/use-shopify", () => ({
  useShopifyConnection: () => ({ data: null, isLoading: false, isError: state.shopifyError }),
}));
vi.mock("@/hooks/use-google-sheets", () => ({
  useGoogleConnection: () => ({ data: null, isLoading: false }),
}));

const { MarketplaceConnectionSummary } = await import(
  "@/components/flipdesk/marketplace-connection-summary"
);

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(
      <MemoryRouter>
        <MarketplaceConnectionSummary extensionChannelCount={3} />
      </MemoryRouter>,
    );
  });
}

function row(name: string): string {
  const li = [...document.querySelectorAll("li")].find((l) => l.textContent?.startsWith(name));
  expect(li, `row ${name}`).toBeTruthy();
  return li!.textContent ?? "";
}

beforeEach(() => {
  Object.assign(state, {
    ebay: null,
    ebayError: false,
    shopifyError: false,
    policies: undefined,
    issue: null,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("MarketplaceConnectionSummary", () => {
  it("a failed eBay read is Couldn't check, not Not connected", () => {
    state.ebayError = true;
    state.shopifyError = true;
    render();
    expect(row("eBay")).toContain("Couldn't check");
    expect(row("eBay")).not.toContain("Not connected");
    expect(row("Shopify")).toContain("Couldn't check");
  });

  it("connected but missing policies reads as 2 of 3 steps", () => {
    state.ebay = { id: "c1", account_handle: "seller" };
    state.policies = {
      policies: [],
      defaults: {
        merchant_location_key: "home",
        fulfillment_policy_id: null,
        payment_policy_id: null,
        return_policy_id: null,
      },
    };
    render();
    expect(row("eBay")).toContain("2 of 3 steps");
  });

  it("a ready account shows its handle and links to its card", () => {
    state.ebay = { id: "c1", account_handle: "seller" };
    state.policies = {
      policies: [],
      defaults: {
        merchant_location_key: "home",
        fulfillment_policy_id: "f",
        payment_policy_id: "p",
        return_policy_id: "r",
      },
    };
    render();
    expect(row("eBay")).toContain("seller");
    const link = [...document.querySelectorAll("a")].find((a) => a.textContent?.startsWith("eBay"));
    expect(link?.getAttribute("href")).toContain("#ebay-setup");
  });
});
