// lib/account-webhook.ts: the account webhook's reads and writes, now shared by
// /api/v1/webhook (API key) and /api/keys/webhook (dashboard session).
//
// Two things are pinned here. (1) TENANCY: every query the module makes is
// filtered on user_id = the owner it was handed, checked query by query
// against a recording fake, because the service-role client bypasses RLS and
// nothing else stands between one account's endpoint and another's. (2) THE
// TEST SEND: a dashboard "send test event" is one real, signed delivery with a
// single attempt, so a dead endpoint answers the button and is then left alone
// rather than retried by the cron for hours.
//
// Pure: no network, no DB.

import "./_env.ts";
import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  deliveryLimit,
  getWebhookConfig,
  listWebhookDeliveries,
  rotateWebhookSecret,
  sendTestWebhook,
  setWebhookUrl,
  TEST_EVENT,
} from "../lib/account-webhook.ts";
import type {
  AttemptLog,
  DeliveryRow,
  EndpointRow,
  SendResult,
  SignedRequest,
  WebhookDeps,
  WebhookStore,
} from "../lib/webhook-delivery.ts";

// crypto-aes needs a key to encrypt the new secret.
if (!Deno.env.get("EDGE_ENCRYPTION_KEY")) {
  Deno.env.set("EDGE_ENCRYPTION_KEY", btoa("0123456789abcdef0123456789abcdef"));
}

const OWNER = "11111111-1111-1111-1111-111111111111";

interface Op {
  table: string;
  op: string;
  values?: unknown;
  options?: unknown;
  filters: Array<[string, unknown]>;
}

