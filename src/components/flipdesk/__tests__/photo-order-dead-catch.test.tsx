// US-3376 AC2: a try/catch around a supabase builder is NOT protection.
//
// persistOrder wrapped a Promise.all over PostgrestFilterBuilders in a
// try/catch. A builder RESOLVES with { error } on a 400 or an RLS refusal - it
// does not reject - so the catch only ever fired on a network drop. Every other
// refusal let the optimistic order stand until the next invalidate silently
// reverted it, with no toast, and the seller's cover photo (index 0, which is
// the eBay search thumbnail) quietly went back to what it was.
//
// This is a shape a source scan cannot see: the code LOOKS handled. So it is
// driven through the "Make it the main photo" button, with the update resolving
// an error and never rejecting, and the assertion is the toast.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const ITEM_ID = "aaaaaaaa-0000-4000-8000-000000000001";

// A tag shot first and a front shot second, which is exactly the state the
// US-1896 hero nudge exists for - so the one-click reorder button renders.
const PHOTOS = [
  {
    id: "photo-tag",
    inventory_item_id: ITEM_ID,
    photo_type: "tag",
    sort_order: 0,
    photo_url: "https://example.test/tag.jpg",
    thumbnail_url: null,
    storage_path: null,
  },
  {
    id: "photo-front",
    inventory_item_id: ITEM_ID,
    photo_type: "front",
    sort_order: 1,
    photo_url: "https://example.test/front.jpg",
    thumbnail_url: null,
    storage_path: null,
  },
];

let sortUpdateError: unknown = null;
let sortUpdateRejects = false;
const sortWrites: Record<string, unknown>[] = [];

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        eq: () => {
          const rows =
            table === "item_photos" ? PHOTOS : ([] as unknown[]);
          const res = Promise.resolve({ data: rows, error: null });
          return Object.assign(res, {
            order: () => Promise.resolve({ data: rows, error: null }),
          });
        },
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: () => {
          sortWrites.push(patch);
          if (sortUpdateRejects) return Promise.reject(new Error("network down"));
          // Resolves. Never rejects. This is the whole point.
          return Promise.resolve({ data: null, error: sortUpdateError });
        },
      }),
    }),
    storage: {
      from: () => ({
        createSignedUrl: () => Promise.resolve({ data: null, error: null }),
        getPublicUrl: () => ({ data: { publicUrl: "" } }),
      }),
    },
  },
}));

const errors: { fallback?: string; nextStep?: string }[] = [];
vi.mock("sonner", () => ({
  toast: {
    success: () => {},
    error: (m: string) => errors.push({ fallback: m }),
    warning: () => {},
    message: () => {},
  },
}));
vi.mock("@/lib/toast-error", () => ({
  toastError: (
    _e: unknown,
    fallback?: string,
    ctx?: { nextStep?: string },
  ) => {
    errors.push({ fallback, nextStep: ctx?.nextStep });
    return {};
  },
  toastWarning: () => ({}),
}));

vi.mock("@/hooks/use-ebay", () => ({
  useEbayReviseListing: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRemovePhotoBackground: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useEbayPhotoTone: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/use-adopt-remote-photos", () => ({
  useAdoptRemotePhotos: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/use-queue-revise", () => ({
  useQueueRevise: () => ({ mutate: () => {} }),
}));

const { PhotoManager } = await import("@/components/flipdesk/photo-manager");

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
        h(PhotoManager, { itemId: ITEM_ID, garment: "jacket" } as never),
      ),
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

async function makeItTheMainPhoto() {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Make it the main photo",
  );
  expect(button).toBeTruthy();
  await act(async () => {
    (button as HTMLElement).click();
  });
  await settle();
}

beforeEach(() => {
  errors.length = 0;
  sortWrites.length = 0;
  sortUpdateError = null;
  sortUpdateRejects = false;
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

describe("PhotoManager reorder: the catch that was dead", () => {
  it("tells the seller when a RESOLVED refusal reverts the new cover photo", async () => {
    sortUpdateError = {
      code: "42501",
      message: "new row violates row-level security policy",
    };
    mount();
    await settle();
    await makeItTheMainPhoto();

    // The reorder really was attempted for both photos.
    expect(sortWrites).toHaveLength(2);
    // The failure the old try/catch could not see.
    expect(errors).toHaveLength(1);
    expect(errors[0]!.fallback).toBe("Couldn't save the new photo order.");
    expect(errors[0]!.nextStep).toContain("old order is back");
  });

  it("still reports a real rejection, which is all the catch ever caught", async () => {
    sortUpdateRejects = true;
    mount();
    await settle();
    await makeItTheMainPhoto();

    expect(errors).toHaveLength(1);
    expect(errors[0]!.fallback).toBe("Couldn't save the new photo order.");
  });

  it("stays quiet when the reorder lands", async () => {
    mount();
    await settle();
    await makeItTheMainPhoto();

    expect(sortWrites).toHaveLength(2);
    expect(errors).toEqual([]);
  });
});
