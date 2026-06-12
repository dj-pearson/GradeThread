// US-479: admin reject-and-regrade must actually re-run the pipeline.
//
// grading-pipeline.ts imports the service-role supabase client at module init,
// so set dummy env BEFORE the dynamic import.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { regradeSubmission } = await import("../lib/grading-pipeline.ts");
import type { RegradeStore } from "../lib/grading-pipeline.ts";

// An in-memory model of the regrade contract. The fake `kick` simulates
// processSubmission: it re-claims the (now pending) row and INSERTs a fresh,
// active grade_report, ending in a terminal 'completed' status. This lets us
// assert the AC — "rejecting produces a new report and a terminal status" —
// without a DB or a live Claude call.
interface Report {
  id: string;
  certificate_id: string | null;
  superseded_at: string | null;
}
function makeStore(opts: {
  exists?: boolean;
  initialReports?: Report[];
  initialStatus?: string;
}): { store: RegradeStore; db: { status: string | null; grading_started_at: string | null; reports: Report[] }; order: string[] } {
  const exists = opts.exists ?? true;
  const db = {
    status: opts.initialStatus ?? "completed" as string | null,
    grading_started_at: "2026-06-12T00:00:00Z" as string | null,
    reports: (opts.initialReports ?? []).slice(),
  };
  const order: string[] = [];
  let nextReportSeq = db.reports.length + 1;

  const store: RegradeStore = {
    loadSubmission: (id) => {
      order.push("load");
      return Promise.resolve(
        exists ? { id, status: db.status, title: "Vintage tee" } : null,
      );
    },
    supersedePriorReports: (_id) => {
      order.push("supersede");
      const superseded: string[] = [];
      for (const r of db.reports) {
        if (r.superseded_at === null) {
          r.superseded_at = "2026-06-12T01:00:00Z";
          r.certificate_id = null; // certificate withheld
          superseded.push(r.id);
        }
      }
      return Promise.resolve(superseded);
    },
    resetForRegrade: (_id) => {
      order.push("reset");
      db.status = "pending";
      db.grading_started_at = null;
      return Promise.resolve();
    },
    kick: (_id) => {
      order.push("kick");
      // Simulate the pipeline: claim → grade → insert fresh active report →
      // terminal status.
      assertEquals(db.status, "pending", "kick must run only after reset");
      assertEquals(db.grading_started_at, null, "row must be claimable on kick");
      db.grading_started_at = "2026-06-12T02:00:00Z";
      db.status = "processing";
      db.reports.push({
        id: `report_${nextReportSeq++}`,
        certificate_id: `cert_${nextReportSeq}`,
        superseded_at: null,
      });
      db.status = "completed"; // terminal
    },
  };
  return { store, db, order };
}

Deno.test("regrade: missing submission → 404, no side effects", async () => {
  const { store, db } = makeStore({ exists: false });
  const res = await regradeSubmission("nope", store);
  assert(!res.ok);
  if (!res.ok) assertEquals(res.status, 404);
  assertEquals(db.reports.length, 0);
});

Deno.test("regrade: produces a NEW active report and a terminal status", async () => {
  const original: Report = { id: "report_1", certificate_id: "cert_1", superseded_at: null };
  const { store, db, order } = makeStore({ initialReports: [original] });

  const res = await regradeSubmission("sub_1", store);

  assert(res.ok);
  if (res.ok) assertEquals(res.supersededReportIds, ["report_1"]);

  // The prior report is superseded with its certificate withheld.
  const prior = db.reports.find((r) => r.id === "report_1")!;
  assert(prior.superseded_at !== null, "prior report must be superseded");
  assertEquals(prior.certificate_id, null, "superseded certificate must be withheld");

  // Exactly one ACTIVE report remains, and it's a NEW one.
  const active = db.reports.filter((r) => r.superseded_at === null);
  assertEquals(active.length, 1);
  assert(active[0].id !== "report_1", "the active report must be freshly produced");

  // The submission reached a terminal status — not stuck in 'processing'.
  assertEquals(db.status, "completed");

  // Supersede happens BEFORE the re-kick; reset happens before kick too.
  assertEquals(order, ["load", "supersede", "reset", "kick"]);
});

Deno.test("regrade: a never-graded submission still re-runs and terminates", async () => {
  // No prior report (e.g. a 'failed' submission an admin retries).
  const { store, db, res } = await (async () => {
    const s = makeStore({ initialReports: [], initialStatus: "failed" });
    const r = await regradeSubmission("sub_2", s.store);
    return { ...s, res: r };
  })();

  assert(res.ok);
  if (res.ok) assertEquals(res.supersededReportIds, []);
  // A fresh active report exists and the status is terminal.
  assertEquals(db.reports.filter((r) => r.superseded_at === null).length, 1);
  assertEquals(db.status, "completed");
  void store;
});