/** Records every query; answers from `rows` per table. */
function recordingDb(rows: Record<string, unknown[]> = {}) {
  const ops: Op[] = [];
  const db = {
    from(table: string) {
      const op: Op = { table, op: "select", filters: [] };
      ops.push(op);
      // An upsert answers with the row it wrote, unless the fixture says the
      // conflict already existed (`upsert:<table>` = [] models ignoreDuplicates
      // skipping the row).
      const result = () =>
        op.op === "upsert"
          ? { data: rows[`upsert:${table}`] ?? [op.values], error: null }
          : { data: rows[table] ?? [], error: null };
      // deno-lint-ignore no-explicit-any
      const b: any = {
        select: () => b,
        insert: (v: unknown) => ((op.op = "insert"), (op.values = v), b),
        upsert: (v: unknown, o?: unknown) => ((op.op = "upsert"), (op.values = v), (op.options = o), b),
        update: (v: unknown) => ((op.op = "update"), (op.values = v), b),
        delete: () => ((op.op = "delete"), b),
        eq: (col: string, val: unknown) => (op.filters.push([col, val]), b),
        order: () => b,
        limit: () => b,
        maybeSingle: () => Promise.resolve({ data: (rows[table] ?? [])[0] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
          Promise.resolve(result()).then(ok, bad),
      };
      return b;
    },
  };
  return { db, ops };
}

function assertAllScoped(ops: Op[]) {
  assert(ops.length > 0, "no queries recorded");
  for (const op of ops) {
    if (op.op === "insert" || op.op === "upsert") {
      assertEquals((op.values as { user_id?: string }).user_id, OWNER, `${op.table} insert not owned`);
      continue;
    }
    assert(
      op.filters.some(([col, val]) => col === "user_id" && val === OWNER),
      `${op.op} on ${op.table} is not scoped to the owner: ${JSON.stringify(op.filters)}`,
    );
  }
}

Deno.test("every read and write is scoped to the owner it was given", async () => {
  const empty = recordingDb();
  await getWebhookConfig(OWNER, empty.db);
  await listWebhookDeliveries(OWNER, 20, empty.db);
  await rotateWebhookSecret(OWNER, empty.db);
  await setWebhookUrl(OWNER, "https://hooks.example.com/a", empty.db); // create
  await setWebhookUrl(OWNER, null, empty.db); // clear
  assertAllScoped(empty.ops);

  const existing = recordingDb({ api_webhook_endpoints: [{ user_id: OWNER }] });
  await setWebhookUrl(OWNER, "https://hooks.example.com/b", existing.db); // update
  assertAllScoped(existing.ops);
});

Deno.test("creating the endpoint returns a whsec_ secret once; changing the URL does not", async () => {
  const created = recordingDb();
  const first = await setWebhookUrl(OWNER, "https://hooks.example.com/a", created.db);
  assertMatch(first.signing_secret ?? "", /^whsec_/);
  const insert = created.ops.find((o) => o.op === "upsert")!;
  assertEquals(insert.options, { onConflict: "user_id", ignoreDuplicates: true });
  const stored = (insert.values as { secret_ciphertext: string }).secret_ciphertext;
  assert(!stored.includes(first.signing_secret!.slice(6)), "the secret was stored in plain text");

  const existing = recordingDb({ api_webhook_endpoints: [{ user_id: OWNER }] });
  const again = await setWebhookUrl(OWNER, "https://hooks.example.com/b", existing.db);
  assertEquals(again.signing_secret, null);
  const update = existing.ops.find((o) => o.table === "api_webhook_endpoints" && o.op === "update")!;
  assertEquals(update.values, { url: "https://hooks.example.com/b" });
});

Deno.test("rotating with no endpoint returns null (the route answers 404)", async () => {
  assertEquals(await rotateWebhookSecret(OWNER, recordingDb().db), null);
  const rotated = await rotateWebhookSecret(OWNER, recordingDb({ api_webhook_endpoints: [{ user_id: OWNER }] }).db);
  assertMatch(rotated?.signing_secret ?? "", /^whsec_/);
});

Deno.test("rotating with no endpoint is null even with no encryption key set", async () => {
  // The tenant-isolation suite runs with no EDGE_ENCRYPTION_KEY. Encrypting
  // before the existence check turned B's "no webhook" into a 500 there.
  const saved = Deno.env.get("EDGE_ENCRYPTION_KEY");
  Deno.env.delete("EDGE_ENCRYPTION_KEY");
  try {
    const empty = recordingDb();
    assertEquals(await rotateWebhookSecret(OWNER, empty.db), null);
    assertEquals(empty.ops.filter((o) => o.op === "update").length, 0);
  } finally {
    if (saved !== undefined) Deno.env.set("EDGE_ENCRYPTION_KEY", saved);
  }
});

Deno.test("delivery list limit is clamped to 1..100, default 20", () => {
  assertEquals(deliveryLimit(undefined), 20);
  assertEquals(deliveryLimit("0"), 1);
  assertEquals(deliveryLimit("500"), 100);
  assertEquals(deliveryLimit("abc"), 20);
});

// ── Test send ────────────────────────────────────────────────────────

function sendHarness(status: number, endpoint: EndpointRow | null) {
  const rows: DeliveryRow[] = [];
  const sent: SignedRequest[] = [];
  const store: WebhookStore = {
    insertDelivery: (row) => {
      const r: DeliveryRow = {
        id: crypto.randomUUID(),
        ...row,
        status: "pending",
        attempts: 0,
        max_attempts: row.max_attempts ?? 6,
        next_attempt_at: new Date().toISOString(),
      };
      rows.push(r);
      return Promise.resolve({ ...r });
    },
    loadEndpoint: (userId) => Promise.resolve(userId === OWNER ? endpoint : null),
    claim: (row) => {
      const r = rows.find((x) => x.id === row.id && x.status === "pending" && x.attempts === row.attempts);
      if (!r) return Promise.resolve(null);
      r.status = "running";
      r.attempts += 1;
      return Promise.resolve({ ...r });
    },
    closeExhausted: () => Promise.resolve(false),
    legacyKeyHash: () => Promise.resolve(null),
    recordAttempt: (_log: AttemptLog) => Promise.resolve(),
    finish: (row, values) => {
      Object.assign(rows.find((x) => x.id === row.id)!, values);
      return Promise.resolve();
    },
    listDue: () => Promise.resolve(rows.filter((r) => r.status === "pending")),
    reclaimStale: () => Promise.resolve(0),
  };
  const deps: WebhookDeps = {
    store,
    send: (_url, req): Promise<SendResult> => {
      sent.push(req);
      return Promise.resolve({ success: status < 300, statusCode: status, responseBody: "" });
    },
    decryptSecret: (c) => Promise.resolve(c),
    now: () => new Date(),
  };
  return { rows, sent, deps };
}

const SECRET = "whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

Deno.test("a test send is one signed webhook.test delivery, logged as a row", async () => {
  const h = sendHarness(200, { url: "https://hooks.example.com/gt", secret_ciphertext: SECRET });
  const result = await sendTestWebhook(OWNER, h.deps);
  assertEquals(result?.outcome, "delivered");
  assertEquals(h.sent.length, 1);
  assertEquals(h.rows[0]!.event_type, TEST_EVENT);
  assertEquals(h.rows[0]!.event_id, result!.event_id);
  assert(h.sent[0]!.headers["webhook-signature"]?.startsWith("v1,"), "the test event was not signed");
  assertEquals(JSON.parse(h.sent[0]!.body).event, TEST_EVENT);
});

Deno.test("a failed test send is final: one attempt, never picked up by the retry sweep", async () => {
  const h = sendHarness(500, { url: "https://hooks.example.com/gt", secret_ciphertext: SECRET });
  const result = await sendTestWebhook(OWNER, h.deps);
  assertEquals(result?.outcome, "failed");
  assertEquals(h.rows[0]!.max_attempts, 1);
  assertEquals(h.rows[0]!.status, "failed");
  assertEquals((await h.deps.store.listDue(new Date(Date.now() + 86_400_000).toISOString(), 50)).length, 0);
});

Deno.test("two test sends are two events, not deduped into one", async () => {
  const h = sendHarness(200, { url: "https://hooks.example.com/gt", secret_ciphertext: SECRET });
  await sendTestWebhook(OWNER, h.deps);
  await sendTestWebhook(OWNER, h.deps);
  assertEquals(h.sent.length, 2);
});

// ── Dashboard routes: role gate ──────────────────────────────────────

Deno.test("dashboard webhook routes refuse a workspace member before touching anything", async () => {
  const { Hono } = await import("hono");
  const { apiKeyRoutes } = await import("../routes/api-keys.ts");
  // deno-lint-ignore no-explicit-any
  const app = new Hono<any>();
  app.use("*", async (c, next) => {
    c.set("userId", "22222222-2222-2222-2222-222222222222");
    c.set("workspaceOwnerId", OWNER);
    c.set("workspaceRole", "member");
    await next();
  });
  app.route("/api/keys", apiKeyRoutes);
  const cases: Array<[string, string]> = [
    ["GET", "/api/keys/webhook"],
    ["PUT", "/api/keys/webhook"],
    ["POST", "/api/keys/webhook/secret/rotate"],
    ["POST", "/api/keys/webhook/test"],
    ["GET", "/api/keys/webhook/deliveries"],
  ];
  for (const [method, path] of cases) {
    const res = await app.request(path, { method, body: method === "PUT" ? "{}" : undefined });
    await res.body?.cancel();
    assertEquals(res.status, 403, `${method} ${path} as a member`);
  }
});

Deno.test("no endpoint: nothing is recorded or sent", async () => {
  const h = sendHarness(200, null);
  assertEquals(await sendTestWebhook(OWNER, h.deps), null);
  assertEquals(h.rows.length, 0);
  assertEquals(h.sent.length, 0);
});

// DEV-11: two first-time saves race past the existence read. The one whose
// upsert wrote the row returns the secret; the one whose upsert was ignored
// on the user_id conflict falls through to a URL update, with no error and
// no secret it did not store.
Deno.test("concurrent first saves: the loser gets no secret and no error", async () => {
  const winner = recordingDb();
  const loser = recordingDb({ "upsert:api_webhook_endpoints": [] });
  const [a, b] = await Promise.all([
    setWebhookUrl(OWNER, "https://hooks.example.com/a", winner.db),
    setWebhookUrl(OWNER, "https://hooks.example.com/b", loser.db),
  ]);
  assertMatch(a.signing_secret ?? "", /^whsec_/);
  assert(a.secret_created_at);
  assertEquals(b.signing_secret, null);
  assertEquals(b.secret_created_at, null);
  const update = loser.ops.find((o) => o.table === "api_webhook_endpoints" && o.op === "update")!;
  assertEquals(update.values, { url: "https://hooks.example.com/b" });
  assertAllScoped(loser.ops);
});
