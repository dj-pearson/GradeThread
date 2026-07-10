// US-1838: signed extension token + tier gating (pure). No DB.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key");
Deno.env.set("EXTENSION_TOKEN_SECRET", "test-extension-secret");

const { mintExtensionToken, verifyExtensionToken, bearerFromHeader } = await import("../lib/extension-token.ts");
const { resolveExtensionGates } = await import("../lib/extension-gates.ts");

// ── token mint / verify ─────────────────────────────────────────────────────

Deno.test("token: mint → verify round-trips the userId", async () => {
  const { token } = await mintExtensionToken("user-abc");
  const v = await verifyExtensionToken(token);
  assertEquals(v?.userId, "user-abc");
});

Deno.test("token: a tampered token fails (signature check)", async () => {
  const { token } = await mintExtensionToken("user-abc");
  const parts = token.split(".");
  // Swap the userId but keep the old signature → mismatch.
  assertEquals(await verifyExtensionToken(`user-evil.${parts[1]}.${parts[2]}`), null);
  // Flip a signature char.
  const badSig = parts[2].slice(0, -1) + (parts[2].endsWith("a") ? "b" : "a");
  assertEquals(await verifyExtensionToken(`${parts[0]}.${parts[1]}.${badSig}`), null);
});

Deno.test("token: expired token fails", async () => {
  // Mint with a tiny TTL, then it's already past (mint clamps TTL≥60, so forge one).
  const past = Math.floor(Date.now() / 1000) - 10;
  // A token whose expiry is in the past → rejected before the sig check.
  assertEquals(await verifyExtensionToken(`u.${past}.deadbeef`), null);
});

Deno.test("token: malformed / empty → null (fail-closed)", async () => {
  assertEquals(await verifyExtensionToken(null), null);
  assertEquals(await verifyExtensionToken(""), null);
  assertEquals(await verifyExtensionToken("notatoken"), null);
  assertEquals(await verifyExtensionToken("a.b"), null);
});

Deno.test("bearer: extracts the token from an Authorization header", () => {
  assertEquals(bearerFromHeader("Bearer abc.def.ghi"), "abc.def.ghi");
  assertEquals(bearerFromHeader("bearer   xyz"), "xyz");
  assertEquals(bearerFromHeader("Basic abc"), null);
  assertEquals(bearerFromHeader(null), null);
});

// ── gating (fail-safe) ──────────────────────────────────────────────────────

Deno.test("gates: anonymous → only free basics, all paid signals OFF", () => {
  const g = resolveExtensionGates(null);
  assertEquals(g, { discrepancy: false, priceFairness: false, fraud: false, coverage: true, tier: "anonymous" });
});

Deno.test("gates: Guard unlocks discrepancy + price-fairness, not fraud", () => {
  const g = resolveExtensionGates({ plan: "guard", gateFlags: { discrepancyScoring: true, priceFairness: true } });
  assert(g.discrepancy);
  assert(g.priceFairness);
  assertEquals(g.fraud, false); // fraud is Connoisseur-only
});

Deno.test("gates: Connoisseur unlocks everything", () => {
  const g = resolveExtensionGates({ plan: "connoisseur", gateFlags: { discrepancyScoring: true, priceFairness: true } });
  assert(g.discrepancy && g.priceFairness && g.fraud && g.coverage);
  assertEquals(g.tier, "connoisseur");
});

Deno.test("gates: a plan without the flags keeps those signals off", () => {
  const g = resolveExtensionGates({ plan: "free", gateFlags: {} });
  assertEquals(g.discrepancy, false);
  assertEquals(g.priceFairness, false);
  assertEquals(g.coverage, true); // basics always on
});
