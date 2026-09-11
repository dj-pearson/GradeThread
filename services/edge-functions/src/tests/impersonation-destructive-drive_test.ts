// US-2351 AC3/AC4: an impersonated session cannot delete the account — PROVEN BY
// DRIVING THE ROUTE, not by reading it.
//
// WHY THIS FILE EXISTS BESIDE impersonation-bounds_test.ts. That file scans
// source: it asserts `refuseWhileImpersonating(c, "Deleting an account")` appears
// in account.ts and that the guard returns a 403. Every one of those assertions
// can be true while the refusal never happens — the guard could sit after an
// early return, the marker query could name a column that does not exist, the
// route could be mounted somewhere the guard never runs. This story already has
// one worked example of exactly that: AC2's "stopping revokes the target's
// sessions" stayed green for two weeks while GoTrue answered 404 to the call it
// asserted (US-2662). A source scan proves a call is WRITTEN. Only a request
// proves a refusal HAPPENS.
//
// HOW IT DRIVES THEM WITHOUT A DATABASE. The marker is one PostgREST read, so
// the seam is `fetch`: a fake PostgREST here answers
// /rest/v1/admin_impersonation_sessions by applying the real query's own
// eq/is/gt filters to an in-memory row. The route, the guard, the supabase-js
// query builder and the filter set are all the real ones — only the wire is
// faked. That means this file also catches a marker query that stops scoping on
// target_id or stops honouring the expiry, which no source scan can see.
//
// EVERY CASE HAS A CONTROL. A 403 is worthless evidence on its own: an
// unreachable stub, a thrown middleware or a typo'd path all produce refusals
// too. So each blocked case is paired with the SAME request under no
// impersonation, which must get somewhere else entirely.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { resetSupabaseAdminForTests } from "../lib/supabase.ts";
import { accountRoutes } from "../routes/account.ts";
import { paymentRoutes } from "../routes/payments.ts";
import { gradeRoutes } from "../routes/grade.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

// ── the fake wire ────────────────────────────────────────────────
//
// Installed before the supabase client is ever constructed (it is built lazily,
// on first query — see lib/supabase.ts), so the client captures this fetch.

interface Marker {
  id: string;
  target_id: string;
  expires_at: string;
  ended_at: string | null;
}

let markers: Marker[] = [];
let markerReadFails = false;
let seenUrls: string[] = [];

// The identity GoTrue reports for the account, and whether the password grant
// accepts. Both are what the AC4 re-auth reads; `null` is what an auth outage
// looks like from inside this endpoint.
let identity: Record<string, unknown> | null = {
  id: USER,
  email: "seller@example.com",
  app_metadata: { providers: ["email"], provider: "email" },
};
let passwordAccepted = false;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Apply the request's own PostgREST filters to the in-memory rows.
 *
 * Deliberately NOT "return the rows the test set up". The point of the fake is
 * that the FILTERS are the code under test: if isImpersonated stops scoping on
 * target_id, or drops the expiry comparison, the rows it gets back change here
 * and a case goes red. A stub that ignored the query string would pass through
 * both of those regressions.
 */
function applyFilters(url: URL): Marker[] {
  return markers.filter((row) => {
    for (const [key, raw] of url.searchParams) {
      if (key === "select" || key === "limit" || key === "order") continue;
      const [op, ...rest] = raw.split(".");
      const value = rest.join(".");
      const cell = (row as unknown as Record<string, unknown>)[key];
      if (op === "eq" && String(cell) !== value) return false;
      if (op === "is" && value === "null" && cell !== null) return false;
      if (op === "gt" && !(Date.parse(String(cell)) > Date.parse(value))) return false;
      if (op === "lt" && !(Date.parse(String(cell)) < Date.parse(value))) return false;
    }
    return true;
  });
}

const realFetch = globalThis.fetch;

globalThis.fetch = ((input: Request | URL | string, _init?: RequestInit) => {
  const href = typeof input === "string"
    ? input
    : input instanceof URL
    ? input.href
    : input.url;
  seenUrls.push(href);

  if (href.includes("/rest/v1/admin_impersonation_sessions")) {
    if (markerReadFails) {
      return Promise.resolve(
        jsonResponse(
          { message: "connection reset by peer", code: "08006", details: null, hint: null },
          500,
        ),
      );
    }
    return Promise.resolve(jsonResponse(applyFilters(new URL(href))));
  }

  // GoTrue's admin user lookup — what the delete endpoint asks to find out
  // whether this account has a password at all.
  if (href.includes("/auth/v1/admin/users/")) {
    return Promise.resolve(
      identity
        ? jsonResponse(identity)
        : jsonResponse({ message: "service unavailable" }, 503),
    );
  }

  // The password grant. Only the status is read.
  if (href.includes("/auth/v1/token")) {
    return Promise.resolve(
      passwordAccepted
        ? jsonResponse({ access_token: "not-used" })
        : jsonResponse({ error: "invalid_grant" }, 400),
    );
  }

  // Anything else is a table this test does not model. Answer with an empty set
  // rather than reaching the network: the control cases only have to land
  // somewhere OTHER than the impersonation refusal, and an empty read gets them
  // there honestly (user not found / feature off / nothing to cancel).
  if (href.includes("/rest/v1/") || href.includes("/auth/v1/")) {
    return Promise.resolve(jsonResponse([]));
  }

  return Promise.reject(
    new Error(`unexpected outbound call in a US-2351 drive test: ${href}`),
  );
}) as typeof fetch;

