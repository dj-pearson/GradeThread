// MP-08: a failed read of the duplicate-link reviews is an error with a retry,
// never "Nothing waiting on you".

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const reviews = {
  data: undefined as unknown,
  isError: false,
  isSuccess: false,
  isLoading: false,
  isFetching: false,
  refetch: vi.fn(),
};

vi.mock("@/hooks/use-cross-channel-link", async (orig) => ({
  ...(await orig<typeof import("@/hooks/use-cross-channel-link")>()),
  useLinkReviews: () => reviews,
  useLinkScan: () => ({ mutate: vi.fn(), isPending: false }),
  useResolveLinkReview: () => ({ mutate: vi.fn(), isPending: false }),
}));

const { LinkDuplicatesCard } = await import("@/components/flipdesk/link-duplicates-card");

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(<LinkDuplicatesCard />);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("LinkDuplicatesCard", () => {
  it("a failed read shows a retry, not 'Nothing waiting on you'", () => {
    Object.assign(reviews, { data: undefined, isError: true, isSuccess: false });
    render();
    expect(document.body.textContent).not.toContain("Nothing waiting on you");
    const retry = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Try again"),
    );
    expect(retry).toBeTruthy();
    act(() => retry!.click());
    expect(reviews.refetch).toHaveBeenCalled();
  });

  it("an empty successful read says nothing is waiting", () => {
    Object.assign(reviews, { data: [], isError: false, isSuccess: true });
    render();
    expect(document.body.textContent).toContain("Nothing waiting on you");
  });
});
