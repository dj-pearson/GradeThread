import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe } from "../lib/http-errors.ts";
import { featureDisabledBody, isFeatureEnabled } from "../lib/feature-flags.ts";
import { isAiBudgetExhausted } from "../lib/ai-budget-gate.ts";
import { validateJson, z } from "../lib/validation.ts";
// US-9129: the validation and submit bodies moved to lib/grading-submit.ts so
// the connector's write tools can call the same money path. This route keeps
// its parsing, its guards and its exact response envelopes, and delegates.
import { buildValidation, submitItemsForGrading } from "../lib/grading-submit.ts";

// FlipDesk → GradeThread bridge.
// Submits inventory items to GradeThread for grading and receives webhook callbacks.
// Until the GradeThread Public API ships (Phase 2 of GradeThread roadmap), this
// can take a direct DB shortcut since both products share a Supabase instance.

type GradingEnv = {
  Variables: {
    userId: string;
    // Workspace owner — billing, item ownership, and submission tenant
    // all key off this. Equals userId for solo users.
    workspaceOwnerId: string;
    workspaceRole:
      | "viewer"
      | "member"
      | "listing_manager"
      | "admin"
      | "owner";
  };
};

export const flipdeskGradingRoutes = new Hono<GradingEnv>();



// Request schema for /validate and /submit (US-267). `.strict()` rejects any
// extra fields so nothing unexpected can ride into a service-role query.
const submitBodySchema = z.object({
  items: z
    .array(
      z
        .object({
          inventory_item_id: z.string().uuid({
            message: "inventory_item_id must be a UUID",
          }),
          tier: z.enum(["standard", "premium", "express"]),
        })
        .strict(),
    )
    .min(1, "items must be a non-empty array")
    .max(200, "a batch may contain at most 200 items"),
  // US-2564: the client's stable token for THIS bulk submit, derived from the
  // selection + tier so it survives a retry. Optional, so an older client keeps
  // working exactly as before — see bulkChargeKey() for why absent must mean
  // null and never "".
  //
  // `.nullish()`, not `.optional()`, and the difference is load-bearing across
  // three clients. `.optional()` accepts a MISSING key and rejects an explicit
  // `null`, and whether a client sends one or the other is a serializer setting
  // nobody thinks about: Android's kotlinx Json currently has
  // `explicitNulls = false` (so it omits), and a future flip of that flag would
  // 400 every single-item grade from the app with no CI able to catch it —
  // the edge suite does not run the mobile serializers. Accepting both makes the
  // contract independent of that setting. bulkChargeKey() already maps null,
  // undefined and blank to the same no-key behaviour.
  batch_key: z.string().trim().min(1).max(255).nullish(),
}).strict();

// Pre-flight validation. Returns per-item readiness + total cost + plan
// remaining without creating any records. UI calls this before /submit so
// it can grey-out unready items and warn about plan limits.
flipdeskGradingRoutes.post("/validate", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const parsed = await validateJson(c, submitBodySchema);
  if (!parsed.ok) {
    return c.json({ error: parsed.error, details: parsed.details }, parsed.status);
  }
  const result = await buildValidation(ownerId, parsed.data.items);
  if (!result.ok) {
    return c.json(
      { error: result.error, details: result.details },
      result.status as 400,
    );
  }
  return c.json(result.result);
});


flipdeskGradingRoutes.post("/submit", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const role = c.get("workspaceRole") ?? "owner";

  // Grading kill-switch + inline AI budget breach — block before any charge so
  // the FlipDesk grading entry can't keep spending after the budget tripped.
  // US-2406: owner-scoped so plan targeting / rollout is honoured.
  if (
    !(await isFeatureEnabled("grading", { userId: ownerId })) ||
    (await isAiBudgetExhausted("grading"))
  ) {
    return c.json(featureDisabledBody("grading"), 503);
  }

  if (role === "viewer") {
    return c.json(
      { error: "Viewers cannot submit grade requests in this workspace" },
      403,
    );
  }

  const parsed = await validateJson(c, submitBodySchema);
  if (!parsed.ok) {
    return c.json({ error: parsed.error, details: parsed.details }, parsed.status);
  }

  // US-9129: the body lives in lib/grading-submit.ts so the connector's write
  // tools can call the same money path instead of reimplementing it. The guards
  // above are repeated inside that function for callers that never come through
  // here; keeping them here too means this route's responses are unchanged.
  const outcome = await submitItemsForGrading(
    ownerId,
    role,
    parsed.data.items,
    parsed.data.batch_key,
  );
  if (!outcome.ok) return c.json(outcome.body, outcome.status as 400);

  return c.json({
    submitted: outcome.submitted,
    failed: outcome.failed,
    results: outcome.results,
  });
});

