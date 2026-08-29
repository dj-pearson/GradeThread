import { Hono } from "hono";
import { getSetting } from "../lib/system-settings.ts";

// US-2911 AC5: the minimum client version each mobile app must be at.
//
// PUBLIC and unauthenticated, deliberately. The whole point is to reach a
// client that may be too old to sign in - an app below the floor might be
// failing auth for the very reason it needs replacing, and a signal gated
// behind a session could never tell it so.
//
// WHY THIS EXISTS BEFORE THE THING THAT USES IT. Play's in-app update API has
// two modes: a FLEXIBLE prompt, which Play decides on its own from the version
// in the store, and an IMMEDIATE one, which blocks until the seller updates.
// Play will not decide the second for you - it has no idea which of your old
// versions is broken. Without a server-declared floor the immediate path has no
// trigger and the API is half-wired, which is exactly the state US-2911 found.
//
// NO MIGRATION. `getSetting` returns its fallback for a key that has no row, so
// this works with an empty settings table and the fallback means "no floor".
// Registering the keys in the settings registry is worth doing for the admin
// editor, and is a follow-up rather than a prerequisite - a story that has to
// hold a migration to ship a read is a story that ships later for no gain.
export const clientVersionRoutes = new Hono();

/** Android: a versionCode, monotonic integer. */
export const ANDROID_MIN_KEY = "client.android_min_version_code";
/** iOS: a CFBundleVersion, compared as a monotonic integer for the same reason. */
export const IOS_MIN_KEY = "client.ios_min_build_number";

/**
 * Absent, junk or negative all mean NO FLOOR.
 *
 * FAILS OPEN, and that is the deliberate direction here - the opposite of the
 * consent regime's fail-safe, for a different reason. A wrong value in the
 * strict direction locks every seller out of an app that works, with no way for
 * them to fix it and no way for us to reach them except another deploy. A wrong
 * value in the permissive direction costs nothing: Play still offers the update
 * through the flexible prompt.
 */
export function normalizeMinVersion(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/** Is this client below the floor? A zero floor is never below. */
export function isBelowMinimum(clientVersion: number, minimum: number): boolean {
  if (minimum <= 0) return false;
  if (!Number.isFinite(clientVersion) || clientVersion <= 0) return false;
  return clientVersion < minimum;
}

clientVersionRoutes.get("/minimum", async (c) => {
  const [android, ios] = await Promise.all([
    getSetting<unknown>(ANDROID_MIN_KEY, 0),
    getSetting<unknown>(IOS_MIN_KEY, 0),
  ]);
  return c.json({
    // 0 means "no floor declared" on both. A client reading this must treat 0
    // as no-op rather than as "everything is below the minimum", which is the
    // one misreading that would brick every install at once.
    android_min_version_code: normalizeMinVersion(android),
    ios_min_build_number: normalizeMinVersion(ios),
  });
});
