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

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));
vi.mock("@/lib/account-export", () => ({
  buildAccountExport: () => buildAccountExport(),
}));
vi.mock("@/lib/download", () => ({ downloadBlob: vi.fn() }));
vi.mock("@/lib/edge-fetch", () => ({ edgeFetch: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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
  useAccountExportStore.getState().finish();
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
});
