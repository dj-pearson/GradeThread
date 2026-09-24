// The Marketplaces page, mounted. It is the first screen a new reseller
// touches (connect eBay, then the ship-from and policy steps) and until now
// nothing rendered it: the tests that mention it are source scans or helper
// tests. These mount the real page with its data hooks stubbed, so a broken
// connect step, a policies step that never offers its dialog, or a queue
// section that stops counting fails here instead of in production.
//
// The eBay setup card and the extension queue section are the parts under
// test, so they run for real. The child cards that fetch their own data
// (promotions, cross-post setup, duplicates, ...) are stubbed out; each has
// its own tests, and here they would only add network mocks.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 requires this flag for act() to flush effects in a test env.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });

const state = {
  connection: null as unknown,
  connLoading: false,
  connError: false,
  policies: undefined as unknown,
  polLoading: false,
  queue: undefined as unknown,
  queueLoading: false,
  role: "owner" as string,
};

vi.mock("@/hooks/use-workspace", async () => {
  const perms = await import("@/lib/workspace-permissions");
  return {
    useWorkspace: () => ({
      role: state.role,
      can: (cap: Parameters<typeof perms.canDo>[1]) =>
        perms.canDo(state.role as Parameters<typeof perms.canDo>[0], cap),
    }),
  };
});

vi.mock("@/hooks/use-ebay", () => ({
  useEbayConnection: () => ({
    data: state.connection,
    isLoading: state.connLoading,
    isError: state.connError,
    refetch: vi.fn(),
  }),
  useEbayConnectionIssue: () => ({ data: null }),
  useEbayPolicies: () => ({ data: state.policies, isLoading: state.polLoading }),
  useStartEbayOauth: mutation,
  useSyncEbayListings: mutation,
  useDisconnectEbay: mutation,
  useCreateEbayLocation: mutation,
  useCreateEbayPolicies: mutation,
  useSetDefaultPolicies: mutation,
  useSyncEbayPolicies: mutation,
  useEbayPromotedOverview: () => ({ data: undefined, isLoading: false }),
  useEbaySyncPromoted: mutation,
}));

vi.mock("@/hooks/use-shopify", () => ({
  useShopifyConnection: () => ({
    data: null,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useStartShopifyOauth: mutation,
  useDisconnectShopify: mutation,
  useSyncShopify: mutation,
}));

// groupQueue and QUEUED_NOTICE stay real: the counts are what is under test.
vi.mock("@/hooks/use-extension-queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-extension-queue")>()),
  useExtensionQueue: () => ({ data: state.queue, isLoading: state.queueLoading }),
  useCancelExtensionWork: mutation,
}));

vi.mock("@/hooks/use-sold-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-sold-sync")>()),
  useSyncStatus: () => ({ data: [], isLoading: false }),
  useSyncReviews: () => ({ data: [] }),
  useDismissSyncReview: mutation,
  useClaimSyncReview: mutation,
  useClaimCandidates: () => ({ data: [], isLoading: false }),
  usePollState: () => ({ data: undefined, isLoading: false }),
  useStopPoll: mutation,
  useSetPollInterval: mutation,
}));

const none = () => null;
vi.mock("@/components/flipdesk/link-duplicates-card", () => ({ LinkDuplicatesCard: none }));
vi.mock("@/components/flipdesk/marketplace-connection-summary", () => ({
  MarketplaceConnectionSummary: none,
}));
vi.mock("@/components/flipdesk/ebay-promotions-card", () => ({ EbayPromotionsCard: none }));
vi.mock("@/components/flipdesk/ebay-keywords-card", () => ({ EbayKeywordsCard: none }));
vi.mock("@/components/flipdesk/ebay-campaign-card", () => ({ EbayCampaignCard: none }));
vi.mock("@/components/flipdesk/promotion-performance-card", () => ({
  PromotionPerformanceCard: none,
}));
vi.mock("@/components/flipdesk/follower-campaign-card", () => ({ FollowerCampaignCard: none }));
vi.mock("@/components/flipdesk/ebay-programs-card", () => ({ EbayProgramsCard: none }));
vi.mock("@/components/flipdesk/cross-post-setup", () => ({ CrossPostSetup: none }));
vi.mock("@/components/flipdesk/cross-post-channel-picker", () => ({
  CrossPostChannelPicker: none,
}));
vi.mock("@/components/flipdesk/lister-locale-picker", () => ({ ListerLocalePicker: none }));
vi.mock("@/components/flipdesk/listing-badge-toggle", () => ({ ListingBadgeToggle: none }));
vi.mock("@/components/help/help-link", () => ({ HelpLink: none }));

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: { id: "owner-1" } }),
}));

// Imported at load time and throws without the env vars. The one direct read
// (flipdesk_settings) resolves to "no row", which is the defaults.
vi.mock("@/lib/supabase", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) chain[m] = () => chain;
  chain.maybeSingle = async () => ({ data: null, error: null });
  return {
    supabase: {
      from: () => chain,
      rpc: async () => ({ data: null, error: null }),
    },
  };
});

const { FlipdeskMarketplacesPage } = await import("@/pages/flipdesk/marketplaces");

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root = createRoot(container!);
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/dashboard/flipdesk/marketplaces"]}>
          <FlipdeskMarketplacesPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return container;
}

