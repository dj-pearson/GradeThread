// The SDK's request layer: Idempotency-Key on the two charging endpoints,
// reused on retry, and a retry policy that never re-sends a write that could
// apply twice.
//
// An SDK retry of grades.create without a key charged twice, and every SDK
// create would have failed with 400 IDEMPOTENCY_KEY_REQUIRED the day the
// operator sets API_IDEMPOTENCY_REQUIRED=true
// (services/edge-functions/src/middleware/api-idempotency.ts).

import { describe, expect, it } from "vitest";
import { GradeThread, GradeThreadError } from "../../sdk/gradethread-js/src/index";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function envelope(status: number, data: unknown, error: unknown = null, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ data, error, meta: null }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** A fetch that answers from a queue and records every call. */
function scripted(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body as string | undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error("scripted fetch ran out of responses");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const GARMENT = {
  title: "Denim jacket",
  garment_type: "outerwear",
  garment_category: "jacket",
  images: [{ image_type: "front" as const, url: "https://example.com/f.jpg" }],
};

function client(fetchImpl: typeof fetch, maxRetries = 2) {
  return new GradeThread({ apiKey: "gt_sk_test", baseUrl: "https://api.test/", fetch: fetchImpl, maxRetries, retryDelayMs: 0 });
}

describe("Idempotency-Key", () => {
  it("grades.create sends a generated key and reuses it on the retry", async () => {
    const { calls, fetchImpl } = scripted([
      envelope(503, null, { message: "down" }),
      envelope(202, { id: "sub_1", status: "pending", tier: "standard", payment_method: "credits" }),
    ]);
    const res = await client(fetchImpl).grades.create(GARMENT);
    expect(res.id).toBe("sub_1");
    expect(calls).toHaveLength(2);
    const key = calls[0]!.headers["Idempotency-Key"];
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[1]!.headers["Idempotency-Key"]).toBe(key);
    expect(calls[1]!.body).toBe(calls[0]!.body);
  });

  it("two separate calls get two different keys", async () => {
    const { calls, fetchImpl } = scripted([
      envelope(202, { id: "a" }),
      envelope(202, { id: "b" }),
    ]);
    const gt = client(fetchImpl);
    await gt.grades.create(GARMENT);
    await gt.grades.create(GARMENT);
    expect(calls[0]!.headers["Idempotency-Key"]).not.toBe(calls[1]!.headers["Idempotency-Key"]);
  });

  it("a caller-supplied key is sent verbatim, and grades.batch sends one too", async () => {
    const { calls, fetchImpl } = scripted([
      envelope(202, { id: "sub_1" }),
      envelope(202, { id: "batch_1", status: "running", item_count: 2 }),
    ]);
    const gt = client(fetchImpl);
    await gt.grades.create(GARMENT, { idempotencyKey: "order-42" });
    const batch = await gt.grades.batch([GARMENT, GARMENT]);
    expect(calls[0]!.headers["Idempotency-Key"]).toBe("order-42");
    expect(calls[1]!.url).toBe("https://api.test/api/v1/grades/batch");
    expect(calls[1]!.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ garments: [GARMENT, GARMENT] });
    expect(batch.item_count).toBe(2);
  });

  it("reads do not send a key", async () => {
    const { calls, fetchImpl } = scripted([envelope(200, { id: "g1" })]);
    await client(fetchImpl).grades.get("g1");
    expect(calls[0]!.headers["Idempotency-Key"]).toBeUndefined();
  });
});

describe("retries", () => {
  it("retries a 409 IDEMPOTENCY_IN_PROGRESS on a keyed create", async () => {
    const { calls, fetchImpl } = scripted([
      envelope(409, null, { message: "still processing", code: "IDEMPOTENCY_IN_PROGRESS" }, { "Retry-After": "0" }),
      envelope(202, { id: "sub_1" }),
    ]);
    await client(fetchImpl).grades.create(GARMENT);
    expect(calls).toHaveLength(2);
  });

  it("retries a 429 on any method, honoring Retry-After", async () => {
    const { calls, fetchImpl } = scripted([
      envelope(429, null, { message: "slow down" }, { "Retry-After": "0" }),
      envelope(200, { webhook_url: null, keys_updated: 1, signing_secret: null }),
    ]);
    await client(fetchImpl).webhook.set(null);
    expect(calls.map((c) => c.method)).toEqual(["PATCH", "PATCH"]);
  });

  it("retries a GET after a 5xx and after a network error", async () => {
    const { calls, fetchImpl } = scripted([
      envelope(502, null, { message: "bad gateway" }),
      new TypeError("fetch failed"),
      envelope(200, { quota: null, used: 3, remaining: null, exceeded: false, resets_at: "x" }),
    ]);
    const usage = await client(fetchImpl).usage.get();
    expect(usage.used).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it("does NOT re-send an unkeyed write after a 5xx or a network error", async () => {
    const a = scripted([envelope(500, null, { message: "boom" })]);
    await expect(client(a.fetchImpl).webhook.rotateSecret()).rejects.toMatchObject({ status: 500 });
    expect(a.calls).toHaveLength(1);

    const b = scripted([new TypeError("fetch failed")]);
    await expect(client(b.fetchImpl).sandbox.grades.create()).rejects.toThrow("fetch failed");
    expect(b.calls).toHaveLength(1);
  });

  it("stops after maxRetries and throws the last error with its code", async () => {
    const { calls, fetchImpl } = scripted([
      envelope(503, null, { message: "down", code: "GRADING_UNAVAILABLE" }),
      envelope(503, null, { message: "down", code: "GRADING_UNAVAILABLE" }),
    ]);
    const err = await client(fetchImpl, 1).grades.create(GARMENT).catch((e) => e);
    expect(err).toBeInstanceOf(GradeThreadError);
    expect(err.status).toBe(503);
    expect(err.code).toBe("GRADING_UNAVAILABLE");
    expect(calls).toHaveLength(2);
  });

  it("does not retry a 4xx", async () => {
    const { calls, fetchImpl } = scripted([
      envelope(400, null, { message: "Validation failed", details: [{ index: 0, errors: ["title"] }] }),
    ]);
    const err = await client(fetchImpl).grades.create(GARMENT).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.details).toEqual([{ index: 0, errors: ["title"] }]);
    expect(calls).toHaveLength(1);
  });
});

describe("query strings and unwrapping", () => {
  it("drops unset params and unwraps list envelopes", async () => {
    const { calls, fetchImpl } = scripted([
      new Response(
        JSON.stringify({
          data: { items: [{ id: "i1" }] },
          error: null,
          meta: { total: 1, next_cursor: null, count: 1 },
        }),
        { status: 200 },
      ),
    ]);
    const page = await client(fetchImpl).items.list({ status: "listed", listed: true, brand: undefined });
    expect(calls[0]!.url).toBe("https://api.test/api/v1/items?status=listed&listed=true");
    expect(page.data).toEqual([{ id: "i1" }]);
    expect(page.meta.total).toBe(1);
  });
});
