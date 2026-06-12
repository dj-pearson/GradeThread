// US-374: workspace MFA-enforcement gate + recovery-code helpers (pure units).
import { assert, assertEquals } from "@std/assert";
import { workspaceMfaBlocked } from "../lib/workspace-roles.ts";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from "../lib/recovery-codes.ts";

// ── workspaceMfaBlocked ──────────────────────────────────────────────────────

Deno.test("workspaceMfaBlocked: no policy → never blocked", () => {
  assertEquals(workspaceMfaBlocked("admin", null, false), false);
  assertEquals(workspaceMfaBlocked("admin", undefined, false), false);
});

Deno.test("workspaceMfaBlocked: below threshold → not blocked even at aal1", () => {
  // policy requires admin+; a viewer/member is below it.
  assertEquals(workspaceMfaBlocked("viewer", "admin", false), false);
  assertEquals(workspaceMfaBlocked("member", "admin", false), false);
});

Deno.test("workspaceMfaBlocked: at/above threshold AND aal1 → BLOCKED", () => {
  assertEquals(workspaceMfaBlocked("admin", "admin", false), true);
  assertEquals(workspaceMfaBlocked("listing_manager", "member", false), true);
});

Deno.test("workspaceMfaBlocked: at/above threshold but aal2 → allowed", () => {
  assertEquals(workspaceMfaBlocked("admin", "admin", true), false);
  assertEquals(workspaceMfaBlocked("listing_manager", "member", true), false);
});

Deno.test("workspaceMfaBlocked: 'everyone' threshold (viewer) gates a viewer at aal1", () => {
  assertEquals(workspaceMfaBlocked("viewer", "viewer", false), true);
  assertEquals(workspaceMfaBlocked("viewer", "viewer", true), false);
});

// ── recovery codes ───────────────────────────────────────────────────────────

Deno.test("normalizeRecoveryCode: strips formatting, uppercases", () => {
  assertEquals(normalizeRecoveryCode("abcd-2345"), "ABCD2345");
  assertEquals(normalizeRecoveryCode("ABCD 2345"), "ABCD2345");
  assertEquals(normalizeRecoveryCode(" a b c d 2 3 4 5 "), "ABCD2345");
});

Deno.test("hashRecoveryCode: deterministic + format-insensitive", async () => {
  const a = await hashRecoveryCode("ABCD-2345");
  const b = await hashRecoveryCode("abcd 2345");
  assertEquals(a, b);
  assertEquals(a.length, 64); // SHA-256 hex
});

Deno.test("hashRecoveryCode: different codes → different hashes", async () => {
  const a = await hashRecoveryCode("ABCD-2345");
  const b = await hashRecoveryCode("ABCD-2346");
  assert(a !== b);
});

Deno.test("generateRecoveryCodes: count, shape, uniqueness", () => {
  const codes = generateRecoveryCodes(10);
  assertEquals(codes.length, 10);
  for (const c of codes) {
    assert(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(c), `bad code shape: ${c}`);
  }
  assertEquals(new Set(codes).size, 10); // no dupes
});
