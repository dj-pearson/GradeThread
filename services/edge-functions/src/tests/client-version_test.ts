// US-2911 AC5: the minimum-client-version signal.
//
// Almost all of this is about the direction the answer fails in. A version
// floor is a kill switch pointed at your own users: get it wrong in the strict
// direction and every seller is locked out of an app that works, with no way
// for them to fix it and no way to reach them except another deploy.
//
// So the tests are mostly about zero, junk and absence all meaning "no floor",
// and about a client reading 0 as a no-op rather than as "everyone is below
// the minimum" - the single misreading that would brick every install at once.

import { assertEquals } from "@std/assert";
import {
  ANDROID_MIN_KEY,
  IOS_MIN_KEY,
  isBelowMinimum,
  normalizeMinVersion,
} from "../routes/client-version.ts";

Deno.test("a real version comes back as itself", () => {
  assertEquals(normalizeMinVersion(42), 42);
  assertEquals(normalizeMinVersion("42"), 42);
});

Deno.test("absent, junk and negative all mean NO FLOOR", () => {
  // This is the fail-open direction, and it is deliberate. getSetting returns
  // its fallback for a key with no row, so an empty settings table lands here.
  for (const raw of [undefined, null, "", "abc", {}, [], NaN, Infinity, -1, -999, 0]) {
    assertEquals(normalizeMinVersion(raw), 0, `${JSON.stringify(raw) ?? "undefined"} should mean no floor`);
  }
});

Deno.test("a fractional version floors rather than rounding up", () => {
  // Rounding UP would put the floor above a version that actually exists, which
  // locks out the newest client for a typo in a settings field.
  assertEquals(normalizeMinVersion(41.9), 41);
  assertEquals(normalizeMinVersion("41.9"), 41);
});

Deno.test("a zero floor never blocks anyone", () => {
  // THE MISREADING THAT WOULD BRICK EVERY INSTALL. If 0 were treated as a real
  // minimum, `clientVersion < 0` is false so nothing breaks - but a client that
  // instead reads "no value means block" does. The server-side answer is pinned
  // here so the contract is unambiguous: 0 is a no-op.
  for (const client of [1, 42, 999999]) {
    assertEquals(isBelowMinimum(client, 0), false, `client ${client} against a zero floor`);
  }
});

Deno.test("a client below the floor is below it, and one at the floor is not", () => {
  assertEquals(isBelowMinimum(41, 42), true);
  assertEquals(isBelowMinimum(42, 42), false);
  assertEquals(isBelowMinimum(43, 42), false);
});

Deno.test("an unknown client version is never blocked", () => {
  // A client that cannot report its own version is a client we know nothing
  // about. Blocking it would be guessing, in the one direction that cannot be
  // undone from the seller's side.
  for (const client of [0, -1, NaN, Infinity]) {
    assertEquals(isBelowMinimum(client, 42), false, `unknown client ${client}`);
  }
});

Deno.test("the setting keys name their platform and their unit", () => {
  // Android compares a versionCode and iOS a build number; they are different
  // numbers on different scales, and one key for both would be a silent
  // cross-platform floor. The names carry the unit so a settings editor cannot
  // suggest otherwise.
  // No "and they differ" assertion: they are literal types, so tsc rejects the
  // comparison as provably false before a test could run it. The two
  // assertions above already pin each key to its own name.
  assertEquals(ANDROID_MIN_KEY, "client.android_min_version_code");
  assertEquals(IOS_MIN_KEY, "client.ios_min_build_number");
});

Deno.test("US-2911 AC5: the route is mounted PUBLIC, with no auth middleware", async () => {
  // The whole point is reaching a client too old to sign in - an app below the
  // floor may be failing auth for the very reason it needs replacing. If this
  // ever ends up behind authMiddleware the signal cannot arrive where it is
  // needed, and nothing else would notice.
  const main = await Deno.readTextFile(new URL("../main.ts", import.meta.url));
  const code = main
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
  assertEquals(code.includes('app.route("/api/client-version", clientVersionRoutes)'), true);
  assertEquals(
    code.includes('app.use("/api/client-version'),
    false,
    "an auth middleware was mounted on /api/client-version — the signal can no longer reach a signed-out client",
  );
});
