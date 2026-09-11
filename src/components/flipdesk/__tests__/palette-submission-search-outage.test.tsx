// US-3381 AC1 + AC4. The command palette's submissions search.
//
// US-2517 fixed the flipdesk_search RPC beside it and left this one alone: a
// try/catch around `const { data } = await supabase.from("submissions")...`.
// A PostgrestFilterBuilder RESOLVES with { data: null, error } on a 400 or an
// RLS refusal, so the catch only ever fired on a network drop, and every other
// failure emptied the Submissions section while the FlipDesk sections kept
// showing hits. The palette then reads as "you own no submission called that",
// which is a claim about the seller's inventory that nobody made.
//
// THE MOCK RESOLVES AND NEVER REJECTS, except in the one case that says so.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let submissionsError: unknown = null;
let submissionsRejects = false;
let submissionRows: unknown[] = [];
let rpcError: unknown = null;

function submissionsChain() {
  const self: Record<string, unknown> = {};
  for (const k of ["select", "ilike", "order", "limit"]) self[k] = () => self;
  self["then"] = (
    onFulfilled: (v: unknown) => unknown,
    onRejected?: (e: unknown) => unknown,
  ) => {
    // The one case that rejects, because a dropped socket really does.
    if (submissionsRejects) {
      return Promise.reject(new Error("network down")).then(onFulfilled, onRejected);
    }
    // Otherwise it RESOLVES, error and all. This is the whole point.
    return Promise.resolve({
      data: submissionsError ? null : submissionRows,
      error: submissionsError,
    }).then(onFulfilled, onRejected);
  };
  return self;
}

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => submissionsChain(),
    rpc: () => Promise.resolve({ data: rpcError ? null : [], error: rpcError }),
  },
}));
vi.mock("@/lib/recent-searches", () => ({
  fetchRecentSearches: () => Promise.resolve([]),
  recordSearch: () => {},
}));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ user: { id: "user-1" }, profile: { role: "user" } }),
}));
vi.mock("@/stores/recent-store", () => ({
  useRecentStore: (sel: (s: unknown) => unknown) => sel({ recentItemIds: [] }),
}));
vi.mock("@/hooks/use-workspace", () => ({
  useWorkspace: () => ({ can: () => true }),
}));

const { CommandPalette, OPEN_COMMAND_PALETTE_EVENT } = await import(
  "@/components/flipdesk/command-palette"
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  act(() => {
    root = createRoot(container!);
    root.render(
      h(
        QueryClientProvider,
        { client: qc },
        h(MemoryRouter, null, h(CommandPalette)),
      ),
    );
  });
}

async function settle(ms = 0) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function openAndType(term: string) {
  await act(async () => {
    window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT));
  });
  const input = document.querySelector("input");
  expect(input, "the palette did not open").toBeTruthy();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, term);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // Past the 250ms debounce, then let the read settle.
  await settle(300);
  await settle(0);
}

function bodyText(): string {
  return document.body.textContent ?? "";
}

beforeEach(() => {
  submissionsError = null;
  submissionsRejects = false;
  submissionRows = [];
  rpcError = null;
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

describe("the palette's submissions search: the catch that was dead", () => {
  it("warns the results are incomplete on a RESOLVED refusal", async () => {
    submissionsError = {
      code: "42501",
      message: "permission denied for table submissions",
    };
    mount();
    await openAndType("carhartt");

    const alerts = Array.from(document.querySelectorAll('[role="alert"]'))
      .map((n) => n.textContent ?? "")
      .join(" | ");
    expect(alerts).toContain("Submission search is unavailable right now");
    // And the empty state stops claiming there is nothing to find.
    expect(bodyText()).not.toContain("No matches.");
  });

  it("still reports a real rejection, which is all the catch ever caught", async () => {
    submissionsRejects = true;
    mount();
    await openAndType("carhartt");

    const alerts = Array.from(document.querySelectorAll('[role="alert"]'))
      .map((n) => n.textContent ?? "")
      .join(" | ");
    expect(alerts).toContain("unavailable right now");
  });

  it("says nothing when the search really is empty", async () => {
    submissionRows = [];
    mount();
    await openAndType("carhartt");

    expect(bodyText()).not.toContain("unavailable right now");
    expect(bodyText()).toContain("No matches.");
  });

  it("shows the hits, and no warning, when the read lands", async () => {
    submissionRows = [
      { id: "sub-1", title: "Carhartt Detroit jacket", brand: "Carhartt", status: "graded" },
    ];
    mount();
    await openAndType("carhartt");

    expect(bodyText()).toContain("Carhartt Detroit jacket");
    expect(bodyText()).not.toContain("unavailable right now");
  });
});
