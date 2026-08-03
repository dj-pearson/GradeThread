// US-2313: the fleet watcher is the one schedule that must not live only in the
// Coolify UI.
//
// Every production schedule is a hand-typed Coolify task. The stall detector
// (/api/jobs/cron-fleet-health) is what makes a missing task visible — and it is
// itself entry number N of that same hand-entered list. If it was never created,
// nothing alerts about anything, and the silence looks exactly like health.
//
// So one job moved to schedules-as-code: a GitHub Actions workflow, which runs
// on infrastructure that cannot fail the way Coolify does. These cases pin the
// two halves agreeing — a workflow pointing at an endpoint the registry no
// longer declares, or a registry entry the workflow does not cover, is the drift
// that would quietly restore the single point of failure.

import { assert, assertEquals } from "@std/assert";

// cron-runs.ts transitively imports the service-role client, which throws at
// module load without these.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { CRON_REGISTRY } = await import("../lib/cron-runs.ts");

const workflow = () =>
  Deno.readTextFileSync(
    new URL("../../../../.github/workflows/cron-fleet-watchdog.yml", import.meta.url),
  );

Deno.test("the watchdog workflow exists and is scheduled", () => {
  const wf = workflow();
  // A workflow_dispatch-only file would look like coverage and provide none.
  assert(/on:\s*[\s\S]*schedule:/.test(wf), "the watchdog must run on a schedule");
  assert(/- cron: "/.test(wf), "no cron expression");
});

Deno.test("it invokes the endpoint the registry declares for cron-fleet-health", () => {
  const entry = CRON_REGISTRY.find((c) => c.name === "cron-fleet-health");
  assert(entry, "cron-fleet-health is gone from CRON_REGISTRY");
  // The registry is the manifest; the workflow is a second scheduler for one of
  // its entries. If someone moves the endpoint, this fails here rather than in
  // six months of silence.
  //
  // Matched on the CURL LINE, not on the file. The workflow's header comment and
  // its step name both name this endpoint, so a plain `includes` would be
  // satisfied by the prose while the actual request drifted — verified by
  // mutation: changing only the first occurrence left the suite green and it was
  // right to. Eighth time a guard here could have been fooled by a comment.
  const curlLine = workflow()
    .split("\n")
    .find((l) => l.includes("-X POST") && l.includes("functions.gradethread.com"));
  assert(curlLine, "no POST to the edge service");
  // And matched with the CLOSING QUOTE, so the path has to end where the
  // registry says it ends. A bare `includes` passes on a prefix — renaming the
  // route to `/cron-fleet-healthz` still contains `/cron-fleet-health`, so the
  // guard would wave through the exact drift it exists to catch. Also found by
  // mutation rather than by reading.
  assert(
    curlLine.includes(`'https://functions.gradethread.com${entry.endpoint}'`),
    `the request does not call ${entry.endpoint}`,
  );
  assertEquals(entry.recorded, true, "the watcher must leave a cron_runs row");
});

Deno.test("it authenticates the way the endpoint expects", () => {
  // requireJobSecret reads X-Internal-Job-Secret (or a Bearer header). A
  // workflow that sends the wrong header 401s on every run, which reads as "the
  // fleet is broken" forever and gets muted.
  const wf = workflow();
  assert(wf.includes("X-Internal-Job-Secret:"), "wrong auth header");
});

Deno.test("an unconfigured secret SKIPS rather than failing", () => {
  // A watchdog that cries wolf every six hours because nobody set a secret gets
  // muted, and a muted watchdog is worse than no watchdog. The skip is the
  // deliberate half of the design, not an oversight.
  const wf = workflow();
  assert(wf.includes('if [ -z "${EDGE_JOB_SECRET:-}" ]'), "no unset-secret branch");
  const skip = wf.slice(wf.indexOf('if [ -z "${EDGE_JOB_SECRET:-}" ]'));
  assert(
    skip.slice(0, 300).includes("exit 0"),
    "an unset secret must exit 0, not fail the run",
  );
});

Deno.test("it checks the BODY, not just the status", () => {
  // This endpoint can answer 200 with an error payload. For the one job whose
  // whole purpose is to notice silence, a bare status check is the failure mode
  // that would let the alarm sit disconnected while the workflow stayed green.
  const wf = workflow();
  assert(wf.includes('grep -q \'"error"\''), "the body is never inspected");
  assert(wf.includes('if [ "$code" != "200" ]'), "the status is never inspected");
});

Deno.test("the registry is still the single manifest of expected schedules", () => {
  // US-2313 AC2 asks for "an artifact in the repo listing every expected
  // schedule". That artifact is CRON_REGISTRY, and it is only an artifact while
  // every entry actually carries a schedule and an endpoint — a half-filled row
  // is a schedule nobody can verify.
  assert(CRON_REGISTRY.length > 0, "the registry is empty");
  for (const c of CRON_REGISTRY) {
    assert(c.name.length > 0, "a registry entry has no name");
    assert(c.schedule.length > 0, `${c.name} has no schedule`);
    assert(c.endpoint.startsWith("/api/"), `${c.name} has no endpoint`);
  }
});
