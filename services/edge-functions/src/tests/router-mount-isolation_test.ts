// US-2377: a sub-app's use("*") is NOT scoped to its mount prefix.
//
// hono's app.route(prefix, subApp) copies the sub-app's entries onto the PARENT
// router with the prefix prepended. A handler registered at "/coupons" becomes
// "<prefix>/coupons" — fine. But a middleware registered at "*" becomes a plain
// "<prefix>/*", which matches every sibling router mounted UNDER that prefix
// too. So a whole-router guard is only safe on a LEAF mount.
//
// admin-billing.ts is mounted at the bare /api/admin (its paths are a mix of
// /users/*, /billing/*, /coupons and /charges/*), so its former
// adminBillingRoutes.use("*", requireScope("billing:write")) registered as
// ALL /api/admin/* and ran ahead of all 54 sibling admin routers. Revoking
// billing:write from a role would have 403'd that role out of the entire admin
// surface — users, grading, moderation, everything — and it would have read as
// a broken admin login, not a scope change.
//
// Two tests: the first pins the hono behavior itself (so a version bump that
// changes it is loud), the second is the drift guard over the real mount table.

import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";

const MAIN = new URL("../main.ts", import.meta.url);
const ROUTES = new URL("../routes/", import.meta.url);

// Native line endings on Windows would break multi-line matching.
const mainSrc = (await Deno.readTextFile(MAIN)).replace(/\r\n/g, "\n");

Deno.test("US-2377: a sub-app use(\"*\") gates every sibling mounted under the same prefix", async () => {
  const guarded = new Hono();
  // deno-lint-ignore require-await
  guarded.use("*", async (c) => c.json({ error: "Missing scope" }, 403));
  guarded.get("/coupons", (c) => c.text("coupons"));

  const sibling = new Hono();
  sibling.get("/:id", (c) => c.text("user"));

  const app = new Hono();
  app.route("/api/admin", guarded); // registered first, so its wildcard runs first
  app.route("/api/admin/users", sibling);

  // Its own route: 403 is the intent.
  assertEquals((await app.request("http://x/api/admin/coupons")).status, 403);
  // A route on a DIFFERENT router: 403 is the bug this story closed.
  assertEquals(
    (await app.request("http://x/api/admin/users/abc")).status,
    403,
    "hono no longer leaks a sub-app wildcard onto siblings — if this is now 200, " +
      "re-read the mount-isolation rule below; it may have become unnecessary",
  );
});

/** Every `app.route("<path>", <router>)` in main.ts, in registration order. */
function mounts(): Array<{ path: string; router: string }> {
  return [...mainSrc.matchAll(/app\.route\(\s*"([^"]+)"\s*,\s*(\w+)\s*\)/g)]
    .map((m) => ({ path: m[1], router: m[2] }));
}

/** The routes/ file a router identifier is imported from, or null. */
function sourceFile(router: string): string | null {
  const m = mainSrc.match(
    new RegExp(`import\\s*\\{\\s*${router}\\s*\\}\\s*from\\s*"\\./routes/([\\w-]+\\.ts)"`),
  );
  return m ? m[1] : null;
}

Deno.test("US-2377: no router mounted at a shared prefix carries a whole-router use(\"*\")", async () => {
  const all = mounts();
  assert(all.length > 100, `expected the full mount table, found ${all.length}`);

  // A mount is a "parent" when another mount lives strictly beneath it. Only
  // those can leak; a leaf mount's wildcard matches nothing but its own routes.
  const parents = all.filter((a) =>
    all.some((b) => b.path !== a.path && b.path.startsWith(a.path + "/"))
  );
  assert(
    parents.some((p) => p.path === "/api/admin"),
    "expected /api/admin to still be a parent mount — the shape this test guards",
  );

  const offenders: string[] = [];
  for (const p of parents) {
    const file = sourceFile(p.router);
    if (!file) continue; // defined inline in main.ts; nothing to read
    const src = (await Deno.readTextFile(new URL(file, ROUTES))).replace(/\r\n/g, "\n");
    // Only a real registration counts — the explanatory comments in these files
    // quote the forbidden call on purpose.
    if (new RegExp(`^${p.router}\\.use\\("\\*"`, "m").test(src)) {
      const children = all
        .filter((b) => b.path !== p.path && b.path.startsWith(p.path + "/"))
        .length;
      offenders.push(
        `${file}: ${p.router}.use("*", …) is mounted at ${p.path}, which is the ` +
          `parent of ${children} other mount(s) — that middleware runs for all of ` +
          `them. Pass it as a per-route argument instead; the URLs don't change.`,
      );
    }
  }
  assertEquals(offenders, [], offenders.join("\n"));
});

Deno.test("US-2377: the billing routes still each carry billing:write", async () => {
  const src = (await Deno.readTextFile(new URL("admin-billing.ts", ROUTES)))
    .replace(/\r\n/g, "\n");
  const regs = [...src.matchAll(/^adminBillingRoutes\.(get|post|put|patch|delete)\((.*)$/gm)];
  assert(regs.length >= 21, `expected the billing routes, found ${regs.length}`);
  const ungated = regs
    .filter((m) => !m[2].includes('requireScope("billing:write")'))
    .map((m) => m[0]);
  assertEquals(
    ungated,
    [],
    "moving the guard off use(\"*\") must not drop it from any route:\n" + ungated.join("\n"),
  );
});
