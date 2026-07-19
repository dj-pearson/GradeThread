import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { downloadItemPhoto } from "../lib/item-photo-storage.ts";
import { failSafe } from "../lib/http-errors.ts";
import { processSubmission } from "../lib/grading-pipeline.ts";
import { featureDisabledBody, isFeatureEnabled } from "../lib/feature-flags.ts";
import { isAiBudgetExhausted } from "../lib/ai-budget-gate.ts";
import { validateJson, z } from "../lib/validation.ts";
import {
  computeBatchCredits,
  effectivePlanFor,
  INCLUDED_STANDARD_PER_MONTH,
  runPaymentPrecedence,
  tierPriceDollars,
  type GradeTier,
} from "../lib/grade-billing.ts";

// Local alias keeps the existing interface names readable.
type GradingTier = GradeTier;

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

interface SubmitItemInput {
  inventory_item_id: string;
  tier: GradingTier;
}

interface ValidatedItem {
  inventory_item_id: string;
  tier: GradingTier;
  cost: number;
  ready: boolean;
  blockers: string[];
  // Echoed for the UI to render — picked from inventory_items.
  title: string | null;
  garment_type: string | null;
  garment_category: string | null;
  required_photo_types_missing: string[];
}

interface ValidationResult {
  user: {
    plan: string; // flipdesk_plan
    grades_used_this_month: number; // included-standard grades consumed
    plan_limit: number; // included-standard cap for the plan
    grades_remaining: number; // included remaining + affordable credit grades
    included_remaining: number; // included standard grades left this month
    credit_balance: number; // grade credit balance
  };
  items: ValidatedItem[];
  total_cost: number; // dollar value (display)
  credits_required: number; // credits needed for the batch after included coverage
  can_submit: boolean; // every item.ready AND the batch is payable
  limit_exceeded: boolean; // not enough included + credits to cover the batch
}

// FlipDesk photo types required for a grading submission. Only Front + Back
// are mandatory. The `tag` shot (GradeThread `label` image_type) still drives
// brand/material/size extraction and the grader uses it when present, but it
// is no longer required — many garments (e.g. Lululemon with a cut size label)
// have no readable tag, and the <0.75-confidence → human-review path already
// covers the weaker-signal case.
const REQUIRED_GRADING_PHOTO_TYPES = ["front", "back"] as const;

// The grading pipeline's image-quality gate (image-quality.ts) ABSTAINS unless
// at least one close-up "detail_*" shot is present — it's what lets the grader
// read the fabric weave/knit, which drives the fabric_condition factor (30% of
// the score). It is NOT a defect photo. We surface it as a pre-submission
// blocker here (rather than letting a "ready" item abstain post-submit) so the
// requirement is known BEFORE the round-trip. These FlipDesk photo types map to
// a grading `detail_*` image_type (see mapPhotoTypeForGrading) and satisfy it.
const FABRIC_CLOSEUP_PHOTO_TYPES = [
  "detail",
  "detail_2",
  "detail_3",
  "detail_4",
] as const;

// Pulls the user record + all items + photo coverage in one round-trip set,
// then computes per-item readiness. Used by both /validate (just returns the
// result) and /submit (in G2; refuses to proceed if can_submit is false).
/**
 * US-2019 — the grading-readiness rules, as a PURE function.
 *
 * These rules exist in two projects that cannot import each other: here (the
 * authority, used by /validate and /submit) and src/lib/grading-readiness.ts
 * (the web mirror, so the "Submit for grading" card can reflect readiness LIVE
 * off the edit form instead of round-tripping).
 *
 * The mirror is legitimate and unavoidable. What was NOT acceptable is that it
 * was held together by a comment ("The blocker STRINGS below are verbatim
 * copies of the server's"). Divergence is silent in BOTH directions and both
 * are bad: a client that says "ready" when the server disagrees sends a seller
 * into a rejection at submit time, and a client that says "not ready" when the
 * server would accept blocks them from paying us.
 *
 * Extracting it here lets both suites assert the SAME behavioural fixture
 * (src/test/fixtures/grading-readiness-cases.json) instead of trusting that two
 * hand-maintained copies stayed identical.
 *
 * The blocker strings are user-facing copy; the web card also regex-matches
 * them (`onlyGarmentBlocks`), so changing one is a cross-project change.
 */
