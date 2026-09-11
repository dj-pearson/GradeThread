import { describe, it, expect, afterEach } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";

import { parsePageParam, useUrlPageState } from "@/hooks/use-url-param-state";

// US-3207 AC2, AC5 and AC6, called rather than scanned.
//
// No @testing-library in this repo - render via createRoot like the app does.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let page = 0;
let setPage: ((next: number | ((prev: number) => number)) => void) | null = null;

function Probe() {
  const [p, set] = useUrlPageState();
  page = p;
  setPage = set;
  return null;
}

function mount(initial: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const router = createMemoryRouter([{ path: "*", element: h(Probe) }], {
    initialEntries: [initial],
  });
  act(() => {
    root = createRoot(container!);
    root.render(h(RouterProvider, { router }));
  });
  return router;
}

function search(router: ReturnType<typeof createMemoryRouter>): string {
  return router.state.location.search;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  setPage = null;
});

describe("AC6: the parser never hands the server something it cannot use", () => {
  // The value becomes an OFFSET in flipdesk_listing_page. `?page=-4` would ask
  // for a negative offset, which is a 500 rather than a cosmetic glitch.
  const junk: [string | null | undefined, number][] = [
    [null, 1],
    [undefined, 1],
    ["", 1],
    ["   ", 1],
    ["abc", 1],
    ["0", 1],
    ["-1", 1],
    ["-4", 1],
    ["-999999", 1],
    ["NaN", 1],
    ["Infinity", 1],
    ["null", 1],
    ["undefined", 1],
    ["1;DROP TABLE items", 1],
    ["  7  ", 7],
    ["3.7", 3],
    ["+5", 5],
    // parseInt stops at the first non-digit, so these are 0 and 1, not 16 and 1e9999.
    ["0x10", 1],
    ["1e9999", 1],
    ["99999999999", 100_000],
  ];

  for (const [raw, want] of junk) {
    it(`parses ${JSON.stringify(raw)} as ${want}`, () => {
      expect(parsePageParam(raw)).toBe(want);
    });
  }

  it("is never below 1 and never absurd, for anything at all", () => {
    for (const [raw] of junk) {
      const n = parsePageParam(raw);
      expect(Number.isInteger(n), `raw ${JSON.stringify(raw)}`).toBe(true);
      expect(n, `raw ${JSON.stringify(raw)}`).toBeGreaterThanOrEqual(1);
      expect(n, `raw ${JSON.stringify(raw)}`).toBeLessThanOrEqual(100_000);
      // The thing that actually matters downstream.
      expect((n - 1) * 100, `offset for ${JSON.stringify(raw)}`).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("AC2: page 1 writes no param", () => {
  it("a bare URL reads as page 1", () => {
    mount("/dashboard/flipdesk/inventory");
    expect(page).toBe(1);
  });

  it("going to page 3 writes ?page=3, and going back to 1 removes it", async () => {
    const router = mount("/dashboard/flipdesk/inventory");
    await act(async () => {
      setPage!(3);
    });
    expect(search(router)).toBe("?page=3");
    expect(page).toBe(3);

    await act(async () => {
      setPage!(1);
    });
    // Not `?page=1`: a link to the top of a list stays clean, and every
    // bookmark written before this story still means what it meant.
    expect(search(router)).toBe("");
    expect(page).toBe(1);
  });

  it("leaves the other params alone", async () => {
    const router = mount("/dashboard/flipdesk/inventory?tab=sold&q=nike&sort=oldest");
    await act(async () => {
      setPage!(2);
    });
    const params = new URLSearchParams(search(router));
    expect(params.get("tab")).toBe("sold");
    expect(params.get("q")).toBe("nike");
    expect(params.get("sort")).toBe("oldest");
    expect(params.get("page")).toBe("2");
  });

  it("a junk inbound param reads as page 1 without writing anything", () => {
    const router = mount("/dashboard/flipdesk/inventory?page=-4");
    expect(page).toBe(1);
    // Nothing is rewritten on read; the value is simply interpreted. The URL
    // only changes when the seller pages.
    expect(search(router)).toBe("?page=-4");
  });
});

describe("AC5: paging replaces, it does not push", () => {
  it("five pager clicks leave one history entry", async () => {
    const router = mount("/dashboard/flipdesk/inventory?tab=active");
    for (let i = 0; i < 5; i += 1) {
        await act(async () => {
        setPage!((p) => p + 1);
      });
      expect(router.state.historyAction).toBe("REPLACE");
    }
    expect(page).toBe(6);
    expect(new URLSearchParams(search(router)).get("page")).toBe("6");
  });

  it("the updater form reads the page it is on, not a captured one", async () => {
    const router = mount("/dashboard/flipdesk/inventory?page=4");
    await act(async () => {
      setPage!((p) => p - 1);
    });
    expect(page).toBe(3);
    expect(new URLSearchParams(search(router)).get("page")).toBe("3");
  });

  it("stepping below 1 lands on 1 rather than 0", async () => {
    const router = mount("/dashboard/flipdesk/inventory");
    await act(async () => {
      setPage!((p) => p - 1);
    });
    expect(page).toBe(1);
    expect(search(router)).toBe("");
  });
});
