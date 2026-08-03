// US-2351 [P0]: impersonation is bounded, marked and revocable.
//
// The ENTRY was always well guarded — super_admin, users:role scope, a fresh
// step-up, privileged targets refused, the start audited. Everything AFTER the
// token was minted was open, and the four holes compound:
//
//   • no clock — the minted magic link yields an ordinary session for the
//     target, access token plus long-lived refresh token, sitting in the admin's
//     browser with no cap anywhere;
//   • no revocation — /stop redeemed the admin's resume token and never signed
//     the target out, so a refresh token copied mid-session outlived the "stop";
//   • no marker — nothing server-side said "this is an impersonation", so every
//     action taken was indistinguishable from the real user's;
//   • a client-controlled stop record — the stop audit row took target_id
//     straight from the request body.
//
// Together: a super_admin could impersonate a disputing customer, cancel their
// subscription and delete their account, and every downstream record — Stripe,
// the deletion log, the marketplace disconnect — would show the CUSTOMER doing
// it. The admin's trail said only "impersonation started".
//
// Source-scanned because driving this needs GoTrue, a real session and a second
// user. What can be pinned without them is that each control is CALLED, in the
// right place, and fails in the safe direction.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key",
);
const { IMPERSONATION_MAX_SECONDS } = await import("../lib/impersonation-session.ts");

const read = (p: string) => Deno.readTextFileSync(new URL(p, import.meta.url));
const ROUTE = read("../routes/admin-impersonation.ts");
const LIB = read("../lib/impersonation-session.ts");
const GUARD = read("../lib/destructive-guard.ts");
const ACCOUNT = read("../routes/account.ts");

Deno.test("US-2351 AC1: there is a hard cap, and it is short", () => {
  assert(IMPERSONATION_MAX_SECONDS > 0, "no cap at all");
  assert(
    IMPERSONATION_MAX_SECONDS <= 60 * 60,
    `${IMPERSONATION_MAX_SECONDS}s is long enough that a session left open over ` +
      `lunch is still live afterwards`,
  );
  // Enforced on READ, not by a sweep. The window between a cap passing and a
  // scheduled job noticing is exactly when a forgotten session is dangerous.
  assert(
    LIB.includes("Date.parse(row.expires_at) > nowMs"),
    "expiry is no longer decided when the session is read",
  );
});

Deno.test("US-2351 AC1: a start that cannot be recorded does not happen", () => {
  // The row is the marker, the clock and the revocation handle. Handing out a
  // token without it recreates precisely the session this story removed, so a
  // failed insert must be a refusal rather than a logged warning.
  const at = ROUTE.indexOf("const session = await startImpersonation(");
  assert(at > -1, "the session record is no longer opened at start");
  const after = ROUTE.slice(at, at + 600);
  assert(after.includes("if (!session)"), "a failed insert is not checked");
  assert(after.includes("500"), "a failed insert does not refuse the start");
  // And it must happen BEFORE the token is returned.
  assert(
    at < ROUTE.indexOf("token_hash: link.properties.hashed_token"),
    "the token is handed out before the session is recorded",
  );
});

Deno.test("US-2351 AC2: stopping revokes the target's sessions", () => {
  assert(
    ROUTE.includes("await revokeUserSessions(session.target_id)"),
    "stop no longer signs the target out — a copied refresh token outlives it",
  );
  // supabase-js cannot do this: `auth.admin.signOut` wants a JWT, which lives in
  // the admin's browser. GoTrue's admin logout is the only thing that reaches a
  // token already copied out.
  assert(
    LIB.includes("/auth/v1/admin/users/") && LIB.includes("/logout"),
    "the revocation no longer calls GoTrue's admin logout",
  );
  assert(
    LIB.includes('scope: "global"'),
    "a non-global scope leaves other refresh tokens for that user alive",
  );
  // The result is reported, not swallowed: an un-revoked stop means the target's
  // tokens are still live and the operator needs to know now.
  assert(ROUTE.includes("revoked"), "the stop response hides whether it worked");
});

