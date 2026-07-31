// Google Photos Picker import: the OAuth consent URL must request the Photos
// Picker scope with OFFLINE access (so Google returns a refresh token we store
// and reuse to skip consent on later imports), and config gating must reflect
// the env. flipdesk-google-photos.ts imports the service-role supabase client
// at load, so set dummy env BEFORE the dynamic import.
//   deno test --allow-env src/tests/google-photos_test.ts
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { buildGoogleConsentUrl, isGooglePhotosConfigured, planImportChunk } =
  await import("../routes/flipdesk-google-photos.ts");

Deno.test("consent URL targets Google with the Picker scope + offline access", () => {
  const url = new URL(buildGoogleConsentUrl("state8", "cid123", "https://edge/cb"));
  assertEquals(
    url.origin + url.pathname,
    "https://accounts.google.com/o/oauth2/v2/auth",
  );
  const p = url.searchParams;
  assertEquals(p.get("client_id"), "cid123");
  assertEquals(p.get("redirect_uri"), "https://edge/cb");
  assertEquals(p.get("state"), "state8");
  assertEquals(p.get("response_type"), "code");
  // Offline + prompt=consent so Google returns a refresh token we can store and
  // reuse — that's what lets later imports skip this consent screen.
  assertEquals(p.get("access_type"), "offline");
  assertEquals(p.get("prompt"), "consent");
  assert(
    p.get("scope")!.includes("photospicker.mediaitems.readonly"),
    "scope must be the Photos Picker readonly scope",
  );
});

// A 200-photo import is pulled in chunks — one bounded slice per request — so
// it can't outlive the proxy's idle timeout. The cursor has to walk cleanly to
// the end and then stop; a cursor that never reports `done` spins the client
// forever, and one that reports `done` early silently drops photos.
Deno.test("planImportChunk walks a 200-photo pick to the end exactly once", () => {
  const seen: number[] = [];
  let offset = 0;
  let guard = 0;
  for (;;) {
    if (++guard > 50) throw new Error("cursor never reported done");
    const p = planImportChunk(200, offset, undefined);
    for (let i = p.offset; i < p.end; i++) seen.push(i);
    if (p.done) break;
    offset = p.nextOffset;
  }
  // Every photo exactly once, in order, and the walk terminated.
  assertEquals(seen.length, 200);
  assertEquals(seen[0], 0);
  assertEquals(seen[199], 199);
  assertEquals(new Set(seen).size, 200);
});

Deno.test("planImportChunk bounds the slice and the cursor", () => {
  // A client asking for the whole thing in one request is clamped to MAX_CHUNK,
  // which is the entire point of chunking.
  const greedy = planImportChunk(200, 0, 500);
  assert(greedy.end - greedy.offset <= 40, "chunk must be clamped");
  assertEquals(greedy.done, false);

  // Past the end, and garbage input, both terminate instead of looping.
  assertEquals(planImportChunk(10, 10, 25).done, true);
  assertEquals(planImportChunk(10, 999, 25).done, true);
  assertEquals(planImportChunk(0, 0, 25).done, true);
  const junk = planImportChunk(10, "abc", "-5");
  assertEquals(junk.offset, 0);
  assertEquals(junk.done, true);

  // The last partial chunk reports done without dropping its tail.
  const tail = planImportChunk(30, 25, 25);
  assertEquals(tail.end, 30);
  assertEquals(tail.done, true);

  // Never past the hard 200 cap even if the pick somehow listed more.
  const over = planImportChunk(500, 190, 25);
  assertEquals(over.end, 200);
  assertEquals(over.done, true);
});

const CLIENT_ENV = [
  "GOOGLE_PHOTOS_CLIENT_ID",
  "GOOGLE_PHOTOS_CLIENT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
];

Deno.test("isGooglePhotosConfigured reflects the client env vars", () => {
  for (const k of CLIENT_ENV) Deno.env.delete(k);
  assertEquals(isGooglePhotosConfigured(), false);

  // Per-service override vars work and require BOTH.
  Deno.env.set("GOOGLE_PHOTOS_CLIENT_ID", "id");
  assertEquals(isGooglePhotosConfigured(), false);
  Deno.env.set("GOOGLE_PHOTOS_CLIENT_SECRET", "secret");
  assertEquals(isGooglePhotosConfigured(), true);

  // The SHARED vars satisfy it too — no per-service vars needed.
  for (const k of CLIENT_ENV) Deno.env.delete(k);
  Deno.env.set("GOOGLE_CLIENT_ID", "id");
  Deno.env.set("GOOGLE_CLIENT_SECRET", "secret");
  assertEquals(isGooglePhotosConfigured(), true);

  for (const k of CLIENT_ENV) Deno.env.delete(k);
});
