// US-3161: the rules of a phone capture session.
//
// The phone holding one of these tokens is not signed in to anything, so every
// limit is the server's or it does not exist. Each case here is one of those
// limits, and the token cases are the ones that matter most: a forgeable or
// guessable code is an upload credential for somebody else's catalogue.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  CAPTURE_MAX_BYTES,
  CAPTURE_MAX_PHOTO_BYTES,
  CAPTURE_MAX_PHOTOS,
  CAPTURE_TTL_MS,
  type CaptureSessionState,
  hashCaptureToken,
  isCaptureTargetKind,
  isWellFormedCaptureToken,
  missingPhotoTypes,
  newCaptureToken,
  publicView,
  refuseCapture,
} from "../lib/phone-capture.ts";

function live(over: Partial<CaptureSessionState> = {}): CaptureSessionState {
  return {
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    ended_at: null,
    photo_count: 0,
    bytes_total: 0,
    ...over,
  };
}

Deno.test("a capture code is random, not derived from anything the seller shows", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const t = newCaptureToken();
    assert(isWellFormedCaptureToken(t), `${t} is not the shape we accept`);
    assert(!seen.has(t), "two tokens collided in 200 draws");
    seen.add(t);
  }
  // A token computed from an item id would be forgeable by anyone who ever saw
  // that id, including the seller's own pages.
  assertNotEquals(newCaptureToken(), newCaptureToken());
});

Deno.test("the stored form is a hash, so a database read is not an upload credential", async () => {
  const token = newCaptureToken();
  const hash = await hashCaptureToken(token);
  assertEquals(hash.length, 64);
  assert(/^[0-9a-f]{64}$/.test(hash));
  assertNotEquals(hash, token);
  // Deterministic, or the lookup could never find the row.
  assertEquals(hash, await hashCaptureToken(token));
  assertNotEquals(hash, await hashCaptureToken(newCaptureToken()));
});

Deno.test("a token that is not our shape is refused before any lookup", () => {
  for (const bad of ["", "short", "../../etc/passwd", "a".repeat(200), null, 42, undefined]) {
    assert(!isWellFormedCaptureToken(bad), `${String(bad)} should not be accepted`);
  }
  // No slashes, no dots, no plus: a URL-safe alphabet only, so a token can
  // never carry a path segment into a query.
  assert(!isWellFormedCaptureToken("abcd/efgh".padEnd(44, "x")));
  assert(isWellFormedCaptureToken("A-b_1".padEnd(44, "z")));
});

Deno.test("a finished code is gone, and says so as gone rather than forbidden", () => {
  const r = refuseCapture(live({ ended_at: new Date().toISOString() }), 1000);
  assertEquals(r?.status, 410);
  // 410 tells the person holding the phone to scan a new code. A 403 would read
  // as "you are not allowed" and send them looking for a login that does not
  // exist.
  assertEquals(r?.kind, "gone");
});

Deno.test("an expired code is gone even one millisecond past its time", () => {
  const justPast = new Date(Date.now() - 1).toISOString();
  assertEquals(refuseCapture({ ...live(), expires_at: justPast }, 1000)?.status, 410);
  // And the boundary itself is closed, not open.
  const now = Date.now();
  assertEquals(
    refuseCapture({ ...live(), expires_at: new Date(now).toISOString() }, 1000, now)?.status,
    410,
  );
});

Deno.test("the caps are counted server-side and refuse with 429, not 400", () => {
  assertEquals(refuseCapture(live({ photo_count: CAPTURE_MAX_PHOTOS }), 1000)?.status, 429);
  assertEquals(refuseCapture(live({ bytes_total: CAPTURE_MAX_BYTES }), 1000)?.status, 429);
  assertEquals(refuseCapture(live(), CAPTURE_MAX_PHOTO_BYTES + 1)?.status, 429);
  // One under each cap still goes through.
  assertEquals(refuseCapture(live({ photo_count: CAPTURE_MAX_PHOTOS - 1 }), 1000), null);
  assertEquals(refuseCapture(live(), CAPTURE_MAX_PHOTO_BYTES), null);
});

Deno.test("a photo that would cross the byte cap is refused, not truncated", () => {
  const nearlyFull = live({ bytes_total: CAPTURE_MAX_BYTES - 1000 });
  assertEquals(refuseCapture(nearlyFull, 999), null);
  assertEquals(refuseCapture(nearlyFull, 1001)?.status, 429);
});

Deno.test("ending beats expiry when both apply, because the seller chose it", () => {
  const both = {
    expires_at: new Date(Date.now() - 60_000).toISOString(),
    ended_at: new Date(Date.now() - 120_000).toISOString(),
    photo_count: 0,
    bytes_total: 0,
  };
  assertEquals(refuseCapture(both, 10)?.error, "This code was finished on the computer.");
});