/** The step row whose label is `label`: its label, status and action. */
function stepRow(label: string): HTMLElement {
  const p = [...document.querySelectorAll("p")].find((el) => el.textContent === label);
  expect(p, `step "${label}" is rendered`).toBeTruthy();
  // StepRow: <div row><div><icon/><div><p label/><p status/></div></div>{action}</div>
  return p!.parentElement!.parentElement!.parentElement as HTMLElement;
}

function buttonIn(el: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...el.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;
}

const CONNECTED = {
  id: "conn-1",
  account_handle: "thrift_seller",
  last_synced_at: null,
  is_active: true,
};

beforeEach(() => {
  Object.assign(state, {
    connection: null,
    connLoading: false,
    connError: false,
    policies: undefined,
    polLoading: false,
    queue: { pending: [], needsAttention: [], finishedNeedsReview: [], lastDrainedAt: null },
    queueLoading: false,
    role: "owner",
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
});

describe("Marketplaces page: eBay setup", () => {
  it("offers the connect step when eBay is not connected, with the later steps blocked", () => {
    render();
    const connect = stepRow("Connect your eBay account");
    expect(buttonIn(connect, "Connect eBay")).toBeTruthy();
    expect(stepRow("Ship-from location").textContent).toContain("Connect your account first");
    expect(stepRow("Business policies").textContent).toContain("Connect your account first");
    expect(buttonIn(stepRow("Business policies"), "Set up")).toBeUndefined();
    expect(document.body.textContent).toContain("0 of 3 complete");
  });

  it("never offers Connect while the connection read has failed", () => {
    state.connError = true;
    render();
    const connect = stepRow("Connect your eBay account");
    expect(buttonIn(connect, "Connect eBay")).toBeUndefined();
    expect(buttonIn(connect, "Check again")).toBeTruthy();
  });

  it("connected with missing policies offers the policies step, and it opens the dialog", () => {
    state.connection = CONNECTED;
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
    expect(stepRow("Connect your eBay account").textContent).toContain("thrift_seller");
    expect(stepRow("Ship-from location").textContent).toContain("Set");
    const policies = stepRow("Business policies");
    expect(policies.textContent).toContain("Pick a shipping, payment & return default");
    expect(document.body.textContent).toContain("2 of 3 complete");

    const trigger = buttonIn(policies, "Set up");
    expect(trigger, "the policies step offers its dialog").toBeTruthy();
    expect(document.querySelector("[role=dialog]")).toBeNull();
    act(() => trigger!.click());
    const dialog = document.querySelector("[role=dialog]");
    expect(dialog, "clicking Set up opens the policies dialog").toBeTruthy();
    expect(dialog!.textContent).toContain("Business policies");
    // No policies on the account: the way out is offered, not a dead end.
    expect(dialog!.textContent).toContain("Create these for me");
  });

  it("collapses to ready once every step is done", () => {
    state.connection = CONNECTED;
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
    expect(document.body.textContent).toContain("Ready to publish on eBay");
    expect(document.body.textContent).not.toContain("of 3 complete");
  });
});

describe("Marketplaces page: roles (MP-01)", () => {
  it("a member sees the admin-only line and no Disconnect or Set up", () => {
    state.role = "member";
    state.connection = CONNECTED;
    state.policies = {
      policies: [],
      defaults: {
        merchant_location_key: null,
        fulfillment_policy_id: null,
        payment_policy_id: null,
        return_policy_id: null,
      },
    };
    render();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Only a workspace admin can change marketplace connections.");
    const buttons = [...document.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(buttons).not.toContain("Disconnect");
    expect(buttons).not.toContain("Reconnect");
    expect(buttons).not.toContain("Set up");
  });

  it("a member who is not connected is not offered Connect eBay or Connect Shopify", () => {
    state.role = "member";
    render();
    const buttons = [...document.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(buttons).not.toContain("Connect eBay");
    expect(buttons).not.toContain("Connect Shopify");
  });

  it("an admin still gets Disconnect", () => {
    state.role = "admin";
    state.connection = CONNECTED;
    render();
    expect(buttonIn(stepRow("Connect your eBay account"), "Disconnect")).toBeTruthy();
  });
});

describe("Marketplaces page: extension queue", () => {
  const job = (id: string, kind: string, platform: string) => ({
    id,
    kind,
    platform,
    inventory_item_id: `item-${id}`,
    listing_id: null,
    payload: {},
    status: "queued",
    attempts: 0,
    source: "web",
    claimed_at: null,
    completed_at: null,
    result: null,
    created_at: new Date().toISOString(),
    item_title: `Garment ${id}`,
  });

  it("renders the queue counts per channel, delists first", () => {
    state.queue = {
      pending: [
        job("1", "list", "poshmark"),
        job("2", "delist", "poshmark"),
        job("3", "list", "mercari"),
      ],
      needsAttention: [],
      finishedNeedsReview: [],
      lastDrainedAt: null,
    };
    render();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Queued for your desktop");
    expect(text).toContain("3 jobs waiting for your desktop");
    expect(text).toContain("Your extension has never run any of this");
    expect(text).toContain("Poshmark 1 to end, 1 to list");
    expect(text).toContain("Mercari 1 to list");
    expect(text).toContain("Garment 2");
  });

  it("still renders when the queue is empty, so a stalled extension is visible", () => {
    render();
    expect(document.body.textContent).toContain("Nothing waiting for your desktop");
  });
});
