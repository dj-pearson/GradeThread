// Switching Settings tabs unmounts DataSettingsTab. While the export flag
// lived in useState, coming back to the Data tab mid-export showed an enabled
// button, and a second click started a second export alongside the first.
// The flag now lives in useAccountExportStore; this renders the tab, unmounts it
// mid-export, remounts it and checks the button stays disabled.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";

// React 19 requires this flag for act() to flush effects in a test env.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let resolveExport: ((b: Blob) => void) | null = null;
const buildAccountExport = vi.fn(
  () =>
    new Promise<Blob>((resolve) => {
      resolveExport = resolve;
    }),
);

let currentUserId = "user-1";
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: currentUserId } }),
}));
vi.mock("@/lib/account-export", () => ({
  buildAccountExport: () => buildAccountExport(),
}));
const downloadBlob = vi.fn();
vi.mock("@/lib/download", () => ({
  downloadBlob: (...args: unknown[]) => downloadBlob(...args),
}));
const edgeFetch = vi.fn<(...args: unknown[]) => Promise<Response>>(
  async () => new Response("{}", { status: 200 }),
);
vi.mock("@/lib/edge-fetch", () => ({
  edgeFetch: (...args: unknown[]) => edgeFetch(...args),
}));
// The deletion-request confirm: each test sets what the dialog answers.
let confirmAnswer = false;
const confirmFn = vi.fn<(...args: unknown[]) => Promise<boolean>>(
  async () => confirmAnswer,
);
vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => (...args: unknown[]) => confirmFn(...args),
}));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

import { DataSettingsTab } from "@/components/settings/data-settings-tab";
import { useAccountExportStore } from "@/stores/account-export-store";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(
      <MemoryRouter>
        <DataSettingsTab />
      </MemoryRouter>,
    );
  });
}
function unmount() {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
}
function exportButton(): HTMLButtonElement {
  const b = [...container!.querySelectorAll("button")].find((el) =>
    /export my data/i.test(el.textContent ?? ""),
  );
  if (!b) throw new Error("Export button not rendered");
  return b;
}

afterEach(() => {
  unmount();
  useAccountExportStore.getState().clear();
  currentUserId = "user-1";
  buildAccountExport.mockClear();
  resolveExport = null;
  localStorage.clear();
});

describe("DataSettingsTab export in-flight state", () => {
  it("stays disabled across an unmount/remount while the export runs", async () => {
    mount();
    await act(async () => {
      exportButton().click();
    });
    expect(buildAccountExport).toHaveBeenCalledTimes(1);
    expect(exportButton().disabled).toBe(true);

    // The user switches to another tab and back.
    unmount();
    mount();
    expect(exportButton().disabled).toBe(true);
    expect(container!.textContent).toContain("Starting…");

    // A disabled button ignores clicks, so call the handler path the way a
    // second click would reach it if the button were enabled.
    exportButton().disabled = false;
    await act(async () => {
      exportButton().click();
    });
    expect(buildAccountExport).toHaveBeenCalledTimes(1);

    // Finishing the first export frees the button on the remounted tab.
    await act(async () => {
      resolveExport!(new Blob(["zip"]));
    });
    expect(exportButton().disabled).toBe(false);
  });

  it("does not block a different user on the same browser", async () => {
    mount();
    await act(async () => {
      exportButton().click();
    });
    expect(exportButton().disabled).toBe(true);
    const firstExport = resolveExport!;

    // user-1 leaves without the store being cleared (worst case); user-2 arrives.
    unmount();
    currentUserId = "user-2";
    mount();
    expect(exportButton().disabled).toBe(false);
    await act(async () => {
      exportButton().click();
    });
    expect(buildAccountExport).toHaveBeenCalledTimes(2);
    expect(exportButton().disabled).toBe(true);

    // user-1's export settling late does not free user-2's slot.
    await act(async () => {
      firstExport(new Blob(["zip"]));
    });
    expect(exportButton().disabled).toBe(true);
  });
});

describe("DataSettingsTab export when storage refuses writes", () => {
  it("still downloads and shows success when setItem throws", async () => {
    downloadBlob.mockClear();
    toastSuccess.mockClear();
    toastError.mockClear();
    // src/test/setup.ts swaps in an in-memory localStorage that is not a
    // Storage instance, so spy on the object itself rather than the prototype.
    const spy = vi
      .spyOn(localStorage, "setItem")
      .mockImplementation(() => {
        throw new DOMException("full", "QuotaExceededError");
      });
    try {
      mount();
      await act(async () => {
        exportButton().click();
      });
      await act(async () => {
        resolveExport!(new Blob(["zip"]));
      });
      expect(downloadBlob).toHaveBeenCalledTimes(1);
      expect(toastSuccess).toHaveBeenCalledWith(
        "Your data export has been downloaded.",
      );
      expect(toastError).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("formal deletion request", () => {
  function requestDeletion(): HTMLButtonElement {
    return [...container!.querySelectorAll("button")].find((el) =>
      /request data deletion/i.test(el.textContent ?? ""),
    ) as HTMLButtonElement;
  }

  it("asks first, and cancelling sends no request", async () => {
    edgeFetch.mockClear();
    confirmFn.mockClear();
    confirmAnswer = false;
    mount();
    await act(async () => {
      requestDeletion().click();
    });
    expect(confirmFn).toHaveBeenCalledTimes(1);
    expect(confirmFn.mock.calls[0]![0]).toMatchObject({ destructive: true });
    expect(edgeFetch).not.toHaveBeenCalled();
  });

  it("confirming files the request", async () => {
    edgeFetch.mockClear();
    confirmAnswer = true;
    mount();
    await act(async () => {
      requestDeletion().click();
    });
    expect(edgeFetch).toHaveBeenCalledWith("/api/account/data-requests", {
      method: "POST",
      json: { type: "delete" },
    });
  });
});

describe("useAccountExportStore", () => {
  it("clear() frees the slot, and a stale owner's progress and finish are ignored", () => {
    const store = useAccountExportStore.getState();
    expect(store.begin("user-1")).toBe(true);
    expect(store.begin("user-1")).toBe(false);
    store.clear();
    expect(useAccountExportStore.getState().exporting).toBe(false);

    expect(store.begin("user-2")).toBe(true);
    store.progress("user-1", "Old stage", 90);
    store.finish("user-1");
    expect(useAccountExportStore.getState()).toMatchObject({
      ownerId: "user-2",
      exporting: true,
      pct: 0,
    });
    store.finish("user-2");
    expect(useAccountExportStore.getState().exporting).toBe(false);
  });

  it("is cleared on the sign-out branch of use-auth", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/hooks/use-auth.ts", "utf8");
    const signedOut = src.slice(src.indexOf("// SIGNED_OUT:"));
    expect(signedOut).toMatch(/useAccountExportStore\.getState\(\)\.clear\(\)/);
  });
});
