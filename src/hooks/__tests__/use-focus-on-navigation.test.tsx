import { describe, it, expect, afterEach } from "vitest";
import { useEffect, useRef, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { useFocusOnNavigation } from "@/hooks/use-focus-on-navigation";

// US-3244 AC4. RouteAnnouncer says the page changed; this moves the keyboard
// there. Without it a screen-reader or keyboard user activates a sidebar link
// and is still standing in the sidebar, so reaching the content means tabbing
// past every nav item again, on every navigation.
//
// The reason this is a behavioural test and not a scan for `tabIndex={-1}` is
// that the attribute has been on all three <main>s since the skip link shipped
// and NOTHING moved focus to it. Every interesting case here is about when the
// hook must stand DOWN, and none of them are visible in the markup:
//
//   - a page that put the cursor in its own field (search, bulk intake);
//   - a dialog or sheet that owns focus and will take it back on close;
//   - a filter, sort or pager writing the query string, which is not a
//     navigation however much the URL changes.
//
// No @testing-library in this repo. React's own `act` against a real jsdom root
// runs effects, which is the whole point -- the ordering between a page's own
// focus-on-mount effect and this layout-level one is the thing under test.

/** Mirrors src/pages/flipdesk/search.tsx: focuses its query box on mount. */
function AutoFocusPage() {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return <input id="page-query" ref={ref} aria-label="Search" />;
}

function PlainPage() {
  return <p>content</p>;
}

/**
 * A layout shaped like the real ones: nav OUTSIDE <main>, routes INSIDE it.
 * Focus starting outside the target is what makes the assertions mean anything.
 */
function Shell({ overlay = false }: { overlay?: boolean }) {
  useFocusOnNavigation("main-content");
  const navigate = useNavigate();
  return (
    <div>
      <nav>
        <button type="button" id="to-plain" onClick={() => navigate("/dashboard/x")}>
          Plain
        </button>
        <button type="button" id="to-search" onClick={() => navigate("/dashboard/search")}>
          Search
        </button>
        <button type="button" id="to-page-2" onClick={() => navigate("/dashboard/x?page=2")}>
          Page 2
        </button>
      </nav>
      {/* A Radix dialog carries role="dialog" while open AND while its exit
          animation plays, which is exactly the window in which its queued
          focus restore is still pending. */}
      {overlay && (
        <div role="dialog" aria-label="Command palette">
          <button type="button" id="in-dialog">
            inside
          </button>
        </div>
      )}
      <main id="main-content" tabIndex={-1} className="outline-none">
        <Routes>
          <Route path="/dashboard/search" element={<AutoFocusPage />} />
          <Route path="*" element={<PlainPage />} />
        </Routes>
      </main>
    </div>
  );
}

let mounted: { container: HTMLElement; root: Root } | null = null;

function mountAt(path: string, props: { overlay?: boolean } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Shell {...props} />
      </MemoryRouter>,
    );
  });
  mounted = { container, root };
  return container;
}

/** Focus a control the way a keyboard user would, then activate it. */
function pressButton(container: HTMLElement, id: string) {
  const button = container.querySelector<HTMLButtonElement>(`#${id}`)!;
  button.focus();
  expect(document.activeElement, "the test did not manage to focus the button")
    .toBe(button);
  act(() => {
    button.click();
  });
  return button;
}

const main = (c: HTMLElement) => c.querySelector<HTMLElement>("#main-content")!;

