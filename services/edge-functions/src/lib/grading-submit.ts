// US-9129: the grading submit path, as a library.
//
// It lived inside the POST /api/flipdesk/grading/submit handler, which is
// behind JWT auth. The connector authenticates with an API KEY, so a tool could
// not reach it: not by an internal fetch (there is no JWT to forge) and not by
// Hono's app.request() (context Variables do not cross it). Every write tool
// after this one would otherwise have reimplemented a money path.
//
// This is a MOVE. The route keeps its request parsing and its exact response
// envelopes; the guards it checked (grading flag, AI budget, viewer role) are
// checked HERE instead, because a caller that reaches this function without
// going through the route must not skip them. The route's own checks stay where
// they were, so its behaviour and its error bodies are byte-identical: the
// duplicate is deliberate and it is defence in depth, not an oversight.
//
// ⚠ THIS CHARGES CREDITS PARTWAY THROUGH A BATCH. Read US-2024 (batch-loading,
// and why the window matters when a killed isolate throws nothing), US-773
// (the stranded-paid re-kick that covers the case the catch block cannot) and
// US-2564 (per-item idempotency keys) before changing a line of the loop.

import { supabaseAdmin } from "./supabase.ts";
import { downloadItemPhoto } from "./item-photo-storage.ts";
import { processSubmission } from "./grading-pipeline.ts";
import { REQUIRED_IMAGE_TYPES } from "./image-quality.ts";
import { featureDisabledBody, isFeatureEnabled } from "./feature-flags.ts";
import { isAiBudgetExhausted } from "./ai-budget-gate.ts";
import {
  bulkChargeKey,
  computeBatchCredits,
  effectivePlanFor,
  INCLUDED_STANDARD_PER_MONTH,
  runPaymentPrecedence,
  tierPriceDollars,
  type GradeTier,
} from "./grade-billing.ts";

// Local alias keeps the existing interface names readable.
type GradingTier = GradeTier;

/** The workspace roles the submit path cares about. */
export type WorkspaceRole = "viewer" | "member" | "listing_manager" | "admin" | "owner";

/**
 * What the caller should return.
 *
 * Refusals carry the status and body the route has always sent, so delegating
 * cannot change a single byte of what an existing client sees.
 */
export type SubmitOutcome =
  | { ok: false; status: number; body: Record<string, unknown> }
  | {
    ok: true;
    submitted: number;
    failed: number;
    results: SubmitResult[];
  };

export type SubmitResult =
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

export interface SubmitItemInput {
  inventory_item_id: string;
  tier: GradingTier;
}

export interface ValidatedItem {
  inventory_item_id: string;
  tier: GradingTier;
  cost: number;
  ready: boolean;
  blockers: string[];
  // US-2397: things the seller should know before submitting that do NOT stop
  // the submission. `ready` deliberately ignores these — a warning that blocks
  // is just a blocker with softer wording.
  warnings: string[];
  // Echoed for the UI to render — picked from inventory_items.
  title: string | null;
  garment_type: string | null;
  garment_category: string | null;
  required_photo_types_missing: string[];
}

