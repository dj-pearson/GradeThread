// US-1075: the cross-surface activation nudge is measurable (event-tracked),
// dismissable (persists), and respects the product-messaging opt-out.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { Tag } from "lucide-react";

import { track } from "@/lib/analytics";
import { useAuth } from "@/hooks/use-auth";
import { CrossSurfaceNudge } from "@/components/cross-surface/cross-surface-nudge";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: vi.fn() }));

// React 19 requires this flag for act() to flush effects in a test env.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mockedTrack = vi.mocked(track);
const mockedUseAuth = vi.mocked(useAuth);

function setProductUpdates(enabled: boolean) {
  mockedUseAuth.mockReturnValue({
    profile: {
      notification_preferences: { product_updates: { email: enabled } },
    },
  } as unknown as ReturnType<typeof useAuth>);
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(props?: Partial<Parameters<typeof CrossSurfaceNudge>[0]>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(
      h(
        MemoryRouter,
        null,
        h(CrossSurfaceNudge, {
          nudgeId: "grade-to-flipdesk",
          icon: Tag,
          title: "Sell this with FlipDesk",
          description: "Turn this grade into a listing.",
          cta: { label: "Open FlipDesk", to: "/dashboard/flipdesk" },
          context: { submission_id: "sub-1" },
          ...props,
        }),
      ),
    );
  });
}

beforeEach(() => {
  mockedTrack.mockReset();
  mockedUseAuth.mockReset();
  localStorage.clear();
  setProductUpdates(true);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

describe("CrossSurfaceNudge (US-1075)", () => {
  it("renders and fires a shown event when promos are enabled", () => {
    render();
    expect(container!.textContent).toContain("Sell this with FlipDesk");
    expect(container!.querySelector("a")?.getAttribute("href")).toBe(
      "/dashboard/flipdesk",
    );
    expect(mockedTrack).toHaveBeenCalledWith("cross_surface_nudge_shown", {
      nudge_id: "grade-to-flipdesk",
      submission_id: "sub-1",
    });
  });

  it("renders nothing and tracks nothing when product updates are off", () => {
    setProductUpdates(false);
    render();
    expect(container!.textContent).toBe("");
    expect(mockedTrack).not.toHaveBeenCalled();
  });

  it("dismiss hides the prompt, persists, and fires a dismissed event", () => {
    render();
    const closeBtn = container!.querySelector(
      'button[aria-label="Dismiss"]',
    ) as HTMLButtonElement;
    act(() => closeBtn.click());
    expect(container!.textContent).toBe("");
    expect(localStorage.getItem("gt:xsurface-nudge-dismissed:grade-to-flipdesk")).toBe(
      "1",
    );
    expect(mockedTrack).toHaveBeenCalledWith("cross_surface_nudge_dismissed", {
      nudge_id: "grade-to-flipdesk",
      submission_id: "sub-1",
    });
  });

  it("stays dismissed across renders once closed", () => {
    localStorage.setItem("gt:xsurface-nudge-dismissed:grade-to-flipdesk", "1");
    render();
    expect(container!.textContent).toBe("");
  });

  it("fires a clicked event and runs onAction for in-page CTAs", () => {
    const onAction = vi.fn();
    render({ cta: { label: "Grade this item", onAction } });
    const buttons = Array.from(container!.querySelectorAll("button"));
    const cta = buttons.find((b) => b.textContent?.includes("Grade this item"))!;
    act(() => cta.click());
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(mockedTrack).toHaveBeenCalledWith("cross_surface_nudge_clicked", {
      nudge_id: "grade-to-flipdesk",
      submission_id: "sub-1",
    });
  });
});