// Inbound webhook from GradeThread when a grade completes.
//
// In the consolidated build (FlipDesk + GradeThread share one Supabase),
// we sync directly from the grading-pipeline — see grading-pipeline.ts
// step 7c. This webhook receiver is reserved for Phase 2 when FlipDesk
// runs as a separate service consuming the GradeThread Public API.
flipdeskGradingRoutes.post("/webhook", (c) => {
  return c.json(
    {
      error:
        "Webhook receiver disabled — using same-process DB sync via grading-pipeline. Enable when GradeThread Public API ships (Phase 2).",
    },
    501,
  );
});

// Status lookup — used as polling fallback for the UI in case the
// pipeline write didn't reach the cache. Returns full state + the linked
// grade_report payload when the grade is complete.
flipdeskGradingRoutes.get("/submissions/:id", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const id = c.req.param("id");

  // Load the flipdesk_grading_submissions row + ownership-check via the
  // joined inventory_item.
  const { data: row, error } = await supabaseAdmin
    .from("flipdesk_grading_submissions")
    .select(
      "id, inventory_item_id, submission_id, tier, status, cost, submitted_at, graded_at, webhook_received_at, error, inventory_items!inner(user_id, title, grade_value, grade_label, grade_report_id, certificate_url)",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) {
    return failSafe(c, 500, "Lookup failed", error, "flipdesk-grading.status");
  }
  if (!row) {
    return c.json({ error: "Submission not found" }, 404);
  }
  const r = row as unknown as {
    id: string;
    inventory_item_id: string;
    submission_id: string | null;
    tier: string;
    status: string;
    cost: number;
    submitted_at: string | null;
    graded_at: string | null;
    webhook_received_at: string | null;
    error: string | null;
    inventory_items: {
      user_id: string;
      title: string | null;
      grade_value: number | null;
      grade_label: string | null;
      grade_report_id: string | null;
      certificate_url: string | null;
    };
  };
  if (r.inventory_items.user_id !== ownerId) {
    return c.json({ error: "Submission not found" }, 404);
  }

  // Fetch the grade report on demand so a polling-only UI can render
  // results without a second round-trip.
  const GRADE_REPORT_COLS =
    "id, overall_score, grade_tier, fabric_condition_score, structural_integrity_score, cosmetic_appearance_score, functional_elements_score, odor_cleanliness_score, ai_summary, confidence_score, certificate_id, created_at";
  let gradeReport: Record<string, unknown> | null = null;
  if (r.status === "completed" && r.inventory_items.grade_report_id) {
    const { data: gr } = await supabaseAdmin
      .from("grade_reports")
      .select(GRADE_REPORT_COLS)
      .eq("id", r.inventory_items.grade_report_id)
      .maybeSingle();
    if (gr) {
      gradeReport = gr as unknown as Record<string, unknown>;
    }
  } else if (r.status === "pending_review" && r.submission_id) {
    // Mandatory review: the grade is produced but the linked item isn't synced
    // to a grade_report_id until a human finalizes it, so resolve the active
    // (non-superseded) PRELIMINARY report by submission so the client can show
    // the provisional score alongside "submitted for human review".
    const { data: gr } = await supabaseAdmin
      .from("grade_reports")
      .select(GRADE_REPORT_COLS)
      .eq("submission_id", r.submission_id)
      .is("superseded_at", null)
      .maybeSingle();
    if (gr) {
      gradeReport = gr as unknown as Record<string, unknown>;
    }
  }

  return c.json({
    id: r.id,
    inventory_item_id: r.inventory_item_id,
    submission_id: r.submission_id,
    tier: r.tier,
    status: r.status,
    cost: r.cost,
    submitted_at: r.submitted_at,
    graded_at: r.graded_at,
    webhook_received_at: r.webhook_received_at,
    error: r.error,
    item: {
      title: r.inventory_items.title,
      grade_value: r.inventory_items.grade_value,
      grade_label: r.inventory_items.grade_label,
      certificate_url: r.inventory_items.certificate_url,
    },
    grade_report: gradeReport,
  });
});
