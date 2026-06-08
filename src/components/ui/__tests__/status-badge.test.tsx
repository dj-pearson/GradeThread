import { describe, it, expect, afterEach } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ITEM_STATUSES,
  ITEM_STATUS_LABELS,
  ITEM_STATUS_TONE,
  STATUS_TONE_CLASSES,
} from "@/lib/constants";
import { StatusBadge } from "@/components/ui/status-badge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("status badge maps (US-728)", () => {
  it("every item status has a label and a tone that resolves to classes", () => {
    for (const status of ITEM_STATUSES) {
      expect(ITEM_STATUS_LABELS[status], `label for ${status}`).toBeTruthy();
      const tone = ITEM_STATUS_TONE[status];
      expect(tone, `tone for ${status}`).toBeTruthy();
      expect(
        STATUS_TONE_CLASSES[tone],
        `classes for tone ${tone}`,
      ).toBeTruthy();
    }
  });
});

describe("StatusBadge", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
  });

  it("renders the status label and its tone classes", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container!);
      root.render(h(StatusBadge, { status: "sold" }));
    });
    const span = container.querySelector("span");
    expect(span?.textContent).toBe(ITEM_STATUS_LABELS.sold);
    // success tone → emerald
    expect(span?.className).toContain("emerald");
  });
});
