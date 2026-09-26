// US-3515: a regrade that fails or abstains must put the prior grade back, and
// must not refund a grade the seller already received.
//
// grading-pipeline.ts imports the service-role supabase client at module init,
// so set dummy env BEFORE the dynamic import.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { restorePriorGradeInsteadOfRefund } = await import(
  "../lib/grading-pipeline.ts"
);
import type { PriorGradeStore } from "../lib/grading-pipeline.ts";

interface Report {
  id: string;
  certificate_id: string | null;
  superseded_at: string | null;
}

function makeStore(opts: {
  reports: Report[];
  revisions?: Record<string, string | null>;
  failOn?: "hasActive" | "latest" | "reactivate";
}) {
  const calls: string[] = [];
  const store: PriorGradeStore = {
    hasActiveReport: () => {
      calls.push("hasActive");
      if (opts.failOn === "hasActive") {
        return Promise.reject(new Error("read failed"));
      }
      return Promise.resolve(
        opts.reports.some((r) => r.superseded_at === null),
      );
    },
    latestSuperseded: () => {
      calls.push("latest");
      if (opts.failOn === "latest") {
        return Promise.reject(new Error("read failed"));
      }
      const sup = opts.reports
        .filter((r) => r.superseded_at !== null)
        .sort((a, b) => (b.superseded_at! < a.superseded_at! ? -1 : 1));
      const r = sup[0];
      return Promise.resolve(
        r
          ? { reportId: r.id, certificateId: opts.revisions?.[r.id] ?? null }
          : null,
      );
    },
    reactivate: (reportId, certificateId) => {
      calls.push(`reactivate:${reportId}:${certificateId}`);
      if (opts.failOn === "reactivate") {
        return Promise.reject(new Error("write failed"));
      }
      const r = opts.reports.find((x) => x.id === reportId)!;
      r.superseded_at = null;
      r.certificate_id = certificateId;
      return Promise.resolve();
    },
    finalize: () => {
      calls.push("finalize");
      return Promise.resolve();
    },
  };
  return { store, calls };
}

Deno.test("US-3515: a failed first grade has no prior report, so it refunds as before", async () => {
  const { store, calls } = makeStore({ reports: [] });
  assertEquals(await restorePriorGradeInsteadOfRefund("s1", store), "none");
  assertEquals(calls, ["hasActive", "latest"]);
});

Deno.test("US-3515: a failed regrade restores the prior report and its certificate", async () => {
  const reports: Report[] = [
    { id: "r1", certificate_id: null, superseded_at: "2026-09-25T10:00:00Z" },
  ];
  const { store, calls } = makeStore({ reports, revisions: { r1: "cert-1" } });
  assertEquals(await restorePriorGradeInsteadOfRefund("s1", store), "restored");
  assertEquals(reports[0], {
    id: "r1",
    certificate_id: "cert-1",
    superseded_at: null,
  });
  assertEquals(calls, [
    "hasActive",
    "latest",
    "reactivate:r1:cert-1",
    "finalize",
  ]);
});

Deno.test("US-3515: the most recently superseded report is the one restored", async () => {
  const reports: Report[] = [
    { id: "old", certificate_id: null, superseded_at: "2026-09-01T00:00:00Z" },
    {
      id: "newer",
      certificate_id: null,
      superseded_at: "2026-09-20T00:00:00Z",
    },
  ];
  const { store } = makeStore({
    reports,
    revisions: { old: "c-old", newer: "c-new" },
  });
  assertEquals(await restorePriorGradeInsteadOfRefund("s1", store), "restored");
  assertEquals(reports.find((r) => r.id === "newer")!.superseded_at, null);
  assert(reports.find((r) => r.id === "old")!.superseded_at !== null);
});

Deno.test("US-3515: an active report means the grade stands; nothing is touched", async () => {
  const { store, calls } = makeStore({
    reports: [{ id: "r2", certificate_id: "c2", superseded_at: null }],
  });
  assertEquals(await restorePriorGradeInsteadOfRefund("s1", store), "graded");
  assertEquals(calls, ["hasActive"]);
});

for (const failOn of ["hasActive", "latest", "reactivate"] as const) {
  Deno.test(`US-3515: a ${failOn} failure answers "unknown", which the caller must not refund`, async () => {
    const { store } = makeStore({
      reports: [{
        id: "r1",
        certificate_id: null,
        superseded_at: "2026-09-25T10:00:00Z",
      }],
      failOn,
    });
    assertEquals(
      await restorePriorGradeInsteadOfRefund("s1", store),
      "unknown",
    );
  });
}

Deno.test("US-3515: the refund and the pipeline catch both consult the restore first", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/grading-pipeline.ts", import.meta.url),
  );
  const refundFn = src.slice(
    src.indexOf("export async function reverseChargeForUngradedSubmission"),
  );
  const guard = refundFn.indexOf(
    "restorePriorGradeInsteadOfRefund(submissionId)",
  );
  const rpc = refundFn.indexOf('"refund_grade"');
  assert(
    guard > 0 && guard < rpc,
    "restore check must run before refund_grade",
  );

  const catchAt = src.indexOf(
    "// US-3515: this read decides whether we refund",
  );
  assert(catchAt > 0, "pipeline catch must consult the restore");
  const markFailed = src.indexOf('.update({ status: "failed" })', catchAt);
  const restoreCall = src.indexOf(
    "restorePriorGradeInsteadOfRefund(submissionId)",
    catchAt,
  );
  assert(
    restoreCall > 0 && restoreCall < markFailed,
    "restore must run before marking failed",
  );
  assertStringIncludes(src.slice(catchAt, markFailed), 'prior === "unknown"');
});
