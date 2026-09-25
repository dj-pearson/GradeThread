// ACC-10: when every photo in the sweep failed, the card said "No photos
// eligible", which hid a broken storage setup. Errors are checked first now,
// and a batch that leaves more waiting offers to run the next one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let response: unknown = null;
vi.mock("@/hooks/use-image-archive", () => ({
  useArchivePhotos: () => ({ mutateAsync: async () => response, isPending: false }),
}));
const toastCalls: Array<[string, unknown[]]> = [];
vi.mock("sonner", () => {
  const rec = (kind: string) => (...a: unknown[]) => toastCalls.push([kind, a]);
  return { toast: { info: rec("info"), success: rec("success"), warning: rec("warning"), error: rec("error") } };
});
vi.mock("@/lib/toast-error", () => ({
  toastWarning: (...a: unknown[]) => toastCalls.push(["toastWarning", a]),
}));

import { PhotoArchiveCard } from "@/components/settings/photo-archive-card";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
beforeEach(() => {
  toastCalls.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(<PhotoArchiveCard />);
  });
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

async function clickArchive() {
  await act(async () => {
    container!.querySelector("button")!.click();
  });
}

describe("PhotoArchiveCard result toasts", () => {
  it("all failed: a warning carrying the error, not 'none eligible'", async () => {
    response = { archived: 0, freed_bytes: 0, errors: [{ photo_id: "p", message: "x" }], remaining: 0 };
    await clickArchive();
    expect(toastCalls).toHaveLength(1);
    const [kind, args] = toastCalls[0]!;
    expect(kind).toBe("warning");
    expect(JSON.stringify(args)).toContain("x");
    expect(JSON.stringify(args)).not.toMatch(/eligible|ready to archive/i);
  });

  it("nothing to do: an info toast", async () => {
    response = { archived: 0, freed_bytes: 0, errors: [], remaining: 0 };
    await clickArchive();
    expect(toastCalls[0]![0]).toBe("info");
  });

  it("more waiting: says so and offers the next batch", async () => {
    response = { archived: 50, freed_bytes: 1024 * 1024, errors: [], remaining: "unknown" };
    await clickArchive();
    const [kind, args] = toastCalls[0]!;
    expect(kind).toBe("success");
    expect(String(args[0])).toContain("More photos are waiting.");
    expect((args[1] as { action: { label: string } }).action.label).toBe("Archive next batch");
  });
});
