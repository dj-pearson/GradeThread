// US-3118: the in-body service-role check actually refuses, proved by calling it.
//
// WHY THESE THREE FUNCTIONS. On this Postgres image a DENIED function call from
// a role in `supautils.hint_roles` segfaults the backend and restarts the
// database, because supautils appends a GRANT hint to the permission error
// (US-2403). So `REVOKE EXECUTE ... FROM anon` is not available to us, and three
// migrations that reached for it had to be undone: 00686 repaired 00685
// (`rebuild_ledger_for_user`), 00720 repaired 00711 (`bump_ebay_api_calls`), and
// 00726 repaired 00724 (`pollable_ebay_owner_ids`). Each restores the default
// EXECUTE — which is what disarms the crash, since a role that HOLDS execute
// never takes the denial path — and moves the authorization into the function
// body, where it raises an ordinary 42501.
//
// That trade is right, and it leaves these three functions with NO privilege
// layer underneath them. The body check is the only thing between an
// unauthenticated request and, in `pollable_ebay_owner_ids`' case, a list of
// every connected seller's user id. `pollable_ebay_owner_ids` returns other
// tenants' rows by design, so a regression there is a US-268 tenant-isolation
// break rather than a leak of one row.
//
// WHY A LIVE CALL AND NOT A SCAN. `us2403-function-revoke-gate.test.ts` reads
// migration TEXT. It is the right instrument for its own job — "did a new
// migration add a REVOKE" — and the wrong one for this: reordering the four-line
// IF, inverting it, or moving it below the first data access all leave the text
// present and the scan green. The failure this file exists for is invisible to a
// scan by construction.
//
// THE BYPASS WORTH KNOWING ABOUT, and the limit of what these cases prove. The
// guard admits a NULL `auth.role()`, so an operator running the function in psql
// is not locked out of their own database. The obvious worry is that an
// unauthenticated HTTP request also has no role and walks straight through. It
// does not: PostgREST assigns `db-anon-role` when no JWT is present, so
// `auth.role()` is `'anon'`, not NULL. The no-header case below pins that.
//
// Measured, because a sabotage run said so rather than because it reads that
// way. Rewriting the guard to RETURN EVERY ROW on a NULL role changed nothing
// observable over HTTP — a no-header call still came back 42501 — while the same
// function in psql, where `auth.role()` really is NULL, took the new branch. So
// the NULL arm is unreachable through PostgREST and these cases do not cover it.
// A guard that leaks only to a caller with a psql session is not a guard
// failure; someone at that prompt is already superuser. Do not read a green run
// here as "the NULL arm was tested".
//
// SABOTAGE RUN, 2026-09-04, against the local stack at 00726. Four mutations of
// `pollable_ebay_owner_ids`, control green either side:
//
//   inverting the guard (admit anon, refuse service_role)      3 failed  CAUGHT
//   deleting the guard entirely                                2 failed  CAUGHT
//   refusing everyone, service_role included                   1 failed  CAUGHT
//   moving the guard BELOW the data access                     0 failed  ignored
//
// The last one is not a hole, and the reason is worth keeping. `RETURN QUERY`
// in plpgsql BUFFERS rows into the result set; it does not return. Execution
// continues to the RAISE, which aborts the function, so anon still gets 42501
// and no rows — verified by curling it, not assumed from the green run. "Put the
// authorization check first" is ordinary and correct advice that this language
// happens to make unnecessary here; a `language sql` function would have no such
// protection.
//
// GATED, and skips cleanly. Needs a running PostgREST with the migrations
// applied:
//   TEST_SUPABASE_URL                 e.g. http://127.0.0.1:54321
//   TEST_SUPABASE_ANON_KEY
//   TEST_SUPABASE_SERVICE_ROLE_KEY
// Locally: `docker start supabase_db_gradethread supabase_rest_gradethread
// supabase_kong_gradethread`, apply the migrations, then read the keys from
// `supabase status -o env`. See CLAUDE.md, "PostgREST CAN run locally".
//
//   deno test --allow-env --allow-net src/tests/body-check-denies-anon_test.ts
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";

const BASE = Deno.env.get("TEST_SUPABASE_URL");
const ANON = Deno.env.get("TEST_SUPABASE_ANON_KEY");
const SERVICE = Deno.env.get("TEST_SUPABASE_SERVICE_ROLE_KEY");
const READY = Boolean(BASE && ANON && SERVICE);

/**
 * The functions whose ONLY authorization is an in-body service-role check, with
 * an argument payload that is valid for each. A new body-check repair belongs
 * here on the commit that adds it.
 */
