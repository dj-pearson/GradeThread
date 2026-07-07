// US-1700: once the visitor authenticates, POST any first-party-stored ad click
// id to /api/ads/attribution so the click links to the converting user. Runs at
// startup (for an already-signed-in session) and on every future sign-in.
import { useAuthStore } from "@/stores/auth-store";
import { edgeFetch } from "@/lib/edge-fetch";
import { getStoredAttribution, markAttributionPersisted } from "@/lib/ad-attribution";

let inFlight = false;

async function tryPersist(userId: string | undefined): Promise<void> {
  if (!userId || inFlight) return;
  const a = getStoredAttribution();
  if (!a || a.persisted) return;
  inFlight = true;
  try {
    const res = await edgeFetch("/api/ads/attribution", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clickId: a.clickId, clickIdType: a.clickIdType, landingAt: a.landingAt }),
    });
    if (res.ok) markAttributionPersisted();
  } catch {
    /* best-effort; retried on the next auth change */
  } finally {
    inFlight = false;
  }
}

export function initAdAttributionSync(): void {
  void tryPersist(useAuthStore.getState().user?.id);
  useAuthStore.subscribe((s) => void tryPersist(s.user?.id));
}
