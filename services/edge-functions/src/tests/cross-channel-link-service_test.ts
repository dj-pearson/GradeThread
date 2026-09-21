// US-3197 AC6: the executor's tenant scoping and its route wiring.
//
// The three decision layers are pure and tested to the case. What this file
// pins is the half they cannot: that every read and write is owner-filtered,
// and that the routes sit under a prefix that is already guarded. A confirm
// endpoint ACTS on the ids a row names, so a row reachable across tenants is
// a merge of somebody else's garments, not a read leak.

import { assert, assertEquals } from "@std/assert";

const SERVICE = await Deno.readTextFile(
  new URL("../lib/cross-channel-link-service.ts", import.meta.url),
);
const ROUTES = await Deno.readTextFile(
  new URL("../routes/flipdesk-link.ts", import.meta.url),
);
const MAIN = await Deno.readTextFile(new URL("../main.ts", import.meta.url));

Deno.test("every supabase call in the service carries an owner filter", () => {
  // Counted rather than spot-checked: a new query added without the filter is
  // the whole of US-268, and it looks exactly like the ones that have it.
  const calls = [...SERVICE.matchAll(/\.from\(\s*(?:REVIEW_TABLE|"[a-z_]+")\s*\)([\s\S]*?);/g)];
  assert(calls.length >= 6, `expected the query corpus, saw ${calls.length}`);
  const unscoped = calls
    .map((m) => m[0])
    .filter((q) =>
      !/\.eq\(\s*"user_id"\s*,\s*ownerId\s*\)/.test(q) &&
      !/\.eq\(\s*"owner_user_id"\s*,\s*ownerId\s*\)/.test(q) &&
      !/owner_user_id:\s*ownerId/.test(q)
    );
  assertEquals(
    unscoped.map((q) => q.slice(0, 90)),
    [],
    "a query in cross-channel-link-service.ts is not scoped to the owner",
  );
});

Deno.test("the write path filters on the owner too, not just the read", () => {
  // The read deciding what to write does not protect the write. applyWrites
  // is the last line and it is the one an escaped id would reach.
  const apply = SERVICE.slice(SERVICE.indexOf("async function applyWrites"));
  assert(/\.eq\("id", w\.id\)/.test(apply));
  assert(/\.eq\("user_id", ownerId\)/.test(apply), "applyWrites lost its owner filter");
});

Deno.test("a review that does not resolve for this owner is a 404, not a 403", () => {
  // B should not learn whether the id exists.
  assert(SERVICE.includes("status: 404"));
  assert(/could not be found/i.test(SERVICE));
});

Deno.test("a forged pair cannot reach the write planner", () => {
  // writeContext returns null unless BOTH listings resolve under this owner,
  // and every caller treats null as a refusal. That is what stops a review
  // row naming another tenant's listings from being applied.
  const ctx = SERVICE.slice(
    SERVICE.indexOf("async function writeContext"),
    SERVICE.indexOf("async function applyWrites"),
  );
  assert(ctx.includes("if (!keeper || !merged) return null;"));
  assert(SERVICE.includes("if (!ctx) return { ok: false, status: 409"));
  assert(/if \(!ctx\) \{\n\s*summary\.failed\+\+;/.test(SERVICE));
});

Deno.test("splitting an already-joined pair replays its writes backwards", () => {
  // The unmerge button. Without the reverse it would mark the row split and
  // leave the garments merged, which is the worst of both.
  const split = SERVICE.slice(SERVICE.indexOf('if (decision === "split")'));
  assert(split.includes("reverseLinkWrites(row.applied_writes)"));
  // And it refuses rather than lying if the undo fails.
  assert(/Nothing was changed/.test(split));
});

Deno.test("an auto-join is recorded as a resolved review, not as nothing", () => {
  // A seller who cannot see what was merged automatically cannot trust the
  // button. The row is what makes an auto-join as undoable as a confirmed one.
  const scan = SERVICE.slice(SERVICE.indexOf("export async function scanForLinks"));
  // UNCONDITIONAL, asserted as a statement rather than as a substring. The
  // first version of this case looked for the text `"linked", writes.writes`,
  // which survives being prefixed with `if (false)` -- measured, and the
  // suite stayed green while every auto-join went unrecorded.
  assert(
    /\n\s*await upsertReview\(ownerId, link\.listingIds/.test(scan),
    "the auto-join no longer records a review row unconditionally",
  );
  assert(scan.includes('"linked", writes.writes'));
  assert(/Joined automatically/.test(scan));
});

Deno.test("only live listings are candidates", () => {
  // A sold or ended listing is not cross-listed, and joining one would move a
  // sold row onto another garment's item.
  assert(SERVICE.includes('const CANDIDATE_STATUSES = ["draft", "active"]'));
  assert(SERVICE.includes('.in("listing_status", CANDIDATE_STATUSES)'));
});

Deno.test("the routes mount under an already-guarded prefix", () => {
  // /api/flipdesk/import/* carries authMiddleware, workspaceMiddleware and a
  // rate limiter in main.ts. A new top-level prefix would be a fourth place
  // for one of those to be forgotten, on a route that writes.
  assert(MAIN.includes('app.route("/api/flipdesk/import/link", flipdeskLinkRoutes)'));
  for (const guard of ["authMiddleware", "workspaceMiddleware", "rateLimiter"]) {
    const line = new RegExp(`app\\.use\\("/api/flipdesk/import/\\*", ${guard}`);
    assert(line.test(MAIN), `/api/flipdesk/import/* lost its ${guard}`);
  }
});

Deno.test("every route reads the workspace owner, never the caller alone", () => {
  const handlers = [...ROUTES.matchAll(/flipdeskLinkRoutes\.(get|post)\(/g)];
  assert(handlers.length >= 3, `expected the route corpus, saw ${handlers.length}`);
  const owners = [...ROUTES.matchAll(/c\.get\("workspaceOwnerId"\) \?\? c\.get\("userId"\)/g)];
  assertEquals(
    owners.length,
    handlers.length,
    "a route handler does not resolve the workspace owner",
  );
});

Deno.test("an unknown status query cannot select rows the caller did not ask for", () => {
  // `?status=` is caller input reaching a query. It is validated against the
  // three the CHECK allows rather than passed through.
  assert(ROUTES.includes('STATUSES.includes(raw as ReviewStatus) ? raw as ReviewStatus : "pending"'));
});
