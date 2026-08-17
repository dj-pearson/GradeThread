// US-2662: stopping impersonation must actually revoke, on a stack where the
// route it used does not exist.
//
// WHY THIS FILE EXISTS AND impersonation-bounds_test.ts WAS NOT ENOUGH. That
// file asserts the SOURCE calls revokeUserSessions and that the lib names
// GoTrue's admin logout. Both were true the whole time and the control did not
// work: POST /auth/v1/admin/users/{id}/logout answers 404 on GoTrue v2.195.0
// (GET /admin/users/{id} answers 200 as the control, so auth, routing and the id
// were all fine and the route was simply absent). Every stop returned
// sessions_revoked: false and the admin's copy of the target's refresh token
// stayed live. A test asserting a call was made cannot see that. These assert
// the OUTCOME of the pair, so they go red if revocation stops happening.
//
// WHY THE SEAM. Neither half can be stubbed from outside: supabaseAdmin is a
// Proxy whose get trap always resolves to the real client (supabase.ts:76), so
// assigning .rpc on it does nothing, and the client captures fetch at
// construction, so stubbing globalThis.fetch does not reach it. Both were tried
// first, and both let the real client attempt a TCP connection.
//
//   deno test --allow-env --allow-read src/tests/impersonation-revoke_test.ts
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { revokeUserSessions } = await import("../lib/impersonation-session.ts");

const TARGET = "11111111-1111-1111-1111-111111111111";

const gotrue = (ok: boolean, detail = ok ? "204" : "404") => () =>
  Promise.resolve({ ok, detail });

/** Records who the fallback was asked to delete, and answers as told. */
function recordingDelete(error: { message: string } | null = null) {
  const calls: string[] = [];
  return {
    calls,
    fn: (userId: string) => {
      calls.push(userId);
      return Promise.resolve({ error });
    },
  };
}

Deno.test("a 404 from GoTrue still revokes, through the mechanism we own", async () => {
  const del = recordingDelete();
  // THE REGRESSION. Before US-2662 this returned false and nothing was revoked:
  // the admin's copy of the target's refresh token outlived the stop by its
  // full lifetime.
  assertEquals(
    await revokeUserSessions(TARGET, { logout: gotrue(false), deleteRows: del.fn }),
    true,
  );
  assertEquals(del.calls.length, 1, "the fallback never ran");
  // Deleting the rows for the WRONG user would report a clean stop while the
  // target stayed signed in, so the id matters as much as the call.
  assertEquals(del.calls[0], TARGET);
});

Deno.test("both paths failing reports false rather than a clean stop", async () => {
  const del = recordingDelete({ message: "permission denied" });
  // The one case where the operator must be told: the tokens are still live.
  assertEquals(
    await revokeUserSessions(TARGET, { logout: gotrue(false), deleteRows: del.fn }),
    false,
  );
  assertEquals(del.calls.length, 1);
});

Deno.test("where GoTrue's route exists, it is used and the fallback stays out of it", async () => {
  const del = recordingDelete();
  assertEquals(
    await revokeUserSessions(TARGET, { logout: gotrue(true), deleteRows: del.fn }),
    true,
  );
  // Not a style point: the fallback deletes rows, so running it after a
  // successful upstream logout would be a second destructive write for no
  // reason, and would mask a regression in the supported route.
  assertEquals(del.calls.length, 0, "the fallback ran even though GoTrue succeeded");
});

Deno.test("a thrown request to GoTrue is not the end of it either", async () => {
  const del = recordingDelete();
  assertEquals(
    await revokeUserSessions(TARGET, {
      logout: () => Promise.resolve({ ok: false, detail: "network down" }),
      deleteRows: del.fn,
    }),
    true,
  );
  assertEquals(del.calls.length, 1, "a failed request skipped the fallback");
});

Deno.test("the real default path is the RPC, not a second GoTrue call", () => {
  // The seam only proves the branching. This pins what the defaults ARE, since
  // a test that injects both halves would otherwise stay green if production
  // stopped calling either one.
  const lib = Deno.readTextFileSync(new URL("../lib/impersonation-session.ts", import.meta.url));
  assert(
    lib.includes('deps.deleteRows ?? revokeViaDatabase'),
    "the default fallback is no longer revokeViaDatabase",
  );
  assert(
    /supabaseAdmin\.rpc\(\s*"admin_revoke_user_sessions"/.test(lib),
    "revokeViaDatabase no longer calls the admin_revoke_user_sessions RPC",
  );
});

Deno.test("the migration ships the function the fallback calls", () => {
  // The RPC name is a string on one side and SQL on the other; nothing else
  // links them, and a rename on either side is silent until an admin stops an
  // impersonation in production.
  const sql = Deno.readTextFileSync(
    new URL(
      "../../../../supabase/migrations/00612_admin_revoke_user_sessions.sql",
      import.meta.url,
    ),
  );
  assert(
    sql.includes("FUNCTION public.admin_revoke_user_sessions(p_user_id uuid)"),
    "the function the fallback calls is not in 00612",
  );
  // It reaches auth, which is the whole reason it cannot be a client call.
  assert(sql.includes("DELETE FROM auth.sessions"), "sessions are not deleted");
  assert(sql.includes("DELETE FROM auth.refresh_tokens"), "refresh tokens are not deleted");
  // And it refuses anyone but the edge. US-2666: the check is in the BODY,
  // because a REVOKE statement here would arm the US-2403 segfault on a denied
  // call. Matched at the start of a line so the header prose may discuss revokes.
  assert(sql.includes("service role required"), "the caller check is missing");
  assert(
    !/^\s*REVOKE\b/im.test(sql),
    "the guard was written as a REVOKE statement — see US-2403 and US-2666",
  );
});
