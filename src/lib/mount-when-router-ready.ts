import type { createBrowserRouter } from "react-router";

type Router = Pick<ReturnType<typeof createBrowserRouter>, "state" | "subscribe">;

// Keep prerendered content on screen until the initial route module is ready.
// Router errors also finish initialization, so a failed import still mounts
// the error boundary instead of leaving an inert page behind.
export function mountWhenRouterReady(router: Router, mount: () => void): void {
  if (router.state.initialized) {
    mount();
    return;
  }
  const unsubscribe = router.subscribe((state) => {
    if (!state.initialized) return;
    unsubscribe();
    mount();
  });
}
