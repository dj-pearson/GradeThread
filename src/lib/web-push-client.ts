// US-1901: browser-side Web Push subscription helpers.
//
// Graceful-degrade throughout: every entry point checks feature support first
// and the caller (Settings UI) only ever requests permission on an explicit user
// gesture. Email/in-app remain the fallback channels when push is unavailable or
// declined.

import { edgeFetch } from "@/lib/edge-fetch";
import { ensureServiceWorker } from "@/lib/pwa";

export function isPushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function getPushPermission(): NotificationPermission | "unsupported" {
  if (!isPushSupported()) return "unsupported";
  return Notification.permission;
}

// The VAPID applicationServerKey must be a Uint8Array of the raw public key.
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Resolve the VAPID public key: build-time env first (avoids a round-trip), then
// the edge endpoint. Returns null when push isn't provisioned server-side.
async function resolveVapidPublicKey(): Promise<string | null> {
  const buildTime = import.meta.env.VITE_VAPID_PUBLIC_KEY?.trim();
  if (buildTime) return buildTime;
  try {
    const res = await edgeFetch("/api/push/vapid-public-key", { method: "GET" });
    if (!res.ok) return null;
    const data = (await res.json()) as { key?: string | null };
    return data.key ?? null;
  } catch {
    return null;
  }
}

async function getReadyRegistration(): Promise<ServiceWorkerRegistration> {
  ensureServiceWorker();
  return await navigator.serviceWorker.ready;
}

export interface SubscribeResult {
  ok: boolean;
  /** A user-facing reason when ok === false. */
  reason?: "unsupported" | "denied" | "unprovisioned" | "error";
}

// Request permission (on the caller's explicit gesture), subscribe via
// PushManager, and register the subscription with the edge. Idempotent — a
// re-subscribe upserts on the endpoint.
export async function subscribeToPush(): Promise<SubscribeResult> {
  if (!isPushSupported()) return { ok: false, reason: "unsupported" };

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, reason: "denied" };

  const key = await resolveVapidPublicKey();
  if (!key) return { ok: false, reason: "unprovisioned" };

  try {
    const registration = await getReadyRegistration();
    // Reuse an existing subscription if present, else create one.
    const existing = await registration.pushManager.getSubscription();
    const sub =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      }));

    const json = sub.toJSON() as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    };
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
      return { ok: false, reason: "error" };
    }

    const res = await edgeFetch("/api/push/subscribe", {
      method: "POST",
      json: {
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
        userAgent: navigator.userAgent,
      },
    });
    return res.ok ? { ok: true } : { ok: false, reason: "error" };
  } catch {
    return { ok: false, reason: "error" };
  }
}

// Tear down the local subscription and tell the edge to forget it.
export async function unsubscribeFromPush(): Promise<boolean> {
  if (!isPushSupported()) return false;
  try {
    const registration = await getReadyRegistration();
    const sub = await registration.pushManager.getSubscription();
    if (!sub) return true; // already gone — idempotent success
    const endpoint = sub.endpoint;
    // Tell the edge first, then drop the local subscription.
    await edgeFetch("/api/push/unsubscribe", {
      method: "POST",
      json: { endpoint },
    }).catch(() => undefined);
    await sub.unsubscribe().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

// Is this browser currently subscribed (permission granted + a live PushManager
// subscription exists)?
export async function isSubscribed(): Promise<boolean> {
  if (!isPushSupported() || Notification.permission !== "granted") return false;
  try {
    const registration = await getReadyRegistration();
    const sub = await registration.pushManager.getSubscription();
    return sub !== null;
  } catch {
    return false;
  }
}
