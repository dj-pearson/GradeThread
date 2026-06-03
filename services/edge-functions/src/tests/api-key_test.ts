// US-356: API-key scopes + hashing. Pure (env-only) logic, runs offline.
import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_API_KEY_SCOPES,
  generateApiKey,
  hashApiKey,
  isApiKeyScope,
  isWellFormedApiKey,
  normalizeScopes,
} from "../lib/api-key.ts";

Deno.test("normalizeScopes: omitted => full default set", () => {
  assertEquals(normalizeScopes(undefined), DEFAULT_API_KEY_SCOPES);
  assertEquals(normalizeScopes(null), DEFAULT_API_KEY_SCOPES);
});

Deno.test("normalizeScopes: valid subset is deduped", () => {
  assertEquals(normalizeScopes(["read", "read", "submit"]), ["read", "submit"]);
});

Deno.test("normalizeScopes: invalid input => null", () => {
  assertEquals(normalizeScopes([]), null);
  assertEquals(normalizeScopes(["read", "bogus"]), null);
  assertEquals(normalizeScopes("read"), null);
  assertEquals(normalizeScopes([123]), null);
});

Deno.test("isApiKeyScope", () => {
  assert(isApiKeyScope("read"));
  assert(isApiKeyScope("submit"));
  assert(isApiKeyScope("webhook_manage"));
  assertEquals(isApiKeyScope("admin"), false);
});

Deno.test("isWellFormedApiKey", () => {
  const k = "gt_sk_" + "a".repeat(64);
  assert(isWellFormedApiKey(k));
  assertEquals(isWellFormedApiKey("gt_sk_short"), false);
  assertEquals(isWellFormedApiKey("nope_" + "a".repeat(64)), false);
});

Deno.test("generateApiKey: well-formed, prefix matches, hash is stable", async () => {
  Deno.env.delete("API_KEY_PEPPER");
  const { fullKey, keyHash, keyPrefix } = await generateApiKey();
  assert(isWellFormedApiKey(fullKey));
  assertEquals(keyPrefix, fullKey.slice(0, 14));
  // Re-hashing the same key reproduces the stored hash (deterministic lookup).
  assertEquals(await hashApiKey(fullKey), keyHash);
});

Deno.test("hashApiKey: pepper changes the digest (HMAC vs SHA-256)", async () => {
  const key = "gt_sk_" + "b".repeat(64);
  Deno.env.delete("API_KEY_PEPPER");
  const plain = await hashApiKey(key);
  Deno.env.set("API_KEY_PEPPER", "server-pepper");
  const peppered = await hashApiKey(key);
  Deno.env.delete("API_KEY_PEPPER");
  assert(plain !== peppered, "pepper must change the hash");
  // 64 hex chars either way (SHA-256 / HMAC-SHA256 output width).
  assertEquals(plain.length, 64);
  assertEquals(peppered.length, 64);
});
