// Android push (FCM) + the shared Google service-account OAuth helper. Pure
// logic: message construction, SA-key parsing, and RS256 assertion signing
// (validated against a freshly generated RSA key — no network, no live FCM).
import { assert, assertEquals } from "@std/assert";
import { buildFcmMessage, FCM_DEAD_REASONS } from "../lib/fcm.ts";
import {
  buildAssertionJwt,
  parseServiceAccount,
} from "../lib/google-service-account.ts";

function decodeJwtPart(part: string): Record<string, unknown> {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(atob(pad)) as Record<string, unknown>;
}

// Generate a throwaway RSA key and export it as a PKCS#8 PEM, so we can exercise
// the real signing path the way a service-account key would.
async function makePkcs8Pem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const der = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  let bin = "";
  for (const b of new Uint8Array(der)) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

Deno.test("parseServiceAccount: raw JSON, base64, and invalid inputs", () => {
  const json = JSON.stringify({
    client_email: "svc@proj.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n",
    project_id: "proj",
  });
  const fromJson = parseServiceAccount(json);
  assert(fromJson);
  assertEquals(fromJson!.client_email, "svc@proj.iam.gserviceaccount.com");
  // Escaped newlines in the PEM are unescaped.
  assert(fromJson!.private_key.includes("\n"));
  assert(!fromJson!.private_key.includes("\\n"));

  // base64 of the same JSON parses identically.
  const fromB64 = parseServiceAccount(btoa(json));
  assert(fromB64);
  assertEquals(fromB64!.project_id, "proj");

  // Unset / blank / malformed → null (treated as unconfigured).
  assertEquals(parseServiceAccount(undefined), null);
  assertEquals(parseServiceAccount(""), null);
  assertEquals(parseServiceAccount("not json or base64 %%%"), null);
  assertEquals(parseServiceAccount(JSON.stringify({ client_email: "x" })), null); // no key
});

Deno.test("buildAssertionJwt: signs an RS256 JWT with the right claims", async () => {
  const pem = await makePkcs8Pem();
  const sa = {
    client_email: "svc@proj.iam.gserviceaccount.com",
    private_key: pem,
    project_id: "proj",
  };
  const now = 1_700_000_000;
  const jwt = await buildAssertionJwt(sa, "https://www.googleapis.com/auth/firebase.messaging", now);
  const [h, c, sig] = jwt.split(".");
  assert(h && c && sig, "JWT has three segments");

  const header = decodeJwtPart(h!);
  assertEquals(header.alg, "RS256");
  assertEquals(header.typ, "JWT");

  const claims = decodeJwtPart(c!);
  assertEquals(claims.iss, "svc@proj.iam.gserviceaccount.com");
  assertEquals(claims.scope, "https://www.googleapis.com/auth/firebase.messaging");
  assertEquals(claims.aud, "https://oauth2.googleapis.com/token");
  assertEquals(claims.iat, now);
  assertEquals(claims.exp, now + 3600);
  assert(sig!.length > 0, "signature present");
});

Deno.test("buildFcmMessage: shape + string-coerced data", () => {
  const msg = buildFcmMessage("tok123", {
    title: "Sale",
    body: "Your item sold",
    category: "sale",
    collapseId: "sale-1",
    data: { itemId: "abc", count: 3 },
  }) as {
    token: string;
    notification: { title: string; body: string };
    android: { priority: string; collapse_key?: string; notification: Record<string, unknown> };
    data: Record<string, string>;
  };

  assertEquals(msg.token, "tok123");
  assertEquals(msg.notification, { title: "Sale", body: "Your item sold" });
  assertEquals(msg.android.priority, "HIGH");
  assertEquals(msg.android.collapse_key, "sale-1");
  // FCM data must be string→string; non-strings are JSON-stringified.
  assertEquals(msg.data.itemId, "abc");
  assertEquals(msg.data.count, "3");
  assertEquals(msg.data.category, "sale");
});

Deno.test("buildFcmMessage: default sound when none given, no data key when empty", () => {
  const msg = buildFcmMessage("tok", { title: "T", body: "B" }) as {
    android: { notification: { default_sound?: boolean } };
    data?: unknown;
  };
  assertEquals(msg.android.notification.default_sound, true);
  assertEquals(msg.data, undefined);
});

Deno.test("FCM_DEAD_REASONS covers the permanent-failure codes", () => {
  assert(FCM_DEAD_REASONS.has("UNREGISTERED"));
  assert(FCM_DEAD_REASONS.has("INVALID_ARGUMENT"));
  assert(FCM_DEAD_REASONS.has("NOT_FOUND"));
  assert(!FCM_DEAD_REASONS.has("INTERNAL"));
  assert(!FCM_DEAD_REASONS.has("UNAVAILABLE"));
});
