import { useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { ensureExtensionTokenFresh } from "@/lib/extension-token-handoff";

// US-3296 AC1: re-hand the extension a fresh account token on sign-in, and
// whenever the one it holds is near its end.
//
// The token lives 30 days and had exactly one source: a button on
// /connect-extension. Nothing renewed it, so a connected seller quietly became
// an anonymous one about a month later and every Lister action failed from then
// on. This is the half the web app owns — minting needs a Supabase session, and
// only the web app has one. The extension renews itself on its own wake for the
// case where no tab is open at all (background.js renewTokenIfNeeded).
//
// Mounted once in the authenticated layout, deliberately not in RootLayout: the
// check needs `useAuth`, and pulling Supabase into the marketing pages is the
// thing that was carefully undone when the billing dialogs moved out of there.
//
// EVERY OUTCOME IS SILENT. No toast, no spinner, no error boundary. A seller
// who never notices this ran is the whole point; the visible surface for a
// connection that genuinely needs help is the Marketplaces setup card.
export function useExtensionTokenHandoff(): void {
  const { user, isLoading } = useAuth();
  const userId = user?.id ?? null;

  useEffect(() => {
    if (isLoading || !userId) return;
    let cancelled = false;
    // A microtask hop so a fresh sign-in never competes with the first paint.
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      void ensureExtensionTokenFresh();
    }, 1500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isLoading, userId]);
}
