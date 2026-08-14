import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2558. /admin/jobs carried Cron Health and Dead Letters tabs that were
// READ-ONLY copies of /admin/ops/jobs and /admin/ops/dead-letters. The ops pages
// are the ones that can act — a super-admin Run-now behind an MFA step-up, and
// real replay / re-queue / discard — so an operator triaging from the copy could
// only watch. The fix removes the copies and links out; folding the ops pages
// into /admin/jobs would have deleted the actions.

const JOBS = "src/pages/admin/jobs.tsx";
const OPS_JOBS = "src/pages/admin/ops-jobs.tsx";
const OPS_DEAD = "src/pages/admin/ops-dead-letters.tsx";
const EDGE = "services/edge-functions/src/routes/admin-jobs.ts";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

/**
 * The file with comments stripped.
 *
 * "This endpoint is gone" assertions match the comment SAYING it is gone, which
 * is how the first version of this guard failed on the note explaining the fix.
 */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the read-only copies are gone (US-2558 AC1, AC3)", () => {
  const src = read(JOBS);

  it("the two duplicated tabs no longer exist", () => {
    expect(src).not.toContain('<TabsTrigger value="crons">');
    expect(src).not.toContain('<TabsTrigger value="dead">');
    expect(code(JOBS)).not.toContain("/api/admin/jobs/crons");
    expect(src).not.toMatch(/getJson<DeadLetters>/);
  });

  it("it links to the pages that can act instead", () => {
    expect(src).toContain('to="/admin/ops/jobs"');
    expect(src).toContain('to="/admin/ops/dead-letters"');
  });

  it("the ops pages still own the actions", () => {
    // The thing this story is protecting. If these ever move into /admin/jobs,
    // that is the fold the story rejected.
    const opsJobs = read(OPS_JOBS);
    expect(opsJobs).toContain("/api/admin/ops/jobs/${key}/run");
    const opsDead = read(OPS_DEAD);
    expect(opsDead).toContain("/retry");
    expect(opsDead).toContain("/discard");
    expect(opsDead).toContain("/api/admin/ops/dead-letters/bulk");
    // And /admin/jobs did NOT grow them.
    expect(code(JOBS)).not.toContain("/api/admin/ops/");
  });

  it("the Jobs tab, which is not a copy, survives", () => {
    // AC4: this page's own reason to exist — per-job retry/cancel across
    // grading, sync and AutoLister jobs — is untouched.
    expect(src).toContain('<TabsTrigger value="jobs">');
    expect(src).toContain("/api/admin/jobs");
    expect(src).toContain('pending.action === "retry"');
  });
});

describe("the sources nothing else showed are now visible (US-2558 AC4)", () => {
  it("failed batches were fetched and rendered by nobody", () => {
    // The verification the AC asked for, and it changed the answer: two of the
    // four families the old endpoint returned were displayed on NO page, so
    // deleting the tab wholesale would have buried them for good.
    const src = read(JOBS);
    expect(src).toContain("failed_generation_batches");
    expect(src).toContain("failed_publish_batches");
    expect((src.match(/<FailedBatchCard/g) ?? []).length).toBe(2);
  });

  it("the endpoint stopped fetching what it no longer serves", () => {
    const edge = read(EDGE);
    expect(edge).toContain('adminJobsRoutes.get("/failed-batches"');
    const at = edge.indexOf('adminJobsRoutes.get("/failed-batches"');
    const handler = edge.slice(at, at + 1400);
    // Two queries per 30-second poll for rows no page rendered.
    expect(handler).not.toContain("webhook_dead_letters");
    expect(handler).not.toContain("email_deliveries");
    expect(handler).toContain("listing_generation_batches");
    expect(handler).toContain("listing_publish_batches");
  });

  it("the webhook and email families still have a home", () => {
    // They moved to the page that can replay them, not out of the product.
    const ops = read("services/edge-functions/src/routes/admin-ops.ts");
    expect(ops).toContain("webhook_dead_letters");
    expect(ops).toContain("email_deliveries");
  });
});