resetSupabaseAdminForTests();

function reset(): void {
  markers = [];
  markerReadFails = false;
  seenUrls = [];
  identity = {
    id: USER,
    email: "seller@example.com",
    app_metadata: { providers: ["email"], provider: "email" },
  };
  passwordAccepted = false;
}

// ── the apps ─────────────────────────────────────────────────────
//
// Mounted the way main.ts mounts them, with the authenticated user stamped the
// way authMiddleware stamps it. Nothing else is faked: these are the real
// routers.

type StampedEnv = { Variables: { userId: string } };

function app(routes: Hono<never>, base: string): Hono<StampedEnv> {
  const a = new Hono<StampedEnv>();
  a.use("*", async (c, next) => {
    c.set("userId", USER);
    await next();
  });
  a.route(base, routes as unknown as Hono<StampedEnv>);
  return a;
}

function impersonationActive(targetId: string, minutesLeft: number): void {
  markers = [{
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    target_id: targetId,
    expires_at: new Date(Date.now() + minutesLeft * 60_000).toISOString(),
    ended_at: null,
  }];
}

async function postDelete(): Promise<Response> {
  return await app(accountRoutes as unknown as Hono<never>, "/api/account")
    .request("/api/account/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "DELETE MY ACCOUNT", password: "hunter2" }),
    });
}

// ── the case this story is named for ─────────────────────────────

Deno.test("US-2351: an impersonated session cannot delete the account", async () => {
  reset();
  impersonationActive(USER, 10);

  const res = await postDelete();
  const body = await res.json();

  assertEquals(res.status, 403, "the deletion was not refused");
  assertEquals(
    body.code,
    "impersonation_blocked",
    "it was refused, but not for being an impersonation — a 403 from somewhere " +
      "else is not evidence this control works",
  );

  // And it refused BEFORE touching anything. The confirm string was correct and
  // the password was supplied, so every later gate would have let it through;
  // if the users row had been read, the deletion sequence had already begun.
  assert(
    !seenUrls.some((u) => u.includes("/rest/v1/users")),
    `the delete path started reading the account before refusing: ${
      seenUrls.join(", ")
    }`,
  );
});

Deno.test("US-2351 control: the same request is NOT refused without an impersonation", async () => {
  // Without this the case above proves only that the endpoint returns 403 for
  // some reason — a broken stub would satisfy it just as well.
  reset();

  const res = await postDelete();
  const body = await res.json().catch(() => ({}));

  // It gets past the guard and into the real delete path, which is where the
  // password re-auth (AC4) then stops it — the account survives either way, and
  // the DIFFERENCE in WHY is what this pair measures.
  assertEquals(
    body.code,
    "password_incorrect",
    `an unimpersonated delete did not reach the password gate (${res.status})`,
  );
  assert(
    seenUrls.some((u) => u.includes("/rest/v1/users")),
    "the request never reached the delete path at all, so the pair proves nothing",
  );
});

Deno.test("US-2351 AC4: a rejected password refuses the deletion", async () => {
  reset();
  const res = await postDelete();
  assertEquals(res.status, 403);
  assertEquals((await res.json()).code, "password_incorrect");
});

Deno.test("US-2351 AC4: an identity lookup that FAILS refuses the deletion", async () => {
  // ⚠ THIS FAILED OPEN UNTIL THIS TEST DROVE IT. The password check ran only
  // when the identity lookup came back naming an email provider, and the lookup
  // was read as `data?.user?.app_metadata?.providers ?? []` with the error
  // ignored — so an auth service that was down produced an empty provider list,
  // which read as "OAuth account, nothing to ask for", and the account was
  // deleted with no re-authentication at all. verifyPassword's own fail-closed
  // catch never came into it: it was not called.
  //
  // Unreachable by any source scan, because every line it would look for was
  // present and correct.
  reset();
  identity = null;

  const res = await postDelete();
  assertEquals(res.status, 503);
  assertEquals((await res.json()).code, "reauth_unavailable");
});