Deno.test("the phone is told what it needs and nothing about the seller", () => {
  const view = publicView({ ...live({ photo_count: 3 }), target_kind: "item" });
  assertEquals(view.photosTaken, 3);
  assertEquals(view.photosLeft, CAPTURE_MAX_PHOTOS - 3);
  assertEquals(view.targetKind, "item");
  // No owner, no item id, no name, no workspace. Whatever is added to this
  // shape reaches a page anybody holding the link can open. US-3162 added
  // missingTypes, which is a fixed vocabulary shared by every seller and so
  // names nothing about this one.
  assertEquals(Object.keys(view).sort(), [
    "expiresAt",
    "missingTypes",
    "photosLeft",
    "photosTaken",
    "targetKind",
  ]);
  // Called with no list at all, it is empty rather than undefined.
  assertEquals(view.missingTypes, []);
});

Deno.test("an unknown target kind reads as an item rather than crashing the page", () => {
  assertEquals(publicView({ ...live(), target_kind: "nonsense" }).targetKind, "item");
  assert(isCaptureTargetKind("item"));
  assert(isCaptureTargetKind("batch"));
  assert(!isCaptureTargetKind("workspace"));
});

Deno.test("the code's life is short, and the story says fifteen minutes", () => {
  assertEquals(CAPTURE_TTL_MS, 15 * 60 * 1000);
  assert(CAPTURE_TTL_MS <= 15 * 60 * 1000, "US-3161 AC1: expiry of 15 minutes or less");
});

// ── US-3162: what the phone is told to shoot next ───────────────────

Deno.test("the missing list is the required shots this item has none of", () => {
  const required = ["front", "back", "tag"];
  assertEquals(missingPhotoTypes(required, []), ["front", "back", "tag"]);
  assertEquals(missingPhotoTypes(required, ["front"]), ["back", "tag"]);
  assertEquals(missingPhotoTypes(required, ["front", "back", "tag"]), []);
  // Order is the required list's, because "front, back, tag" is the order a
  // seller shoots in and re-sorting reads as a different instruction.
  assertEquals(missingPhotoTypes(required, ["tag"]), ["front", "back"]);
});

Deno.test("a photo type that is not required does not satisfy one that is", () => {
  assertEquals(missingPhotoTypes(["front", "back"], ["detail", "flatlay", "defect"]), [
    "front",
    "back",
  ]);
});

Deno.test("casing from the database does not make a shot look missing", () => {
  assertEquals(missingPhotoTypes(["front", "tag"], ["FRONT", "Tag"]), []);
});

Deno.test("a batch capture is told nothing about missing shots, having no one item", () => {
  const view = publicView(
    { ...live(), target_kind: "batch" },
    ["front", "back"],
  );
  assertEquals(view.targetKind, "batch");
  // Passing a list for a batch is a caller mistake, not a reason to leak a
  // prompt about an item this session is not bound to.
  assertEquals(view.missingTypes, []);
});

Deno.test("an item capture carries the missing list and still names nothing else", () => {
  const view = publicView({ ...live({ photo_count: 1 }), target_kind: "item" }, ["back", "tag"]);
  assertEquals(view.missingTypes, ["back", "tag"]);
  assertEquals(Object.keys(view).sort(), [
    "expiresAt",
    "missingTypes",
    "photosLeft",
    "photosTaken",
    "targetKind",
  ]);
});

// US-3162's whole point is that the phone's "shoot the back next" prompt
// tracks what has actually landed. It never did: the query read
// `item_photos.item_id`, a column that does not exist, so PostgREST answered
// 42703, the error was thrown away, and the empty result meant EVERY required
// shot read as still missing forever.
//
// A source scan, because the failure was invisible everywhere else: it
// typechecked, it lint-passed, it returned 200, and the wrong answer was a
// perfectly well-formed list of photo types.
Deno.test("the missing-shots read names the column item_photos actually has", async () => {
  const src = await Deno.readTextFile(
    new URL("../routes/flipdesk-phone-capture.ts", import.meta.url),
  );
  const at = src.indexOf('.from("item_photos")');
  assert(at > -1, "the item_photos read is gone — this guard needs re-pointing");
  const query = src.slice(at, at + 300);
  assert(
    query.includes('.eq("inventory_item_id"'),
    "the item_photos read must filter on inventory_item_id",
  );
  assert(
    !/\.eq\("item_id"/.test(query),
    "item_photos has no item_id column; PostgREST answers 42703 and the read fails whole",
  );
});

Deno.test("a failed missing-shots read is not reported as 'nothing shot yet'", async () => {
  const src = await Deno.readTextFile(
    new URL("../routes/flipdesk-phone-capture.ts", import.meta.url),
  );
  const at = src.indexOf("async function missingForTarget");
  assert(at > -1, "missingForTarget is gone — this guard needs re-pointing");
  const body = src.slice(at, src.indexOf("\n}", at));
  // Destructuring only `data` is what let the broken column pass for a real
  // answer. The error has to be looked at, and it has to stop the caller
  // rather than fall through to an empty list.
  assert(body.includes("error"), "missingForTarget must read the query's error");
  assert(/if \(error\) throw/.test(body), "a failed read must throw, not return []");
});
