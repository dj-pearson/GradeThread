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
  activeOwner: null as string | null,
  settingsError: false,
  polError: false,
  policyCalls: [] as boolean[],
  queueError: false,
  syncStatusError: false,
  syncChannels: [] as unknown[],
  syncReviews: [] as unknown[],
  candidatesError: false,
  claim: vi.fn(),
  overviewError: false,
  issue: null as unknown,
  disconnect: vi.fn(),
  toastErrors: [] as string[],
  entry: "/dashboard/flipdesk/marketplaces",
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

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: (msg: string) => state.toastErrors.push(msg),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-ebay", async (orig) => ({
  isReauthNeeded: (await orig<typeof import("@/hooks/use-ebay")>()).isReauthNeeded,
  reauthMessage: (await orig<typeof import("@/hooks/use-ebay")>()).reauthMessage,
  useEbayConnection: () => ({
    data: state.connection,
    isLoading: state.connLoading,
    isError: state.connError,
    refetch: vi.fn(),
  }),
  useEbayConnectionIssue: () => ({ data: state.issue }),
  useEbayPolicies: (enabled: boolean) => {
    state.policyCalls.push(enabled);
    return {
      data: state.polError ? undefined : state.policies,
      isLoading: state.polLoading,
      isError: state.polError,
      refetch: vi.fn(),
    };
  },
  useStartEbayOauth: mutation,
  useSyncEbayListings: mutation,
  useDisconnectEbay: () => ({ ...mutation(), mutate: state.disconnect }),
  useCreateEbayLocation: mutation,
  useCreateEbayPolicies: mutation,
  useSetDefaultPolicies: mutation,
  useSyncEbayPolicies: mutation,
  useEbayPromotedOverview: () => ({
    data: undefined,
    isLoading: false,
    isError: state.overviewError,
    isFetching: false,
    refetch: vi.fn(),
  }),
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
  useExtensionQueue: () => ({
    data: state.queueError ? undefined : state.queue,
    isLoading: state.queueLoading,
    isError: state.queueError,
    isSuccess: !state.queueError && !state.queueLoading,
    isFetching: false,
    refetch: vi.fn(),
  }),
  useCancelExtensionWork: mutation,
  useRequeueExtensionWork: mutation,
}));

vi.mock("@/hooks/use-sold-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-sold-sync")>()),
  useSyncStatus: () => ({
    data: state.syncStatusError ? undefined : state.syncChannels,
    isLoading: false,
    isError: state.syncStatusError,
    isFetching: false,
    refetch: vi.fn(),
  }),
  useSyncReviews: () => ({ data: state.syncReviews, isError: false, refetch: vi.fn() }),
  useDismissSyncReview: mutation,
  useClaimSyncReview: () => ({ ...mutation(), mutate: state.claim }),
  useClaimCandidates: () => ({
    data: [],
    isLoading: false,
    isError: state.candidatesError,
    refetch: vi.fn(),
  }),
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
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({ user: { id: "owner-1" }, activeWorkspaceOwnerId: state.activeOwner }),
}));

// Imported at load time and throws without the env vars. The one direct read
// (flipdesk_settings) resolves to "no row", which is the defaults.
vi.mock("@/lib/supabase", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) chain[m] = () => chain;
  chain.maybeSingle = async () =>
    state.settingsError
      ? { data: null, error: { message: "boom", code: "XX000" } }
      : { data: null, error: null };
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
        <MemoryRouter initialEntries={[state.entry]}>
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
    activeOwner: null,
    settingsError: false,
    polError: false,
    policyCalls: [],
    queueError: false,
    syncStatusError: false,
    syncChannels: [],
    syncReviews: [],
    candidatesError: false,
    claim: vi.fn(),
    overviewError: false,
    issue: null,
    disconnect: vi.fn(),
    toastErrors: [],
    entry: "/dashboard/flipdesk/marketplaces",
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

