#!/usr/bin/env node
// Generates the Sign in with Apple client-secret JWT for GoTrue
// (GOTRUE_EXTERNAL_APPLE_SECRET on the self-hosted auth container — see
// vault/10-ops/env-reference.md "OAuth providers").
//
// Apple doesn't issue a static OAuth secret: you sign one yourself with the
// .p8 private key from developer.apple.com → Keys → (+) → Sign in with Apple.
// Apple caps the JWT lifetime at 6 months (15777000s), so this must be re-run
// and the Coolify env var updated before it expires — set a calendar reminder.
//
// Usage:
//   node scripts/generate-apple-client-secret.mjs \
//     --key path/to/AuthKey_ABC123DEFG.p8 \
//     --key-id ABC123DEFG \
//     --team-id 4G65K64G73 \
//     --client-id com.gradethread.app
//
// No dependencies — uses node:crypto ES256 signing (ieee-p1363 gives the raw
// r||s signature JWTs require, not DER).

import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  if (!flag.startsWith("--") || process.argv[i + 1] === undefined) usage();
  args[flag.slice(2)] = process.argv[i + 1];
}

const keyPath = args["key"];
const keyId = args["key-id"];
const teamId = args["team-id"] ?? "4G65K64G73";
const clientId = args["client-id"] ?? "com.gradethread.app";
// Apple's hard maximum is 15777000s (~182.6 days); default just under it.
const days = Math.min(Number(args["days"] ?? 180), 182);
if (!keyPath || !keyId || !Number.isFinite(days) || days <= 0) usage();

function usage() {
  console.error(
    "Usage: node scripts/generate-apple-client-secret.mjs --key <AuthKey.p8> --key-id <KEY_ID> [--team-id 4G65K64G73] [--client-id com.gradethread.app] [--days 180]",
  );
  process.exit(1);
}

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

const now = Math.floor(Date.now() / 1000);
const exp = now + days * 86400;

const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
const payload = b64url(
  JSON.stringify({
    iss: teamId,
    iat: now,
    exp,
    aud: "https://appleid.apple.com",
    sub: clientId,
  }),
);

const privateKey = createPrivateKey(readFileSync(keyPath, "utf8"));
const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
  key: privateKey,
  dsaEncoding: "ieee-p1363",
});

const jwt = `${header}.${payload}.${b64url(signature)}`;
console.log(jwt);
console.error(
  `\nExpires ${new Date(exp * 1000).toISOString()} — set GOTRUE_EXTERNAL_APPLE_SECRET to the line above and restart the auth container. Re-run before expiry.`,
);
