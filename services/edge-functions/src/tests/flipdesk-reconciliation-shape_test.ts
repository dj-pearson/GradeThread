// US-793: the reconciliation /queue response is PAGINATED (total + has_more +
// showing) so the iOS client surfaces "showing first N of M" instead of silently
// truncating. This pins the wire shape both via the shared fixture and a
// source-guard on the handler (the iOS side decodes the same fixture).
import { assert, assertEquals } from "@std/assert";

const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL("../../../../ios/GradeThreadTests/Fixtures/reconciliation_queue.json", import.meta.url),
  ),
);

Deno.test("reconciliation queue fixture carries the paginated contract shape", () => {
  for (const k of ["queue", "total", "showing", "has_more", "limit"]) {
    assert(k in fixture, `fixture must include '${k}'`);
  }
  assert(Array.isArray(fixture.queue));
  assertEquals(typeof fixture.total, "number");
  assertEquals(typeof fixture.showing, "number");
  assertEquals(typeof fixture.has_more, "boolean");
  assertEquals(typeof fixture.limit, "number");
  // showing never exceeds the limit; has_more iff total > showing.
  assert(fixture.showing <= fixture.limit);
  assertEquals(fixture.has_more, fixture.total > fixture.showing);
});

Deno.test("the /queue handler returns total + has_more + showing (no silent truncation)", async () => {
  const src = await Deno.readTextFile(
    new URL("../routes/flipdesk-reconciliation.ts", import.meta.url),
  );
  assert(src.includes("has_more"), "handler must return has_more");
  assert(/total[,:]/.test(src), "handler must return total");
  assert(/showing:/.test(src), "handler must return showing");
  assert(src.includes('count: "exact"'), "handler must count the full unreconciled set");
});