Deno.test("US-2351 AC6: the stop record comes from the START, not the body", () => {
  // It used to read target_id straight from the request, so an admin could
  // impersonate one person and log having stopped impersonating another — worse
  // than no row, because it reads as evidence.
  assert(
    ROUTE.includes("activeImpersonationByActor(actorId, now)"),
    "stop no longer resolves the session from the actor's own start record",
  );
  const stopAt = ROUTE.indexOf('adminImpersonationRoutes.post("/stop"');
  const stopBody = ROUTE.slice(stopAt);
  assert(
    !/body\.target_id/.test(stopBody),
    "the stop audit row is client-controlled again",
  );
});

Deno.test("US-2351 AC3: the marker read fails CLOSED", () => {
  // A database blip must refuse the destructive action, not permit it. Being
  // wrong that way costs a real user a retry; being wrong the other way is
  // unrecoverable.
  const at = LIB.indexOf("export async function isImpersonated");
  assert(at > -1, "isImpersonated is gone");
  const body = LIB.slice(at, LIB.indexOf("\n}", at));
  assert(
    /if \(error\)[\s\S]{0,200}return true/.test(body),
    "an error path that returns false silently re-opens every guarded route",
  );
});

Deno.test("US-2351 AC3: the destructive routes are guarded, by enumeration", () => {
  // Enumerated rather than covered by a blanket middleware: a middleware would
  // have to list what is destructive anyway, and would silently permit anything
  // it did not know about — the same failure shape US-2354 removed from the
  // scope guard.
  const SITES: Array<[string, string]> = [
    ["../routes/account.ts", "Deleting an account"],
    ["../routes/payments.ts", "Cancelling a subscription"],
    ["../routes/payments.ts", "Opening the billing portal"],
    ["../routes/flipdesk-ebay.ts", "Disconnecting a marketplace"],
    ["../routes/flipdesk-depop.ts", "Disconnecting a marketplace"],
    ["../routes/flipdesk-etsy.ts", "Disconnecting a marketplace"],
    ["../routes/flipdesk-google.ts", "Disconnecting a marketplace"],
    ["../routes/flipdesk-shopify.ts", "Disconnecting a marketplace"],
  ];
  const missing: string[] = [];
  for (const [file, label] of SITES) {
    const src = read(file);
    if (!src.includes(`refuseWhileImpersonating(c, "${label}")`)) {
      missing.push(`${file} → ${label}`);
    }
  }
  assertEquals(missing, [], "these destructive routes lost their guard");
});

Deno.test("US-2351 AC3: the guard refuses rather than merely reporting", () => {
  assert(GUARD.includes("impersonation_blocked"), "the refusal code is gone");
  assert(/403/.test(GUARD), "the guard no longer returns a refusal status");
});

