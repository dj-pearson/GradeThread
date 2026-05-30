// Auto-Disclosure Engine — turn a grade report's structured defects into a
// documented "Condition & Flaws" disclosure + per-photo annotation data.
//
// This is DETERMINISTIC on purpose: a flaws disclosure is a dispute-defense
// artifact, so it must be a faithful, reproducible read of what the grader
// found — not a fresh creative generation. It powers (1) the listing's
// condition narrative and (2) AI-annotated defect photos with zoom callouts.
//
// Pure module (no I/O) so it's unit-testable and usable from both the listing
// generator and the disclosure endpoint.

export interface DefectFound {
  defect: string;
  severity: "minor" | "moderate" | "major";
  location: string;
  impact_on_grade?: string;
}

export interface DisclosureIssue {
  issue: string;
  severity: "minor" | "moderate" | "major";
  location: string;
  is_intentional?: boolean;
  bbox?: [number, number, number, number] | null;
}

export interface PerImageAnalysisLike {
  image_type: string;
  detected_issues?: DisclosureIssue[];
}

export interface StyleAttributeLike {
  attribute: string;
  location?: string;
}

export interface DisclosureInput {
  overall_score: number;
  grade_tier: string;
  defects_found: DefectFound[];
  detected_style_attributes?: StyleAttributeLike[];
  per_image_analysis?: PerImageAnalysisLike[] | null;
  certificate_id?: string | null;
  // Legacy fallback: detailed_notes.defects_summary for pre-00058 grades that
  // never persisted structured defects_found.
  legacy_defects_summary?: string | null;
  siteUrl?: string;
}

export interface PhotoAnnotation {
  n: number;
  issue: string;
  severity: "minor" | "moderate" | "major";
  location: string;
  // Normalized [x, y, w, h] (0..1) when the grader localized the issue.
  bbox: [number, number, number, number] | null;
}

export interface ImageAnnotations {
  image_type: string;
  annotations: PhotoAnnotation[];
}

export interface Disclosure {
  grade_tier: string;
  overall_score: number;
  defect_count: number;
  has_defects: boolean;
  // The same content in three renderings for different surfaces.
  plain: string;
  markdown: string;
  html: string;
  // Per-image annotation data the client canvas draws callouts from.
  image_annotations: ImageAnnotations[];
  style_features: string[];
}

const SEVERITY_RANK: Record<DefectFound["severity"], number> = {
  major: 0,
  moderate: 1,
  minor: 2,
};

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Sort defects worst-first so the disclosure leads with what matters. */
function sortDefects(defects: DefectFound[]): DefectFound[] {
  return [...defects].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3),
  );
}

/** A "Loc — flaw" line, e.g. "Left cuff — light pilling (moderate)". */
function defectLine(d: DefectFound): string {
  const loc = d.location?.trim();
  const sev = titleCase(d.severity);
  return loc
    ? `${titleCase(loc)} — ${d.defect} (${sev})`
    : `${d.defect} (${sev})`;
}

/**
 * Genuine (non-intentional) issues grouped per image, in a stable order, with
 * a running callout number that matches across the photo and the legend.
 */
function buildImageAnnotations(
  perImage: PerImageAnalysisLike[] | null | undefined,
): ImageAnnotations[] {
  if (!Array.isArray(perImage)) return [];
  const out: ImageAnnotations[] = [];
  let n = 1;
  for (const img of perImage) {
    const genuine = (img.detected_issues ?? []).filter(
      (i) => i && i.is_intentional !== true,
    );
    if (genuine.length === 0) continue;
    const annotations: PhotoAnnotation[] = genuine
      .slice()
      .sort(
        (a, b) =>
          (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3),
      )
      .map((i) => ({
        n: n++,
        issue: i.issue,
        severity: i.severity,
        location: i.location ?? "",
        bbox: Array.isArray(i.bbox) && i.bbox.length === 4 ? i.bbox : null,
      }));
    out.push({ image_type: img.image_type, annotations });
  }
  return out;
}

/**
 * Parse the legacy free-text defects_summary written by the pre-00058 pipeline
 * (`[severity] defect at location — impact; …`) back into structured defects.
 * Best-effort: anything that doesn't match falls through as a minor defect.
 */
function parseLegacySummary(summary: string): DefectFound[] {
  const out: DefectFound[] = [];
  for (const part of summary.split(";")) {
    const seg = part.trim();
    if (!seg) continue;
    const m = seg.match(/^\[(minor|moderate|major)\]\s*(.*)$/i);
    const severity = (m?.[1]?.toLowerCase() as DefectFound["severity"]) ?? "minor";
    let rest = (m?.[2] ?? seg).trim();
    let location = "";
    // Strip a trailing "— impact" clause, then split off "at <location>".
    rest = rest.replace(/\s+[—-]\s+.*$/, "").trim();
    const at = rest.match(/^(.*?)\s+at\s+(.*)$/i);
    if (at) {
      rest = at[1].trim();
      location = at[2].trim();
    }
    if (rest) out.push({ defect: rest, severity, location });
  }
  return out;
}

/**
 * Effective defect list: prefer structured defects_found; fall back to the
 * genuine per-image issues, then the legacy free-text summary (for grades
 * created before defects_found existed), de-duplicated by defect+location.
 */
