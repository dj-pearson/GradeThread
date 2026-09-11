// US-3328: GET /api/grade/turnaround is owner-scoped and takes no id from the
// request. The live cross-tenant case is in tenant-isolation_test.ts.
//
//   deno test --allow-net --allow-env --allow-read src/tests/grade-turnaround-route_test.ts

import { assert } from "@std/assert";

const src = Deno.readTextFileSync(new URL("../routes/grade.ts", import.meta.url))
  .replace(/\r\n/g, "\n")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const start = src.indexOf('gradeRoutes.get("/turnaround"');
const body = src.slice(start, src.indexOf("\ngradeRoutes.", start + 10));

Deno.test("the turnaround route exists", () => {
  assert(start >= 0);
});

Deno.test("it resolves the tenant the US-268 way and filters submissions by it first", () => {
  assert(body.includes('const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");'));
  const scope = body.indexOf('.eq("user_id", ownerId)');
  const reports = body.indexOf('.in("submission_id", ids)');
  assert(scope > 0 && reports > scope, "reports must be keyed on owner-verified submission ids");
});

Deno.test("it takes nothing from the request that could name another tenant", () => {
  assert(!/c\.req\.(query|param|json)\(/.test(body));
});
