// US-352: AES-GCM token encryption — AAD binding (cross-tenant replay defense),
// key rotation, and legacy-v1 decrypt compatibility.
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  _resetKeyCacheForTest,
  decryptToken,
  encryptToken,
} from "../lib/crypto-aes.ts";

function b64Key(seed: number): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (seed + i) & 0xff;
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function setKeys(active: string, activeId = "k1", old?: string) {
  Deno.env.set("EDGE_ENCRYPTION_KEY", active);
  Deno.env.set("EDGE_ENCRYPTION_KEY_ID", activeId);
  if (old) Deno.env.set("EDGE_ENCRYPTION_KEYS_OLD", old);
  else Deno.env.delete("EDGE_ENCRYPTION_KEYS_OLD");
  _resetKeyCacheForTest();
}

Deno.test("encryptToken emits v2:<keyId>:... and round-trips with AAD", async () => {
  setKeys(b64Key(1), "k1");
  const blob = await encryptToken("secret-token", { aad: "user-A" });
  assertStringIncludes(blob, "v2:k1:");
  assertEquals(await decryptToken(blob, { aad: "user-A" }), "secret-token");
});

Deno.test("decrypt fails when the AAD (user_id) differs — cross-tenant replay", async () => {
  setKeys(b64Key(2), "k1");
  const blob = await encryptToken("tok", { aad: "user-A" });
  await assertRejects(() => decryptToken(blob, { aad: "user-B" }));
});

Deno.test("decrypt fails when AAD is omitted for an AAD-bound ciphertext", async () => {
  setKeys(b64Key(3), "k1");
  const blob = await encryptToken("tok", { aad: "user-A" });
  await assertRejects(() => decryptToken(blob));
});

Deno.test("round-trips without AAD when none was used", async () => {
  setKeys(b64Key(4), "k1");
  const blob = await encryptToken("no-aad");
  assertEquals(await decryptToken(blob), "no-aad");
});

Deno.test("key rotation: old ciphertext still decrypts after the active key changes", async () => {
  setKeys(b64Key(10), "k1");
  const oldBlob = await encryptToken("rotate-me", { aad: "user-A" });

  // Rotate: k2 becomes active, k1 retained for decrypt only.
  setKeys(b64Key(20), "k2", `k1:${b64Key(10)}`);

  // Old k1 blob still decrypts via the OLD set...
  assertEquals(await decryptToken(oldBlob, { aad: "user-A" }), "rotate-me");
  // ...and new writes use k2.
  const newBlob = await encryptToken("fresh", { aad: "user-A" });
  assertStringIncludes(newBlob, "v2:k2:");
  assertEquals(await decryptToken(newBlob, { aad: "user-A" }), "fresh");
});

Deno.test("legacy v1 ciphertext (no AAD) decrypts with the active key", async () => {
  const keyB64 = b64Key(30);
  setKeys(keyB64, "k1");

  // Build a v1-format blob by hand (raw AES-GCM, no AAD), as old rows look.
  const rawKey = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode("legacy")),
  );
  const enc = (b: Uint8Array) => btoa(String.fromCharCode(...b));
  const v1Blob = `v1:${enc(iv)}:${enc(ct)}`;

  // Passing an AAD must NOT break v1 decryption (it's ignored for v1).
  assertEquals(await decryptToken(v1Blob, { aad: "user-A" }), "legacy");
});

Deno.test("rejects an unrecognized format", async () => {
  setKeys(b64Key(40), "k1");
  await assertRejects(() => decryptToken("v9:garbage"));
  assert(true);
});