async function openTab(name: string) {
  const trigger = [...document.querySelectorAll("[role=tab]")].find(
    (t) => t.textContent?.trim() === name,
  ) as HTMLElement | undefined;
  expect(trigger, `tab ${name}`).toBeTruthy();
  await act(async () => {
    trigger!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("Marketplaces page: settings (MP-06)", () => {
  it("inside another owner's workspace, auto-end is disabled and says who sets it", async () => {
    state.activeOwner = "someone-else";
    render();
    await openTab("Settings");
    await settle();
    const sw = document.getElementById("auto-end-cross") as HTMLButtonElement | null;
    expect(sw).toBeTruthy();
    expect(sw!.disabled).toBe(true);
    expect(document.body.textContent).toContain("Set by the workspace owner.");
  });

  it("a failed auto-end read shows Retry and no switch", async () => {
    state.settingsError = true;
    render();
    await openTab("Settings");
    await settle();
    expect(document.getElementById("auto-end-cross")).toBeNull();
    expect(document.body.textContent).toContain("Couldn't load this setting.");
    const retry = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Retry",
    );
    expect(retry).toBeTruthy();
  });

  it("in the seller's own workspace the switch renders ON by default", async () => {
    render();
    await openTab("Settings");
    await settle();
    const sw = document.getElementById("auto-end-cross") as HTMLButtonElement | null;
    expect(sw?.getAttribute("aria-checked")).toBe("true");
    expect(sw?.disabled).toBe(false);
  });
});

describe("Marketplaces page: couldn't check is not missing (MP-07)", () => {
  const MISSING = {
    policies: [],
    defaults: {
      merchant_location_key: "home",
      fulfillment_policy_id: null,
      payment_policy_id: null,
      return_policy_id: null,
    },
  };

  it("a failed policies read in the dialog offers Check again, never Create these for me", async () => {
    state.connection = CONNECTED;
    state.policies = MISSING;
    render();
    act(() => buttonIn(stepRow("Business policies"), "Set up")!.click());
    let dialog = document.querySelector("[role=dialog]") as HTMLElement;
    expect(dialog.textContent).toContain("Create these for me");
    state.polError = true;
    // Any local state change re-renders the dialog against the failed read.
    act(() => buttonIn(dialog, "No returns")!.click());
    dialog = document.querySelector("[role=dialog]") as HTMLElement;
    expect(dialog.textContent).not.toContain("Create these for me");
    expect(buttonIn(dialog, "Check again")).toBeTruthy();
    expect(dialog.textContent).toContain("not missing policies");
  });

  it("a failed policies read marks steps 2 and 3 unknown, with Check again", () => {
    state.connection = CONNECTED;
    state.polError = true;
    render();
    expect(stepRow("Ship-from location").textContent).toContain("Couldn't check");
    expect(buttonIn(stepRow("Business policies"), "Check again")).toBeTruthy();
    expect(buttonIn(stepRow("Business policies"), "Set up")).toBeUndefined();
  });

  it("disconnected with the dialog closed never asks for policies", () => {
    render();
    expect(state.policyCalls.length).toBeGreaterThan(0);
    expect(state.policyCalls.every((c) => c === false)).toBe(true);
  });

  it("a failed connection read says couldn't check on Ads and Settings, not Connect eBay", async () => {
    state.connError = true;
    render();
    await openTab("Ads & promotions");
    expect(document.body.textContent).toContain("Couldn't check your eBay connection");
    expect(document.body.textContent).not.toContain("Connect eBay on the Connections tab");
    await openTab("Settings");
    expect(document.body.textContent).toContain("Couldn't check your eBay connection");
    expect(document.body.textContent).not.toContain("Connect eBay on the Connections tab");
  });

  it("the disconnected Ads prompt is a button back to Connections", async () => {
    render();
    await openTab("Ads & promotions");
    const go = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Go to Connections",
    );
    expect(go).toBeTruthy();
    await act(async () => {
      go!.click();
    });
    expect(stepRow("Connect your eBay account")).toBeTruthy();
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

  it("a failed row offers Queue again and Dismiss (MP-10)", () => {
    state.queue = {
      pending: [],
      needsAttention: [{ ...job("9", "delist", "mercari"), status: "failed" }],
      finishedNeedsReview: [],
      lastDrainedAt: null,
    };
    render();
    const buttons = [...document.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(buttons).toContain("Queue again");
    expect(buttons).toContain("Dismiss");
  });

  it("Cancel names the item it cancels (MP-10)", () => {
    state.queue = {
      pending: [job("1", "list", "poshmark")],
      needsAttention: [],
      finishedNeedsReview: [],
      lastDrainedAt: null,
    };
    render();
    const cancel = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Cancel",
    );
    expect(cancel?.getAttribute("aria-label")).toContain("Garment 1");
  });

  it("still renders when the queue is empty, so a stalled extension is visible", () => {
    render();
    expect(document.body.textContent).toContain("Nothing waiting for your desktop");
  });
});

describe("Marketplaces page: extension section errors (MP-08)", () => {
  it("a failed queue read shows Retry, never 'Nothing waiting'", () => {
    state.queueError = true;
    render();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Nothing waiting for your desktop");
    expect(text).toContain("Couldn't load your queued work");
    expect(document.getElementById("extension-queue")).toBeTruthy();
    expect(
      [...document.querySelectorAll("button")].some((b) => b.textContent?.includes("Try again")),
    ).toBe(true);
  });

  it("the queue anchor exists while loading", () => {
    state.queueLoading = true;
    render();
    expect(document.getElementById("extension-queue")).toBeTruthy();
  });

  it("a failed sold-sync status read keeps the heading with a retry", () => {
    state.syncStatusError = true;
    render();
    const headings = [...document.querySelectorAll("h3")].map((h) => h.textContent);
    expect(headings).toContain("Sold-sync");
    expect(document.body.textContent).toContain("Couldn't check sold-sync");
  });

  it("a failed claim-candidate read says so instead of an empty picker", () => {
    state.syncChannels = [
      {
        platform: "poshmark",
        status: "ok",
        failure_reason: null,
        listings_seen: 3,
        last_ok_at: null,
        last_read_at: null,
        open_reviews: 1,
        live_listings: 3,
      },
    ];
    state.syncReviews = [
      {
        id: "r1",
        platform: "poshmark",
        reason: "probable_match",
        status: "open",
        listing_id: null,
        inventory_item_id: null,
        listing_url: "https://poshmark.com/listing/x",
        title: "Blue coat",
        sold_price_cents: null,
        sold_at: null,
        dedupe_key: null,
        unexplained: null,
        claimed: null,
        cap: null,
        created_at: new Date().toISOString(),
      },
    ];
    state.candidatesError = true;
    render();
    const link = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Link to an item",
    );
    expect(link).toBeTruthy();
    act(() => link!.click());
    expect(document.body.textContent).toContain("Couldn't load your listings.");
  });
});

describe("Marketplaces page: confirm a probable match (MP-09)", () => {
  const channel = {
    platform: "poshmark",
    status: "ok",
    failure_reason: null,
    listings_seen: 3,
    last_ok_at: null,
    last_read_at: null,
    open_reviews: 1,
    live_listings: 3,
  };
  const review = (over: Record<string, unknown>) => ({
    id: "r1",
    platform: "poshmark",
    reason: "probable_match",
    status: "open",
    listing_id: null,
    inventory_item_id: null,
    listing_url: "https://poshmark.com/listing/x",
    title: "Blue coat",
    sold_price_cents: 4200,
    sold_at: "2026-09-01T12:00:00Z",
    dedupe_key: null,
    unexplained: null,
    claimed: null,
    cap: null,
    created_at: new Date().toISOString(),
    ...over,
  });

  it("a needs-confirming row offers 'Yes, this item' and it claims the matched listing", () => {
    state.syncChannels = [channel];
    state.syncReviews = [review({ listing_id: "listing-9" })];
    render();
    const yes = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Yes, this item",
    );
    expect(yes).toBeTruthy();
    act(() => yes!.click());
    expect(state.claim).toHaveBeenCalledWith(
      { reviewId: "r1", listingId: "listing-9" },
      expect.anything(),
    );
  });

  it("each review row shows the sold price and a link to the channel", () => {
    state.syncChannels = [channel];
    state.syncReviews = [review({})];
    render();
    expect(document.body.textContent).toContain("sold for $42.00");
    const open = [...document.querySelectorAll("a")].find((a) =>
      a.textContent?.includes("Open on Poshmark"),
    );
    expect(open?.getAttribute("href")).toBe("https://poshmark.com/listing/x");
  });

  it("an unmatched row with no address offers no Link to an item", () => {
    state.syncChannels = [channel];
    state.syncReviews = [review({ listing_url: null })];
    render();
    expect(
      [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Link to an item"),
    ).toBe(false);
  });
});

describe("Marketplaces page: promoted listings error (MP-11)", () => {
  it("a failed overview read is an error, not 'No promoted listings yet'", async () => {
    state.connection = CONNECTED;
    state.overviewError = true;
    render();
    await openTab("Ads & promotions");
    expect(document.body.textContent).toContain("Couldn't load promoted listings");
    expect(document.body.textContent).not.toContain("No promoted listings yet");
  });
});

describe("Marketplaces page: safe disconnect (MP-12)", () => {
  it("Disconnect opens a confirm and only disconnects when confirmed", async () => {
    state.connection = CONNECTED;
    render();
    const btn = buttonIn(stepRow("Connect your eBay account"), "Disconnect")!;
    act(() => btn.click());
    const dialog = document.querySelector("[role=alertdialog]") as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain("thrift_seller");
    expect(dialog.textContent).toContain("stop syncing");
    expect(state.disconnect).not.toHaveBeenCalled();
    act(() => buttonIn(dialog, "Disconnect")!.click());
    expect(state.disconnect).toHaveBeenCalledWith({ connectionId: "conn-1" });
  });

  it("a disconnect the seller chose does not raise the re-auth banner", () => {
    state.issue = { is_active: false, refresh_error: "disconnected" };
    render();
    expect(document.body.textContent).not.toContain("Reconnect eBay to keep syncing");
  });

  it("a revoked grant raises the banner in plain words, never the raw string", () => {
    state.issue = {
      is_active: false,
      refresh_error:
        "eBay disconnected: your authorization was revoked or expired. Please reconnect your eBay account.",
    };
    render();
    const alert = [...document.querySelectorAll("[role=alert]")].find((a) =>
      a.textContent?.includes("expired or was revoked"),
    );
    expect(alert).toBeTruthy();
    expect(alert!.textContent).not.toContain("eBay disconnected:");
  });

  it("an unknown eBay callback code still tells the seller something", async () => {
    state.entry = "/dashboard/flipdesk/marketplaces?ebay=invalid_scope";
    render();
    await settle();
    expect(state.toastErrors).toContain(
      "eBay sign-in didn't finish. Try again, and contact support if it keeps happening.",
    );
  });
});
