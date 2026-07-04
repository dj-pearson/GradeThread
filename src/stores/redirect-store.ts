import { create } from "zustand";

// US-1631: a latch for "we're navigating away to Stripe (Checkout / billing
// portal)". Setting `window.location.href` resolves the mutation, so a button
// disabled only on `mutation.isPending` re-enables in the seconds before the
// browser actually navigates — long enough for a second click to mint a
// duplicate Checkout session. Redirect buttons OR this flag into `disabled`; it
// is never reset (the page unloads), so it keeps them disabled through the nav.
interface RedirectState {
  isRedirecting: boolean;
  redirectTo: (url: string) => void;
}

// US-1631: set the moment we send the user to Stripe Checkout, consumed once on
// return so the checkout-success toast/analytics/reconcile fire ONLY for a real
// checkout — not every time a bookmarked ?checkout=success URL is opened (which
// otherwise re-fires the conversion event and inflates metrics). sessionStorage
// survives the same-tab round-trip to Stripe and back.
export const CHECKOUT_INITIATED_KEY = "gt:checkout_initiated";

export const useRedirectStore = create<RedirectState>((set) => ({
  isRedirecting: false,
  redirectTo: (url: string) => {
    set({ isRedirecting: true });
    try {
      sessionStorage.setItem(CHECKOUT_INITIATED_KEY, "1");
    } catch {
      // sessionStorage unavailable (private mode / SSR) — the flag is a
      // best-effort replay guard, so degrade to always-firing.
    }
    window.location.href = url;
  },
}));
