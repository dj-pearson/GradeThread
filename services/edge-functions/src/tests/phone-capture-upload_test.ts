// US-3161: the public phone-capture upload, driven through the real route.
//
// The phone is not signed in, so the caps and the answer it gets back are the
// server's or they do not exist. These cases run POST /s/:token/photos against
// a fake PostgREST and Storage behind `fetch`, because the two defects they
// hold shut were both in how the route used the database, not in a pure rule:
//
//   - any insert error was answered ok:true as a "duplicate", so a photo that
//     never saved showed as saved on the phone and never reached the desktop;
//   - the counters were written back from a value read at the top of the
//     request, so two uploads in flight both took the last slot.
//
// Run alone: deno test --allow-env --allow-net --allow-read src/tests/phone-capture-upload_test.ts

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { flipdeskPhoneCaptureRoutes } from "../routes/flipdesk-phone-capture.ts";
import { resetSupabaseAdminForTests } from "../lib/supabase.ts";
import {
  CAPTURE_MAX_PHOTOS,
  hashCaptureToken,
  isDuplicateCaptureInsert,
  newCaptureToken,
} from "../lib/phone-capture.ts";

// A 2x2 PNG: small, real enough for the US-276 sniff and strip.
function tinyPng(): Uint8Array<ArrayBuffer> {
  const chunk = (type: string, data: number[]): number[] => {
    const len = data.length;
    return [
      (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff,
      ...[...type].map((c) => c.charCodeAt(0)),
      ...data,
      0, 0, 0, 0,
    ];
  };
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", [0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0]),
    ...chunk("IDAT", [1, 2, 3]),
    ...chunk("IEND", []),
  ]);
}

interface FakeSession {
  id: string;
  owner_user_id: string;
  started_by_user_id: string;
  target_kind: string;
  target_id: string;
  expires_at: string;
  ended_at: string | null;
  photo_count: number;
  bytes_total: number;
  group_index: number;
  token_hash: string;
}

interface Backend {
  session: FakeSession;
  photos: Record<string, unknown>[];
  uploaded: string[];
  removed: string[];
  restore: () => void;
}

/**
 * A fake PostgREST + Storage with one session row.
 *
 * The session PATCH honours its eq/is/gt filters and applies in one step, the
 * way a single UPDATE does in Postgres, so a compare-and-swap either matches
 * the row or does not. `insertError` makes every photo insert fail with that
 * PostgREST error. `holdSessionReads` makes the first N token lookups wait for
 * each other, so concurrent uploads provably read the same starting row.
 */
function fakeBackend(opts: {
  tokenHash: string;
  photoCount?: number;
  insertError?: { status: number; code: string; message: string };
  holdSessionReads?: number;
}): Backend {
  const session: FakeSession = {
    id: "11111111-1111-4111-8111-111111111111",
    owner_user_id: "22222222-2222-4222-8222-222222222222",
    started_by_user_id: "22222222-2222-4222-8222-222222222222",
    target_kind: "item",
    target_id: "33333333-3333-4333-8333-333333333333",
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    ended_at: null,
    photo_count: opts.photoCount ?? 0,
    bytes_total: 0,
    group_index: 0,
    token_hash: opts.tokenHash,
  };
  const photos: Record<string, unknown>[] = [];
  const uploaded: string[] = [];
  const removed: string[] = [];

  let held = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const matches = (row: Record<string, unknown>, params: URLSearchParams): boolean => {
    for (const [key, raw] of params) {
      if (key === "select" || key === "columns") continue;
      const dot = raw.indexOf(".");
      const op = raw.slice(0, dot);
      const val = raw.slice(dot + 1);
      const have = row[key];
      if (op === "eq" && String(have) !== val) return false;
      if (op === "is" && val === "null" && have !== null) return false;
      if (op === "gt" && !(String(have) > val)) return false;
    }
    return true;
  };

  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const wantsObject = (req.headers.get("accept") ?? "").includes("vnd.pgrst.object");

    if (url.pathname.startsWith("/storage/v1/object/item-photos") && method === "DELETE") {
      const body = await req.json() as { prefixes: string[] };
      removed.push(...body.prefixes);
      return json([]);
    }
    if (url.pathname.startsWith("/storage/v1/object/item-photos/") && method === "POST") {
      const path = decodeURIComponent(url.pathname.slice("/storage/v1/object/item-photos/".length));
      uploaded.push(path);
      return json({ Key: `item-photos/${path}` });
    }

    if (url.pathname === "/rest/v1/phone_capture_sessions") {
      if (method === "GET") {
        if (opts.holdSessionReads && url.searchParams.has("token_hash") && held < opts.holdSessionReads) {
          held++;
          if (held === opts.holdSessionReads) release();
          await gate;
        }
        const rows = matches(session as unknown as Record<string, unknown>, url.searchParams)
          ? [{ ...session }]
          : [];
        return json(wantsObject ? rows[0] ?? null : rows);
      }
      if (method === "PATCH") {
        const patch = await req.json() as Partial<FakeSession>;
        if (!matches(session as unknown as Record<string, unknown>, url.searchParams)) return json([]);
        Object.assign(session, patch);
        return json([{ id: session.id }]);
      }
    }

    if (url.pathname === "/rest/v1/phone_capture_photos") {
      if (method === "POST") {
        if (opts.insertError) {
          const { status, code, message } = opts.insertError;
          return json({ code, message, details: null, hint: null }, status);
        }
        const row = { id: crypto.randomUUID(), ...(await req.json() as Record<string, unknown>) };
        photos.push(row);
        return json(wantsObject ? { id: row.id } : [{ id: row.id }], 201);
      }
      if (method === "GET") return json(wantsObject ? null : []);
    }

    if (url.pathname === "/rest/v1/item_photos" && method === "GET") return json([]);

    return json({ message: `unexpected ${method} ${url.pathname}` }, 500);
  }) as typeof fetch;

  // supabase-js keeps the fetch it was built with, so the memoised client is
  // dropped on both sides: this backend's client, then a clean one after.
  resetSupabaseAdminForTests();
  const restore = () => {
    globalThis.fetch = real;
    resetSupabaseAdminForTests();
  };
  return { session, photos, uploaded, removed, restore };
}

