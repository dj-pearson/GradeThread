// Crypto/network boundary for App Store payloads — the ONLY impure part of the
// appstore lib. Wraps Apple's official SignedDataVerifier (x5c cert-chain
// validation to Apple Root CA - G3) and maps decoded payloads into our pure
// Lite types. NOT unit-tested (needs real Apple-signed data + a real device);
// exercised via manual sandbox testing. Everything downstream is pure + tested.

import { Buffer } from "node:buffer";
import { Environment, SignedDataVerifier } from "@apple/app-store-server-library";
import type { DecodedRenewalLite, DecodedTransactionLite } from "./types.ts";
import {
  parseAppleAppId,
  resolveAppstoreEnvironmentName,
  shouldWarnMissingAppleAppId,
} from "./verify-config.ts";

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

// One verifier per Apple environment, built lazily and cached. App Review
// always exercises IAP in the SANDBOX — even against a Production build in the
// store — so a verifier locked to a single environment rejects the reviewer's
// purchase (Apple's SignedDataVerifier throws INVALID_ENVIRONMENT on a
// mismatch). We keep both and try the configured one first, then the other
// (the prod→sandbox fallback Apple recommends, mirroring the legacy 21007
// receipt-validation rule). Accepting Sandbox in Production is not an abuse
// vector: a valid Sandbox JWS can only be produced by a sandbox tester the
// developer provisions in App Store Connect, not by an arbitrary end user.
const cached = new Map<Environment, SignedDataVerifier>();

function buildVerifier(environment: Environment): SignedDataVerifier {
  const bundleId = Deno.env.get("APPLE_BUNDLE_ID");
  const rootB64 = Deno.env.get("APPLE_ROOT_CA_G3_B64");
  // US-788: env parsing lives in verify-config.ts (pure + unit-tested). The
  // appAppleId parse guards the `Number("") === 0` trap that silently degraded
  // Production JWS validation when APPLE_APP_APPLE_ID was unset.
  const appAppleId = parseAppleAppId(Deno.env.get("APPLE_APP_APPLE_ID"));
  if (!bundleId || !rootB64) {
    throw new Error(
      "App Store verification not configured (APPLE_BUNDLE_ID / APPLE_ROOT_CA_G3_B64).",
    );
  }
  // Production verification needs the app's Apple ID to fully validate the JWS;
  // warn loudly if it's missing so a misconfigured prod deploy is visible rather
  // than silently degrading (US-788). Sandbox doesn't require it.
  if (
    environment === Environment.PRODUCTION &&
    shouldWarnMissingAppleAppId("Production", appAppleId)
  ) {
    console.warn(
      "[appstore] APPLE_APP_APPLE_ID is unset in Production — StoreKit JWS " +
        "validation is degraded. Set it to the app's numeric Apple ID.",
    );
  }
  // Comma-separate to supply multiple roots if ever needed.
  const roots = rootB64.split(",").map((b) => Buffer.from(b.trim(), "base64"));
  // enableOnlineChecks=false → offline chain validation (no OCSP round-trip).
  return new SignedDataVerifier(roots, false, environment, bundleId, appAppleId);
}

function verifier(environment: Environment): SignedDataVerifier {
  const existing = cached.get(environment);
  if (existing) return existing;
  const built = buildVerifier(environment);
  cached.set(environment, built);
  return built;
}

/** Environments to attempt, in order: the configured one first, then the other
 * as a fallback (so a Production deploy still accepts App Review's Sandbox
 * purchases). */
function environmentOrder(): Environment[] {
  const configured = resolveAppstoreEnvironmentName(Deno.env.get("APPSTORE_ENVIRONMENT"));
  const primary = configured === "Sandbox" ? Environment.SANDBOX : Environment.PRODUCTION;
  const secondary = primary === Environment.PRODUCTION
    ? Environment.SANDBOX
    : Environment.PRODUCTION;
  return [primary, secondary];
}

/** Run `fn` against each environment's verifier, returning the first success.
 * Rethrows the last error if every environment rejects the payload. */
async function withVerifier<T>(
  fn: (v: SignedDataVerifier, environment: Environment) => Promise<T>,
): Promise<T> {
  const order = environmentOrder();
  let lastErr: unknown;
  for (let i = 0; i < order.length; i++) {
    const environment = order[i]!;
    try {
      const result = await fn(verifier(environment), environment);
      // Surface a fallback success so review-in-sandbox cycles are diagnosable
      // from the logs without being noisy on the normal (primary) path.
      if (i > 0) {
        console.log(
          `[appstore] verified against fallback environment ${environment}`,
        );
      }
      return result;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
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
  const payload = (await withVerifier((v) =>
    v.verifyAndDecodeTransaction(jws),
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
  // Decode the notification across environments, then reuse the SAME verifier
  // (the environment that accepted the outer payload) for the nested
  // transaction/renewal so they validate consistently.
  const { v, body } = await withVerifier(async (verifier) => ({
    v: verifier,
    body: (await verifier.verifyAndDecodeNotification(
      signedPayload,
    )) as unknown as AppleNotificationPayload,
  }));

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