Deno.test("US-2351 AC4: the older singular `provider` still demands a password", async () => {
  // GoTrue writes both `app_metadata.providers` (the list) and the older
  // `app_metadata.provider` (a single string). Reading only the list means a
  // user object carrying just the singular is treated as passwordless, which is
  // the same fail-open direction as the case above.
  reset();
  identity = {
    id: USER,
    email: "seller@example.com",
    app_metadata: { provider: "email" },
  };

  const res = await postDelete();
  assertEquals(res.status, 403);
  assertEquals((await res.json()).code, "password_incorrect");
});

// ── the marker's own properties, seen through the route ──────────

Deno.test("US-2351 AC1: an EXPIRED impersonation does not block", async () => {
  // The cap is enforced on read (there is no sweep), so a row past its
  // expires_at must stop marking the session. Driven rather than asserted on
  // source: the comparison is in the PostgREST query, and the fake applies the
  // query's own filters.
  reset();
  impersonationActive(USER, -1);

  const res = await postDelete();
  const body = await res.json().catch(() => ({}));
  assertEquals(
    body.code,
    "password_incorrect",
    "a session past its 30-minute cap still marks the account",
  );
});

Deno.test("US-2351: an ENDED impersonation does not block", async () => {
  reset();
  impersonationActive(USER, 10);
  markers[0]!.ended_at = new Date().toISOString();

  const res = await postDelete();
  const body = await res.json().catch(() => ({}));
  assertEquals(
    body.code,
    "password_incorrect",
    "a stopped impersonation still marks the account",
  );
});

Deno.test("US-2351: impersonating SOMEONE ELSE does not block this user", async () => {
  // The marker is per-target. A guard that read "is any impersonation live"
  // would freeze every user's account the moment support looked at one of them,
  // and would pass every source scan in the bounds file.
  reset();
  impersonationActive(OTHER, 10);

  const res = await postDelete();
  const body = await res.json().catch(() => ({}));
  assertEquals(
    body.code,
    "password_incorrect",
    "an impersonation of a different user blocked this one",
  );
});

Deno.test("US-2351 AC3: the marker read FAILS CLOSED", async () => {
  // A database blip must refuse the deletion rather than permit it. Being wrong
  // this way costs a real user one retry; being wrong the other way is
  // unrecoverable. Asserted through the route because that is the only place
  // the choice has consequences.
  reset();
  markerReadFails = true;

  const res = await postDelete();
  const body = await res.json();
  assertEquals(res.status, 403);
  assertEquals(
    body.code,
    "impersonation_blocked",
    "a failed marker lookup let the deletion proceed",
  );
});

// ── the other destructive surfaces AC3 names ─────────────────────

Deno.test("US-2351 AC3: an impersonated session cannot cancel the subscription", async () => {
  reset();
  impersonationActive(USER, 10);

  const res = await app(paymentRoutes as unknown as Hono<never>, "/api/payments")
    .request("/api/payments/buyer/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
  const body = await res.json();
  assertEquals(res.status, 403);
  assertEquals(body.code, "impersonation_blocked");
});

Deno.test("US-2351 AC3 control: the cancel is reached without an impersonation", async () => {
  reset();

  const res = await app(paymentRoutes as unknown as Hono<never>, "/api/payments")
    .request("/api/payments/buyer/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
  const body = await res.json().catch(() => ({}));
  assert(
    body.code !== "impersonation_blocked",
    "an unimpersonated cancel was blocked as an impersonation",
  );
});

Deno.test("US-2351 AC3: an impersonated session cannot spend the user's money on a grade", async () => {
  // "grading spend" is named in AC3 alongside account delete, subscription
  // cancel and marketplace disconnect. It was the one of the four with no guard:
  // a super_admin viewing an account could submit grades that debit the seller's
  // credits or charge their card, and the submission, the ledger row and the
  // Stripe event would all read as the seller's own.
  reset();
  impersonationActive(USER, 10);

  const res = await app(gradeRoutes as unknown as Hono<never>, "/api/grade")
    .request("/api/grade/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
  const body = await res.json();
  assertEquals(res.status, 403);
  assertEquals(body.code, "impersonation_blocked");
});

Deno.test("US-2351 AC3 control: a grade submit is reached without an impersonation", async () => {
  reset();

  const res = await app(gradeRoutes as unknown as Hono<never>, "/api/grade")
    .request("/api/grade/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
  const body = await res.json().catch(() => ({}));
  assert(
    body.code !== "impersonation_blocked",
    "an unimpersonated grade submit was blocked as an impersonation",
  );
});

globalThis.addEventListener("unload", () => {
  globalThis.fetch = realFetch;
});
