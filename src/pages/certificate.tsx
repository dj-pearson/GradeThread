import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import {
  Shield,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  Calendar,
  Cpu,
  BadgeCheck,
  Gauge,
  UserCheck,
  Info,
  Image as ImageIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { SEO } from "@/components/seo";
import { certificateLd, breadcrumbLd } from "@/lib/seo/json-ld";
import { SITE_URL } from "@/lib/seo/public-routes";
import { cn } from "@/lib/utils";
import { GRADE_FACTORS } from "@/lib/constants";
import { VerifiedBadge } from "@/components/verified/verified-badge";
import { GradedPhotoPanel } from "@/components/verified/graded-photo-panel";
import { ImageLightbox } from "@/components/certificate/image-lightbox";
import { CopyField } from "@/components/verified/copy-field";
import { certBadgeEmbedHtml, certBadgeEmbedText } from "@/lib/verified";
import { supabase } from "@/lib/supabase";
import { edgeApiUrl } from "@/lib/edge-api";
import { Button } from "@/components/ui/button";
import type {
  PublicGradeReportRow,
  PublicConfidenceLabel,
  SubmissionRow,
  SubmissionImageRow,
} from "@/types/database";

// US-333: result of the public tamper-evident integrity check.
type IntegrityVerify = {
  status: "verified" | "mismatch" | "unverifiable";
  verified: boolean;
  signed: boolean;
  algorithm: string;
  content_hash: string | null;
};
type VerifyState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "done"; result: IntegrityVerify }
  | { phase: "error" };

// Grade-tier colors follow the refreshed media kit (design.md §3B): Emerald
// Mint (#10B981 = emerald-500), Amber Gold (#F59E0B = amber-500), and Vibrant
// Crimson (#F03D5F = brand-red / rose tints) for the lower tier.
function getScoreColor(score: number): string {
  if (score > 7) return "text-emerald-500";
  if (score >= 5) return "text-amber-500";
  return "text-brand-red";
}

function getScoreBorderColor(score: number): string {
  if (score > 7) return "border-emerald-500";
  if (score >= 5) return "border-amber-500";
  return "border-brand-red";
}

function getTierBadgeClasses(score: number): string {
  if (score > 7) return "bg-emerald-100 text-emerald-800 border-emerald-200";
  if (score >= 5) return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-rose-100 text-rose-800 border-rose-200";
}

function getProgressColor(score: number): string {
  if (score > 7) return "[&>div]:bg-emerald-500";
  if (score >= 5) return "[&>div]:bg-amber-500";
  return "[&>div]:bg-brand-red";
}

