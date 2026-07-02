// US-1507: acting on a listing owned by a NON-PRIMARY eBay connection must use
// THAT connection's token, not the current primary's. These tests drive the real
// resolution seam — getOffer(userId, offerId, connectionId) → fetchAuthed →
// getConnectionAccessToken — against a stubbed fetch that emulates PostgREST
// (marketplace_connections lookups) and the eBay Sell API, asserting:
//
//   1. connectionId set   → the connections query is per-id + tenant-scoped
//                           (id=eq + user_id=eq + is_active=eq.true) and the eBay
//                           call carries the NON-PRIMARY account's bearer token.
//   2. connectionId unset → the legacy primary resolution (is_primary ordering)
//                           and the PRIMARY account's bearer token (legacy rows
//                           with a null listings.marketplace_connection_id).
//   3. connection gone/inactive → throws the SAME "No active eBay connection"
//                           message getUserAccessToken uses, so the routes'
//                           isNoEbayConnectionError branch turns it into the
//                           friendly "reconnect this account" 409, never a 500.
//
// ebay-client.ts creates the service-role supabase client at module load, and
// supabase-js binds its fetch reference at creation — so BOTH the env and the
// fetch dispatcher must be installed BEFORE the dynamic import.
//
//   deno test --allow-env src/tests/us1507-connection-threading_test.ts

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const SUPABASE_URL = "http://supabase.test";
Deno.env.set("SUPABASE_URL", SUPABASE_URL);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
Deno.env.set("EBAY_APP_ID", "test-app-id");
Deno.env.set("EBAY_CERT_ID", "test-cert-id");
// base64 of 32 bytes — the test-only AES-GCM key encryptToken/decryptToken use.
Deno.env.set("EDGE_ENCRYPTION_KEY", btoa("0123456789abcdef0123456789abcdef"));

interface SeenRequest {
  url: string;
  authorization: string | null;
}

// Mutable per-test state the dispatcher below consults at CALL time. The
// dispatcher itself must be installed before ebay-client is imported because
// supabase-js closes over the fetch reference when the client is created.
let connectionRows: Array<Record<string, unknown>> = [];
let connectionQueries: SeenRequest[] = [];
let ebayCalls: SeenRequest[] = [];

function resetStub(rows: Array<Record<string, unknown>>) {
  connectionRows = rows;
  connectionQueries = [];
  ebayCalls = [];
}

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
    ? input.toString()
    : input.url;
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const seen: SeenRequest = { url, authorization: headers.get("Authorization") };

  if (url.startsWith(`${SUPABASE_URL}/rest/v1/marketplace_connections`)) {
    connectionQueries.push(seen);
    const wantsObject = (headers.get("Accept") ?? "").includes("pgrst.object");
    if (wantsObject) {
      if (connectionRows.length === 0) {
        // PostgREST zero-rows-for-object response; supabase-js maybeSingle maps
        // PGRST116 to { data: null, error: null }.
        return Promise.resolve(
          new Response(
            JSON.stringify({ code: "PGRST116", message: "0 rows", details: null, hint: null }),
            { status: 406, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(connectionRows[0]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(connectionRows), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  // Everything else = the eBay Sell API (getOffer GET).
  ebayCalls.push(seen);
  return Promise.resolve(
    new Response(JSON.stringify({ offerId: "offer-1", sku: "SKU-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}) as typeof fetch;

const { getOffer, getConnectionAccessToken, isNoEbayConnectionError } =
  await import("../lib/ebay-client.ts");
const { encryptToken } = await import("../lib/crypto-aes.ts");

const USER_ID = "user-1";
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

// A connection row as PostgREST would serve it to getUserAccessToken /
// getConnectionAccessToken (select id, access_token_encrypted, …).
async function connectionRow(id: string, plaintextToken: string) {
  return {
    id,
    access_token_encrypted: await encryptToken(plaintextToken, { aad: USER_ID }),
    refresh_token_encrypted: await encryptToken(`refresh-${id}`, { aad: USER_ID }),
    token_expires_at: FUTURE, // unexpired → no refresh round-trip in the test
    account_handle: `handle-${id}`,
    external_account_id: `ext-${id}`,
  };
}

Deno.test("getOffer with connectionId uses THAT connection's token (per-id + tenant-scoped query)", async () => {
  // The listing belongs to conn-b; conn-a is the current primary. The stub
  // serves conn-b for the per-id lookup — the bearer must be token-B.
  resetStub([await connectionRow("conn-b", "token-B")]);

  const offer = await getOffer(USER_ID, "offer-1", "conn-b");
  assertEquals(offer.offerId, "offer-1");

  assertEquals(connectionQueries.length, 1);
  const q = connectionQueries[0]!.url;
  // Per-connection resolution, scoped to the caller (US-268) + active-only.
  assertStringIncludes(q, "id=eq.conn-b");
  assertStringIncludes(q, `user_id=eq.${USER_ID}`);
  assertStringIncludes(q, "is_active=eq.true");
  // NOT the primary resolver — no is_primary ordering.
  assert(!q.includes("is_primary"), `per-id lookup must not order by is_primary: ${q}`);

  assertEquals(ebayCalls.length, 1);
  assertEquals(ebayCalls[0]!.authorization, "Bearer token-B");
});

Deno.test("getOffer without connectionId falls back to the PRIMARY connection (legacy null rows)", async () => {
  resetStub([await connectionRow("conn-a", "token-A")]);

  await getOffer(USER_ID, "offer-1");

  assertEquals(connectionQueries.length, 1);
  const q = connectionQueries[0]!.url;
  assertStringIncludes(q, `user_id=eq.${USER_ID}`);
  assertStringIncludes(q, "is_primary");
  // No bare id filter (`user_id=eq.` contains "id=eq.", so anchor on the
  // query-param boundary).
  assert(
    !/[?&]id=eq\./.test(q),
    `primary lookup must not filter on a connection id: ${q}`,
  );

  assertEquals(ebayCalls.length, 1);
  assertEquals(ebayCalls[0]!.authorization, "Bearer token-A");
});

Deno.test("a gone/inactive listing connection throws the friendly no-connection error (never a raw 500)", async () => {
  // The listing's connection was disconnected (is_active=false) or deleted →
  // the per-id + is_active=eq.true lookup finds nothing.
  resetStub([]);

  let thrown: unknown = null;
  try {
    await getConnectionAccessToken("conn-gone", USER_ID);
  } catch (err) {
    thrown = err;
  }
  assert(thrown instanceof Error, "expected getConnectionAccessToken to throw");
  // Same message as getUserAccessToken → the routes' isNoEbayConnectionError
  // branch maps it to the "reconnect this account" 409.
  assert(
    isNoEbayConnectionError(thrown),
    `error must match isNoEbayConnectionError: ${(thrown as Error).message}`,
  );
  assertEquals(ebayCalls.length, 0, "no eBay call without a token");
});
