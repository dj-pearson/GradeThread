// Pre-grade image-quality gate + active abstention (US-332).
//
// Truthful-inputs pillar: rather than emit a low-confidence guess from blurry,
// dark, or incomplete photos, the pipeline runs this lightweight gate BEFORE
// composite grading. If a CORE shot is unusable or a required angle is missing,
// it abstains and returns specific, actionable photo requests instead of a
// grade. Abstention is NOT a failed grade and must not consume a paid credit.
//
// The per-image quality signals come from the existing per-image vision pass
// (the only pass that sees pixels) — see PerImageQuality in ai-grading.ts. This
// module is PURE DECISION LOGIC over those signals + photo-type coverage, so it
// is fully unit-testable and deterministic. A missing/garbled quality field
// defaults to "good", so the gate never abstains on absent data.

export type BlurLevel = "none" | "mild" | "severe";
export type LightingLevel = "ok" | "dim" | "dark";
export type FramingLevel = "full" | "partial";

export interface ImageQuality {
  blur: BlurLevel;
  lighting: LightingLevel;
  framing: FramingLevel;
  // Whether the label text (brand/size/care) is legible. Only meaningful for
  // label images; ignored elsewhere.
  legible?: boolean;
}

export const DEFAULT_IMAGE_QUALITY: ImageQuality = {
  blur: "none",
  lighting: "ok",
  framing: "full",
  legible: true,
};

export interface QualityImageInput {
  image_type: string;
  quality?: ImageQuality;
}

export type QualityProblem =
  | "missing"
  | "blur"
  | "lighting"
  | "framing"
  | "illegible_label";

export interface QualityIssue {
  image_type: string;
  problem: QualityProblem;
  // 'block' issues trigger abstention; 'warn' issues are surfaced but the grade
  // still proceeds (with the existing confidence machinery handling the rest).
  severity: "block" | "warn";
  message: string;
}

export interface QualityGateResult {
  // No issues at all — clean inputs.
  ok: boolean;
  // At least one blocking issue — DO NOT finalize a grade; request better photos.
  abstain: boolean;
  issues: QualityIssue[];
  // De-duplicated, user-facing asks derived from the blocking issues.
  photo_requests: string[];
  summary: string;
  /**
   * No `detail_*` close-up was supplied, so fabric_condition (30% of the grade)
   * was read off the full-garment shots instead of the weave/knit.
   *
   * This USED to abstain. It no longer does: a seller with good front/back/label
   * coverage and nothing tagged Detail can now get a grade. What it must never
   * do is get that grade for free — the caller caps confidence and routes to a
   * human (NO_FABRIC_CLOSEUP_CONFIDENCE_CAP in ai-grading.ts). Reported as an
   * explicit boolean rather than re-derived by scanning `issues` for a message,
   * because a copy edit would silently switch the cap off.
   */
  fabricCloseupMissing: boolean;
}

// Required angles for a gradeable submission (AC #3).
export const REQUIRED_IMAGE_TYPES = ["front", "back", "label"] as const;
// Core shots whose quality, if unusable, blocks grading. detail/defect photos
// are supplementary — quality problems there warn but don't abstain.
const CORE_TYPES = new Set<string>(["front", "back", "label"]);

const TYPE_LABEL: Record<string, string> = {
  front: "front",
  back: "back",
  label: "brand/care label",
  label_2: "second tag",
  detail: "detail",
  detail_2: "detail",
  detail_3: "detail",
  detail_4: "detail",
  defect: "defect",
  measurement_chest: "chest measurement",
  measurement_waist: "waist measurement",
  measurement_length: "length measurement",
  measurement_sleeve: "sleeve measurement",
  measurement_inseam: "inseam measurement",
};

function label(t: string): string {
  return TYPE_LABEL[t] ?? t;
}

/**
 * Is the fabric close-up absent from this set of image types?
 *
 * The ONE definition of that rule. Exported because two places need it and they
 * must not drift: the quality gate below, and the escalation re-grade in
 * grading-pipeline.ts, which builds its own analyzed set on the stronger model
 * and would otherwise ship an UNCAPPED escalated grade. That is precisely the
 * bug US-1642 fixed for the partial-image cap, one cap over.
 */
export function fabricCloseupMissingFor(imageTypes: Iterable<string>): boolean {
  for (const t of imageTypes) {
    if (t.startsWith("detail")) return false;
  }
  return true;
}