function formatLabel(value: string): string {
  return value
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// Order defects worst-first so the most grade-relevant flaws lead.
const SEVERITY_RANK: Record<string, number> = { major: 0, moderate: 1, minor: 2 };

function severityBadgeClasses(severity: string): string {
  if (severity === "major") return "bg-red-100 text-red-800 border-red-200";
  if (severity === "moderate") return "bg-yellow-100 text-yellow-800 border-yellow-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

// Plain-language confidence label from the coarse public bucket. The precise
// 0–1 confidence_score is an anti-fraud signal and is not exposed publicly
// (US-348) — the view buckets it server-side before it ever reaches the client.
const CONFIDENCE_LABELS: Record<PublicConfidenceLabel, string> = {
  very_high: "Very high",
  high: "High",
  moderate: "Moderate",
  reviewed: "Reviewed", // below threshold → was routed to human review
};

function confidenceLabel(bucket: PublicConfidenceLabel): string {
  return CONFIDENCE_LABELS[bucket] ?? "Reviewed";
}

// US-333: renders the tamper-evident integrity verdict for the certificate.
function IntegrityPanel({
  state,
  onRetry,
}: {
  state: VerifyState;
  onRetry: () => void;
}) {
  if (state.phase === "checking" || state.phase === "idle") {
    return (
      <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
        <Shield className="h-4 w-4 animate-pulse" />
        <span>Verifying certificate integrity…</span>
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border bg-muted/40 px-4 py-3 text-center text-sm text-muted-foreground sm:flex-row sm:justify-between sm:text-left">
        <span className="flex items-center gap-2">
          <Shield className="h-4 w-4" />
          Integrity check couldn’t reach the verification service.
        </span>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  const { result } = state;

  if (result.status === "verified") {
    return (
      <div className="rounded-lg border border-green-600/30 bg-green-50 px-4 py-3 text-sm dark:bg-green-950/30">
        <div className="flex items-center gap-2 font-medium text-green-700 dark:text-green-400">
          <ShieldCheck className="h-5 w-5" />
          Authentic — integrity verified
        </div>
        <p className="mt-1 text-xs text-green-800/80 dark:text-green-300/80">
          The grade data on this certificate matches what GradeThread sealed at
          finalization{result.signed ? " and carries a valid signature" : ""}.
          {" "}
          {result.algorithm}.
        </p>
        {result.content_hash && (
          <p className="mt-1 break-all font-mono text-[10px] text-green-800/60 dark:text-green-300/60">
            {result.content_hash}
          </p>
        )}
      </div>
    );
  }

  if (result.status === "mismatch") {
    return (
      <div className="rounded-lg border border-red-600/40 bg-red-50 px-4 py-3 text-sm dark:bg-red-950/30">
        <div className="flex items-center gap-2 font-medium text-red-700 dark:text-red-400">
          <ShieldAlert className="h-5 w-5" />
          Integrity check failed — do not trust this certificate
        </div>
        <p className="mt-1 text-xs text-red-800/80 dark:text-red-300/80">
          The grade data does not match GradeThread’s sealed record. This
          certificate may have been altered or forged.
        </p>
      </div>
    );
  }

  // unverifiable — legacy grade issued before the integrity scheme.
  return (
    <div className="rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
      <div className="flex items-center gap-2 font-medium">
        <Shield className="h-5 w-5" />
        Integrity record not available
      </div>
      <p className="mt-1 text-xs">
        This certificate predates GradeThread’s tamper-evident integrity scheme,
        so a cryptographic check isn’t available. The grade itself remains valid.
      </p>
    </div>
  );
}

function CertificateLoadingSkeleton() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div className="flex flex-col items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-full" />
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-4 w-48" />
      </div>
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

export function CertificatePage() {
  const { id } = useParams<{ id: string }>();
  const [gradeReport, setGradeReport] = useState<PublicGradeReportRow | null>(null);
  const [submission, setSubmission] = useState<SubmissionRow | null>(null);
  const [images, setImages] = useState<SubmissionImageRow[]>([]);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verify, setVerify] = useState<VerifyState>({ phase: "idle" });
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const certificateUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/cert/${id}`
      : "";

  // US-333: ask the edge service to re-derive the certificate's content hash
  // from the stored grade fields and confirm it matches (and that the HMAC
  // signature validates, when signed). No auth — the verify endpoint exposes
  // only the public verdict. Network/transport failures degrade to "error"
  // (try again), never to a false "verified".
  const runVerify = useCallback(async () => {
    if (!id) return;
    setVerify({ phase: "checking" });
    try {
      const res = await fetch(
        `${edgeApiUrl()}/api/content/public/certificates/${encodeURIComponent(id)}/verify`,
      );
      if (!res.ok) throw new Error(`verify failed: ${res.status}`);
      const data = (await res.json()) as IntegrityVerify;
      setVerify({ phase: "done", result: data });
    } catch {
      setVerify({ phase: "error" });
    }
  }, [id]);

  useEffect(() => {
    void runVerify();
  }, [runVerify]);

  useEffect(() => {
    if (!id) return;

    async function fetchCertificate() {
      setLoading(true);
      setError(null);

      // US-348: read the column-restricted public_grade_reports view, not the
      // base table. Anonymous viewers get only public-safe certificate fields.
      const { data: reportData, error: reportError } = await supabase
        .from("public_grade_reports")
        .select("*")
        .eq("certificate_id", id!)
        .single();

      if (reportError || !reportData) {
        setError("Certificate not found");
        setLoading(false);
        return;
      }

      const report = reportData as PublicGradeReportRow;
      setGradeReport(report);

      // Set OG meta tags
      document.title = `GradeThread Certificate — Grade ${report.overall_score.toFixed(1)} (${report.grade_tier})`;
      setMetaTag("og:title", `GradeThread Grade Certificate — ${report.grade_tier}`);
      setMetaTag("og:description", `Verified condition grade: ${report.overall_score.toFixed(1)}/10.0 (${report.grade_tier}). Graded by GradeThread AI.`);
      setMetaTag("og:url", `${window.location.origin}/cert/${id}`);
      setMetaTag("og:type", "website");

      // Fetch submission for garment info
      const { data: subData } = await supabase
        .from("submissions")
        .select("*")
        .eq("id", report.submission_id)
        .single();

      if (subData) {
        setSubmission(subData);
      }

      // Fetch images
      const { data: imagesRaw } = await supabase
        .from("submission_images")
        .select("*")
        .eq("submission_id", report.submission_id);

      const imagesData = (imagesRaw ?? []) as SubmissionImageRow[];
      if (imagesData.length > 0) {
        const sorted = [...imagesData].sort(
          (a, b) => a.display_order - b.display_order
        );
        setImages(sorted);

        const urls: Record<string, string> = {};
        for (const img of sorted) {
          const { data: urlData } = await supabase.storage
            .from("submission-images")
            // submission-images is private — short-lived signed URL (US-276).
            .createSignedUrl(img.storage_path, 900);
          if (urlData?.signedUrl) {
            urls[img.id] = urlData.signedUrl;
          }
        }
        setImageUrls(urls);
      }

      setLoading(false);
    }

    fetchCertificate();
  }, [id]);

  if (loading) {
    return <CertificateLoadingSkeleton />;
  }

  if (error || !gradeReport) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <Card className="w-full max-w-md">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <AlertTriangle className="h-12 w-12 text-muted-foreground/50" />
            <h3 className="mt-4 text-lg font-medium">
              {error || "Certificate not found"}
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              This certificate may have been removed or the link is invalid.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const factorScores = [
    {
      key: "fabric_condition" as const,
      score: gradeReport.fabric_condition_score,
    },
    {
      key: "structural_integrity" as const,
      score: gradeReport.structural_integrity_score,
    },
    {
      key: "cosmetic_appearance" as const,
      score: gradeReport.cosmetic_appearance_score,
    },
    {
      key: "functional_elements" as const,
      score: gradeReport.functional_elements_score,
    },
    {
      key: "odor_cleanliness" as const,
      score: gradeReport.odor_cleanliness_score,
    },
  ];

  // US-328: genuine defects, worst-first. Empty for clean items / historical
  // grades that never persisted structured defects.
  const defects = [...(gradeReport.defects_found ?? [])].sort(
    (a, b) =>
      (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3)
  );

  // US-336/US-338 + US-348: authenticity result, reduced to public-safe booleans
  // by the view (raw detection tells stay server-side so they can't be used to
  // evade the check). `authenticity_checked` is false for grades created before
  // the check existed.
  const authenticity = gradeReport.authenticity_checked;
  const authenticityFlagged =
    authenticity &&
    (gradeReport.authenticity_manipulation_suspected ||
      gradeReport.authenticity_screenshot_or_watermark_detected);

  return (
    <div className="min-h-screen bg-background">
      <SEO
        title={`Grade Certificate - ${gradeReport.grade_tier} (${gradeReport.overall_score}/10)`}
        description={`Verified GradeThread grade certificate for ${submission?.title ?? "garment"}. Grade: ${gradeReport.grade_tier} (${gradeReport.overall_score}/10).`}
        ogType="article"
        canonicalUrl={`https://gradethread.com/cert/${id}`}
        jsonLd={[
          certificateLd({
            id: id ?? "",
            title: submission?.title ?? "Graded garment",
            overallScore: gradeReport.overall_score,
            gradeTier: gradeReport.grade_tier,
            brand: submission?.brand ?? null,
            datePublished: gradeReport.created_at,
          }),
          breadcrumbLd([
            { name: "GradeThread", url: `${SITE_URL}/` },
            {
              name: "Grade Certificate",
              url: `${SITE_URL}/cert/${id ?? ""}`,
            },
          ]),
        ]}
      />
      {/* Header with branding */}
      <div className="bg-brand-navy py-6 text-white">
        <div className="mx-auto flex max-w-3xl flex-col items-center gap-3 px-6">
          <div className="flex items-center gap-3">
            <img
              src="/logo_white.png"
              alt="GradeThread"
              className="h-8"
            />
          </div>
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            <h1 className="text-lg font-bold sm:text-xl">
              Verified Grade Certificate
            </h1>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
        {/* Overall Score */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col items-center gap-4 sm:flex-row sm:gap-6">
              <div
                className={cn(
                  "flex h-28 w-28 flex-shrink-0 items-center justify-center rounded-full border-4",
                  getScoreBorderColor(gradeReport.overall_score)
                )}
              >
                <span
                  className={cn(
                    "text-4xl font-bold",
                    getScoreColor(gradeReport.overall_score)
                  )}
                >
                  {gradeReport.overall_score.toFixed(1)}
                </span>
              </div>
              <div className="text-center sm:text-left">
                <Badge
                  variant="outline"
                  className={cn(
                    "text-sm font-medium",
                    getTierBadgeClasses(gradeReport.overall_score)
                  )}
                >
                  {gradeReport.grade_tier}
                </Badge>
                <p className="mt-1 text-sm text-muted-foreground">
                  Overall Condition Grade
                </p>
                {submission && (
                  <p className="mt-2 text-base font-medium">
                    {submission.title}
                    {submission.brand && (
                      <span className="text-muted-foreground">
                        {" "}
                        — {submission.brand}
                      </span>
                    )}
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Photo Gallery — the evidence behind the grade. Tap a photo to open
            the full-screen viewer (US-761): zoom, step through, download. */}
        {images.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Garment Photos</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {images.map((img, i) => (
                  <div key={img.id} className="space-y-1.5">
                    {imageUrls[img.id] ? (
                      <button
                        type="button"
                        onClick={() => setLightboxIndex(i)}
                        className="block aspect-square w-full overflow-hidden rounded-lg border bg-muted transition hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-ring"
                        aria-label={`View ${formatLabel(img.image_type)} photo full screen`}
                      >
                        <img
                          src={imageUrls[img.id]}
                          alt={`${img.image_type} photo`}
                          className="h-full w-full object-cover"
                        />
                      </button>
                    ) : (
                      <div className="aspect-square overflow-hidden rounded-lg border bg-muted">
                        <div className="flex h-full w-full items-center justify-center">
                          <Skeleton className="h-full w-full" />
                        </div>
                      </div>
                    )}
                    <Badge variant="outline" className="text-xs">
                      {formatLabel(img.image_type)}
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* US-761: full-screen photo viewer, opened from the gallery above. */}
        {lightboxIndex !== null && (
          <ImageLightbox
            // Same index space as the gallery grid above (no filtering) so the
            // clicked thumbnail's index always maps to the right photo.
            images={images.map((img) => ({
              id: img.id,
              src: imageUrls[img.id] ?? "",
              caption: formatLabel(img.image_type),
            }))}
            index={lightboxIndex}
            onClose={() => setLightboxIndex(null)}
            onNavigate={setLightboxIndex}
          />
        )}

        {/* About this item (US-760) — the structured facts a buyer wants,
            alongside the seller's own description. Rows with no value are
            omitted so the panel never shows empty fields. */}
        {submission &&
          (submission.brand ||
            submission.garment_type ||
            submission.garment_category ||
            submission.description) && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">About this item</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
                  {submission.brand && (
                    <div>
                      <dt className="text-muted-foreground">Brand</dt>
                      <dd className="font-medium">{submission.brand}</dd>
                    </div>
                  )}
                  {submission.garment_type && (
                    <div>
                      <dt className="text-muted-foreground">Type</dt>
                      <dd className="font-medium">
                        {formatLabel(submission.garment_type)}
                      </dd>
                    </div>
                  )}
                  {submission.garment_category && (
                    <div>
                      <dt className="text-muted-foreground">Category</dt>
                      <dd className="font-medium">
                        {formatLabel(submission.garment_category)}
                      </dd>
                    </div>
                  )}
                </dl>
                {submission.description && (
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                    {submission.description}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

        {/* Factor Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Factor Breakdown</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {factorScores.map(({ key, score }) => {
              const factor = GRADE_FACTORS[key];
              return (
                <div key={key} className="space-y-1.5">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">
                      {factor.label}{" "}
                      <span className="text-muted-foreground">
                        ({(factor.weight * 100).toFixed(0)}%)
                      </span>
                    </span>
                    <span
                      className={cn("font-semibold", getScoreColor(score))}
                    >
                      {score.toFixed(1)}
                    </span>
                  </div>
                  <Progress
                    value={score * 10}
                    className={cn("h-2", getProgressColor(score))}
                  />
                </div>
              );
            })}
          </CardContent>
        </Card>

        {/* AI Summary */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">AI Analysis Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">
              {gradeReport.ai_summary}
            </p>
          </CardContent>
        </Card>

        {/* Condition & Flaws — the genuine defects behind the grade, so a buyer
            sees exactly WHY the score is what it is. */}
        {defects.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Condition &amp; Flaws</CardTitle>
              <CardDescription>
                Genuine wear and damage the grade accounts for. Intentional
                design features are listed separately and don&apos;t lower the
                grade.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3">
                {defects.map((d, i) => (
                  <li
                    key={i}
                    className="flex flex-col gap-1 border-b pb-3 last:border-b-0 last:pb-0"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-xs capitalize",
                          severityBadgeClasses(d.severity)
                        )}
                      >
                        {d.severity}
                      </Badge>
                      <span className="text-sm font-medium">{d.defect}</span>
                      {d.location && (
                        <span className="text-xs text-muted-foreground">
                          · {d.location}
                        </span>
                      )}
                    </div>
                    {d.impact_on_grade && (
                      <p className="text-xs text-muted-foreground">
                        {d.impact_on_grade}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {/* Grade Assurance — confidence, human review, and the authenticity
            check, so a buyer can trust HOW the grade was produced, not just the
            number. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Grade Assurance</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Confidence */}
            <div className="flex items-start gap-3">
              <Gauge className="mt-0.5 h-5 w-5 flex-shrink-0 text-brand-navy" />
              <div>
                <p className="text-sm font-medium">
                  Grade confidence: {confidenceLabel(gradeReport.confidence_label)}
                </p>
                <p className="text-xs text-muted-foreground">
                  Low-confidence grades are routed to a human reviewer before
                  they&apos;re finalized.
                </p>
              </div>
            </div>

            {/* Human review */}
            {gradeReport.human_reviewed && (
              <div className="flex items-start gap-3">
                <UserCheck className="mt-0.5 h-5 w-5 flex-shrink-0 text-green-600" />
                <div>
                  <p className="text-sm font-medium">Human-reviewed</p>
                  <p className="text-xs text-muted-foreground">
                    A GradeThread reviewer checked this grade.
                  </p>
                </div>
              </div>
            )}

            {/* Authenticity check — only shown when the check actually ran. */}
            {authenticity &&
              (authenticityFlagged ? (
                <div className="flex items-start gap-3">
                  <ShieldAlert className="mt-0.5 h-5 w-5 flex-shrink-0 text-yellow-600" />
                  <div>
                    <p className="text-sm font-medium">
                      Authenticity check: routed for review
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Our photo-authenticity check flagged this submission, so it
                      received additional human review
                      {gradeReport.human_reviewed ? " and was confirmed" : ""}.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3">
                  <ShieldCheck className="mt-0.5 h-5 w-5 flex-shrink-0 text-green-600" />
                  <div>
                    <p className="text-sm font-medium">
                      Authenticity check passed
                    </p>
                    <p className="text-xs text-muted-foreground">
                      No signs of photo manipulation or reused/screenshot images.
                    </p>
                  </div>
                </div>
              ))}
          </CardContent>
        </Card>

        {/* US-514: AI-transparency disclosure. Buyers must be clearly told the
            grade is an AI-generated estimate, not a professional appraisal or
            guarantee. Wording mirrors Terms §5. */}
        <Card className="border-amber-300 bg-amber-50/60">
          <CardContent className="flex items-start gap-3 pt-6">
            <Info className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-amber-900">
                AI-generated condition estimate — not a professional appraisal or
                guarantee
              </p>
              <p className="text-xs text-amber-800">
                This grade is produced by an automated AI system from the seller's
                photos. It is an estimate of condition, not a certified appraisal,
                authentication, or warranty of value. Confidence is shown above;
                lower-confidence grades are routed to a human reviewer. Always
                review the photos and item description before purchasing. See our{" "}
                <a href="/terms" className="underline">Terms</a> (section 5) for
                details.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Intentional design features — buyers see distressing was assessed
            as styling, not counted against the condition grade. */}
        {gradeReport.detected_style_attributes &&
          gradeReport.detected_style_attributes.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Design Features</CardTitle>
                <CardDescription>
                  Intentional design elements assessed as styling — graded
                  relative to the garment's original manufactured state.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {gradeReport.detected_style_attributes.map((s, i) => (
                    <span
                      key={i}
                      className="rounded-full bg-muted px-3 py-1 text-xs font-medium capitalize"
                    >
                      {s.attribute}
                      {s.location ? ` · ${s.location}` : ""}
                    </span>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

        {/* Graded photo (US-765) — the PSA-style certified image: the garment
            photo with the grade + scannable QR burned in. The seller's
            highest-leverage share asset; the slab is public so anyone viewing
            the certificate can grab it. */}
        {id && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ImageIcon className="h-5 w-5 text-brand-navy" />
                Graded photo
              </CardTitle>
              <CardDescription>
                Download this item&apos;s certified photo — the grade and a
                scannable code are burned in, so buyers can verify it from any
                marketplace listing.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <GradedPhotoPanel certificateId={id} />
            </CardContent>
          </Card>
        )}

        {/* Embed this badge in your listing — the viral surface of
            GradeThread Verified. Buyers see a standardized, verifiable grade
            right inside the marketplace listing and click through to here. */}
        {id && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <BadgeCheck className="h-5 w-5 text-brand-navy" />
                Add this badge to your listing
              </CardTitle>
              <CardDescription>
                Paste it into your eBay, Poshmark, Mercari, Depop or Grailed
                listing description. Buyers see the verified grade and can tap to
                confirm it here.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex justify-center">
                <VerifiedBadge
                  score={gradeReport.overall_score}
                  tier={gradeReport.grade_tier}
                />
              </div>
              <CopyField
                label="HTML (listing descriptions)"
                value={certBadgeEmbedHtml(id)}
                multiline
              />
              <CopyField
                label="Plain text (where HTML isn't allowed)"
                value={certBadgeEmbedText(id)}
              />
            </CardContent>
          </Card>
        )}

        <Separator />

        {/* Footer: Date, Model, QR Code */}
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:justify-between">
          <div className="space-y-2 text-center text-sm text-muted-foreground sm:text-left">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              <span>
                Graded on{" "}
                {new Date(gradeReport.created_at).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Cpu className="h-4 w-4" />
              <span>Model: {gradeReport.model_version}</span>
            </div>
            <p className="text-xs">
              Certificate ID:{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                {id}
              </code>
            </p>
          </div>
          <div className="flex flex-col items-center gap-2">
            <QRCodeSVG
              value={certificateUrl}
              size={120}
              bgColor="transparent"
              fgColor="#0C1E36"
              level="M"
            />
            <p className="text-xs text-muted-foreground">Scan to verify</p>
          </div>
        </div>

        {/* US-333: tamper-evident integrity verdict */}
        <IntegrityPanel state={verify} onRetry={runVerify} />

        {/* Powered by footer */}
        <div className="pb-4 text-center">
          <p className="text-xs text-muted-foreground">
            Powered by{" "}
            <a
              href="/"
              className="font-medium text-brand-navy hover:underline"
            >
              GradeThread
            </a>{" "}
            — The Standard for Clothing Condition Grading
          </p>
        </div>
      </div>
    </div>
  );
}

function setMetaTag(property: string, content: string) {
  let meta = document.querySelector(
    `meta[property="${property}"]`
  ) as HTMLMetaElement | null;
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("property", property);
    document.head.appendChild(meta);
  }
  meta.setAttribute("content", content);
}
