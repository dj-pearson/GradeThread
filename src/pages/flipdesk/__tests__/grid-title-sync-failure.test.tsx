// US-3376 AC5, rank 3: the US-1995 listing-title sync in the inventory grid.
//
// Editing Brand, Style or Size here has to drag the live listing TITLE along,
// or a seller who fixes a brand across twenty rows gets twenty listings still
// naming the old one, in the field buyers search hardest. The write that does it
// dropped its result, and so did the read that finds the listings, so a refusal
// showed as "Saved 1 row." and nothing else.
//
// Best-effort for the ROW is still right and is unchanged: the item save
// succeeded and must not be reported as a failure. What changed is that
// best-effort stopped meaning silent. This mounts the real page, edits a Brand
// cell, presses Save all, and asserts the SECOND toast the seller gets.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const TEST_USER = { id: "11111111-1111-4111-8111-111111111111" };
const ITEM_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const LISTING_ID = "bbbbbbbb-0000-4000-8000-000000000002";

// -- supabase ----------------------------------------------------------------
// Three shapes are needed, and they must be told apart:
//   items_full   select().order().range()      -> the page of rows
//   listings     select().in()                 -> the title-sync read
//   inventory_items update().eq()              -> the row save
//   listings     update().eq()                 -> the title write
let listingsReadError: unknown = null;
let titleWriteError: unknown = null;
let itemWriteError: unknown = null;
const titleWrites: Record<string, unknown>[] = [];
const listingsReads: number[] = [];

const ROW = {
  id: ITEM_ID,
  user_id: TEST_USER.id,
  item_number: "SKU-1",
  item_title: "Detroit jacket",
  brand: "Carhart",
  style: "J97",
  size: "L",
  status: "listed",
  listing_id: LISTING_ID,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const LISTING = {
  id: LISTING_ID,
  inventory_item_id: ITEM_ID,
  listing_title: "Carhart Detroit jacket J97 L",
  title_variants: null,
  listing_origin: "gradethread",
  ai_generated_snapshot: { title: "Carhart Detroit jacket J97 L" },
};

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        order: () => ({
          range: () =>
            Promise.resolve({ data: [ROW], error: null, count: 1 }),
        }),
        // The title-sync read. Resolves with { error } - it does not reject.
        in: () => {
          listingsReads.push(1);
          return Promise.resolve({
            data: listingsReadError ? null : [LISTING],
            error: listingsReadError,
          });
        },
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: () => {
          if (table === "listings") {
            titleWrites.push(patch);
            return Promise.resolve({ data: null, error: titleWriteError });
          }
          return Promise.resolve({ data: null, error: itemWriteError });
        },
      }),
    }),
    auth: {
      getSession: () =>
        Promise.resolve({ data: { session: { user: TEST_USER } }, error: null }),
      getUser: () => Promise.resolve({ data: { user: TEST_USER }, error: null }),
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe: () => {} } },
      }),
      refreshSession: () =>
        Promise.resolve({ data: { session: { user: TEST_USER } }, error: null }),
    },
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
    removeChannel: () => {},
    storage: {
      from: () => ({
        createSignedUrl: () => Promise.resolve({ data: null, error: null }),
      }),
    },
  },
}));

const successes: string[] = [];
const warnings: { fallback?: string; nextStep?: string }[] = [];
vi.mock("sonner", () => ({
  toast: {
    success: (m: string) => successes.push(m),
    error: () => {},
    warning: () => {},
    message: () => {},
  },
}));
vi.mock("@/lib/toast-error", () => ({
  toastError: () => ({}),
  toastWarning: (
    _e: unknown,
    fallback?: string,
    ctx?: { nextStep?: string },
  ) => {
    warnings.push({ fallback, nextStep: ctx?.nextStep });
    return {};
  },
}));

import { useAuthStore } from "@/stores/auth-store";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { FlipdeskGridPage } from "@/pages/flipdesk/grid";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  // A DATA router: the grid uses useNavigationGuard -> useBlocker, which throws
  // outside one.
  const router = createMemoryRouter(
    [{ path: "*", element: h(ConfirmProvider, null, node) }],
    { initialEntries: ["/dashboard/flipdesk/grid"] },
  );
  act(() => {
    root = createRoot(container!);
    root.render(
      h(QueryClientProvider, { client: qc }, h(RouterProvider, { router })),
    );
  });
}

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function editBrandAndSave(value: string) {
  const cell = document.querySelector<HTMLInputElement>(
    'input[aria-label="Brand, row 1"]',
  );
  expect(cell).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(cell!, value);
    cell!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const save = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Save all",
  );
  expect(save).toBeTruthy();
  await act(async () => {
    (save as HTMLElement).click();
  });
  await settle();
}

beforeEach(() => {
  successes.length = 0;
  warnings.length = 0;
  titleWrites.length = 0;
  listingsReads.length = 0;
  listingsReadError = null;
  titleWriteError = null;
  itemWriteError = null;
  useAuthStore.setState({
    user: TEST_USER as never,
    session: { user: TEST_USER } as never,
    isLoading: false,
    activeWorkspaceOwnerId: TEST_USER.id,
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

describe("inventory grid: the listing-title sync", () => {
  it("says the live listing still names the old brand when the title write is refused", async () => {
    titleWriteError = {
      code: "42501",
      message: "new row violates row-level security policy",
    };
    mount(h(FlipdeskGridPage));
    await settle();
    await editBrandAndSave("Carhartt");

    // It really tried to rewrite the title, so this is about the answer and not
    // about a branch that never ran.
    expect(titleWrites).toHaveLength(1);
    // The row DID save, and still reports so. That half is deliberate.
    expect(successes).toEqual(["Saved 1 row."]);
    // The half that used to be silent.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.fallback).toContain("1 live listing title");
    expect(warnings[0]!.fallback).toContain("may still name the old value");
    expect(warnings[0]!.nextStep).toContain("save again");
  });

  it("says so when the listings read fails, which silently skipped EVERY title", async () => {
    // The worse half of the same bug: a refused read left the map empty, every
    // syncListingTitle returned early on `!lst`, and no title followed anywhere
    // while the save reported a clean success.
    listingsReadError = { message: "permission denied for table listings" };
    mount(h(FlipdeskGridPage));
    await settle();
    await editBrandAndSave("Carhartt");

    expect(listingsReads).toHaveLength(1);
    expect(titleWrites).toHaveLength(0);
    expect(successes).toEqual(["Saved 1 row."]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.fallback).toContain("may still name the old value");
  });

  it("stays quiet when the title really followed", async () => {
    mount(h(FlipdeskGridPage));
    await settle();
    await editBrandAndSave("Carhartt");

    expect(titleWrites).toHaveLength(1);
    expect(successes).toEqual(["Saved 1 row."]);
    expect(warnings).toEqual([]);
  });
});