function effectiveDefects(input: DisclosureInput): DefectFound[] {
  if (Array.isArray(input.defects_found) && input.defects_found.length > 0) {
    return input.defects_found;
  }
  // Fallback 1: reconstruct from per-image genuine issues.
  const fromImages: DefectFound[] = [];
  const seen = new Set<string>();
  for (const img of input.per_image_analysis ?? []) {
    for (const i of img.detected_issues ?? []) {
      if (i.is_intentional === true) continue;
      const key = `${i.issue}|${i.location}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      fromImages.push({
        defect: i.issue,
        severity: i.severity,
        location: i.location ?? "",
      });
    }
  }
  if (fromImages.length > 0) return fromImages;

  // Fallback 2: the legacy free-text summary from pre-00058 grades.
  if (input.legacy_defects_summary && input.legacy_defects_summary.trim()) {
    return parseLegacySummary(input.legacy_defects_summary);
  }
  return [];
}

export function buildDisclosure(input: DisclosureInput): Disclosure {
  const site = input.siteUrl ?? "https://gradethread.com";
  const defects = sortDefects(effectiveDefects(input));
  const score = input.overall_score.toFixed(1);
  const certUrl = input.certificate_id
    ? `${site}/cert/${input.certificate_id}`
    : null;

  const styleFeatures = (input.detected_style_attributes ?? [])
    .map((s) => (s.location ? `${s.attribute} (${s.location})` : s.attribute))
    .filter(Boolean);

  // ── Plain text ──────────────────────────────────────────────────
  const plainLines: string[] = [];
  plainLines.push("CONDITION & FLAWS — AI-Verified by GradeThread");
  plainLines.push("");
  plainLines.push(`Overall condition grade: ${score} / 10 (${input.grade_tier})`);
  plainLines.push("");
  if (defects.length > 0) {
    plainLines.push(`Documented flaws (${defects.length}):`);
    for (const d of defects) plainLines.push(`• ${defectLine(d)}`);
  } else {
    plainLines.push(
      "No significant flaws were detected during AI condition grading.",
    );
  }
  if (styleFeatures.length > 0) {
    plainLines.push("");
    plainLines.push(`Design features (intentional, not flaws): ${styleFeatures.join(", ")}.`);
    plainLines.push(
      "These are manufacturing details graded as styling — not damage.",
    );
  }
  if (certUrl) {
    plainLines.push("");
    plainLines.push(
      `Independently verify this condition report: ${certUrl}`,
    );
  }
  const plain = plainLines.join("\n");

  // ── Markdown ────────────────────────────────────────────────────
  const mdLines: string[] = [];
  mdLines.push("**Condition & Flaws — AI-Verified by GradeThread**");
  mdLines.push("");
  mdLines.push(`Overall condition grade: **${score} / 10 (${input.grade_tier})**`);
  mdLines.push("");
  if (defects.length > 0) {
    mdLines.push(`Documented flaws (${defects.length}):`);
    for (const d of defects) mdLines.push(`- ${defectLine(d)}`);
  } else {
    mdLines.push("No significant flaws were detected during AI condition grading.");
  }
  if (styleFeatures.length > 0) {
    mdLines.push("");
    mdLines.push(
      `_Design features (intentional, not flaws): ${styleFeatures.join(", ")}._`,
    );
  }
  if (certUrl) {
    mdLines.push("");
    mdLines.push(`[Verify this condition report ↗](${certUrl})`);
  }
  const markdown = mdLines.join("\n");

  // ── HTML (for listing descriptions) ─────────────────────────────
  const htmlParts: string[] = [];
  htmlParts.push(
    `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;font:14px/1.5 system-ui,sans-serif">`,
  );
  htmlParts.push(
    `<div style="font-weight:700;color:#0F3460;margin-bottom:6px">Condition &amp; Flaws — AI-Verified by GradeThread</div>`,
  );
  htmlParts.push(
    `<div style="margin-bottom:8px">Overall condition grade: <strong>${escapeHtml(score)} / 10 (${escapeHtml(input.grade_tier)})</strong></div>`,
  );
  if (defects.length > 0) {
    htmlParts.push(
      `<div style="margin-bottom:4px">Documented flaws (${defects.length}):</div>`,
    );
    htmlParts.push(`<ul style="margin:0 0 8px 18px;padding:0">`);
    for (const d of defects) {
      htmlParts.push(`<li>${escapeHtml(defectLine(d))}</li>`);
    }
    htmlParts.push(`</ul>`);
  } else {
    htmlParts.push(
      `<div style="margin-bottom:8px">No significant flaws were detected during AI condition grading.</div>`,
    );
  }
  if (styleFeatures.length > 0) {
    htmlParts.push(
      `<div style="color:#6b7280;font-size:13px;margin-bottom:6px"><em>Design features (intentional, not flaws): ${escapeHtml(styleFeatures.join(", "))}. Graded as styling, not damage.</em></div>`,
    );
  }
  if (certUrl) {
    htmlParts.push(
      `<a href="${escapeHtml(certUrl)}" style="color:#0F3460;font-weight:600;text-decoration:none">Independently verify this condition report ↗</a>`,
    );
  }
  htmlParts.push(`</div>`);
  const html = htmlParts.join("");

  return {
    grade_tier: input.grade_tier,
    overall_score: input.overall_score,
    defect_count: defects.length,
    has_defects: defects.length > 0,
    plain,
    markdown,
    html,
    image_annotations: buildImageAnnotations(input.per_image_analysis),
    style_features: styleFeatures,
  };
}
