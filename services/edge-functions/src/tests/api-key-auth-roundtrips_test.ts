import "./_env.ts";
// extensions-api plan, action 6: how many database round trips an API-key
// request costs before the handler runs.
//
// Every /api/v1 and /mcp call goes through resolveApiKeyIdentity. It used to
// send three requests on every call: the key lookup, an UPDATE of
// last_used_at, and a second SELECT on users for the owner's plan. The owner
// now rides in the key lookup as an embed, and last_used_at is only written
// when the stored value is null or a minute old. This file counts what goes
// out on the wire (a stubbed fetch), so a refactor that brings back the
// per-call write or the second lookup fails here rather than in a latency
// graph.
//
// Run alone:
//   deno test --allow-net --allow-env --allow-read src/tests/api-key-auth-roundtrips_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  LAST_USED_WRITE_INTERVAL_MS,
  resolveApiKeyIdentity,
  shouldTouchLastUsed,
} from "../middleware/api-key-auth.ts";

const KEY = "gt_sk_" + "b".repeat(64);
const USER_ID = "11111111-1111-4111-8111-111111111111";
const KEY_ID = "22222222-2222-4222-8222-222222222222";

interface Sent {
  method: string;
  table: string;
  query: URLSearchParams;
}

interface KeyRowOptions {
  lastUsedAt: string | null;
  monthlyQuota?: number | null;
  rateTier?: string | null;
  owner?: Record<string, unknown> | null;
  quotaCount?: number;
}

// The service-role client is built on first query and captures the global fetch
// at that moment, so the stub is installed ONCE, before any query, and each
// test swaps the state it reads instead of swapping fetch.
let current: { opts: KeyRowOptions; sent: Sent[] } = { opts: { lastUsedAt: null }, sent: [] };

/** Point the PostgREST stub at `opts` and start a fresh request log. */
function stubRest(opts: KeyRowOptions): Sent[] {
  current = { opts, sent: [] };
  return current.sent;
}

{
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const { opts, sent } = current;
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const table = url.pathname.replace(/^.*\/rest\/v1\//, "");
    sent.push({ method, table, query: url.searchParams });

    const json = (body: unknown, headers: Record<string, string> = {}) =>
      Promise.resolve(
        new Response(body === null ? null : JSON.stringify(body), {
          status: body === null ? 204 : 200,
          headers: { "Content-Type": "application/json", ...headers },
        }),
      );

    if (table === "api_keys" && method === "GET") {
      const select = url.searchParams.get("select") ?? "";
      const row: Record<string, unknown> = {
        id: KEY_ID,
        user_id: USER_ID,
        expires_at: null,
        last_used_at: opts.lastUsedAt,
        scopes: ["grades:read"],
        monthly_quota: opts.monthlyQuota ?? null,
        rate_tier: opts.rateTier ?? null,
      };
      if (select.includes("owner:users(")) row.owner = opts.owner ?? null;
      return json(row);
    }
    if (table === "users" && method === "GET") return json(opts.owner ?? null);
    if (table === "api_keys" && method === "PATCH") return json(null);
    if (table === "api_usage_events") {
      return json(null, { "Content-Range": `*/${opts.quotaCount ?? 0}` });
    }
    return json(null);
  }) as typeof fetch;
}

/** Let the fire-and-forget last_used_at write reach the stub. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

const PRO_OWNER = {
  role: "user",
  flipdesk_plan: "pro",
  subscription_status: "active",
  trial_ends_at: null,
  past_due_since: null,
};

Deno.test("a key used in the last minute costs ONE request: no write, no second lookup", async () => {
  const sent = stubRest({
    lastUsedAt: new Date(Date.now() - 5_000).toISOString(),
    owner: PRO_OWNER,
  });
  const res = await resolveApiKeyIdentity(KEY);
  await settle();
  assert(res.ok, "a valid key must resolve");
  assertEquals(res.identity.userId, USER_ID);
  assertEquals(res.identity.apiKeyId, KEY_ID);
  assertEquals(res.identity.apiKeyPlan, "pro", "the owner's plan must come through the embed");
  assertEquals(
    sent.map((s) => `${s.method} ${s.table}`),
    ["GET api_keys"],
    "before this change a request cost GET api_keys + PATCH api_keys + GET users",
  );
});

Deno.test("a stale last_used_at is written once, guarded by the same staleness filter", async () => {
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  const sent = stubRest({ lastUsedAt: stale, owner: PRO_OWNER });
  const res = await resolveApiKeyIdentity(KEY);
  await settle();
  assert(res.ok);
  assertEquals(sent.map((s) => `${s.method} ${s.table}`), ["GET api_keys", "PATCH api_keys"]);
  const patch = sent[1].query;
  assertEquals(patch.get("id"), `eq.${KEY_ID}`, "the write must be keyed on the resolved key id");
  assert(
    patch.get("last_used_at")?.startsWith("lt."),
    `expected an lt. guard, got ${patch.get("last_used_at")}`,
  );
  assertEquals(patch.get("or"), null, "no .or() on an UPDATE (US-1552)");
});

Deno.test("a never-used key writes last_used_at with an is.null guard", async () => {
  const sent = stubRest({ lastUsedAt: null, owner: PRO_OWNER });
  const res = await resolveApiKeyIdentity(KEY);
  await settle();
  assert(res.ok);
  assertEquals(sent.map((s) => `${s.method} ${s.table}`), ["GET api_keys", "PATCH api_keys"]);
  assertEquals(sent[1].query.get("last_used_at"), "is.null");
});

Deno.test("plan tiering is unchanged: super_admin, per-key rate_tier, and a missing owner", async () => {
  const fresh = new Date().toISOString();

  stubRest({ lastUsedAt: fresh, owner: { ...PRO_OWNER, role: "super_admin" } });
  let res = await resolveApiKeyIdentity(KEY);
  assert(res.ok);
  assertEquals(res.identity.apiKeyPlan, "super_admin");

  stubRest({ lastUsedAt: fresh, owner: PRO_OWNER, rateTier: "enterprise" });
  res = await resolveApiKeyIdentity(KEY);
  assert(res.ok);
  assertEquals(res.identity.apiKeyPlan, "enterprise", "rate_tier still overrides the plan");

  stubRest({ lastUsedAt: fresh, owner: null });
  res = await resolveApiKeyIdentity(KEY);
  assert(res.ok);
  assertEquals(res.identity.apiKeyPlan, "free", "no owner row falls back to the tightest tier");
});

Deno.test("a quota key adds exactly the usage COUNT, scoped to the key", async () => {
  const sent = stubRest({
    lastUsedAt: new Date().toISOString(),
    owner: PRO_OWNER,
    monthlyQuota: 1000,
    quotaCount: 3,
  });
  const res = await resolveApiKeyIdentity(KEY);
  await settle();
  assert(res.ok);
  assertEquals(sent.map((s) => `${s.method} ${s.table}`), ["GET api_keys", "HEAD api_usage_events"]);
  assertEquals(sent[1].query.get("api_key_id"), `eq.${KEY_ID}`);
});

Deno.test("shouldTouchLastUsed: null, unparseable and stale write; fresh does not", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  assertEquals(shouldTouchLastUsed(null, now), true);
  assertEquals(shouldTouchLastUsed("not a date", now), true);
  assertEquals(
    shouldTouchLastUsed(new Date(now.getTime() - LAST_USED_WRITE_INTERVAL_MS).toISOString(), now),
    true,
  );
  assertEquals(
    shouldTouchLastUsed(new Date(now.getTime() - LAST_USED_WRITE_INTERVAL_MS + 1000).toISOString(), now),
    false,
  );
});
