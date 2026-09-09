import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { RouteAnnouncer } from "@/components/route-announcer";

// US-3244. Clicking a nav link in an SPA swaps the content with no page load,
// so a screen reader announces nothing: the user activates a link and, as far
// as anything tells them, stays put.
//
// Two things have to be true and neither is visible from reading the JSX: the
// region must SPEAK on navigation, and it must stay SILENT on first paint. An
// announcer that fires on load is noise, and noise is how people learn to tune
// a live region out.
//
// No @testing-library here -- the repo does not have it, and the house pattern
// (renderToStaticMarkup) cannot run effects. React's own `act` with a real
// jsdom root does, so this exercises the behaviour rather than the markup.

function Harness({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>
      go
    </button>
  );
}

function mountAt(path: string): { container: HTMLElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <RouteAnnouncer />
        <Routes>
          <Route path="*" element={<Harness to="/dashboard/flipdesk/inventory" />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

const region = (c: HTMLElement) => c.querySelector('[role="status"]');

describe("an in-app navigation is announced (US-3244)", () => {
  it("says nothing on first paint", () => {
    const { container, root } = mountAt("/dashboard/flipdesk/inventory");
    // The region must EXIST while empty, so a later message lands in an
    // already-present live region rather than one inserted at the same moment
    // -- which several screen readers skip.
    expect(region(container)).not.toBeNull();
    expect(region(container)!.textContent).toBe("");
    act(() => root.unmount());
  });

  it("names the destination after a navigation", () => {
    const { container, root } = mountAt("/dashboard");
    act(() => {
      container.querySelector("button")!.click();
    });
    expect(region(container)!.textContent).toBe("Inventory page");
    act(() => root.unmount());
  });

  it("reads from the same resolver as the browser tab title", () => {
    // If these diverge, a page is called one thing in the tab and another out
    // loud. Asserting the import is what keeps them one source.
    const src = readFileSync(
      resolve(process.cwd(), "src/components/route-announcer.tsx"),
      "utf8",
    );
    expect(src).toContain('from "@/hooks/use-surface-title"');
    expect(src).toContain("surfaceLabelFor");
  });

  it("is mounted in every signed-in layout, not merely exported", () => {
    // A component nothing renders announces nothing. US-3252 added the buyer
    // and admin trees: neither is in the surfaces registry, so both announce
    // the generic "Page changed" rather than a page name — which is still the
    // difference between saying something and saying nothing.
    for (const rel of [
      "src/layouts/dashboard-layout.tsx",
      "src/layouts/buyer-layout.tsx",
      "src/layouts/admin-layout.tsx",
    ]) {
      const layout = readFileSync(resolve(process.cwd(), rel), "utf8");
      expect(layout, `${rel} does not mount RouteAnnouncer`).toContain(
        "<RouteAnnouncer />",
      );
    }
  });

  it("does NOT mount the title hook where nothing can resolve a name", () => {
    // The trap: mounting useSurfaceTitle in a tree the resolver knows nothing
    // about returns the marketing default on every route, so the mount reads
    // like a fix and does nothing.
    //
    // Buyer came OFF this list once BUYER_NAV became its source. Admin stays
    // until its nav is extracted from the eight unexported arrays inside
    // admin-layout.tsx. Remove it here only when there is something to read.
    const layout = readFileSync(
      resolve(process.cwd(), "src/layouts/admin-layout.tsx"),
      "utf8",
    );
    expect(
      layout,
      "admin mounts useSurfaceTitle with no source to resolve against",
    ).not.toContain("useSurfaceTitle()");
  });
});