afterEach(() => {
  if (mounted) {
    const { container, root } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
  document.body.removeAttribute("data-scroll-locked");
});

describe("focus follows an in-app navigation (US-3244 AC4)", () => {
  it("leaves focus alone on first paint", () => {
    // Nothing moved, so nothing should move. Stealing focus on load would also
    // scroll a deep-linked page back to the top.
    const container = mountAt("/dashboard/x");
    expect(document.activeElement).toBe(document.body);
    expect(document.activeElement).not.toBe(main(container));
  });

  it("moves focus to the content region after a navigation", () => {
    const container = mountAt("/dashboard");
    const button = pressButton(container, "to-plain");
    expect(document.activeElement).toBe(main(container));
    expect(document.activeElement).not.toBe(button);
  });

  it("does NOT steal the cursor from a page that focuses its own field", () => {
    // The failure this prevents: the seller opens Search, starts typing, and
    // the characters go nowhere. React runs the page's mount effect BEFORE this
    // layout-level one, so an unconditional focus() wins the race every time.
    const container = mountAt("/dashboard");
    pressButton(container, "to-search");
    expect(document.activeElement).toBe(container.querySelector("#page-query"));
    expect(document.activeElement).not.toBe(main(container));
  });

  it("stands down while a dialog or sheet is on screen", () => {
    // The command palette runs `setOpen(false); navigate(to)` in one tick, and
    // on a phone every nav click closes a Sheet. Radix restores focus from
    // inside a setTimeout, so grabbing it here is a fight the page loses a
    // frame later -- with the cursor ending up on the hamburger button.
    const container = mountAt("/dashboard", { overlay: true });
    const inDialog = container.querySelector<HTMLButtonElement>("#in-dialog")!;
    inDialog.focus();
    act(() => {
      container.querySelector<HTMLButtonElement>("#to-plain")!.click();
    });
    expect(document.activeElement).toBe(inDialog);
    expect(document.activeElement).not.toBe(main(container));
  });

  it("stands down while the body scroll lock is held", () => {
    // The modal menus and selects that lock scroll carry role="menu" or
    // "listbox" rather than "dialog", so the role check alone would miss them.
    const container = mountAt("/dashboard");
    document.body.setAttribute("data-scroll-locked", "1");
    const button = pressButton(container, "to-plain");
    expect(document.activeElement).toBe(button);
    expect(document.activeElement).not.toBe(main(container));
  });

  it("ignores a query-string change, which is a filter and not a navigation", () => {
    // Tabs, sorts, the pager and the inventory search box all write params:
    // useUrlParamState replaces the URL on every change and useUrlSearchInput
    // does it 250ms after a keystroke. Keying off `search` would pull the
    // cursor out of the search box mid-word.
    const container = mountAt("/dashboard/x");
    const button = pressButton(container, "to-page-2");
    expect(document.activeElement).toBe(button);
    expect(document.activeElement).not.toBe(main(container));
  });

  it("is mounted in all three signed-in layouts, not merely exported", async () => {
    // A hook nothing calls moves nothing. Same guard shape as the announcer's.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    for (const rel of [
      "src/layouts/dashboard-layout.tsx",
      "src/layouts/buyer-layout.tsx",
      "src/layouts/admin-layout.tsx",
    ]) {
      const src = readFileSync(resolve(process.cwd(), rel), "utf8");
      expect(src, `${rel} does not call useFocusOnNavigation`).toMatch(
        /useFocusOnNavigation\("[a-z-]+"\)/,
      );
    }
  });

  it("targets an id that the layout actually renders as a focusable main", async () => {
    // The move is silent when the id is wrong: getElementById returns null and
    // the hook returns. Pin the id, tabIndex and outline-none together -- a
    // programmatic move onto a target without outline-none paints a ring
    // around the entire page.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    for (const rel of [
      "src/layouts/dashboard-layout.tsx",
      "src/layouts/buyer-layout.tsx",
      "src/layouts/admin-layout.tsx",
    ]) {
      const src = readFileSync(resolve(process.cwd(), rel), "utf8");
      const id = /useFocusOnNavigation\("([a-z-]+)"\)/.exec(src)![1]!;
      const mainTag = /<main[\s\S]*?>/.exec(src)![0];
      expect(mainTag, `${rel} focus target`).toContain(`id="${id}"`);
      expect(mainTag, `${rel} focus target`).toContain("tabIndex={-1}");
      expect(mainTag, `${rel} focus target`).toContain("outline-none");
    }
  });
});
