import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement as h, act, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";

import {
  useUrlPageState,
  useUrlParamState,
  useUrlSearchInput,
} from "@/hooks/use-url-param-state";

// US-3348. The sibling hook's identical bug is US-3207, and the note there is
// the reason this file mounts a real router instead of scanning the source:
// every one of these failures is invisible to a source scan and visible in
// about four lines of render.
//
// No @testing-library in this repo - render via createRoot like the app does.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function render(element: ReturnType<typeof h>, initial: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const router = createMemoryRouter([{ path: "*", element }], {
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

// ── AC2: the setter's identity is the thing under test ──────────────────────
//
// react-router's setSearchParams is a useCallback over [navigate, searchParams]
// and searchParams is a useMemo over [location.search], so the setter is a NEW
// FUNCTION after every navigation. A setter built on it inherits that, and any
// effect listing the setter in its deps then fires on EVERY navigation - which
// is exactly how the Inventory pager stopped paging (US-3207).
//
// These tests FAIL against a setter whose deps include setSearchParams.
describe("AC2: the setter is stable across navigations", () => {
  it("an effect keyed on the setter does NOT re-fire when the URL changes", async () => {
    let effectRuns = 0;
    function Probe() {
      const [, setSort] = useUrlParamState("sort", "default");
      useEffect(() => {
        effectRuns += 1;
      }, [setSort]);
      return null;
    }
    const router = render(h(Probe), "/dashboard/flipdesk/inventory");
    expect(effectRuns).toBe(1);

    // A navigation the hook had nothing to do with.
    await act(async () => {
      await router.navigate("/dashboard/flipdesk/inventory?tab=sold");
    });
    expect(search(router)).toBe("?tab=sold");
    // The whole story in one number. Against the unstable setter this is 2.
    expect(effectRuns).toBe(1);

    await act(async () => {
      await router.navigate("/dashboard/flipdesk/inventory?tab=sold&q=nike");
    });
    expect(effectRuns).toBe(1);
  });

  it("the setter's own write does not re-fire an effect keyed on it", async () => {
    let effectRuns = 0;
    let setSort: ((v: string) => void) | null = null;
    function Probe() {
      const [, set] = useUrlParamState("sort", "default");
      setSort = set;
      useEffect(() => {
        effectRuns += 1;
      }, [set]);
      return null;
    }
    render(h(Probe), "/dashboard/flipdesk/inventory");
    expect(effectRuns).toBe(1);

    await act(async () => {
      setSort!("oldest");
    });
    // This is the shape that ate the pager: write the param, the write changes
    // the setter, the effect re-runs and undoes the write.
    expect(effectRuns).toBe(1);
  });

  it("holds the SAME function object across navigations", async () => {
    const seen: Array<(v: string) => void> = [];
    function Probe() {
      const [, setSort] = useUrlParamState("sort", "default");
      seen.push(setSort);
      return null;
    }
    const router = render(h(Probe), "/dashboard/flipdesk/inventory");
    await act(async () => {
      await router.navigate("/dashboard/flipdesk/inventory?tab=sold");
    });
    await act(async () => {
      await router.navigate("/dashboard/flipdesk/inventory?tab=active&page=3");
    });
    expect(seen.length).toBeGreaterThan(1);
    for (const fn of seen) expect(Object.is(fn, seen[0])).toBe(true);
  });

  it("useUrlSearchInput's setDraft is stable too, since it wraps the same setter", async () => {
    const seen: Array<(v: string) => void> = [];
    function Probe() {
      const { setDraft } = useUrlSearchInput("q", "");
      seen.push(setDraft);
      return null;
    }
    const router = render(h(Probe), "/dashboard/flipdesk/inventory");
    await act(async () => {
      await router.navigate("/dashboard/flipdesk/inventory?tab=sold");
    });
    expect(seen.length).toBeGreaterThan(1);
    for (const fn of seen) expect(Object.is(fn, seen[0])).toBe(true);
  });
});

