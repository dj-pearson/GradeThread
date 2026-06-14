import { assertEquals } from "@std/assert";

// US-904 AC#5: a user who hasn't (re-)accepted is NOT silently treated as
// accepted. These exercise the pure version-resolution + gate logic.
//
// legal-versions.ts imports the service-role supabase client at init; set dummy
// env BEFORE the dynamic import (same pattern as schema-version_test.ts).
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  deriveLegalVersionState,
  FALLBACK_PRIVACY_VERSION,
  FALLBACK_TOS_VERSION,
  needsReacceptance,
} = await import("../lib/legal-versions.ts");
type LegalDocRow = import("../lib/legal-versions.ts").LegalDocRow;

function doc(
  kind: "tos" | "privacy",
  version: string,
  requires_reacceptance = true,
): LegalDocRow {
  return { kind, version, effective_date: version, requires_reacceptance };
}

Deno.test("empty table → falls back to the historical baseline", () => {
  const state = deriveLegalVersionState([]);
  assertEquals(state.tos.current, FALLBACK_TOS_VERSION);
  assertEquals(state.tos.requiredSince, FALLBACK_TOS_VERSION);
  assertEquals(state.privacy.current, FALLBACK_PRIVACY_VERSION);
  assertEquals(state.privacy.requiredSince, FALLBACK_PRIVACY_VERSION);
});

Deno.test("current version = latest published per kind", () => {
  const state = deriveLegalVersionState([
    doc("tos", "2026-04-01"),
    doc("tos", "2026-07-01"),
    doc("privacy", "2026-04-01"),
  ]);
  assertEquals(state.tos.current, "2026-07-01");
  assertEquals(state.tos.requiredSince, "2026-07-01");
  assertEquals(state.privacy.current, "2026-04-01");
});

Deno.test("NULL recorded acceptance always needs (re-)acceptance", () => {
  const state = deriveLegalVersionState([doc("tos", "2026-04-01"), doc("privacy", "2026-04-01")]);
  assertEquals(needsReacceptance(state, { tos: null, privacy: null }), true);
  assertEquals(needsReacceptance(state, { tos: "2026-04-01", privacy: null }), true);
});

Deno.test("acceptance matching the required bar is current", () => {
  const state = deriveLegalVersionState([doc("tos", "2026-04-01"), doc("privacy", "2026-04-01")]);
  assertEquals(
    needsReacceptance(state, { tos: "2026-04-01", privacy: "2026-04-01" }),
    false,
  );
});

Deno.test("publishing a forcing version flips prior acceptors to must-re-accept", () => {
  const state = deriveLegalVersionState([
    doc("tos", "2026-04-01"),
    doc("tos", "2026-07-01"), // requires_reacceptance = true
    doc("privacy", "2026-04-01"),
  ]);
  // A user on the old ToS version must re-accept; up-to-date privacy is fine.
  assertEquals(
    needsReacceptance(state, { tos: "2026-04-01", privacy: "2026-04-01" }),
    true,
  );
  assertEquals(
    needsReacceptance(state, { tos: "2026-07-01", privacy: "2026-04-01" }),
    false,
  );
});

Deno.test("a non-forcing new version does NOT disturb prior acceptors", () => {
  const state = deriveLegalVersionState([
    doc("tos", "2026-04-01"),
    doc("tos", "2026-07-01", false), // minor edit, no forced re-acceptance
    doc("privacy", "2026-04-01"),
  ]);
  // current advances, but the required bar stays at 2026-04-01.
  assertEquals(state.tos.current, "2026-07-01");
  assertEquals(state.tos.requiredSince, "2026-04-01");
  assertEquals(
    needsReacceptance(state, { tos: "2026-04-01", privacy: "2026-04-01" }),
    false,
  );
});

Deno.test("an acceptance older than the required bar needs re-acceptance", () => {
  const state = deriveLegalVersionState([
    doc("tos", "2026-07-01"), // only the new forcing version is published
    doc("privacy", "2026-04-01"),
  ]);
  assertEquals(
    needsReacceptance(state, { tos: "2026-01-01", privacy: "2026-04-01" }),
    true,
  );
});
