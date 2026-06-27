// FCM (Firebase Cloud Messaging) HTTP v1 push send — the Android counterpart to
// apns.ts. The native Android client registers FCM device tokens
// (push_device_tokens.platform = 'fcm', migration 00320); the fan-out
// (sendPushToUser) routes those rows here. Mirrors the apns.ts contract:
// no-ops cleanly when unconfigured, returns a per-send {status, reason}, and
// surfaces the FCM errorCode so the fan-out can prune dead tokens.
//
// Config (optional — no-ops when unset):
//   FCM_SERVICE_ACCOUNT_JSON  the Firebase service-account key (raw JSON or
//                             base64); its project_id is used unless overridden
//   FCM_PROJECT_ID            optional explicit project id

import type { PushPayload } from "./apns.ts";
import {
  getAccessToken,
  parseServiceAccount,
  type ServiceAccount,
} from "./google-service-account.ts";

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

function fcmConfig(): { sa: ServiceAccount; projectId: string } | null {
  const sa = parseServiceAccount(Deno.env.get("FCM_SERVICE_ACCOUNT_JSON"));
  if (!sa) return null;
  const projectId = (Deno.env.get("FCM_PROJECT_ID") ?? sa.project_id ?? "").trim();
  if (!projectId) return null;
  return { sa, projectId };
}

export function isFcmConfigured(): boolean {
  return fcmConfig() !== null;
}

/**
 * Build the FCM v1 `message` object from the shared PushPayload. Exported for
 * tests. Custom `data` values are stringified (FCM data must be string→string).
 */
export function buildFcmMessage(
  deviceToken: string,
  payload: PushPayload,
): Record<string, unknown> {
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(payload.data ?? {})) {
    data[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  if (payload.category) data.category = payload.category;

  const androidNotification: Record<string, unknown> = {};
  if (payload.sound) androidNotification.sound = payload.sound;
  else androidNotification.default_sound = true;
  // The iOS APNs category routes a tap to the right surface; on Android the
  // client reads it from `data.category`, but pass click_action too for parity.
  if (payload.category) androidNotification.click_action = payload.category;
  if (payload.collapseId) androidNotification.tag = payload.collapseId.slice(0, 64);

  const android: Record<string, unknown> = {
    priority: "HIGH",
    notification: androidNotification,
  };
  if (payload.collapseId) android.collapse_key = payload.collapseId.slice(0, 64);

  const message: Record<string, unknown> = {
    token: deviceToken,
    notification: { title: payload.title, body: payload.body },
    android,
  };
  if (Object.keys(data).length > 0) message.data = data;
  return message;
}

/**
 * Send one push to one FCM token. Returns {status, reason} mirroring apns.ts's
 * sendToToken. `reason` carries the FCM errorCode (e.g. UNREGISTERED) so the
 * fan-out can deactivate dead tokens. Never throws.
 */
export async function sendFcmToToken(
  deviceToken: string,
  payload: PushPayload,
): Promise<{ status: number; reason?: string }> {
  const cfg = fcmConfig();
  if (!cfg) return { status: 0, reason: "fcm_unconfigured" };

  let accessToken: string;
  try {
    accessToken = await getAccessToken(cfg.sa, FCM_SCOPE);
  } catch (err) {
    return { status: 0, reason: err instanceof Error ? err.message : String(err) };
  }

  try {
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${cfg.projectId}/messages:send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: buildFcmMessage(deviceToken, payload) }),
      },
    );
    if (res.status === 200) {
      await res.body?.cancel();
      return { status: 200 };
    }
    const text = await res.text().catch(() => "");
    let reason: string | undefined;
    try {
      const j = JSON.parse(text) as {
        error?: { status?: string; details?: Array<{ errorCode?: string }> };
      };
      reason = j.error?.details?.find((d) => d.errorCode)?.errorCode ??
        j.error?.status ?? undefined;
    } catch {
      reason = text || undefined;
    }
    return { status: res.status, reason };
  } catch (err) {
    return { status: 0, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * FCM error codes that mean the token is permanently dead → deactivate it.
 * UNREGISTERED (app uninstalled / token rotated) and the NOT_FOUND/404 +
 * INVALID_ARGUMENT shapes FCM returns for a stale or malformed token.
 */
export const FCM_DEAD_REASONS = new Set([
  "UNREGISTERED",
  "NOT_FOUND",
  "INVALID_ARGUMENT",
]);