// ── AC4: two writes in one tick must not eat each other ─────────────────────
//
// setSearchParams DOES NOT QUEUE. Both calls in a tick receive the params of
// the render they were made in, so the second navigation overwrites the first.
// US-3207 hit this between a tab effect and a page reset and the old tab won.
describe("AC4: writes in the same tick compose instead of clobbering", () => {
  function TwoParams(props: { onReady: (a: (v: string) => void, b: (v: string) => void) => void }) {
    const [, setSort] = useUrlParamState("sort", "default");
    const [, setShow] = useUrlParamState("show", "all");
    props.onReady(setSort, setShow);
    return null;
  }

  it("two different keys written in one tick both survive", async () => {
    let setSort: ((v: string) => void) | null = null;
    let setShow: ((v: string) => void) | null = null;
    const router = render(
      h(TwoParams, {
        onReady: (a, b) => {
          setSort = a;
          setShow = b;
        },
      }),
      "/dashboard/flipdesk/inventory?tab=active",
    );

    await act(async () => {
      setSort!("oldest");
      setShow!("unlisted");
    });

    const params = new URLSearchParams(search(router));
    expect(params.get("tab")).toBe("active");
    // Against the unclamped hook the second write wins and `sort` is absent.
    expect(params.get("sort")).toBe("oldest");
    expect(params.get("show")).toBe("unlisted");
  });

  it("three keys in one tick all survive, in any order", async () => {
    let setSort: ((v: string) => void) | null = null;
    let setShow: ((v: string) => void) | null = null;
    let setSize: ((v: string) => void) | null = null;
    function Three() {
      const [, a] = useUrlParamState("sort", "default");
      const [, b] = useUrlParamState("show", "all");
      const [, c] = useUrlParamState("size", "100");
      setSort = a;
      setShow = b;
      setSize = c;
      return null;
    }
    const router = render(h(Three), "/dashboard/flipdesk/inventory");
    await act(async () => {
      setSize!("50");
      setShow!("unlisted");
      setSort!("oldest");
    });
    const params = new URLSearchParams(search(router));
    expect(params.get("size")).toBe("50");
    expect(params.get("show")).toBe("unlisted");
    expect(params.get("sort")).toBe("oldest");
  });

  it("a delete and a set in the same tick both land", async () => {
    let setSort: ((v: string) => void) | null = null;
    let setShow: ((v: string) => void) | null = null;
    const router = render(
      h(TwoParams, {
        onReady: (a, b) => {
          setSort = a;
          setShow = b;
        },
      }),
      "/dashboard/flipdesk/inventory?sort=oldest&show=unlisted",
    );
    await act(async () => {
      setSort!("default"); // equals the fallback, so the param is removed
      setShow!("drafted");
    });
    const params = new URLSearchParams(search(router));
    expect(params.get("sort")).toBeNull();
    expect(params.get("show")).toBe("drafted");
  });

  it("a page reset and a sort change in one tick both land", async () => {
    // The two hooks share one buffer, which is the point: US-3207's actual
    // failure was a page reset and a tab write in the same tick, and the loser
    // was invisible.
    let setPage: ((n: number) => void) | null = null;
    let setSort: ((v: string) => void) | null = null;
    function Both() {
      const [, p] = useUrlPageState();
      const [, s] = useUrlParamState("sort", "default");
      setPage = p;
      setSort = s;
      return null;
    }
    const router = render(h(Both), "/dashboard/flipdesk/inventory?tab=active&page=4");
    await act(async () => {
      setSort!("oldest");
      setPage!(1);
    });
    const params = new URLSearchParams(search(router));
    expect(params.get("sort")).toBe("oldest");
    expect(params.get("page")).toBeNull();
    expect(params.get("tab")).toBe("active");
  });

  it("warns in development when one key is written twice in a tick", async () => {
    let setSort: ((v: string) => void) | null = null;
    function One() {
      const [, set] = useUrlParamState("sort", "default");
      setSort = set;
      return null;
    }
    const router = render(h(One), "/dashboard/flipdesk/inventory");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await act(async () => {
        setSort!("oldest");
        setSort!("newest");
      });
      // Last write wins, which is the only answer available, but it is no
      // longer silent.
      expect(new URLSearchParams(search(router)).get("sort")).toBe("newest");
      const messages = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(messages).toContain("sort");
      expect(messages).toContain("oldest");
      expect(messages).toContain("newest");
    } finally {
      warn.mockRestore();
    }
  });

  it("a later write onto the SAME base does not resurrect an earlier param", async () => {
    // The buffer is keyed on the params it was built from, so this is the case
    // that needs it cleared rather than only base-checked: write `sort`, leave
    // that URL, come back to the URL the buffer was built from, then write a
    // different key. A buffer that outlived its tick would hand this write the
    // params object still carrying `sort=oldest` and put back a value the
    // seller had navigated away from.
    //
    // A sabotage removing the microtask cleanup passes every other test in this
    // file and fails this one.
    let setSort: ((v: string) => void) | null = null;
    let setShow: ((v: string) => void) | null = null;
    const router = render(
      h(TwoParams, {
        onReady: (a, b) => {
          setSort = a;
          setShow = b;
        },
      }),
      "/dashboard/flipdesk/inventory?tab=active",
    );

    await act(async () => {
      setSort!("oldest");
    });
    expect(new URLSearchParams(search(router)).get("sort")).toBe("oldest");

    // Back to exactly the URL the buffer was built from.
    await act(async () => {
      await router.navigate("/dashboard/flipdesk/inventory?tab=active");
    });
    expect(search(router)).toBe("?tab=active");

    await act(async () => {
      setShow!("unlisted");
    });
    const params = new URLSearchParams(search(router));
    expect(params.get("show")).toBe("unlisted");
    expect(params.get("tab")).toBe("active");
    expect(params.get("sort")).toBeNull();
  });

  it("two routers writing in the same tick do not borrow each other's params", async () => {
    // The buffer is module scope, so it is shared by every mount in the
    // process. That is fine for the one router the app runs, and it is the
    // reason the buffer is only reused when the incoming params MATCH the ones
    // it was built from: a second tree writing in the same tick must start from
    // its own URL, not from whatever the first tree left behind.
    //
    // A sabotage dropping the base check passes every other test in this file
    // and fails this one.
    let setA: ((v: string) => void) | null = null;
    let setB: ((v: string) => void) | null = null;
    function ProbeA() {
      const [, set] = useUrlParamState("sort", "default");
      setA = set;
      return null;
    }
    function ProbeB() {
      const [, set] = useUrlParamState("show", "all");
      setB = set;
      return null;
    }
    const routerA = createMemoryRouter([{ path: "*", element: h(ProbeA) }], {
      initialEntries: ["/one?tab=active"],
    });
    const routerB = createMemoryRouter([{ path: "*", element: h(ProbeB) }], {
      initialEntries: ["/two?tab=sold"],
    });
    const containerB = document.createElement("div");
    document.body.appendChild(containerB);
    let rootB: Root | null = null;

    container = document.createElement("div");
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container!);
      root.render(h(RouterProvider, { router: routerA }));
      rootB = createRoot(containerB);
      rootB.render(h(RouterProvider, { router: routerB }));
    });

    try {
      await act(async () => {
        setA!("oldest");
        setB!("unlisted");
      });
      const a = new URLSearchParams(routerA.state.location.search);
      const b = new URLSearchParams(routerB.state.location.search);
      expect(a.get("sort")).toBe("oldest");
      expect(a.get("tab")).toBe("active");
      expect(a.get("show")).toBeNull();
      expect(b.get("show")).toBe("unlisted");
      expect(b.get("tab")).toBe("sold");
      expect(b.get("sort")).toBeNull();
    } finally {
      act(() => {
        rootB?.unmount();
      });
      containerB.remove();
    }
  });

  it("writes in SEPARATE ticks do not compose with a stale buffer", async () => {
    let setSort: ((v: string) => void) | null = null;
    let setShow: ((v: string) => void) | null = null;
    const router = render(
      h(TwoParams, {
        onReady: (a, b) => {
          setSort = a;
          setShow = b;
        },
      }),
      "/dashboard/flipdesk/inventory",
    );
    await act(async () => {
      setSort!("oldest");
    });
    await act(async () => {
      setShow!("unlisted");
    });
    await act(async () => {
      setSort!("default");
    });
    const params = new URLSearchParams(search(router));
    expect(params.get("sort")).toBeNull();
    expect(params.get("show")).toBe("unlisted");
  });
});

