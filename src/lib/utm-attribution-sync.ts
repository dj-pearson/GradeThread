// US-2101: once the visitor authenticates, POST any first-party-stored UTM set
// to /api/attribution/utm so the acquiring channel links to the converting user.
// Mirrors ad-attribution-sync.ts (click ids); runs at startup for an already
// signed-in session and on every future sign-in.
import { useAuthStore } from "@/stores/auth-store";
import { edgeFetch } from "@/lib/edge-fetch";
import { getStoredUtm, markUtmPersisted } from "@/lib/ad-attribution";

let inFlight = false;

async function tryPersist(userId: string | undefined): Promise<void> {
  if (!userId || inFlight) return;
  const u = getStoredUtm();
  if (!u || u.persisted) return;
  inFlight = true;
  try {
    const res = await edgeFetch("/api/attribution/utm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ first: u.first, last: u.last }),
    });
    if (res.ok) markUtmPersisted();
  } catch {
    /* best-effort; retried on the next auth change */
  } finally {
    inFlight = false;
  }
}

export function initUtmAttributionSync(): void {
  void tryPersist(useAuthStore.getState().user?.id);
  useAuthStore.subscribe((s) => void tryPersist(s.user?.id));
}