function upload(token: string, clientKey?: string): Promise<Response> {
  const form = new FormData();
  form.append("photo", new File([tinyPng()], "shot.png", { type: "image/png" }));
  if (clientKey) form.append("clientKey", clientKey);
  return Promise.resolve(
    flipdeskPhoneCaptureRoutes.request(`/s/${token}/photos`, { method: "POST", body: form }),
  );
}

Deno.test("only a unique-key clash reads as a duplicate insert", () => {
  assert(isDuplicateCaptureInsert({ code: "23505" }));
  assert(!isDuplicateCaptureInsert({ code: "23514" }));
  assert(!isDuplicateCaptureInsert({ code: "" }));
  assert(!isDuplicateCaptureInsert(null));
  assert(!isDuplicateCaptureInsert(undefined));
});

Deno.test("an upload that saves is counted once and answers ok", async () => {
  const token = newCaptureToken();
  const be = fakeBackend({ tokenHash: await hashCaptureToken(token) });
  try {
    const res = await upload(token);
    const body = await res.json();
    assertEquals(res.status, 200, JSON.stringify(body));
    assertEquals(body.ok, true);
    assertEquals(body.photosTaken, 1);
    assertEquals(be.photos.length, 1);
    assertEquals(be.session.photo_count, 1);
    assert(be.session.bytes_total > 0);
    assertEquals(be.removed, []);
  } finally {
    be.restore();
  }
});

Deno.test("a failed insert that is not a duplicate is a failure, not a saved photo", async () => {
  const token = newCaptureToken();
  const be = fakeBackend({
    tokenHash: await hashCaptureToken(token),
    photoCount: 3,
    insertError: { status: 400, code: "23514", message: "violates check constraint" },
  });
  try {
    const res = await upload(token, "shot-1");
    const body = await res.json();
    assertEquals(res.status, 502, JSON.stringify(body));
    assert(body.ok !== true, "the phone was told a photo saved that has no row");
    // The object uploaded for it is removed, and the slot it claimed goes back.
    assertEquals(be.uploaded.length, 1);
    assertEquals(be.removed, be.uploaded);
    assertEquals(be.session.photo_count, 3);
    assertEquals(be.session.bytes_total, 0);
  } finally {
    be.restore();
  }
});

Deno.test("a racing retry of the same shot is still a duplicate, and does not count twice", async () => {
  const token = newCaptureToken();
  const be = fakeBackend({
    tokenHash: await hashCaptureToken(token),
    photoCount: 5,
    insertError: { status: 409, code: "23505", message: "duplicate key value" },
  });
  try {
    const res = await upload(token, "shot-1");
    const body = await res.json();
    assertEquals(res.status, 200, JSON.stringify(body));
    assertEquals(body.ok, true);
    assertEquals(body.duplicate, true);
    assertEquals(be.session.photo_count, 5);
    assertEquals(be.removed, be.uploaded);
  } finally {
    be.restore();
  }
});

Deno.test("two uploads racing for the last slot: one lands, one is refused", async () => {
  const token = newCaptureToken();
  const be = fakeBackend({
    tokenHash: await hashCaptureToken(token),
    photoCount: CAPTURE_MAX_PHOTOS - 1,
    holdSessionReads: 2,
  });
  try {
    const [a, b] = await Promise.all([upload(token, "a"), upload(token, "b")]);
    const statuses = [a.status, b.status].sort();
    assertEquals(statuses, [200, 429], `got ${a.status} and ${b.status}`);
    assertEquals(be.photos.length, 1, "the cap let two photos through");
    assertEquals(be.session.photo_count, CAPTURE_MAX_PHOTOS);
  } finally {
    be.restore();
  }
});

Deno.test("two uploads racing below the cap are both counted", async () => {
  const token = newCaptureToken();
  const be = fakeBackend({ tokenHash: await hashCaptureToken(token), photoCount: 10, holdSessionReads: 2 });
  try {
    const [a, b] = await Promise.all([upload(token, "a"), upload(token, "b")]);
    assertEquals([a.status, b.status], [200, 200]);
    assertEquals(be.photos.length, 2);
    assertEquals(be.session.photo_count, 12, "an increment was lost");
  } finally {
    be.restore();
  }
});

Deno.test("the public capture upload has its own POST rate limit, mounted before the route", async () => {
  const main = await Deno.readTextFile(new URL("../main.ts", import.meta.url));
  const limiter = main.search(
    /app\.use\(\s*"\/api\/flipdesk\/capture\/s\/\*",\s*rateLimiter\(\s*\d+,\s*60_000,\s*"flipdesk-capture-public"/,
  );
  assert(limiter >= 0, "no rateLimiter on /api/flipdesk/capture/s/*");
  const block = main.slice(limiter, main.indexOf(");", limiter));
  assert(/methods:\s*\["POST"\]/.test(block), "the capture limiter should govern POST");
  assert(/failClosed:\s*true/.test(block), "a public write should fail closed");
  const mount = main.indexOf('app.route("/api/flipdesk/capture", flipdeskPhoneCaptureRoutes)');
  assert(mount > limiter, "the limiter must be mounted before the route");
});
