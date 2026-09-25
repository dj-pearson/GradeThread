// The Verified page must never put the live profile at risk.
//
// These render the real page with its data hooks swapped for plain state, so
// each case can say exactly what the server answered and read back what the
// seller would see and what the page would send.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Profile = {
  handle: string | null;
  display_name: string | null;
  account_name?: string | null;
  bio: string | null;
  enabled: boolean;
  verified_since: string | null;
  show_listings: boolean;
  embed_in_listings: boolean;
};

const profileState: {
  data: { profile: Profile; stats: { total_graded: number; average_grade: number } } | undefined;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: ReturnType<typeof vi.fn>;
} = {
  data: undefined,
  isLoading: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
};

const mutateAsync = vi.fn();
const updateState = { mutateAsync, isPending: false };

const funnelState: {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: ReturnType<typeof vi.fn>;
} = { data: undefined, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };

const nodesState: {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: ReturnType<typeof vi.fn>;
} = { data: undefined, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };

const revealMutate = vi.fn();
const checkHandleAvailable = vi.fn();
const confirmFn = vi.fn();

vi.mock("@/hooks/use-verified", () => ({
  useVerifiedProfile: () => profileState,
  useUpdateVerifiedProfile: () => updateState,
  useBadgeFunnel: () => funnelState,
  checkHandleAvailable: (h: string) => checkHandleAvailable(h),
}));
vi.mock("@/hooks/use-passport-identity", () => ({
  usePassportIdentityNodes: () => nodesState,
  useSetPassportReveal: () => ({ mutateAsync: revealMutate, isPending: false }),
}));
vi.mock("@/components/verified/badge-studio", () => ({
  BadgeStudio: () => null,
}));
vi.mock("@/components/help/page-help", () => ({ PageHelp: () => null }));
vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => confirmFn,
}));
vi.mock("@/hooks/use-navigation-guard", () => ({
  useNavigationGuard: () => ({ blocked: false, confirmLeave: () => {}, cancelLeave: () => {} }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { FlipdeskVerifiedPage } = await import("@/pages/flipdesk/verified");
const { toast } = await import("sonner");

function profile(over: Partial<Profile> = {}): Profile {
  return {
    handle: "alpha",
    display_name: "Alpha Store",
    account_name: null,
    bio: "Vintage denim.",
    enabled: false,
    verified_since: null,
    show_listings: false,
    embed_in_listings: false,
    ...over,
  };
}

function setProfile(p: Profile | undefined, graded = 0) {
  profileState.data = p ? { profile: p, stats: { total_graded: graded, average_grade: 0 } } : undefined;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(
      <MemoryRouter>
        <FlipdeskVerifiedPage />
      </MemoryRouter>,
    );
  });
  return container!;
}

function byText(tag: string, text: string): HTMLElement | undefined {
  return Array.from(container!.querySelectorAll<HTMLElement>(tag)).find(
    (el) => el.textContent?.trim() === text,
  );
}

function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function switchByLabel(labelId: string): HTMLButtonElement {
  const el = container!.querySelector<HTMLButtonElement>(`[role="switch"][aria-labelledby="${labelId}"]`);
  if (!el) throw new Error(`no switch labelled by ${labelId}`);
  return el;
}

function openTab(value: string) {
  const trigger = Array.from(container!.querySelectorAll<HTMLElement>('[role="tab"]')).find(
    (t) => t.getAttribute("aria-controls")?.endsWith(`-content-${value}`),
  );
  if (!trigger) throw new Error(`no tab ${value}`);
  act(() => {
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  profileState.isLoading = false;
  profileState.isError = false;
  profileState.isFetching = false;
  profileState.refetch = vi.fn();
  funnelState.data = undefined;
  funnelState.isLoading = false;
  funnelState.isError = false;
  nodesState.data = undefined;
  nodesState.isLoading = false;
  nodesState.isError = false;
  mutateAsync.mockReset();
  revealMutate.mockReset();
  checkHandleAvailable.mockReset();
  confirmFn.mockReset();
  vi.mocked(toast.success).mockReset();
  setProfile(profile());
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.useRealTimers();
});

describe("profile load failure (V1)", () => {
  it("shows an error card with Retry and no savable form", () => {
    profileState.isError = true;
    setProfile(undefined);
    const c = render();
    expect(c.textContent).toContain("Your Verified profile didn't load.");
    expect(c.querySelector("#handle")).toBeNull();
    expect(byText("button", "Save profile")).toBeUndefined();
    const retry = byText("button", "Retry");
    expect(retry).toBeDefined();
    act(() => retry!.click());
    expect(profileState.refetch).toHaveBeenCalledTimes(1);
  });
});

describe("public switch (V2)", () => {
  it("is disabled with a hint while the handle has unsaved edits", () => {
    const c = render();
    typeInto(c.querySelector<HTMLInputElement>("#handle")!, "beta");
    const sw = switchByLabel("public-switch-label");
    expect(sw.disabled).toBe(true);
    expect(c.textContent).toContain("Save your handle change first.");
  });

  it("sends only the enabled flag, never a handle", async () => {
    mutateAsync.mockResolvedValue(profile({ enabled: true }));
    render();
    const sw = switchByLabel("public-switch-label");
    expect(sw.disabled).toBe(false);
    act(() => sw.click());
    await flush();
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenCalledWith({ enabled: true });
  });
});

describe("display name is never pre-filled from the account (V3)", () => {
  it("starts empty and offers the account name as a choice", () => {
    setProfile(profile({ display_name: null, account_name: "Jane Q. Legal" }));
    const c = render();
    const input = c.querySelector<HTMLInputElement>("#display_name")!;
    expect(input.value).toBe("");
    const suggest = byText("button", "Use my account name (Jane Q. Legal)");
    expect(suggest).toBeDefined();
    act(() => suggest!.click());
    expect(c.querySelector<HTMLInputElement>("#display_name")!.value).toBe("Jane Q. Legal");
  });

  it("previews the handle, not a name, when no display name is set", () => {
    setProfile(profile({ display_name: null, account_name: "Jane Q. Legal" }));
    const c = render();
    const heroName = c.querySelector(".bg-brand-navy p.text-xl");
    expect(heroName?.textContent).toBe("alpha");
  });
});

describe("handle availability fails closed (V7)", () => {
  it("a failed check disables Save and says to try again", async () => {
    vi.useFakeTimers();
    checkHandleAvailable.mockRejectedValue(new Error("network"));
    const c = render();
    typeInto(c.querySelector<HTMLInputElement>("#handle")!, "beta-store");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(checkHandleAvailable).toHaveBeenCalledWith("beta-store");
    expect(c.textContent).toContain("Couldn't check that handle. Try again.");
    const save = byText("button", "Save profile") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });
});

describe("badge performance card (V8)", () => {
  function live() {
    setProfile(profile({ enabled: true }));
  }

  it("shows Retry on an error instead of disappearing", () => {
    live();
    funnelState.isError = true;
    const c = render();
    openTab("badges");
    expect(c.textContent).toContain("Couldn't load badge stats.");
    const retry = Array.from(c.querySelectorAll("button")).find((b) => b.textContent === "Retry");
    act(() => retry!.click());
    expect(funnelState.refetch).toHaveBeenCalled();
  });

  it("explains the empty state and links to Badge Studio", () => {
    live();
    funnelState.data = { clicksBySource: {}, totalClicks: 0, conversions: 0, windowDays: 30 };
    const c = render();
    openTab("badges");
    expect(c.textContent).toContain("No badge clicks yet.");
    expect(c.querySelector('a[href="#badge-studio"]')).not.toBeNull();
  });

  it("names sources in plain words", () => {
    live();
    funnelState.data = {
      clicksBySource: { qr: 3, embed: 1 },
      totalClicks: 4,
      conversions: 2,
      windowDays: 30,
    };
    const c = render();
    openTab("badges");
    expect(c.textContent).toContain("QR code scans");
    expect(c.textContent).toContain("Listing embeds");
    expect(c.textContent).toContain("Referral signups (all channels)");
  });
});

describe("save flow (V10)", () => {
  function saveButton() {
    return byText("button", "Save profile") as HTMLButtonElement;
  }

  it("Save is off on a fresh form and on after an edit", () => {
    const c = render();
    expect(saveButton().disabled).toBe(true);
    expect(c.textContent).not.toContain("Unsaved changes");
    typeInto(c.querySelector<HTMLTextAreaElement>("#bio")!, "Vintage denim and workwear.");
    expect(saveButton().disabled).toBe(false);
    expect(c.textContent).toContain("Unsaved changes");
  });

  it("a successful save says so and clears the dirty state", async () => {
    mutateAsync.mockResolvedValue(profile({ bio: "New bio" }));
    const c = render();
    typeInto(c.querySelector<HTMLTextAreaElement>("#bio")!, "New bio");
    act(() => saveButton().click());
    await flush();
    expect(toast.success).toHaveBeenCalledWith("Profile saved");
    expect(c.textContent).not.toContain("Unsaved changes");
  });

  it("a rejected save leaves no unhandled rejection", async () => {
    const seen: unknown[] = [];
    const onWindow = (e: PromiseRejectionEvent) => seen.push(e.reason);
    const onProcess = (r: unknown) => seen.push(r);
    window.addEventListener("unhandledrejection", onWindow);
    process.on("unhandledRejection", onProcess);
    try {
      mutateAsync.mockRejectedValue(new Error("server said no"));
      const c = render();
      typeInto(c.querySelector<HTMLTextAreaElement>("#bio")!, "New bio");
      act(() => saveButton().click());
      await flush();
      await new Promise((r) => setTimeout(r, 0));
      expect(seen).toEqual([]);
      expect(toast.success).not.toHaveBeenCalled();
      // The edit is kept.
      expect(c.querySelector<HTMLTextAreaElement>("#bio")!.value).toBe("New bio");
    } finally {
      window.removeEventListener("unhandledrejection", onWindow);
      process.off("unhandledRejection", onProcess);
    }
  });

  it("renaming a live handle asks first, and Cancel sends nothing", async () => {
    vi.useFakeTimers();
    setProfile(profile({ enabled: true }));
    checkHandleAvailable.mockResolvedValue({ available: true, reason: null });
    confirmFn.mockResolvedValue(false);
    const c = render();
    typeInto(c.querySelector<HTMLInputElement>("#handle")!, "beta-store");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    act(() => saveButton().click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(confirmFn).toHaveBeenCalledTimes(1);
    expect(String(confirmFn.mock.calls[0]?.[0]?.description)).toContain("/verified/alpha");
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("the preview names the saved URL under Live, and the draft separately", () => {
    setProfile(profile({ enabled: true }));
    const c = render();
    typeInto(c.querySelector<HTMLInputElement>("#handle")!, "beta");
    expect(c.textContent).toContain("Live at gradethread.com/verified/alpha");
    expect(c.textContent).toContain("Unsaved: /verified/beta");
  });
});

describe("passport identity tab (V11)", () => {
  function node(id: string, brand: string) {
    return {
      node_id: id,
      label: `Owner ${id}`,
      kind: "seller",
      revealed: false,
      revealed_at: null,
      revealed_effective: false,
      passport_slug: null,
      sku_class: { brand },
    };
  }

  it("shows Retry when the list fails", () => {
    nodesState.isError = true;
    const c = render();
    openTab("passport");
    expect(c.textContent).toContain("Couldn't load your passports.");
    const retry = Array.from(c.querySelectorAll("button")).find((b) => b.textContent === "Retry");
    act(() => retry!.click());
    expect(nodesState.refetch).toHaveBeenCalled();
  });

  it("explains an empty list and links to start a grade", () => {
    nodesState.data = { verified_profile_public: true, verified_handle: "alpha", nodes: [] };
    const c = render();
    openTab("passport");
    expect(c.textContent).toContain("A passport is created when an item you own is graded");
    expect(c.querySelector('a[href="/dashboard/submissions/new"]')).not.toBeNull();
  });

  it("keeps each of two quick toggles disabled until its own request settles", async () => {
    nodesState.data = {
      verified_profile_public: true,
      verified_handle: "alpha",
      nodes: [node("n1", "Levi's"), node("n2", "Carhartt")],
    };
    const resolvers: Record<string, () => void> = {};
    revealMutate.mockImplementation(
      ({ nodeId }: { nodeId: string }) =>
        new Promise<void>((r) => {
          resolvers[nodeId] = r;
        }),
    );
    const c = render();
    openTab("passport");
    const sw = (brand: string) =>
      c.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="Reveal identity on ${brand}"]`)!;
    act(() => sw("Levi's").click());
    act(() => sw("Carhartt").click());
    expect(sw("Levi's").disabled).toBe(true);
    expect(sw("Carhartt").disabled).toBe(true);
    await act(async () => {
      resolvers.n1?.();
    });
    expect(sw("Levi's").disabled).toBe(false);
    expect(sw("Carhartt").disabled).toBe(true);
    await act(async () => {
      resolvers.n2?.();
    });
    expect(sw("Carhartt").disabled).toBe(false);
  });

  it("'publish first' sends the seller to the Profile tab", () => {
    nodesState.data = {
      verified_profile_public: false,
      verified_handle: null,
      nodes: [node("n1", "Levi's")],
    };
    const c = render();
    openTab("passport");
    const go = Array.from(c.querySelectorAll("button")).find(
      (b) => b.textContent === "Go to your profile",
    );
    expect(go).toBeDefined();
    act(() => go!.click());
    expect(c.querySelector("#handle")).not.toBeNull();
  });
});

describe("switch rows and form accessibility (V12)", () => {
  it("while private, storefront and embed read Off with one hint", () => {
    setProfile(profile({ enabled: false, show_listings: true, embed_in_listings: true }));
    const c = render();
    expect(switchByLabel("storefront-switch-label").getAttribute("aria-checked")).toBe("false");
    expect(switchByLabel("embed-switch-label").getAttribute("aria-checked")).toBe("false");
    expect(c.textContent).toContain("These turn back on when your profile is public.");
  });

  it("while live, they show the saved choice and no hint", () => {
    setProfile(profile({ enabled: true, show_listings: true, embed_in_listings: false }));
    const c = render();
    expect(switchByLabel("storefront-switch-label").getAttribute("aria-checked")).toBe("true");
    expect(switchByLabel("embed-switch-label").getAttribute("aria-checked")).toBe("false");
    expect(c.textContent).not.toContain("These turn back on");
  });

  it("the handle input is described by a live status node", () => {
    const c = render();
    const input = c.querySelector<HTMLInputElement>("#handle")!;
    const id = input.getAttribute("aria-describedby");
    expect(id).toBe("handle-status");
    expect(c.querySelector(`#${id}`)?.getAttribute("role")).toBe("status");
    expect(c.querySelector("#bio")?.getAttribute("aria-describedby")).toBe("bio-count");
  });

  it("the page source carries no em dash", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/pages/flipdesk/verified.tsx", "utf8")).not.toContain("—");
  });
});

describe("readiness strip (V13)", () => {
  it("counts what is done and takes the seller to the next control", () => {
    setProfile(profile({ handle: "alpha", bio: "Denim.", enabled: false }), 0);
    const c = render();
    expect(c.textContent).toContain("Setup: 2 of 6 done");
    const btn = byText("button", "Make profile public");
    expect(btn).toBeDefined();
    act(() => btn!.click());
    expect(document.activeElement).toBe(switchByLabel("public-switch-label"));
  });

  it("links 'Grade your first item' to a new grade", () => {
    setProfile(profile(), 0);
    const c = render();
    const link = Array.from(c.querySelectorAll("a")).find((a) => a.textContent === "Grade your first item");
    expect(link?.getAttribute("href")).toBe("/dashboard/submissions/new");
  });
});
