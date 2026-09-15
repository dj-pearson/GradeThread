import { describe, expect, it, vi } from "vitest";
import { createMemoryRouter } from "react-router";
import { mountWhenRouterReady } from "./mount-when-router-ready";

describe("initial page handoff", () => {
  it("mounts immediately when the route is ready", () => {
    const router = createMemoryRouter([{ path: "/", Component: () => null }]);
    const mount = vi.fn();
    mountWhenRouterReady(router, mount);
    expect(mount).toHaveBeenCalledOnce();
    router.dispose();
  });

  it("keeps the static page until the module resolves and mounts only once", async () => {
    let resolve!: (value: { Component: () => null }) => void;
    const ready = new Promise<{ Component: () => null }>((r) => { resolve = r; });
    const router = createMemoryRouter([
      { path: "/", lazy: () => ready },
      { path: "/next", Component: () => null },
    ]);
    const mount = vi.fn();
    mountWhenRouterReady(router, mount);
    expect(mount).not.toHaveBeenCalled();
    resolve({ Component: () => null });
    await vi.waitFor(() => expect(mount).toHaveBeenCalledOnce());
    await router.navigate("/next");
    expect(mount).toHaveBeenCalledOnce();
    router.dispose();
  });

  it("mounts the error boundary when the initial module fails", async () => {
    const router = createMemoryRouter([{
      path: "/",
      lazy: () => Promise.reject(new Error("Unavailable chunk")),
      ErrorBoundary: () => null,
    }]);
    const mount = vi.fn();
    mountWhenRouterReady(router, mount);
    await vi.waitFor(() => expect(mount).toHaveBeenCalledOnce());
    expect(router.state.errors).toBeTruthy();
    router.dispose();
  });
});