export function gradingReadinessBlockers(input: {
  garment_type: string | null | undefined;
  garment_category: string | null | undefined;
  title: string | null | undefined;
  photoTypes: Set<string> | readonly string[];
}): { blockers: string[]; missingPhotos: string[] } {
  const have = input.photoTypes instanceof Set
    ? input.photoTypes
    : new Set(input.photoTypes);
  const blockers: string[] = [];
  const missingPhotos: string[] = [];

  if (!input.garment_type) blockers.push("Missing garment_type");
  if (!input.garment_category) blockers.push("Missing garment_category");
  if (!input.title || !input.title.trim()) blockers.push("Missing title");

  for (const t of REQUIRED_GRADING_PHOTO_TYPES) {
    if (!have.has(t)) missingPhotos.push(t);
  }
  if (missingPhotos.length > 0) {
    blockers.push(`Missing required photos: ${missingPhotos.join(", ")}`);
  }
  // Mirror the grading gate's fabric close-up requirement up front so a
  // "ready" item doesn't abstain after submission (see FABRIC_CLOSEUP note).
  if (!FABRIC_CLOSEUP_PHOTO_TYPES.some((t) => have.has(t))) {
    blockers.push(
      "Add one fabric close-up (a detail photo of the weave/knit or a seam) — it's what we grade the fabric from, not a defect shot.",
    );
  }

  return { blockers, missingPhotos };
}

async function buildValidation(
  ownerId: string,
  inputs: SubmitItemInput[],
): Promise<
  | { ok: true; result: ValidationResult }
  | { ok: false; status: number; error: string; details?: unknown }
