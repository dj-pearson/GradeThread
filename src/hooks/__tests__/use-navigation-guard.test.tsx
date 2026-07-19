// US-2032: the guard that stops a sidebar click from destroying staged photos.
//
// The wizard keeps image binaries in React state only (the autosave persists a
// manifest, not multi-MB Files), so an unguarded navigation silently discards
// the highest-effort step of the highest-value journey.
//
// Two failure modes matter more than "does it block", and both are pure logic
// that can be pinned without a browser:
//
//   1. TRAPPING THE USER. The condition is `photos.length > 0 && !isSubmitting`.
//      Drop the isSubmitting half and submitting the form trips the guard
//      against the caller's OWN success navigation — the seller is warned they
//      will lose the photos they just successfully submitted.
//   2. STRANDING THE USER. useBlocker's "blocked" state survives re-renders, so
//      if the condition clears while a prompt is open the dialog must release
//      itself — otherwise it asks about work that no longer exists.
//
// What is NOT covered here and needs a real browser: whether the native
// beforeunload prompt actually appears on refresh. Chrome only shows it after a
// user gesture and no automation can assert the chrome itself; this asserts the
// listener is registered and torn down with the condition, which is the part
// under our control.

import { describe, it, expect, afterEach } from "vitest";
import { createElement as h, act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, Link, RouterProvider } from "react-router-dom";
import { useNavigationGuard, type NavigationGuard } from "@/hooks/use-navigation-guard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let guard: NavigationGuard | null = null;
let setBlock: ((v: boolean) => void) | null = null;

function mount(shouldBlock: boolean) {
  container = document.createElement("div");
  document.body.appendChild(container);

  function Wizard() {
    const [block, setBlockState] = useState(shouldBlock);
    setBlock = setBlockState;
    guard = useNavigationGuard(block);
    return h(Link, { to: "/elsewhere", id: "leave" }, "leave");
  }

  const router = createMemoryRouter(
    [
      { path: "/", element: h(Wizard) },
      { path: "/elsewhere", element: h("div", { id: "elsewhere" }, "elsewhere") },
    ],
    { initialEntries: ["/"] },
  );

  act(() => {
    root = createRoot(container!);
    root.render(h(RouterProvider, { router }));
  });
  return router;
}

function clickLeave() {
  const link = container!.querySelector("#leave") as HTMLAnchorElement;
  act(() => {
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  guard = null;
  setBlock = null;
});

describe("US-2032: useNavigationGuard", () => {
  it("lets navigation through when there is nothing to lose", () => {
    const router = mount(false);
    clickLeave();
    expect(guard?.blocked).toBe(false);
    expect(router.state.location.pathname).toBe("/elsewhere");
  });

  it("blocks in-app navigation while work is at stake, and stays put", () => {
    const router = mount(true);
    clickLeave();
    expect(guard?.blocked).toBe(true);
    // The critical half: blocking must actually PREVENT the navigation, not
    // just render a dialog after the route already changed.
    expect(router.state.location.pathname).toBe("/");
  });

  it("cancelLeave keeps the user on the page with the work intact", () => {
    const router = mount(true);
    clickLeave();
    act(() => guard!.cancelLeave());
    expect(guard?.blocked).toBe(false);
    expect(router.state.location.pathname).toBe("/");
  });

  it("confirmLeave discards and proceeds to the requested route", () => {
    const router = mount(true);
    clickLeave();
    act(() => guard!.confirmLeave());
    expect(router.state.location.pathname).toBe("/elsewhere");
  });

  // Registration/teardown of the unload handler. The native prompt itself is
  // browser chrome and cannot be asserted from here.
  it("registers beforeunload only while blocking, and removes it after", () => {
    const added: string[] = [];
    const removed: string[] = [];
    const origAdd = window.addEventListener.bind(window);
    const origRemove = window.removeEventListener.bind(window);
    window.addEventListener = ((t: string, ...rest: unknown[]) => {
      added.push(t);
      return (origAdd as unknown as (...a: unknown[]) => void)(t, ...rest);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((t: string, ...rest: unknown[]) => {
      removed.push(t);
      return (origRemove as unknown as (...a: unknown[]) => void)(t, ...rest);
    }) as typeof window.removeEventListener;

    try {
      mount(true);
      expect(added).toContain("beforeunload");
      act(() => root?.unmount());
      expect(removed).toContain("beforeunload");
    } finally {
      window.addEventListener = origAdd;
      window.removeEventListener = origRemove;
    }
  });

  it("does NOT register beforeunload when there is nothing to lose", () => {
    const added: string[] = [];
    const origAdd = window.addEventListener.bind(window);
    window.addEventListener = ((t: string, ...rest: unknown[]) => {
      added.push(t);
      return (origAdd as unknown as (...a: unknown[]) => void)(t, ...rest);
    }) as typeof window.addEventListener;
    try {
      mount(false);
      expect(added).not.toContain("beforeunload");
    } finally {
      window.addEventListener = origAdd;
    }
  });
});

// The stranding case, and the reason the wizard's condition carries
// `&& !isSubmitting`. A seller clicks Submit while the guard is armed: the
// submit navigates, the guard blocks its OWN success navigation, and then the
// photos are gone from state — leaving a dialog asking whether to discard work
// that no longer exists, with no way forward. The hook must release itself when
// the condition clears.
describe("US-2032: the guard releases itself when the condition clears", () => {
  it("auto-resets a blocked prompt once there is nothing left to lose", () => {
    mount(true);
    clickLeave();
    expect(guard?.blocked).toBe(true);

    // Simulate submit completing: the condition goes false the way the real
    // component does it — a state update, not a re-render with new props.
    act(() => setBlock!(false));

    expect(guard?.blocked).toBe(false);
  });
});
