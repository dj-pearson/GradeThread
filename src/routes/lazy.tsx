// Shared route-loading helpers.
//
// Extracted from routes/index.tsx (US-2112) so a lazily-loaded route MODULE —
// admin-routes.tsx — can use the same `lazy` wrapper. Duplicating it there would
// have quietly dropped the stale-chunk recovery below for every admin page,
// which is the kind of regression that only shows up on a deploy.
/* eslint-disable react-refresh/only-export-components */
import { lazy as reactLazy, Suspense, type ComponentType } from "react";

// Wrap React.lazy so a failed dynamic import doesn't hard-crash the route.
// A rejected import() almost always means a new deploy replaced the hashed
// chunk this (older) page references, so the asset now 404s and Cloudflare's
// SPA fallback serves index.html — yielding the "expected a JS module but got
// text/html" MIME error. Reloading once fetches the fresh index + chunk map.
// A sessionStorage flag prevents an infinite reload loop if the chunk is
// genuinely missing (a broken deploy); the flag is cleared on any success.
const CHUNK_RELOAD_KEY = "chunk-reload-once";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirror React.lazy's own ComponentType<any> so components with props stay assignable
export function lazy<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
) {
  return reactLazy(() =>
    factory()
      .then((mod) => {
        sessionStorage.removeItem(CHUNK_RELOAD_KEY);
        return mod;
      })
      .catch((err: unknown) => {
        if (!sessionStorage.getItem(CHUNK_RELOAD_KEY)) {
          sessionStorage.setItem(CHUNK_RELOAD_KEY, "1");
          window.location.reload();
          // Never resolve — keep the Suspense fallback up during the reload.
          return new Promise<{ default: T }>(() => {});
        }
        throw err;
      }),
  );
}

function PageLoader() {
  // Live region (US-452): the bare spinner is decorative, so announce the load
  // politely with an sr-only label rather than leaving SR users in silence.
  return (
    <div
      className="flex min-h-[50vh] items-center justify-center"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="sr-only">Loading page…</span>
      <div
        className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"
        aria-hidden="true"
      />
    </div>
  );
}

export function SuspenseWrapper({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<PageLoader />}>{children}</Suspense>;
}