> {
  if (inputs.length === 0) {
    return { ok: false, status: 400, error: "items must be a non-empty array" };
  }

  const { data: userRow, error: userErr } = await supabaseAdmin
    .from("users")
    .select(
      "flipdesk_plan, subscription_status, trial_ends_at, grades_used_this_month, grade_reset_at, grade_credit_balance, suspended",
    )
    .eq("id", ownerId)
    .maybeSingle();
  if (userErr || !userRow) {
    return { ok: false, status: 404, error: "User not found" };
  }
  const user = userRow as {
    flipdesk_plan: string;
    subscription_status: string | null;
    trial_ends_at: string | null;
    grades_used_this_month: number;
    grade_reset_at: string;
    grade_credit_balance: number;
    suspended: boolean;
  };
  if (user.suspended) {
    return {
      ok: false,
      status: 403,
      error:
        "Your account is suspended and cannot submit for grading. Contact support.",
    };
  }

  // Mirror runPaymentPrecedence: included standard grades come from the plan's
  // monthly bundle (Standard tier only); everything else is paid with credits.
  // We compute "as if" here — /submit charges atomically via the shared path.
  const effectivePlan = effectivePlanFor(
    user.flipdesk_plan,
    user.subscription_status,
    user.trial_ends_at,
  );
  const includedCap = INCLUDED_STANDARD_PER_MONTH[effectivePlan] ?? 0;
  const resetAt = new Date(user.grade_reset_at).getTime();
  const usedThisMonth = resetAt <= Date.now() ? 0 : user.grades_used_this_month;
  const includedRemaining = Math.max(0, includedCap - usedThisMonth);
  const creditBalance = user.grade_credit_balance ?? 0;

  const itemIds = Array.from(
    new Set(inputs.map((i) => i.inventory_item_id)),
  );

  const { data: itemsRaw, error: itemsErr } = await supabaseAdmin
    .from("inventory_items")
    .select("id, user_id, title, garment_type, garment_category, brand, description")
    .in("id", itemIds);
  if (itemsErr) {
    return {
      ok: false,
      status: 500,
      error: "Failed to load items",
      details: itemsErr.message,
    };
  }
  const itemMap = new Map<
    string,
    {
      id: string;
      user_id: string;
      title: string | null;
      garment_type: string | null;
      garment_category: string | null;
      brand: string | null;
      description: string | null;
    }
  >();
  for (const row of (itemsRaw ?? []) as Array<{
    id: string;
    user_id: string;
    title: string | null;
    garment_type: string | null;
    garment_category: string | null;
    brand: string | null;
    description: string | null;
  }>) {
    itemMap.set(row.id, row);
  }

  // Photo coverage — one query covering all items.
  const { data: photosRaw } = await supabaseAdmin
    .from("item_photos")
    .select("inventory_item_id, photo_type")
    .in("inventory_item_id", itemIds);
  const photoTypesByItem = new Map<string, Set<string>>();
  for (const p of (photosRaw ?? []) as Array<{
    inventory_item_id: string;
    photo_type: string;
  }>) {
    let s = photoTypesByItem.get(p.inventory_item_id);
    if (!s) {
      s = new Set();
      photoTypesByItem.set(p.inventory_item_id, s);
    }
    s.add(p.photo_type);
  }

  const items: ValidatedItem[] = inputs.map((input) => {
    const item = itemMap.get(input.inventory_item_id);
    const blockers: string[] = [];
    const missingPhotos: string[] = [];

    if (!item) {
      blockers.push("Item not found");
    } else if (item.user_id !== ownerId) {
      blockers.push("Item not found");
    } else {
      // US-2019: the readiness rules are computed by a PURE, EXPORTED helper so
      // the web mirror (src/lib/grading-readiness.ts) can assert the identical
      // behaviour against a shared fixture. Previously both sides implemented
      // the rules independently and were kept aligned by a comment.
      const have = photoTypesByItem.get(input.inventory_item_id) ?? new Set();
      const computed = gradingReadinessBlockers({
        garment_type: item.garment_type,
        garment_category: item.garment_category,
        title: item.title,
        photoTypes: have,
      });
      blockers.push(...computed.blockers);
      missingPhotos.push(...computed.missingPhotos);
    }

    return {
      inventory_item_id: input.inventory_item_id,
      tier: input.tier,
      cost: tierPriceDollars(input.tier),
      ready: blockers.length === 0,
      blockers,
      title: item?.title ?? null,
      garment_type: item?.garment_type ?? null,
      garment_category: item?.garment_category ?? null,
      required_photo_types_missing: missingPhotos,
    };
  });

  // Credits the batch needs after included-standard coverage (Standard-only,
  // cheapest-first — matches runPaymentPrecedence run per item).
  const readyItems = items.filter((i) => i.ready);
  const creditsRequired = computeBatchCredits(
    includedRemaining,
    readyItems.map((i) => i.tier),
  );

  const totalCost = items.reduce((acc, i) => acc + i.cost, 0);
  const affordable = creditBalance >= creditsRequired;
  const canSubmit = items.length > 0 && items.every((i) => i.ready) && affordable;

  return {
    ok: true,
    result: {
      user: {
        plan: user.flipdesk_plan,
        grades_used_this_month: usedThisMonth,
        plan_limit: includedCap,
        // "Grades left" proxy for the UI: included remaining + how many more
        // standard grades the credit balance covers (1 credit = 1 standard).
        grades_remaining: includedRemaining + creditBalance,
        included_remaining: includedRemaining,
        credit_balance: creditBalance,
      },
      items,
      total_cost: Number(totalCost.toFixed(2)),
      credits_required: creditsRequired,
      can_submit: canSubmit,
      limit_exceeded: !affordable,
    },
  };
}

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