// ── The behaviour the stabilisation must not cost ───────────────────────────
//
// Pinning the deps to [key] means anything else the setter reads has to come
// from a ref, or it goes stale. `fallback` is that thing.
describe("the stable setter still reads live inputs", () => {
  it("a value equal to the fallback drops the param, and other params survive", async () => {
    let setSort: ((v: string) => void) | null = null;
    function Probe() {
      const [, set] = useUrlParamState("sort", "default");
      setSort = set;
      return null;
    }
    const router = render(h(Probe), "/dashboard/flipdesk/inventory?tab=sold&q=nike");
    await act(async () => {
      setSort!("oldest");
    });
    expect(new URLSearchParams(search(router)).get("sort")).toBe("oldest");

    await act(async () => {
      setSort!("default");
    });
    const params = new URLSearchParams(search(router));
    expect(params.get("sort")).toBeNull();
    expect(params.get("tab")).toBe("sold");
    expect(params.get("q")).toBe("nike");
  });

  it("an empty string drops the param even when the fallback is not empty", async () => {
    let setSort: ((v: string) => void) | null = null;
    function Probe() {
      const [, set] = useUrlParamState("sort", "default");
      setSort = set;
      return null;
    }
    const router = render(h(Probe), "/dashboard/flipdesk/inventory?sort=oldest");
    await act(async () => {
      setSort!("");
    });
    expect(search(router)).toBe("");
  });

  it("a CHANGED fallback is honoured by the already-created setter", async () => {
    // The deps are [key], so `fallback` has to be read live rather than closed
    // over. A component whose fallback depends on props or on a feature flag
    // would otherwise keep writing against the fallback it mounted with.
    let setSort: ((v: string) => void) | null = null;
    let bumpFallback: (() => void) | null = null;
    function Probe(props: { fallback: string }) {
      const [, set] = useUrlParamState("sort", props.fallback);
      setSort = set;
      return null;
    }
    function Harness() {
      const [fallback, setFallback] = useState("default");
      bumpFallback = () => setFallback("newest");
      return h(Probe, { fallback });
    }
    const router = render(h(Harness), "/dashboard/flipdesk/inventory");

    await act(async () => {
      setSort!("newest");
    });
    // While "default" is the fallback, "newest" is a real value.
    expect(new URLSearchParams(search(router)).get("sort")).toBe("newest");

    const before = setSort!;
    act(() => {
      bumpFallback!();
    });
    // Same component, same setter object, new fallback.
    expect(Object.is(setSort!, before)).toBe(true);
    await act(async () => {
      setSort!("newest");
    });
    // "newest" IS the fallback now, so it is dropped rather than written.
    expect(new URLSearchParams(search(router)).get("sort")).toBeNull();
  });

  it("a CHANGED key writes the new key, not the mounted one", async () => {
    let setParam: ((v: string) => void) | null = null;
    let bumpKey: (() => void) | null = null;
    function Probe(props: { paramKey: string }) {
      const [, set] = useUrlParamState(props.paramKey, "");
      setParam = set;
      return null;
    }
    function Harness() {
      const [paramKey, setKey] = useState("sort");
      bumpKey = () => setKey("show");
      return h(Probe, { paramKey });
    }
    const router = render(h(Harness), "/dashboard/flipdesk/inventory");
    act(() => {
      bumpKey!();
    });
    await act(async () => {
      setParam!("unlisted");
    });
    const params = new URLSearchParams(search(router));
    expect(params.get("show")).toBe("unlisted");
    expect(params.get("sort")).toBeNull();
  });

  it("the written value is readable on the next render", async () => {
    const seen: string[] = [];
    let setSort: ((v: string) => void) | null = null;
    function Probe() {
      const [value, set] = useUrlParamState("sort", "default");
      setSort = set;
      seen.push(value);
      return null;
    }
    render(h(Probe), "/dashboard/flipdesk/inventory");
    expect(seen[0]).toBe("default");
    await act(async () => {
      setSort!("oldest");
    });
    expect(seen[seen.length - 1]).toBe("oldest");
  });

  it("paging-style writes replace rather than push history", async () => {
    let setSort: ((v: string) => void) | null = null;
    function Probe() {
      const [, set] = useUrlParamState("sort", "default");
      setSort = set;
      return null;
    }
    const router = render(h(Probe), "/dashboard/flipdesk/inventory");
    for (const v of ["oldest", "newest", "price"]) {
      await act(async () => {
        setSort!(v);
      });
      expect(router.state.historyAction).toBe("REPLACE");
    }
  });
});