export interface ValidationResult {
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

/**
 * The inverse of {@link mapPhotoTypeForGrading}, for the required-photo list.
 *
 * US-2304: only the two names that actually differ are listed. Everything else
 * is the same string on both sides, and spelling out an identity mapping would
 * invite it to drift into something that is not one.
 *
 * MUST be declared ABOVE REQUIRED_GRADING_PHOTO_TYPES. That list is built at
 * module load, and a `const` declared later is still in its temporal dead
 * zone then — the edge crashed at import until this moved up. A function
 * declaration hoists; the map it reads does not.
 *
 * Exported so the parity test can assert the round trip rather than trusting
 * this table — a wrong entry here would make the requirement lists agree on
 * paper while asking the seller for a photo type that does not exist.
 */
const GRADING_TO_PHOTO_TYPE: Record<string, string> = {
  label: "tag",
  label_2: "tag_2",
};

export function gradingImageTypeToPhotoType(imageType: string): string {
  return GRADING_TO_PHOTO_TYPE[imageType] ?? imageType;
}

// FlipDesk photo types required for a grading submission.
//
// US-2304 (owner's call, 2026-08-03): the `tag` shot is REQUIRED, and this list
// is DERIVED from the grading gate rather than written out, because the two
// disagreeing is the whole defect.
//
// The comment that used to sit here said Front + Back were enough because "the
// <0.75-confidence → human-review path already covers the weaker-signal case".
// That premise was false. image-quality.ts lists `label` in REQUIRED_IMAGE_TYPES
// at severity `block`, and grading-pipeline.ts applies it at Step 4b — which
// runs BEFORE any confidence scoring. So the review path it named never
// executed. What actually happened to a FlipDesk item with no tag photo:
// charged, one Claude Vision call per image, abstain to needs_photos, refund.
// The money came back and the AI spend did not, every single time, and the
// seller round-tripped to be told something we could have told them up front.
//
// Requiring it here is therefore strictly better for the SAME seller the old
// comment was written to protect: a garment with no readable tag is refused at
// the point of submission instead of after payment and a full vision run.
//
// ⚠ The concern in that old comment is real and is NOT resolved by this: some
// garments (Lululemon cut size labels, tagless resale) genuinely have no
// readable tag. That is a product question about what those sellers photograph,
// deliberately left open rather than settled by loosening a grading gate.
export const REQUIRED_GRADING_PHOTO_TYPES = REQUIRED_IMAGE_TYPES.map(
  gradingImageTypeToPhotoType,
);

// A close-up "detail_*" shot is what lets the grader read the fabric weave/knit,
// which drives fabric_condition — 30% of the score, the heaviest factor. It is
// NOT a defect photo. These FlipDesk photo types map to a grading `detail_*`
// image_type (see mapPhotoTypeForGrading) and satisfy it.
//
// US-2397: this used to be a hard blocker here, mirroring an ABSTAIN in
// image-quality.ts. Both are now warnings: a seller with solid front/back/label
// coverage and nothing tagged Detail gets their grade. The cost is stated up
// front rather than discovered later — the grade is capped below the review
// threshold and a human checks it (NO_FABRIC_CLOSEUP_CONFIDENCE_CAP). Supply a
// close-up and nothing about grading changes.
const FABRIC_CLOSEUP_PHOTO_TYPES = [
  "detail",
  "detail_2",
  "detail_3",
  "detail_4",
] as const;

// User-facing copy, kept verbatim in the web mirror (src/lib/grading-readiness.ts)
// and asserted by src/test/fixtures/grading-readiness-cases.json.
export const FABRIC_CLOSEUP_WARNING =
  "No fabric close-up, so a person will check this grade before it is final. Add a detail photo of the weave/knit or a seam for a faster, more certain grade. This isn't a defect shot.";

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
/**
 * US-2467: does this photo set contain an actual fabric close-up?
 *
 * VERBATIM behavioural mirror of `hasFabricCloseup` in
 * src/lib/grading-readiness.ts — the shared fixture
 * (src/test/fixtures/grading-readiness-cases.json) asserts both sides agree.
 *
 * Before roles this could only ask "is any Detail slot filled", so four photos
 * of buttons passed and dodged NO_FABRIC_CLOSEUP_CONFIDENCE_CAP while a real
 * fabric macro tagged "Detail 3" counted only by luck. fabric_condition is 30%
 * of the score, so this was an accuracy hole, not a tidiness one.
 *
 * `have` may hold bare types ("detail") and/or role-qualified slots
 * ("detail:fabric", and "detail:" for a detail carrying NO role):
 *
 *   1. An explicit fabric close-up always counts.
 *   2. An explicitly unqualified detail counts — the seller never said what it
 *      was and it may be the weave. Deliberately the same benefit of the doubt
 *      the old rule gave, so no historical item is retro-capped.
 *   3. A role-blind caller (legacy rows, the fixture, an older client) is
 *      recognised by having details but no qualified slot, and keeps the old
 *      behavior.
 *
 * Only one case changes: a detail set where EVERY photo is qualified as
 * something other than fabric no longer counts. That is the case the old rule
 * got wrong.
 */
export function hasFabricCloseup(have: Set<string>): boolean {
  if (have.has("detail:fabric")) return true;
  if (have.has("detail:")) return true;

  const details = [...have].filter(
    (s) =>
      s === "detail" ||
      s.startsWith("detail:") ||
      (FABRIC_CLOSEUP_PHOTO_TYPES as readonly string[]).includes(s),
  );
  if (details.length === 0) return false;
  const qualified = details.filter((s) => s.startsWith("detail:") && s !== "detail:");
  return qualified.length === 0;
}

export function gradingReadinessBlockers(input: {
  garment_type: string | null | undefined;
  garment_category: string | null | undefined;
  title: string | null | undefined;
  photoTypes: Set<string> | readonly string[];
}): { blockers: string[]; warnings: string[]; missingPhotos: string[] } {
  const have = input.photoTypes instanceof Set
    ? input.photoTypes
    : new Set(input.photoTypes);
  const blockers: string[] = [];
  const warnings: string[] = [];
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
  // A WARNING, not a blocker (owner's call, 2026-08-03). It still tells the
  // seller what they give up, because the consequence is real and they should
  // learn it BEFORE they submit, not from a slower grade afterwards.
  if (!hasFabricCloseup(have)) {
    warnings.push(FABRIC_CLOSEUP_WARNING);
  }

  return { blockers, warnings, missingPhotos };
}

// US-9114: exported so the connector's readiness tool answers with the SAME
// validation the submit path uses - blockers, warnings, tier, cost and whether
// credits cover the batch. A second opinion about readiness is a second answer
// to "can I grade this", and the seller would get whichever one they asked.
export async function buildValidation(
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

  // Photo coverage — one query covering all items. US-2200: scope to items the
  // caller actually owns (verified via itemMap.user_id === ownerId) rather than
  // the raw request ids. Defense-in-depth: results are only consumed inside the
  // ownership-gated branch below, but this keeps item_photos reads tenant-scoped
  // via the owner-verified parent so a future refactor can't leak foreign rows.
  const ownedItemIds = itemIds.filter(
    (id) => itemMap.get(id)?.user_id === ownerId,
  );
  const { data: photosRaw } = ownedItemIds.length
    ? await supabaseAdmin
        .from("item_photos")
        .select("inventory_item_id, photo_type, photo_role")
        .in("inventory_item_id", ownedItemIds)
    : {
      data: [] as Array<
        { inventory_item_id: string; photo_type: string; photo_role: string | null }
      >,
    };
  const photoTypesByItem = new Map<string, Set<string>>();
  for (const p of (photosRaw ?? []) as Array<{
    inventory_item_id: string;
    photo_type: string;
    photo_role: string | null;
  }>) {
    let s = photoTypesByItem.get(p.inventory_item_id);
    if (!s) {
      s = new Set();
      photoTypesByItem.set(p.inventory_item_id, s);
    }
    // US-2467: BOTH the bare type and the role-qualified slot. The bare type
    // keeps the required-photo checks working (a tag is a tag whatever role it
    // carries); the qualified slot is what lets the fabric check tell a weave
    // close-up from a button close-up. A role-less photo contributes
    // "<type>:" so "unqualified" is distinguishable from "unknown".
    s.add(p.photo_type);
    s.add(`${p.photo_type}:${p.photo_role ?? ""}`);
  }

  const items: ValidatedItem[] = inputs.map((input) => {
    const item = itemMap.get(input.inventory_item_id);
    const blockers: string[] = [];
    const warnings: string[] = [];
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
      warnings.push(...computed.warnings);
      missingPhotos.push(...computed.missingPhotos);
    }

    // US-9112/US-9114: echo the item's fields ONLY when the caller owns it.
    //
    // These used to read `item?.title` straight off the row, which the query
    // above fetches by id with no tenant filter — so validating another
    // tenant's item id returned "Item not found" in `blockers` AND that item's
    // title, garment_type and garment_category in the same object. The blocker
    // made it look handled. Found by the connector's readiness tool hitting the
    // tenant-isolation lane, but the hole is on POST
    // /api/flipdesk/grading/validate too and is reachable by any authenticated
    // user with a guessed id.
    //
    // The ownership test is repeated rather than hoisted into a flag on
    // purpose: this is the line that leaked, and it should be obvious at the
    // point of use what makes it safe.
    const owned = item !== undefined && item.user_id === ownerId;

    return {
      inventory_item_id: input.inventory_item_id,
      tier: input.tier,
      cost: tierPriceDollars(input.tier),
      ready: blockers.length === 0,
      blockers,
      warnings,
      title: owned ? item.title : null,
      garment_type: owned ? item.garment_type : null,
      garment_category: owned ? item.garment_category : null,
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

// The five tape-measure dimensions that have their own `image_type` enum value
// (00103). A `measurement` photo whose role is one of these is the same shot the
// retired `measurement_chest` type used to name, so it keeps that enum value and
// nothing about a historical submission changes shape.
const LEGACY_MEASUREMENT_IMAGE_ROLES = new Set([
  "chest",
  "waist",
  "length",
  "sleeve",
  "inseam",
]);

/**
 * Maps a FlipDesk (photo_type, photo_role) pair onto the grading
 * `submission_images` (image_type, image_role) pair. Returns null for photos
 * that aren't useful for grading (interior/flatlay/on_model).
 *
 * US-2471: this used to take the type alone, and US-2462's backfill broke it.
 * That migration rewrote `measurement_chest` → (`measurement`, `chest`), and
 * `measurement` on its own is the MeasureCard calibration frame, which 00346
 * excludes from grading on purpose. So every tape-measure photo started
 * resolving to null and silently stopped reaching the grader — the role is what
 * tells the two apart, and there was nowhere to read it.
 *
 * The role is carried through rather than folded into the type, because
 * `image_type` is a Postgres enum the photo-tags epic deliberately stopped
 * growing. A `tag` shot is `label` whether it holds the brand or the size; which
 * one it holds is `image_role`, and that is what ai-extract reads.
 */
export function mapPhotoTypeForGrading(
  t: string,
  role?: string | null,
): { imageType: string; imageRole: string | null } | null {
  const pair = (imageType: string, imageRole: string | null = role ?? null) => ({
    imageType,
    imageRole,
  });

  if (t === "front") return pair("front", null);
  if (t === "back") return pair("back", null);
  if (t === "tag") return pair("label");
  // Retired by 00587; historical rows and the round-trip test still name it.
  if (t === "tag_2") return pair("label_2", null);
  if (t === "detail") return pair("detail");
  if (t === "detail_2" || t === "detail_3" || t === "detail_4") {
    return pair(t, null);
  }
  if (t === "defect") return pair("defect", null);
  // Retired by 00587, same as above: the type already names the dimension, so
  // hand it on as the role too and the prompt site only has to speak roles.
  if (t.startsWith("measurement_")) {
    return pair(t, t.slice("measurement_".length));
  }
  if (t === "measurement") {
    // No role = the MeasureCard calibration frame. It is a branded foreign
    // object next to the garment, not evidence about the garment.
    if (!role) return null;
    // A dimension outside the five has no `image_type` to land in, and inventing
    // one would restart the enum growth this epic ended. Those roles are new
    // slots that never reached the grader before either, so nothing regresses.
    if (!LEGACY_MEASUREMENT_IMAGE_ROLES.has(role)) return null;
    return pair(`measurement_${role}`, role);
  }
  return null;
}

/**
 * Submit one or many inventory items for grading.
 *
 * For each item:
 *   1. Create a `submissions` row with metadata copied from inventory_items
 *   2. Copy eligible item_photos into the submission-images bucket
 *   3. Insert `submission_images` rows
 *   4. Insert `flipdesk_grading_submissions` linking the two
 *   5. Mark the item as in-grading
 *   6. Fire processSubmission() async
 *
 * Partial success is normal: failing items do not block successful ones.
 */
export async function submitItemsForGrading(
  ownerId: string,
  role: WorkspaceRole,
  items: SubmitItemInput[],
  batchKey?: string | null,
): Promise<SubmitOutcome> {
  // The same three guards the route applies, applied again here because a
  // caller arriving through anything other than the route (the connector's
  // tools, a future job) would otherwise skip all three: the grading kill
  // switch, the AI budget breach, and the viewer floor. Blocking before any
  // charge is the point of the first two.
  if (
    !(await isFeatureEnabled("grading", { userId: ownerId })) ||
    (await isAiBudgetExhausted("grading"))
  ) {
    return { ok: false, status: 503, body: featureDisabledBody("grading") };
  }
  if (role === "viewer") {
    return {
      ok: false,
      status: 403,
      body: { error: "Viewers cannot submit grade requests in this workspace" },
    };
  }

  const validation = await buildValidation(ownerId, items);
  if (!validation.ok) {
    return {
      ok: false,
      status: validation.status,
      body: { error: validation.error, details: validation.details },
    };
  }
  if (!validation.result.can_submit) {
    return {
      ok: false,
      status: 422,
      body: {
        error: validation.result.limit_exceeded
          ? "Not enough grading credits to cover this batch. Buy a credit pack or upgrade your plan."
          : "One or more items are not ready for grading. Call /validate for per-item blockers.",
        validation: validation.result,
      },
    };
  }

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
  //
  // US-2024 AC4 — WHAT COVERS THE KILLED-ISOLATE CASE (it is not this file).
  // The in-request catch below genuinely cannot help: an isolate kill runs no
  // JS. Recovery happens OUT of the request, in the stuck-submission cron:
  // a batch item killed after the charge leaves status='pending' + payment
  // satisfied + grading_started_at NULL, which is exactly the signature
  // recoverAbandonedCheckouts()'s findStrandedPaid selects and re-kicks
  // (lib/stuck-submissions.ts, US-773). If the crash landed before the photo
  // copy, the re-kick throws "No images found", the row lands in 'processing',
  // and recoverStuckSubmissions() retries it up to GRADING_MAX_ATTEMPTS before
  // failing + refunding it — so the chain terminates in the seller's money
  // coming back rather than looping. Pinned by the US-2024 cases in
  // src/tests/abandoned-checkout_test.ts; do not add a fourth mechanism here
  // without checking that one first.
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
      .select("inventory_item_id, photo_type, photo_role, storage_path, sort_order")
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
    photo_role: string | null;
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
      // US-2564: keyed on the CLIENT's batch token plus the item, so a retried
      // batch charges once per garment instead of once per attempt. Null when no
      // batch_key was sent, which is the pre-US-2564 behaviour exactly.
      const precedence = await runPaymentPrecedence(
        ownerId,
        submissionId,
        tier,
        bulkChargeKey(batchKey, item.inventory_item_id),
      );
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
        photo_role: string | null;
        storage_path: string;
        sort_order: number;
      }>)
        .map((p) => ({
          ...p,
          grading: mapPhotoTypeForGrading(p.photo_type, p.photo_role),
        }))
        .filter(
          (
            p,
          ): p is typeof p & {
            grading: { imageType: string; imageRole: string | null };
          } => p.grading !== null,
        );

      // 3. Copy each eligible photo into submission-images
      const imageRecords: Array<{
        submission_id: string;
        image_type: string;
        image_role: string | null;
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
        const newPath = `${ownerId}/${submissionId}/${photo.grading.imageType}_${i}.${ext}`;
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
          image_type: photo.grading.imageType,
          image_role: photo.grading.imageRole,
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
  return {
    ok: true,
    submitted: successfullySubmitted,
    failed: results.length - successfullySubmitted,
    results,
  };
}