// Maps a FlipDesk photo type to the GradeThread submission_images image_type.
// Returns null for photos that aren't useful for grading (interior/flatlay/on_model).
function mapPhotoTypeForGrading(t: string): string | null {
  if (t === "front") return "front";
  if (t === "back") return "back";
  if (t === "tag") return "label";
  if (t === "tag_2") return "label_2";
  // detail_2..4 and the measurement_* shots are valid grading image_types too,
  // so carry them through 1:1 — measurements help the grader establish size.
  if (
    t === "detail" || t === "detail_2" || t === "detail_3" || t === "detail_4"
  ) {
    return t;
  }
  if (t === "defect") return "defect";
  if (t.startsWith("measurement_")) return t;
  return null;
}

// Submit one or many inventory items for grading.
// Body: { items: Array<{ inventory_item_id: string; tier: "standard" | "premium" | "express" }> }
//
// For each item:
//   1. Create a `submissions` row with metadata copied from inventory_items
//   2. Copy eligible item_photos → submission-images bucket (new path)
//   3. Insert `submission_images` rows
//   4. Insert `flipdesk_grading_submissions` linking the two
//   5. Increment user grade counter
//   6. Fire processSubmission() async (status flips pending → processing → completed)
//
// Returns a per-item result: success rows include submission_id + cost;
// failed rows include the blocker. Partial success is normal — failing
// items don't block successful ones.
flipdeskGradingRoutes.post("/submit", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const role = c.get("workspaceRole") ?? "owner";

  // Grading kill-switch + inline AI budget breach — block before any charge so
  // the FlipDesk grading entry can't keep spending after the budget tripped.
  if (!(await isFeatureEnabled("grading")) || (await isAiBudgetExhausted("grading"))) {
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

  const validation = await buildValidation(ownerId, parsed.data.items);
  if (!validation.ok) {
    return c.json(
      { error: validation.error, details: validation.details },
      validation.status as 400,
    );
  }
  if (!validation.result.can_submit) {
    return c.json(
      {
        error: validation.result.limit_exceeded
          ? "Not enough grading credits to cover this batch. Buy a credit pack or upgrade your plan."
          : "One or more items are not ready for grading. Call /validate for per-item blockers.",
        validation: validation.result,
      },
      422,
    );
  }

  type SubmitResult =
    | {
        ok: true;
        inventory_item_id: string;
        submission_id: string;
        flipdesk_grading_submission_id: string;
        tier: GradingTier;
        cost: number;
      }
    | {
        ok: false;
        inventory_item_id: string;
        error: string;
      };

  const results: SubmitResult[] = [];
  let successfullySubmitted = 0;

  // US-2024: batch-load everything the loop needs, ONCE.
  //
  // This loop previously re-queried inventory_items and item_photos PER ITEM —
  // a straight N+1, and a regression against buildValidation() in this same
  // file, which already loads photo coverage for the whole batch in one
  // `.in(itemIds)` (see "Photo coverage — one query covering all items" above).
  // At the schema cap of 200 items that was ~400 avoidable sequential round
  // trips on top of the writes, and the loop CHARGES CREDITS partway through:
  // every second spent on avoidable I/O widens the window in which an edge
  // timeout leaves a partially-charged batch that the catch-block compensation
  // cannot cover (it handles a THROWN error; a killed isolate throws nothing).
  // Shrinking the window is not the whole fix for that, but it is the half that
  // is safe to do here.
  const batchItemIds = validation.result.items.map((i) => i.inventory_item_id);
  const [batchItemsRes, batchPhotosRes] = await Promise.all([
    supabaseAdmin
      .from("inventory_items")
      .select("id, user_id, title, brand, description, garment_type, garment_category")
      .in("id", batchItemIds)
      // US-268: scope by owner here too. The per-item ownership assertion below
      // is kept as defence in depth, but filtering server-side means a foreign
      // id simply never enters the map.
      .eq("user_id", ownerId),
    supabaseAdmin
      .from("item_photos")
      .select("inventory_item_id, photo_type, storage_path, sort_order")
      .in("inventory_item_id", batchItemIds)
      .not("storage_path", "is", null)
      .order("sort_order", { ascending: true }),
  ]);

  type BatchItem = {
    id: string;
    user_id: string;
    title: string | null;
    brand: string | null;
    description: string | null;
    garment_type: string;
    garment_category: string;
  };
  const itemById = new Map<string, BatchItem>();
  for (const row of (batchItemsRes.data ?? []) as BatchItem[]) {
    itemById.set(row.id, row);
  }
  type BatchPhoto = {
    inventory_item_id: string;
    photo_type: string | null;
    storage_path: string | null;
    sort_order: number | null;
  };
  const photosByItem = new Map<string, BatchPhoto[]>();
  // The query is ordered by sort_order, and pushing in iteration order
  // preserves that per item — the loop below relies on it (detail_1/2/3 must
  // land in a sensible order in the submission).
  for (const row of (batchPhotosRes.data ?? []) as BatchPhoto[]) {
    const arr = photosByItem.get(row.inventory_item_id) ?? [];
    arr.push(row);
    photosByItem.set(row.inventory_item_id, arr);
  }

  for (const item of validation.result.items) {
    const tier = item.tier;
    const cost = item.cost;
    // Tracked across the try so the catch can compensate a charge if a later
    // step (photo copy, link insert) fails after the grade was already paid.
    let submissionId = "";
    let charged = false;
    try {
      // US-2024: from the batch map (was a per-item query). buildValidation
      // only selected readiness fields, so the full row is still needed for
      // brand/description on the submission insert.
      const it = itemById.get(item.inventory_item_id);
      if (!it) {
        throw new Error("Item lookup failed");
      }
      if (it.user_id !== ownerId) throw new Error("Item ownership mismatch");

      // 1. Create submissions row (keyed on workspace owner so all members see it).
      const { data: subInsert, error: subErr } = await supabaseAdmin
        .from("submissions")
        .insert({
          user_id: ownerId,
          garment_type: it.garment_type,
          garment_category: it.garment_category,
          title: (it.title ?? "").trim() || "Untitled item",
          brand: it.brand,
          description: it.description,
          status: "pending",
          payment_status: "unpaid",
        })
        .select("id")
        .single();
      if (subErr || !subInsert) {
        throw new Error(`Submission create failed: ${subErr?.message}`);
      }
      submissionId = (subInsert as { id: string }).id;

      // 1b. Charge through the shared payment precedence (included → credits).
      //     Batch validation already confirmed the owner can afford this, but
      //     a concurrent submission could have drained credits in between, so
      //     handle the checkout-required case per item.
      const precedence = await runPaymentPrecedence(ownerId, submissionId, tier);
      if (!precedence.paid) {
        // Nothing was charged — drop the empty submission and report it.
        await supabaseAdmin.from("submissions").delete().eq("id", submissionId);
        submissionId = "";
        results.push({
          ok: false,
          inventory_item_id: item.inventory_item_id,
          error:
            `Payment required for ${tier} grade — not enough grading credits. ` +
            `Buy a credit pack or upgrade your plan.`,
        });
        continue;
      }
      charged = true;

      // 2. Load item photos eligible for grading (sort_order ascending so
      //    detail_1/2/3 land in a sensible order in the submission too).
      // US-2024: from the batch map (was a per-item query), already filtered to
      // non-null storage_path and ordered by sort_order.
      const photos = photosByItem.get(it.id) ?? [];

      const eligible = ((photos ?? []) as Array<{
        photo_type: string;
        storage_path: string;
        sort_order: number;
      }>)
        .map((p) => ({
          ...p,
          submission_image_type: mapPhotoTypeForGrading(p.photo_type),
        }))
        .filter(
          (p): p is typeof p & { submission_image_type: string } =>
            p.submission_image_type !== null,
        );

      // 3. Copy each eligible photo into submission-images
      const imageRecords: Array<{
        submission_id: string;
        image_type: string;
        storage_path: string;
        display_order: number;
      }> = [];
      for (let i = 0; i < eligible.length; i++) {
        const photo = eligible[i]!;
        const dl = await downloadItemPhoto(
          photo.storage_path,
          photo.photo_type,
        );
        if ("error" in dl) {
          throw new Error(`Failed to copy photo for grading: ${dl.error}`);
        }
        const blob = dl.blob;
        const arrayBuf = await blob.arrayBuffer();
        const ext =
          photo.storage_path.split(".").pop()?.toLowerCase() || "webp";
        const newPath = `${ownerId}/${submissionId}/${photo.submission_image_type}_${i}.${ext}`;
        const { error: upErr } = await supabaseAdmin.storage
          .from("submission-images")
          .upload(newPath, new Uint8Array(arrayBuf), {
            upsert: false,
            contentType: blob.type || "image/webp",
          });
        if (upErr) {
          throw new Error(
            `Failed to upload photo to submission bucket: ${upErr.message}`,
          );
        }
        imageRecords.push({
          submission_id: submissionId,
          image_type: photo.submission_image_type,
          storage_path: newPath,
          display_order: i,
        });
      }

      const { error: imgInsertErr } = await supabaseAdmin
        .from("submission_images")
        .insert(imageRecords);
      if (imgInsertErr) {
        throw new Error(
          `Failed to record submission images: ${imgInsertErr.message}`,
        );
      }

      // 4. Link via flipdesk_grading_submissions
      const { data: fdInsert, error: fdErr } = await supabaseAdmin
        .from("flipdesk_grading_submissions")
        .insert({
          inventory_item_id: it.id,
          submission_id: submissionId,
          tier,
          status: "pending",
          cost,
          submitted_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (fdErr || !fdInsert) {
        throw new Error(`Link create failed: ${fdErr?.message}`);
      }
      const fdId = (fdInsert as { id: string }).id;

      // 5. Mark the item as in-grading + link it to the submission so the
      //    grading-pipeline's inventory_items sync (see grading-pipeline.ts
      //    step 7b) writes back grade_value/grade_label/grade_report_id
      //    when the AI completes.
      await supabaseAdmin
        .from("inventory_items")
        .update({ status: "grading", submission_id: submissionId })
        .eq("id", it.id);

      // 6. Flip submission to processing and fire-and-forget pipeline.
      await supabaseAdmin
        .from("submissions")
        .update({ status: "processing" })
        .eq("id", submissionId);
      processSubmission(submissionId).catch((err) => {
        console.error(
          `[flipdesk-grading] pipeline failed for ${submissionId}:`,
          err instanceof Error ? err.message : String(err),
        );
      });

      successfullySubmitted++;
      results.push({
        ok: true,
        inventory_item_id: it.id,
        submission_id: submissionId,
        flipdesk_grading_submission_id: fdId,
        tier,
        cost,
      });
    } catch (err) {
      // If the grade was already charged before this step failed, reverse it
      // so the customer isn't billed for a submission that never ran. The
      // refund_grade RPC is idempotent.
      if (charged && submissionId) {
        try {
          await supabaseAdmin.rpc("refund_grade", {
            p_submission_id: submissionId,
          });
        } catch (refundErr) {
          console.error(
            `[flipdesk-grading] refund failed for ${submissionId} — manual review needed:`,
            refundErr instanceof Error ? refundErr.message : String(refundErr),
          );
        }
      }
      results.push({
        ok: false,
        inventory_item_id: item.inventory_item_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Note: the included-grade counter and credit balance are debited atomically
  // per item by runPaymentPrecedence above — no separate counter bump here.

  return c.json({
    submitted: successfullySubmitted,
    failed: results.length - successfullySubmitted,
    results,
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
