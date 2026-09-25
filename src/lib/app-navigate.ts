// Client-side navigation for code that lives outside React (toast actions in
// src/lib/edge-fetch.ts). The router registers itself here once it exists;
// until then, or in a context with no router, a plain location.assign keeps
// the link working with a full load. Registered from src/routes/index.tsx, and
// kept as its own tiny module so edge-fetch does not import the route tree.
type NavigateFn = (to: string) => void;

let navigateImpl: NavigateFn | null = null;

export function registerAppNavigate(fn: NavigateFn | null): void {
  navigateImpl = fn;
}

export function appNavigate(to: string): void {
  if (navigateImpl) {
    navigateImpl(to);
    return;
  }
  window.location.assign(to);
}
