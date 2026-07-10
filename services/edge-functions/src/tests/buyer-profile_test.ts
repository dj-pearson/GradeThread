// US-1818: buyer public profile — handle validation + PII-safe view (pure). No DB.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { normalizeHandle, normalizeVisibility, buildPublicProfile } = await import(
  "../lib/buyer-profile.ts"
);

// ── normalizeHandle ─────────────────────────────────────────────────────────

Deno.test("handle: valid slugs pass, lowercased", () => {
  assertEquals(normalizeHandle("ThriftScout"), "thriftscout");
  assertEquals(normalizeHandle("thrift-scout-99"), "thrift-scout-99");
});

Deno.test("handle: too short / bad chars / edge dashes rejected", () => {
  assertEquals(normalizeHandle("ab"), null); // < 3
  assertEquals(normalizeHandle("-lead"), null);
  assertEquals(normalizeHandle("trail-"), null);
  assertEquals(normalizeHandle("has space"), null);
  assertEquals(normalizeHandle("emoji😀name"), null);
  assertEquals(normalizeHandle("a".repeat(31)), null); // > 30
});

Deno.test("handle: reserved words rejected", () => {
  assertEquals(normalizeHandle("admin"), null);
  assertEquals(normalizeHandle("Trust"), null);
  assertEquals(normalizeHandle("verified"), null);
});

Deno.test("handle: non-string → null", () => {
  assertEquals(normalizeHandle(42), null);
  assertEquals(normalizeHandle(null), null);
});

// ── normalizeVisibility ─────────────────────────────────────────────────────

Deno.test("visibility: private by default (all false)", () => {
  assertEquals(normalizeVisibility(undefined), { level: false, confirmations: false, member_since: false });
  assertEquals(normalizeVisibility({}), { level: false, confirmations: false, member_since: false });
  // Only an explicit `true` opts a field in.
  assertEquals(normalizeVisibility({ level: "yes" }), { level: false, confirmations: false, member_since: false });
});

// ── buildPublicProfile — the PII chokepoint ─────────────────────────────────

const src = {
  handle: "thriftscout",
  displayName: "ThriftScout",
  level: 2,
  levelLabel: "established",
  memberSince: "2026-01-01T00:00:00Z",
  confirmations: 42,
};

Deno.test("profile: handle + display are always public; nothing else by default", () => {
  const p = buildPublicProfile(src, { level: false, confirmations: false, member_since: false });
  assertEquals(p, { handle: "thriftscout", displayName: "ThriftScout" });
});

Deno.test("profile: only opted-in stats are emitted", () => {
  const p = buildPublicProfile(src, { level: true, confirmations: false, member_since: true });
  assertEquals(p, {
    handle: "thriftscout",
    displayName: "ThriftScout",
    level: 2,
    levelLabel: "established",
    memberSince: "2026-01-01T00:00:00Z",
  });
  // confirmations was NOT opted in → absent entirely (not zeroed).
  assertEquals("confirmations" in p, false);
});

Deno.test("profile: all opted in", () => {
  const p = buildPublicProfile(src, { level: true, confirmations: true, member_since: true });
  assertEquals(p.confirmations, 42);
  assertEquals(p.level, 2);
  assertEquals(p.memberSince, "2026-01-01T00:00:00Z");
});
