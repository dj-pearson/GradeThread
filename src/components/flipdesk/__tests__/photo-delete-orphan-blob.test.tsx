// US-3381 AC1 + AC4. The uploader's photo delete.
//
// `await supabase.storage.from("item-photos").remove(paths)` dropped its
// result. A storage remove RESOLVES with { data, error } like everything else
// in supabase-js, so the try/catch around it was dead and a refused blob delete
// fell straight through to the row delete below it. The row is the only thing
// that points at those objects: deleting it second turns a failed blob delete
// into an object nobody can find, reclaim, or purge the PII out of -- under a
// success toast and a photo that vanishes from the grid.
//
// THE MOCK RESOLVES AND NEVER REJECTS, except in the one case that says so.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const ITEM_ID = "aaaaaaaa-0000-4000-8000-000000000001";

const PHOTOS = [
  {
    id: "photo-front",
    inventory_item_id: ITEM_ID,
    photo_type: "front",
    photo_role: null,
    sort_order: 0,
    photo_url: "https://example.test/front.jpg",
    thumbnail_url: null,
    storage_path: "user-1/front.jpg",
    thumbnail_storage_path: "user-1/front-thumb.jpg",
    original_storage_path: null,
    edit_recipe: null,
  },
];

let blobRemoveError: unknown = null;
let blobRemoveRejects = false;
let rowDeleteError: unknown = null;
const removedPaths: string[][] = [];
const rowDeletes: string[] = [];

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          order: () => Promise.resolve({ data: PHOTOS, error: null }),
        }),
      }),
      delete: () => ({
        eq: (_col: string, id: string) => {
          rowDeletes.push(`${table}:${id}`);
          return Promise.resolve({ data: null, error: rowDeleteError });
        },
      }),
    }),
    storage: {
      from: () => ({
        remove: (paths: string[]) => {
          removedPaths.push(paths);
          if (blobRemoveRejects) return Promise.reject(new Error("network down"));
          // Resolves. Never rejects. This is the whole point.
          return Promise.resolve({ data: null, error: blobRemoveError });
        },
        createSignedUrl: () => Promise.resolve({ data: null, error: null }),
        getPublicUrl: () => ({ data: { publicUrl: "https://example.test/front.jpg" } }),
      }),
    },
  },
}));

const errors: string[] = [];
vi.mock("@/lib/toast-error", () => ({
  toastError: (_e: unknown, fallback?: string) => {
    errors.push(fallback ?? "");
    return {};
  },
  toastWarning: () => ({}),
}));
vi.mock("sonner", () => ({
  toast: { success: () => {}, error: () => {}, warning: () => {}, info: () => {}, message: () => {} },
}));

// The delete is behind a destructive confirm (US-3240). Auto-confirm it.
vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => () => Promise.resolve(true),
}));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: "user-1" } }),
}));
vi.mock("@/hooks/use-workspace", () => ({
  useWorkspace: () => ({ workspaceOwnerId: "user-1", can: () => true }),
}));
vi.mock("@/hooks/use-google-photos-import", () => ({
  useGooglePhotosImport: () => ({ enabled: false, providers: [] }),
}));
vi.mock("@/hooks/use-cloud-folder-import", () => ({
  useCloudFolderImport: () => ({ providers: [] }),
}));

const { PhotoUploader } = await import("@/components/flipdesk/photo-uploader");

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
        h(PhotoUploader, { itemId: ITEM_ID, category: "clothing" } as never),
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

async function clickRemove() {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => b.getAttribute("aria-label") === "Remove photo",
  );
  expect(button, "no Remove photo button rendered").toBeTruthy();
  await act(async () => {
    (button as HTMLElement).click();
  });
  await settle();
}

beforeEach(() => {
  blobRemoveError = null;
  blobRemoveRejects = false;
  rowDeleteError = null;
  removedPaths.length = 0;
  rowDeletes.length = 0;
  errors.length = 0;
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

describe("photo delete: the storage remove whose catch was dead", () => {
  it("keeps the row when a RESOLVED refusal leaves the blobs behind", async () => {
    blobRemoveError = { message: "Object not found", statusCode: "404" };
    mount();
    await settle();
    await clickRemove();

    // It really tried, with both the working file and the thumbnail.
    expect(removedPaths).toEqual([["user-1/front.jpg", "user-1/front-thumb.jpg"]]);
    // And it stopped. The row is what points at those objects; deleting it now
    // would strand them forever.
    expect(rowDeletes).toEqual([]);
    expect(errors).toEqual(["Delete failed."]);
  });

  it("still reports a real rejection, which is all the catch ever caught", async () => {
    blobRemoveRejects = true;
    mount();
    await settle();
    await clickRemove();

    expect(rowDeletes).toEqual([]);
    expect(errors).toEqual(["Delete failed."]);
  });

  it("deletes the row once the blobs are really gone", async () => {
    mount();
    await settle();
    await clickRemove();

    expect(removedPaths).toHaveLength(1);
    expect(rowDeletes).toEqual(["item_photos:photo-front"]);
    expect(errors).toEqual([]);
  });
});
