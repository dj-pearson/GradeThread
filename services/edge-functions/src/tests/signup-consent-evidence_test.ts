// US-2116 AC4 — the rules that keep a consent record honest.
//
// Every case here is about the same thing: this endpoint must never produce a
// row that claims more than the server actually observed. legal_acceptances is
// append-only and is the artifact you would hand to a regulator, so a wrong row
// cannot be corrected later — only explained.

import { assertEquals } from "@std/assert";
import {
  type AcceptanceRow,
  decideSignupConsentEvidence,
  SIGNUP_CLICKWRAP_METHOD,
  SIGNUP_CONFIRMED_METHOD,
} from "../lib/signup-consent-evidence.ts";

function row(
  method: string,
  acceptedAt: string,
  tos = "2026-04-01",
  privacy = "2026-04-01",
): AcceptanceRow {
  return {
    method,
    tos_version: tos,
    privacy_version: privacy,
    accepted_at: acceptedAt,
  };
}

Deno.test("records evidence for a signup clickwrap that has none", () => {
  const d = decideSignupConsentEvidence([
    row(SIGNUP_CLICKWRAP_METHOD, "2026-05-01T00:00:00Z"),
  ]);
  assertEquals(d.action, "insert");
});

Deno.test("copies the versions the user ACTUALLY accepted, not today's", () => {
  // THE CORE CASE. Email signup defers the session until the confirmation link
  // is clicked, which can be days later. If the confirmation row resolved the
  // current published versions instead of copying, a version bump in between
  // would record the user as having accepted a document they never saw — and
  // it would look like stronger evidence than the row it sits beside, because
  // it has a real IP on it.
  //
  // This is also why the endpoint is not POST /api/legal/accept, which stamps
  // the current versions by design.
  const d = decideSignupConsentEvidence([
    row(SIGNUP_CLICKWRAP_METHOD, "2026-05-01T00:00:00Z", "2026-01-15", "2026-02-20"),
  ]);
  if (d.action !== "insert") throw new Error("expected insert");
  assertEquals(d.tosVersion, "2026-01-15");
  assertEquals(d.privacyVersion, "2026-02-20");
});

Deno.test("refuses when there is no clickwrap to corroborate", () => {
  // An OAuth signup: the trigger writes no audit row (00142:120 only fires when
  // the clickwrap metadata is present), and the legal gate records that consent
  // through /accept with a real IP already. Writing a row here would be
  // asserting an acceptance that never happened, which is the exact failure the
  // whole module exists to avoid — a fabricated record is worse than a missing
  // one, because it will be believed.
  const d = decideSignupConsentEvidence([
    row("oauth_clickwrap", "2026-05-01T00:00:00Z"),
    row("reacceptance", "2026-06-01T00:00:00Z"),
  ]);
  assertEquals(d, { action: "refuse", reason: "no_signup_clickwrap" });
});

Deno.test("refuses on an empty history", () => {
  assertEquals(decideSignupConsentEvidence([]), {
    action: "refuse",
    reason: "no_signup_clickwrap",
  });
});

Deno.test("refuses a clickwrap row naming no document", () => {
  // A confirmation whose versions are blank is a record that reads as evidence
  // and carries none: it says somebody agreed to something.
  const d = decideSignupConsentEvidence([
    row(SIGNUP_CLICKWRAP_METHOD, "2026-05-01T00:00:00Z", "", "2026-04-01"),
  ]);
  assertEquals(d.action, "refuse");
});

Deno.test("is idempotent — a second sign-in appends nothing", () => {
  // The table is append-only, so a lost race is not a harmless retry, it is a
  // duplicate audit row forever. The guard is server-side for that reason: a
  // client flag can be stale, cleared, or raced by two tabs.
  const d = decideSignupConsentEvidence([
    row(SIGNUP_CLICKWRAP_METHOD, "2026-05-01T00:00:00Z"),
    row(SIGNUP_CONFIRMED_METHOD, "2026-05-03T00:00:00Z"),
  ]);
  assertEquals(d, { action: "skip", reason: "already_confirmed" });
});

Deno.test("idempotency wins even when the confirmation is recorded FIRST", () => {
  // Order-independence matters because the caller passes whatever the query
  // returned. A check that only looked at the last row would re-insert here.
  const d = decideSignupConsentEvidence([
    row(SIGNUP_CONFIRMED_METHOD, "2026-05-03T00:00:00Z"),
    row(SIGNUP_CLICKWRAP_METHOD, "2026-05-01T00:00:00Z"),
  ]);
  assertEquals(d.action, "skip");
});

Deno.test("corroborates the EARLIEST clickwrap when somehow there are two", () => {
  // There should only ever be one. If a future path appends another, the signup
  // is the first — taking the latest would attach the confirmation to the wrong
  // acceptance and name the wrong documents.
  const d = decideSignupConsentEvidence([
    row(SIGNUP_CLICKWRAP_METHOD, "2026-07-01T00:00:00Z", "2026-06-01", "2026-06-01"),
    row(SIGNUP_CLICKWRAP_METHOD, "2026-05-01T00:00:00Z", "2026-01-15", "2026-02-20"),
  ]);
  if (d.action !== "insert") throw new Error("expected insert");
  assertEquals(d.tosVersion, "2026-01-15");
});

Deno.test("a clickwrap with no timestamp still gets evidence", () => {
  // accepted_at is NOT NULL in the schema, so this is defensive — but sorting
  // undefined-first would silently pick a row with no time as "the earliest",
  // and dropping it would refuse a real acceptance. It sorts LAST and is still
  // usable when it is the only one.
  const d = decideSignupConsentEvidence([
    { ...row(SIGNUP_CLICKWRAP_METHOD, ""), accepted_at: null },
  ]);
  assertEquals(d.action, "insert");
});

Deno.test("the two method values are distinct strings", () => {
  // The whole design rests on a reader being able to tell the guaranteed-weak
  // row from the best-effort-strong one WITHOUT inferring it from a null IP.
  // Collapsing these to one value would make the pair indistinguishable and
  // would also break the idempotency check, which would then see the trigger's
  // own row as proof the work was already done.
  //
  // The literal types are narrow enough that `A === B` is a COMPILE error, so
  // the strongest form of this check is the one deno check already runs. Widen
  // to string here so the runtime assertion survives too — the constants are
  // read as plain text by the migration comment and by anyone querying the
  // table, and only one of those has a type checker.
  const a: string = SIGNUP_CLICKWRAP_METHOD;
  const b: string = SIGNUP_CONFIRMED_METHOD;
  assertEquals(a === b, false);
  assertEquals(a, "signup_clickwrap");
  assertEquals(b, "signup_clickwrap_confirmed");
});
