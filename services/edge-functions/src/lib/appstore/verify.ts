// Crypto/network boundary for App Store payloads — the ONLY impure part of the
// appstore lib. Wraps Apple's official SignedDataVerifier (x5c cert-chain
// validation to Apple Root CA - G3) and maps decoded payloads into our pure
// Lite types. NOT unit-tested (needs real Apple-signed data + a real device);
// exercised via manual sandbox testing. Everything downstream is pure + tested.

import { Buffer } from "node:buffer";
import { Environment, SignedDataVerifier } from "@apple/app-store-server-library";
import type { DecodedRenewalLite, DecodedTransactionLite } from "./types.ts";

// Structural views of the fields we read, so we don't couple to the library's
// exported payload types.
interface AppleTransactionPayload {
  productId: string;
  originalTransactionId: string;
  transactionId: string;
  expiresDate?: number;
  appAccountToken?: string;
  environment?: string;
}
interface AppleRenewalPayload {
  autoRenewStatus?: number;
}
interface AppleNotificationPayload {
  notificationType: string;
  subtype?: string;
  notificationUUID: string;
  data?: { signedTransactionInfo?: string; signedRenewalInfo?: string };
}

let cached: SignedDataVerifier | null = null;

function verifier(): SignedDataVerifier {
  if (cached) return cached;
  const bundleId = Deno.env.get("APPLE_BUNDLE_ID");
  const rootB64 = Deno.env.get("APPLE_ROOT_CA_G3_B64");
  const envName = Deno.env.get("APPSTORE_ENVIRONMENT") ?? "Production";
  // US-788: parse the app's Apple ID correctly. `Number("")` is 0 (a FINITE
  // number), so the previous `Number(... ?? "")` + isFinite guard passed 0 —
  // not undefined — when APPLE_APP_APPLE_ID was unset, which breaks Apple's
  // strict transaction/notification validation in Production. Treat unset /
  // non-positive as "not provided" (undefined).
  const rawAppId = Deno.env.get("APPLE_APP_APPLE_ID")?.trim();
  const parsedAppId = rawAppId ? Number(rawAppId) : NaN;
  const appAppleId = Number.isFinite(parsedAppId) && parsedAppId > 0
    ? parsedAppId
    : undefined;
  if (!bundleId || !rootB64) {
    throw new Error(
      "App Store verification not configured (APPLE_BUNDLE_ID / APPLE_ROOT_CA_G3_B64).",
    );
  }
  const environment = envName === "Sandbox" ? Environment.SANDBOX : Environment.PRODUCTION;
  // Production verification needs the app's Apple ID to fully validate the JWS;
  // warn loudly if it's missing so a misconfigured prod deploy is visible rather
  // than silently degrading (US-788). Sandbox doesn't require it.
  if (environment === Environment.PRODUCTION && appAppleId === undefined) {
    console.warn(
      "[appstore] APPLE_APP_APPLE_ID is unset in Production — StoreKit JWS " +
        "validation is degraded. Set it to the app's numeric Apple ID.",
    );
  }
  // Comma-separate to supply multiple roots if ever needed.
  const roots = rootB64.split(",").map((b) => Buffer.from(b.trim(), "base64"));
  // enableOnlineChecks=false → offline chain validation (no OCSP round-trip).
  cached = new SignedDataVerifier(
    roots,
    false,
    environment,
    bundleId,
    appAppleId,
  );
  return cached;
}

function toLite(p: AppleTransactionPayload): DecodedTransactionLite {
  return {
    productId: p.productId,
    originalTransactionId: p.originalTransactionId,
    transactionId: p.transactionId,
    expiresDate: p.expiresDate ?? null,
    appAccountToken: p.appAccountToken ?? null,
    environment: p.environment ?? null,
  };
}

/** Verify + decode a single StoreKit 2 signed transaction (from the client). */
export async function verifyTransaction(jws: string): Promise<DecodedTransactionLite> {
  const payload = (await verifier().verifyAndDecodeTransaction(
    jws,
  )) as unknown as AppleTransactionPayload;
  return toLite(payload);
}

export interface VerifiedNotification {
  notificationType: string;
  subtype: string | null;
  notificationUUID: string;
  transaction: DecodedTransactionLite | null;
  renewal: DecodedRenewalLite | null;
}

/** Verify + decode an App Store Server Notification V2 (and its nested data). */
export async function verifyNotification(signedPayload: string): Promise<VerifiedNotification> {
  const v = verifier();
  const body = (await v.verifyAndDecodeNotification(
    signedPayload,
  )) as unknown as AppleNotificationPayload;

  let transaction: DecodedTransactionLite | null = null;
  let renewal: DecodedRenewalLite | null = null;

  if (body.data?.signedTransactionInfo) {
    const txn = (await v.verifyAndDecodeTransaction(
      body.data.signedTransactionInfo,
    )) as unknown as AppleTransactionPayload;
    transaction = toLite(txn);
  }
  if (body.data?.signedRenewalInfo) {
    const r = (await v.verifyAndDecodeRenewalInfo(
      body.data.signedRenewalInfo,
    )) as unknown as AppleRenewalPayload;
    renewal = { autoRenewStatus: r.autoRenewStatus ?? null };
  }

  return {
    notificationType: body.notificationType,
    subtype: body.subtype ?? null,
    notificationUUID: body.notificationUUID,
    transaction,
    renewal,
  };
}
