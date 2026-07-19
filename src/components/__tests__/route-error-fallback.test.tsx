// US-2027: the router-level error fallback must REPORT, not just render.
//
// The class ErrorBoundary calls captureException; RouteErrorFallback (the
// router's errorElement) did not, so every route error rendered a "Page Error"
// card with zero telemetry. The sharpest case is /embed/grade/:id — mounted
// OUTSIDE RootLayout, so it has no class boundary above it. A white-label
// partner iframe could be broken indefinitely with nobody knowing.
//
// The subtle half, and the reason this test exists rather than a code read:
// useRouteError() also surfaces THROWN RESPONSES (a 404/500 from a loader),
// which are not Error instances. Captured raw, Sentry records "[object Object]"
// — telemetry that exists but tells you nothing, which is arguably worse than
// none because it looks like coverage.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";

const captureException = vi.fn();
vi.mock("@/lib/sentry", () => ({
  captureException: (...args: unknown[]) => captureException(...args),
}));

const { RouteErrorFallback } = await import("@/components/error-boundary");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** Render a route whose loader throws `thrown`, so the errorElement takes over. */
async function renderWithThrown(thrown: unknown) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: h("div", null, "ok"),
        loader: () => {
          throw thrown;
        },
        errorElement: h(RouteErrorFallback),
      },
    ],
    { initialEntries: ["/"] },
  );
  await act(async () => {
    root = createRoot(container!);
    root.render(h(RouterProvider, { router }));
  });
  // The loader rejects asynchronously; let the router settle into its error state.
  await act(async () => { await Promise.resolve(); });
}

/** The reported (error, context) pair, asserting a report actually happened. */
function reported(): [unknown, { tags?: Record<string, string>; extra?: Record<string, unknown> }] {
  const call = captureException.mock.calls[0];
  expect(call, "expected captureException to have been called").toBeDefined();
  return call as [unknown, { tags?: Record<string, string>; extra?: Record<string, unknown> }];
}

beforeEach(() => captureException.mockClear());
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("US-2027: RouteErrorFallback reports to Sentry", () => {
  it("reports a thrown Error", async () => {
    await renderWithThrown(new Error("kaboom"));
    expect(captureException).toHaveBeenCalledTimes(1);
    const [err] = reported();
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("kaboom");
  });

  it("tags the source so route errors are separable from component errors", async () => {
    await renderWithThrown(new Error("kaboom"));
    const [, ctx] = reported();
    expect(ctx.tags?.source).toBe(
      "RouteErrorFallback",
    );
  });

  // The embed route has no boundary above it, so WHERE it fired is the
  // difference between a triaged partner outage and a mystery.
  it("includes the pathname", async () => {
    await renderWithThrown(new Error("kaboom"));
    const [, ctx] = reported();
    expect(ctx.extra).toHaveProperty("pathname");
  });

  // A loader that throws a Response is the normal React Router idiom for 404 —
  // this is NOT an exotic case, and raw it would reach Sentry as [object Object].
  it("normalizes a thrown Response into a readable message", async () => {
    await renderWithThrown(new Response("nope", { status: 404, statusText: "Not Found" }));
    expect(captureException).toHaveBeenCalledTimes(1);
    const [err] = reported();
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("404");
    expect(msg).not.toContain("[object Object]");
  });

  it("normalizes a non-Error, non-Response throw rather than dropping it", async () => {
    await renderWithThrown("just a string");
    expect(captureException).toHaveBeenCalledTimes(1);
    const [err] = reported();
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("just a string");
  });

  it("still renders the Page Error card for the user", async () => {
    await renderWithThrown(new Error("kaboom"));
    expect(container!.textContent).toContain("Page Error");
  });
});