const BODY_CHECKED: {
  fn: string;
  args: Record<string, unknown>;
  repairedBy: string;
  why: string;
  /**
   * What service_role should get with the synthetic arguments above.
   * "ok"       — a clean 200; the call is harmless with these args.
   * "executes" — the guard lets it through and the function then complains
   *              about the arguments themselves. Still proves authorization
   *              passed, which is the only property this file is testing.
   */
  service: "ok" | "executes";
}[] = [
  {
    fn: "pollable_ebay_owner_ids",
    args: { p_since: "2026-01-01T00:00:00Z" },
    repairedBy: "00726 (undoing 00724)",
    why: "returns every connected seller's user id — other tenants' rows by design",
    service: "ok",
  },
  {
    fn: "bump_ebay_api_calls",
    args: { p_rows: [] },
    repairedBy: "00720 (undoing 00711)",
    why: "writes the eBay API-call accounting rollup",
    service: "ok",
  },
  {
    fn: "rebuild_ledger_for_user",
    args: { p_user_id: "00000000-0000-0000-0000-000000000000" },
    repairedBy: "00686 (undoing 00685)",
    why: "rewrites a user's credit ledger",
    // Measured 2026-09-04: returns 400 / 21000 "DELETE requires a WHERE clause"
    // for a user id that owns nothing. That is the function's own logic
    // objecting to a made-up argument, which means it ran — the guard admitted
    // service_role. Inventing a real ledger to get a 200 would buy nothing here
    // and would make this file own credit-ledger fixtures.
    service: "executes",
  },
];

type Caller = "none" | "anon" | "service";

async function callRpc(
  fn: string,
  args: Record<string, unknown>,
  as: Caller,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (as === "anon") {
    headers.apikey = ANON!;
    headers.Authorization = `Bearer ${ANON!}`;
  } else if (as === "service") {
    headers.apikey = SERVICE!;
    headers.Authorization = `Bearer ${SERVICE!}`;
  }
  const res = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers,
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Leave it as text; the assertions below report it either way.
  }
  return { status: res.status, body };
}

function pgCode(body: unknown): string | undefined {
  return typeof body === "object" && body !== null
    ? (body as { code?: string }).code
    : undefined;
}

for (const target of BODY_CHECKED) {
  Deno.test({
    name: `${target.fn}: anon is refused with 42501 and gets no rows`,
    ignore: !READY,
    fn: async () => {
      const { status, body } = await callRpc(target.fn, target.args, "anon");
      assert(
        !Array.isArray(body),
        `${target.fn} RETURNED A RESULT SET to anon (${target.why}). The body ` +
          `check added by ${target.repairedBy} is the only thing guarding it, ` +
          `and it did not fire.`,
      );
      assertEquals(
        pgCode(body),
        "42501",
        `${target.fn} as anon: expected 42501, got ${JSON.stringify(body)}`,
      );
      assertEquals(status, 401);
    },
  });

  Deno.test({
    name: `${target.fn}: a request with NO auth header is refused too`,
    ignore: !READY,
    fn: async () => {
      // PostgREST assigns db-anon-role when no JWT is present, so auth.role()
      // is 'anon' rather than NULL and the guard still fires.
      //
      // The assertion is 42501 SPECIFICALLY, not merely "some error". A gateway
      // that rejected the request before it reached Postgres would also produce
      // a 401 with a code, and that would prove nothing about the function —
      // the refusal has to come from the body check itself. 42501 raised with
      // the function's own message is what says it ran.
      const { body } = await callRpc(target.fn, target.args, "none");
      assert(
        !Array.isArray(body),
        `${target.fn} answered an UNAUTHENTICATED request with a result set.`,
      );
      assertEquals(
        pgCode(body),
        "42501",
        `${target.fn} with no auth headers: expected the FUNCTION to refuse ` +
          `with 42501, got ${JSON.stringify(body)}. Anything else means the ` +
          `call did not reach the body check, so this case proves nothing.`,
      );
    },
  });

  Deno.test({
    name: `${target.fn}: service_role still works`,
    ignore: !READY,
    fn: async () => {
      // Without this, a future "tightening" that denies EVERYONE would pass the
      // two cases above while breaking the job that depends on the function.
      const { status, body } = await callRpc(target.fn, target.args, "service");

      // The property, for both kinds: service_role got PAST the guard. A 42501
      // or a 401 here means the body check now refuses the one caller it exists
      // to admit.
      assert(
        pgCode(body) !== "42501" && status !== 401 && status !== 403,
        `${target.fn} REFUSED service_role (${status} ${JSON.stringify(body)}). ` +
          `The body check from ${target.repairedBy} must admit exactly this ` +
          `caller — denying everyone is not a tightening, it is an outage.`,
      );

      if (target.service === "ok") {
        assertEquals(
          status,
          200,
          `${target.fn} as service_role: expected 200, got ${status} ` +
            `${JSON.stringify(body)}`,
        );
        assertEquals(
          pgCode(body),
          undefined,
          `${target.fn} as service_role returned an error: ${
            JSON.stringify(body)
          }`,
        );
      }
    },
  });
}

Deno.test({
  name: "the gate is armed: the fixture env is present, or every case skipped",
  fn: () => {
    // A file whose cases all skip reads exactly like a file that passes. This
    // states which of the two happened, so a CI job that MEANT to run these
    // does not report success for having run nothing.
    if (!READY) {
      console.log(
        "[body-check-denies-anon] SKIPPED — set TEST_SUPABASE_URL, " +
          "TEST_SUPABASE_ANON_KEY and TEST_SUPABASE_SERVICE_ROLE_KEY to run.",
      );
    }
    assertEquals(BODY_CHECKED.length, 3);
  },
});
