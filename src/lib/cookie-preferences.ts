// Decouples the footer "Cookie settings" / "Your Privacy Choices" links from the
// consent banner: they dispatch this event and <CookieConsent> reopens its
// preferences manager. Kept in its own module so the banner file only exports a
// component (React Fast Refresh requirement).

const OPEN_EVENT = "gt:cookie-preferences";

/** Reopen the cookie preferences manager (used by footer links). */
export function openCookiePreferences() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/** Subscribe to reopen requests; returns an unsubscribe fn. */
export function onOpenCookiePreferences(cb: () => void): () => void {
  window.addEventListener(OPEN_EVENT, cb);
  return () => window.removeEventListener(OPEN_EVENT, cb);
}