// ── useUrlSearchInput keeps working on top of the stable setter ─────────────
describe("useUrlSearchInput still commits on a pause", () => {
  it("the draft echoes immediately and the URL follows", async () => {
    vi.useFakeTimers();
    try {
      let setDraft: ((v: string) => void) | null = null;
      const drafts: string[] = [];
      function Probe() {
        const s = useUrlSearchInput("q", "", 250);
        setDraft = s.setDraft;
        drafts.push(s.draft);
        return null;
      }
      const router = render(h(Probe), "/dashboard/flipdesk/inventory");
      act(() => {
        setDraft!("nik");
      });
      expect(drafts[drafts.length - 1]).toBe("nik");
      expect(search(router)).toBe("");
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(new URLSearchParams(search(router)).get("q")).toBe("nik");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an external param change replaces the draft", async () => {
    const drafts: string[] = [];
    function Probe() {
      const s = useUrlSearchInput("q", "");
      drafts.push(s.draft);
      return null;
    }
    const router = render(h(Probe), "/dashboard/flipdesk/inventory?q=nike");
    expect(drafts[drafts.length - 1]).toBe("nike");
    await act(async () => {
      await router.navigate("/dashboard/flipdesk/inventory?q=adidas");
    });
    expect(drafts[drafts.length - 1]).toBe("adidas");
  });

  it("a pending commit does not navigate after unmount", async () => {
    vi.useFakeTimers();
    try {
      let setDraft: ((v: string) => void) | null = null;
      function Probe() {
        const s = useUrlSearchInput("q", "", 250);
        setDraft = s.setDraft;
        return null;
      }
      const router = render(h(Probe), "/dashboard/flipdesk/inventory");
      act(() => {
        setDraft!("nike");
      });
      act(() => {
        root!.unmount();
        root = null;
      });
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(search(router)).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
});

// A render-count guard: a stable setter must not cost extra renders either.
describe("no render churn is introduced", () => {
  it("a write produces exactly one additional render", async () => {
    let renders = 0;
    let setSort: ((v: string) => void) | null = null;
    function Probe() {
      const [, set] = useUrlParamState("sort", "default");
      const n = useRef(0);
      n.current += 1;
      renders = n.current;
      setSort = set;
      return null;
    }
    render(h(Probe), "/dashboard/flipdesk/inventory");
    const before = renders;
    await act(async () => {
      setSort!("oldest");
    });
    expect(renders - before).toBeLessThanOrEqual(2);
    expect(renders - before).toBeGreaterThanOrEqual(1);
  });
});