Deno.test("US-2351 AC4: the delete password check is server-side and fails closed", () => {
  // It used to be a signInWithPassword() call in the browser before the POST,
  // which is a UX courtesy. The endpoint's only real control was the confirm
  // string, so anything holding a session could delete the account directly —
  // including an impersonating admin, for whom the dialog never appears.
  assert(ACCOUNT.includes("async function verifyPassword("), "no server-side check");
  assert(
    ACCOUNT.includes("grant_type=password"),
    "the check no longer asks the auth service, so it cannot be proving anything",
  );
  assert(
    ACCOUNT.includes("password_incorrect"),
    "a wrong password no longer refuses the deletion",
  );
  const at = ACCOUNT.indexOf("async function verifyPassword(");
  const body = ACCOUNT.slice(at, ACCOUNT.indexOf("\n}", at));
  assert(
    /catch \{[\s\S]{0,400}return false/.test(body),
    "an unreachable auth service reads as a proved password",
  );
  // It must NOT use the service-role client, which would mint a session.
  assert(
    !/verifyPassword[\s\S]{0,800}supabaseAdmin\.auth/.test(ACCOUNT.slice(at, at + 900)),
    "the password check goes through the privileged client",
  );
});

Deno.test("US-2351: the browser no longer decides the password check", () => {
  // Two places deciding the same thing is how one of them drifts, and the
  // browser's answer was never the one that mattered.
  const settings = Deno.readTextFileSync(
    new URL("../../../../src/pages/settings.tsx", import.meta.url),
  );
  const at = settings.indexOf("async function handleDelete()");
  assert(at > -1, "handleDelete was renamed");
  const body = settings.slice(at, at + 2000);
  // Matched as a CALL, not as the word: the surrounding comments explain what
  // the old local check did, and a substring scan would fire on its own
  // explanation. That is the second time in this session a guard accused its own
  // prose, so it is worth doing properly the first time.
  assert(
    !/await\s+supabase\.auth\.signInWithPassword\(/.test(body),
    "the browser still re-authenticates locally before deleting",
  );
  assert(
    body.includes("password: reauthPassword"),
    "the password is no longer sent to the server, so the server cannot check it",
  );
});

Deno.test("US-2351 AC5: a reviewer cannot be impersonated either", () => {
  // The set is "roles whose account carries authority a super_admin should not
  // be able to borrow", not "roles above some line in the ladder". A reviewer
  // holds grading:review — they adjust issued grades, which are the product —
  // so impersonating one produces a grade adjustment audited to the reviewer
  // rather than to the admin who made it. That is the same non-repudiation loss
  // the admin exclusion exists to prevent.
  const m = /const PRIVILEGED_ROLES = new Set\(\[([^\]]*)\]\)/.exec(ROUTE);
  assert(m, "PRIVILEGED_ROLES is gone");
  const roles = m[1]!.split(",").map((r) => r.trim().replace(/"/g, "")).filter(Boolean);
  for (const r of ["reviewer", "admin", "super_admin"]) {
    assert(roles.includes(r), `${r} can be impersonated`);
  }
  // And ordinary users must stay impersonable — that is what the feature is for.
  assert(!roles.includes("user"), "nobody can be impersonated at all now");
});

Deno.test("the refusal names the rule that actually stopped you", () => {
  // AC5 added `reviewer` to PRIVILEGED_ROLES and left the message saying "an
  // admin or super-admin", so a refused reviewer was told about a rule that was
  // not the one applied. The cost is not cosmetic: the next operator reads a
  // message that does not match the code, concludes the check is broken, and
  // goes looking for a bug that is not there.
  //
  // Asserted against PRIVILEGED_ROLES itself rather than a fixed string, so the
  // message cannot drift away from the set again.
  const m = /const PRIVILEGED_ROLES = new Set\(\[([^\]]*)\]\)/.exec(ROUTE);
  assert(m, "PRIVILEGED_ROLES is gone");
  const roles = m[1]!.split(",").map((r) => r.trim().replace(/"/g, "")).filter(Boolean);

  const refusal = ROUTE.slice(ROUTE.indexOf("PRIVILEGED_ROLES.has(target.role)"));
  // COMMENTS STRIPPED. The first version of this checked the raw slice, and the
  // explanatory comment above the message names every role — so reverting the
  // message to the stale one left the case GREEN, satisfied by prose about the
  // very bug it was written to catch. Negative verification is the only reason
  // that was found; the assertion read as correct.
  const message = refusal
    .slice(0, refusal.indexOf("403"))
    .replace(/\/\/[^\n]*/g, "");
  for (const role of roles) {
    // super_admin appears as "super-admin" in prose; compare on the stem.
    const stem = role.replace(/_/g, "-");
    assert(
      message.includes(stem) || message.includes(role),
      `the refusal does not mention ${role}, which it refuses`,
    );
  }
});