export function evaluateImageQuality(
  images: QualityImageInput[],
): QualityGateResult {
  const issues: QualityIssue[] = [];
  const present = new Set(images.map((i) => i.image_type));

  // --- Coverage: required angles must be present (AC #3) ---
  for (const t of REQUIRED_IMAGE_TYPES) {
    if (!present.has(t)) {
      issues.push({
        image_type: t,
        problem: "missing",
        severity: "block",
        message: `Add a clear, well-lit photo of the ${label(t)}.`,
      });
    }
  }
  // Any detail_* slot satisfies the "at least one close-up" requirement.
  //
  // WARN, not BLOCK (owner's call, 2026-08-03). Refusing to grade a garment that
  // has good front/back/label coverage and simply nothing tagged Detail cost the
  // seller a grade they had the photos for. So we grade it — and the caller caps
  // confidence and sends it to a human, because fabric_condition is 30% of the
  // score and its primary evidence is genuinely absent. The trade is "a slower,
  // checked grade" instead of "no grade", never "the same grade for less".
  const fabricCloseupMissing = fabricCloseupMissingFor(present);
  if (fabricCloseupMissing) {
    issues.push({
      image_type: "detail",
      problem: "missing",
      severity: "warn",
      message:
        "No fabric close-up, so a person will check this grade before it is final. A close-up of the weave/knit or a seam gets you a faster, more certain grade next time. This isn't a defect photo.",
    });
  }

  // --- Per-image quality ---
  for (const img of images) {
    const q: ImageQuality = {
      ...DEFAULT_IMAGE_QUALITY,
      ...(img.quality ?? {}),
    };
    const core = CORE_TYPES.has(img.image_type);
    const name = label(img.image_type);

    // Blur
    if (q.blur === "severe") {
      issues.push({
        image_type: img.image_type,
        problem: "blur",
        severity: core ? "block" : "warn",
        message:
          `The ${name} photo is too blurry to grade reliably — retake it in sharp focus.`,
      });
    } else if (q.blur === "mild" && core) {
      issues.push({
        image_type: img.image_type,
        problem: "blur",
        severity: "warn",
        message:
          `The ${name} photo is slightly soft; a sharper shot improves accuracy.`,
      });
    }

    // Lighting
    if (q.lighting === "dark") {
      issues.push({
        image_type: img.image_type,
        problem: "lighting",
        severity: core ? "block" : "warn",
        message:
          `The ${name} photo is too dark to assess — retake it in brighter, even light.`,
      });
    } else if (q.lighting === "dim" && core) {
      issues.push({
        image_type: img.image_type,
        problem: "lighting",
        severity: "warn",
        message:
          `The ${name} photo is a little dim; brighter light improves accuracy.`,
      });
    }

    // Framing — a partial front/back hides part of the garment we must assess.
    if (
      q.framing === "partial" &&
      (img.image_type === "front" || img.image_type === "back")
    ) {
      issues.push({
        image_type: img.image_type,
        problem: "framing",
        severity: "block",
        message:
          `The ${name} photo cuts off part of the garment — reshoot showing the whole item.`,
      });
    } else if (q.framing === "partial" && !core) {
      issues.push({
        image_type: img.image_type,
        problem: "framing",
        severity: "warn",
        message: `The ${name} photo is partially framed.`,
      });
    }

    // Label legibility — can't verify brand/size/care from an unreadable label.
    if (img.image_type === "label" && q.legible === false) {
      issues.push({
        image_type: img.image_type,
        problem: "illegible_label",
        severity: "block",
        message:
          "The label isn't readable — retake a sharp, straight-on close-up of the brand/care label.",
      });
    }
  }

  const blocking = issues.filter((i) => i.severity === "block");
  const abstain = blocking.length > 0;
  // De-dupe while preserving order.
  const photo_requests = [...new Set(blocking.map((i) => i.message))];

  let summary: string;
  if (abstain) {
    summary = `Grading paused — ${photo_requests.length} photo issue${
      photo_requests.length === 1 ? "" : "s"
    } to fix before we can grade reliably.`;
  } else if (issues.length > 0) {
    summary = "Graded with minor photo-quality notes.";
  } else {
    summary = "Photo quality sufficient for grading.";
  }

  return {
    ok: issues.length === 0,
    abstain,
    fabricCloseupMissing,
    issues,
    photo_requests,
    summary,
  };
}
