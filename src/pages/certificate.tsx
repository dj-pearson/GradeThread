import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
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
  History,
  ArrowRight,
  Camera,
  Store,
  Image as ImageIcon,
  Box,
  Video,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ScoreBandIcon } from "@/components/grade/score-indicator";
import { AiDisclosure } from "@/components/grade/ai-disclosure";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { SEO } from "@/components/seo";
import { Breadcrumbs } from "@/components/breadcrumbs";
import {
  certificateLd,
  breadcrumbLd,
  certGalleryImageUrls,
} from "@/lib/seo/json-ld";
import { SITE_URL } from "@/lib/seo/site";
import { cn } from "@/lib/utils";
import {
  getScoreColor,
  getScoreBorderColor,
  getTierBadgeClasses,
  getProgressColor,
  tierBandRange,
} from "@/lib/constants";
import {
  CONDITION_NOT_AUTHENTICITY_DISCLOSURE,
  needsAuthenticitySeparation,
  rubricForKey,
} from "@/lib/rubrics";
import { confidenceInfo } from "@/lib/passport-confidence";
import { VerifiedBadge } from "@/components/verified/verified-badge";
import { ReportCertificateDialog } from "@/components/certificate/report-certificate-dialog";
import { CoverageHeatmap } from "@/components/certificate/coverage-heatmap";
import { GradedPhotoPanel } from "@/components/verified/graded-photo-panel";
import { ImageLightbox } from "@/components/certificate/image-lightbox";
import {
  AnnotatedDefectPhoto,
  buildAnnotatedGroups,
} from "@/components/certificate/annotated-defect-photo";
import { CertShareActions } from "@/components/certificate/cert-share-actions";
import { WatchButton } from "@/components/watchlist/watch-button";
import { CertImpactLine } from "@/components/impact/cert-impact-line";
import { CopyField } from "@/components/verified/copy-field";
import {
  certBadgeEmbedHtml,
  certBadgeEmbedText,
  certBadgeScriptEmbed,
  INTEGRITY_TIER_BASIS,
  LEVEL_FLAIR_BASIS,
  parseBadgeVariant,
} from "@/lib/verified";
import { supabase } from "@/lib/supabase";
import { ScoreExplainer } from "@/components/grading/score-explainer";
import { track } from "@/lib/analytics";
import { badgeArrival, badgeArrivalNote } from "@/lib/badge-arrival";
import { isExtensionInstalled } from "@/lib/lister-extension";
import { edgeApiUrl } from "@/lib/edge-api";
import { CrossSurfaceNudge } from "@/components/cross-surface/cross-surface-nudge";
import type {
  PublicGradeReportRow,
  PublicConfidenceLabel,
  SubmissionRow,
  SubmissionImageRow,
} from "@/types/database";

// US-333: result of the public tamper-evident integrity check.
type IntegrityVerify = {
  status: "verified" | "mismatch" | "unsigned" | "unverifiable";
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

function formatLabel(value: string): string {
  return value
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// US-1665: the "what does a {grade} grade mean?" copy varies by grade band (10
// variants). Kept in sync with the cert SSR Pages Function's gradeBandMeaning().
const GRADE_BAND_MEANING: Record<number, string> = {
  10: "A 10 is New With Tags (NWT): brand-new and unworn, with the original retail tags still attached.",
  9: "A 9 is New Without Tags (NWOT): new and unworn, just missing the original tags.",
  8: "An 8 is Excellent: gently used with no notable flaws — it looks nearly new.",
  7: "A 7 is Very Good: light, even wear that doesn’t affect how the garment looks or functions.",
  6: "A 6 is Good: visible but minor wear on a garment that is still very wearable.",
  5: "A 5 is Fair: a documented flaw — a stain, small hole, or clear fading — that affects appearance.",
  4: "A 4 sits at the top of the Poor band: heavy wear or damage, best sold transparently as-is.",
  3: "A 3 is Poor: significant damage such as holes, tears, large stains, or broken hardware.",
  2: "A 2 is salvage condition: heavily damaged, typically sold for parts or repair.",
  1: "A 1 is salvage: extensive damage — valued for its material or graphic, not for wear.",
};
function gradeBandMeaning(score: number): string {
  const band = Math.min(10, Math.max(1, Math.round(score)));
  return GRADE_BAND_MEANING[band] ?? GRADE_BAND_MEANING[5]!;
}

// Order defects worst-first so the most grade-relevant flaws lead.
const SEVERITY_RANK: Record<string, number> = { major: 0, moderate: 1, minor: 2 };

function severityBadgeClasses(severity: string): string {
  if (severity === "major") return "bg-red-100 text-red-800 border-red-200 dark:bg-red-950/50 dark:text-red-300 dark:border-red-800";
  if (severity === "moderate") return "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-950/50 dark:text-yellow-300 dark:border-yellow-800";
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
  certificateId,
}: {
  state: VerifyState;
  onRetry: () => void;
  /** US-2550: what a failed verdict files a report against. */
  certificateId: string;
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
    // US-1465: a transient network/transport failure is NOT a trust signal — keep
    // it quiet and unobtrusive (a small inline line + subtle retry link) rather
    // than a prominent bordered panel that alarms buyers about a valid grade.
    return (
      <div className="flex items-center justify-center gap-2 px-4 py-1.5 text-center text-xs text-muted-foreground">
        <Shield className="h-3.5 w-3.5 opacity-60" />
        <span>Couldn’t reach the integrity checker.</span>
        <button
          type="button"
          onClick={onRetry}
          className="font-medium underline underline-offset-2 hover:text-foreground"
        >
          Retry
        </button>
      </div>
    );
  }

  const { result } = state;

  if (result.status === "verified") {
    return (
      <div className="rounded-lg border border-green-600/30 bg-green-50 px-4 py-3 text-sm dark:bg-green-950/30">
        <div className="flex items-center gap-2 font-medium text-green-700 dark:text-green-400">
          <ShieldCheck className="h-5 w-5" />
          Authentic — grade claims verified
        </div>
        <p className="mt-1 text-xs text-green-800/80 dark:text-green-300/80">
          The certified grade claims — overall score, tier, the five factor
          scores, the condition summary and buyer write-up — match what
          GradeThread sealed at finalization
          {result.signed ? " and carry a valid signature" : ""}. {result.algorithm}.
        </p>
        {/* US-489: be precise about scope — the seal binds the grade CLAIMS,
            not the photo pixels, so a buyer isn't misled into thinking the
            images are cryptographically bound. */}
        <p className="mt-1 text-[11px] text-green-800/70 dark:text-green-300/70">
          The seal covers the grade data above; it does not cryptographically
          bind the photographs themselves.
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
        {/* US-2550: the worst news the product can give a buyer used to end
            here. Two ways out, both reachable without an account: file it
            with a reviewer, or write to a human. */}
        <p className="mt-2 text-xs font-medium text-red-800 dark:text-red-300">
          Do not pay for this item on the strength of this certificate.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ReportCertificateDialog certificateId={certificateId} />
          <a
            href="mailto:support@gradethread.com"
            className="text-xs font-medium text-red-800 underline underline-offset-2 dark:text-red-300"
          >
            Email support
          </a>
        </div>
      </div>
    );
  }

  // US-2132: the grade data hashes consistently but carries no signature, so we
  // can't rule out that both were rewritten together. Deliberately softer than
  // 'mismatch' (no evidence of tampering) and firmer than 'unverifiable' (this
  // certificate is NOT pre-scheme — it should have been signed and wasn't).
  if (result.status === "unsigned") {
    return (
      <div className="rounded-lg border border-amber-600/40 bg-amber-50 px-4 py-3 text-sm dark:bg-amber-950/30">
        <div className="flex items-center gap-2 font-medium text-amber-800 dark:text-amber-400">
          <ShieldAlert className="h-5 w-5" />
          Integrity could not be confirmed
        </div>
        <p className="mt-1 text-xs text-amber-900/80 dark:text-amber-300/80">
          This certificate has no cryptographic signature on record, so we can’t
          confirm the grade data is unaltered.
        </p>
        {/* US-2550: this copy said "contact support" and gave no way to do it. */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ReportCertificateDialog certificateId={certificateId} tone="caution" />
          <a
            href="mailto:support@gradethread.com"
            className="text-xs font-medium text-amber-900 underline underline-offset-2 dark:text-amber-300"
          >
            Email support
          </a>
        </div>
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
  const [searchParams] = useSearchParams();
  const [gradeReport, setGradeReport] = useState<PublicGradeReportRow | null>(null);
  const [submission, setSubmission] = useState<SubmissionRow | null>(null);
  // US-1912: the grader's Grade Integrity standing, or null when they have none
  // to show. The SSR Pages Function renders the same field from the same payload.
  const [sellerIntegrity, setSellerIntegrity] = useState<{
    tier: string;
    label: string;
    handle: string;
    // US-1913: the grader's level flair, beside the tier. Null below level 1.
    level?: { level: number; tier_name: string; tier_blurb: string } | null;
  } | null>(null);
  const [images, setImages] = useState<SubmissionImageRow[]>([]);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verify, setVerify] = useState<VerifyState>({ phase: "idle" });
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  // US-1095: the garment's passport slug, if this certificate is linked to a
  // Garment Passport. Resolved from the PII-free public_passport_links view.
  const [passportSlug, setPassportSlug] = useState<string | null>(null);

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

  // US-769: attribute the view once the certificate resolves. `?s=` lets us
  // tell a QR scan (slab, s=qr) from a shared link (s=share) or a direct visit
  // — no buyer PII, and consent-gated by track() so it's a no-op until opt-in.
  useEffect(() => {
    if (!gradeReport || !id) return;
    track("cert_view", {
      certificate_id: id,
      source: searchParams.get("s") ?? "direct",
    });
    // US-3060 AC6: the SITE half of the install loop. The extension's own
    // badge_shown counter is opt-in telemetry with no listing id; this is the
    // arrival, which is the half that says whether the badge earns anything.
    // Carries the platform and nothing else — the badge works without us
    // learning what anyone browses.
    const arrival = badgeArrival(searchParams);
    if (arrival) {
      track("badge_certificate_click", { platform: arrival.platform ?? "unknown" });
    }
    // US-769: bump the server-side view counter once per browser session (coarse
    // + abuse-resistant enough for a soft "viewed N times" signal). No PII.
    try {
      const key = `gt_cv_${id}`;
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, "1");
        void fetch(
          `${edgeApiUrl()}/api/content/public/certificates/${encodeURIComponent(id)}/view`,
          { method: "POST" },
        ).catch(() => {});
        // US-1760: attribute a badge-driven arrival to the seller. Only for the
        // badge/embed/qr sources; the owner is resolved server-side. Once per
        // session (shares the view session-key gate above).
        //
        // US-1854 adds `share`: a visit that came from a link the seller shared
        // is the verified click-through the share-to-earn loop pays for. The
        // server decides whether it counts (bot gate, self-click, fingerprint) —
        // this only reports that the arrival happened.
        const src = searchParams.get("s") ?? "";
        if (src === "embed" || src === "badge" || src === "qr" || src === "share") {
          void fetch(`${edgeApiUrl()}/api/content/public/badge-click`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              targetType: "cert",
              targetId: id,
              source: src,
              // US-1913 AC5: which FORMAT of badge sent them. `?s=` is
              // untouched — this is the second, independent axis, so a status
              // badge's click-throughs can be compared against a plain one's.
              variant: parseBadgeVariant(searchParams.get("v")),
            }),
          }).catch(() => {});
        }
      }
    } catch {
      /* storage/network disabled — the counter is best-effort */
    }
    // Fire once per resolved certificate, not on every searchParams identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gradeReport?.id, id]);

  useEffect(() => {
    if (!id) return;
    // US-1632: guard against an A→B certificate navigation race so the old id's
    // async continuations never write over the new page.
    let cancelled = false;

    async function fetchCertificate() {
      setLoading(true);
      setError(null);
      setGradeReport(null);
      setPassportSlug(null);
      // US-1632's A→B navigation guard applies here too: a stale standing from
      // the previous certificate would attribute one seller's record to another.
      setSellerIntegrity(null);

      // US-348: read the column-restricted public_grade_reports view, not the
      // base table. Anonymous viewers get only public-safe certificate fields.
      const { data: reportData, error: reportError } = await supabase
        .from("public_grade_reports")
        .select("*")
        .eq("certificate_id", id!)
        .single();

      if (cancelled) return;
      if (reportError || !reportData) {
        setError("Certificate not found");
        setLoading(false);
        return;
      }

      const report = reportData as PublicGradeReportRow;
      setGradeReport(report);

      // US-1095: resolve the Garment Passport slug (if any) from the PII-free
      // public view so buyers can open the garment's full history + claim it.
      const { data: passportLink } = await supabase
        .from("public_passport_links")
        .select("passport_slug")
        .eq("certificate_id", id!)
        .maybeSingle();
      if (cancelled) return;
      if (passportLink) {
        setPassportSlug((passportLink as { passport_slug: string }).passport_slug);
      }

      // Set OG meta tags
      document.title = `GradeThread Certificate — Grade ${report.overall_score.toFixed(1)} (${report.grade_tier})`;
      setMetaTag("og:title", `GradeThread Grade Certificate — ${report.grade_tier}`);
      setMetaTag("og:description", `Verified condition grade: ${report.overall_score.toFixed(1)}/10.0 (${report.grade_tier}). Graded by GradeThread AI.`);
      setMetaTag("og:url", `${window.location.origin}/cert/${id}`);
      // US-425: og:type=product matches the page's primary entity (a Product
      // JSON-LD node) and the cert SSR Pages Function — keeps the two paths
      // consistent so crawler markup doesn't drift.
      setMetaTag("og:type", "product");

      // US-1413: garment facts + the photo gallery come from the public
      // service-role endpoint, NOT direct anon reads of submissions /
      // submission-images (both are owner-only via RLS, so a logged-out buyer —
      // the certificate's primary audience — would otherwise get no photos,
      // title, or "About this item" after the SSR HTML hydrates). The cert SSR
      // Pages Function already uses this same endpoint.
      try {
        const certRes = await fetch(
          `${edgeApiUrl()}/api/content/public/certificates/${encodeURIComponent(id!)}`,
        );
        if (cancelled) return;
        if (certRes.ok) {
          const { certificate } = (await certRes.json()) as {
            certificate?: {
              title: string | null;
              brand: string | null;
              garment_type: string | null;
              garment_category: string | null;
              description: string | null;
              // US-1912: the grader's Grade Integrity standing. Null unless they
              // publish a verified profile AND clear the display floor — the
              // edge decides both, so this page just renders what it is given.
              seller_integrity?: {
                tier: string;
                label: string;
                handle: string;
                level?: {
                  level: number;
                  tier_name: string;
                  tier_blurb: string;
                } | null;
              } | null;
              images?: Array<{
                id: string;
                image_type: string;
                display_order: number;
                url: string;
              }>;
            };
          };
          if (certificate) {
            setSellerIntegrity(certificate.seller_integrity ?? null);
            setSubmission({
              title: certificate.title,
              brand: certificate.brand,
              garment_type: certificate.garment_type,
              garment_category: certificate.garment_category,
              description: certificate.description,
            } as SubmissionRow);

            const gallery = [...(certificate.images ?? [])].sort(
              (a, b) => a.display_order - b.display_order,
            );
            setImages(
              gallery.map(
                (img) =>
                  ({
                    id: img.id,
                    submission_id: report.submission_id,
                    image_type: img.image_type,
                    display_order: img.display_order,
                    storage_path: "",
                  }) as SubmissionImageRow,
              ),
            );
            setImageUrls(
              Object.fromEntries(gallery.map((img) => [img.id, img.url])),
            );
          }
        }
      } catch {
        /* network/edge down — the grade + scores still render from the view */
      }

      if (cancelled) return;
      setLoading(false);
    }

    fetchCertificate();
    return () => {
      cancelled = true;
    };
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

  // Factor breakdown is category-aware: a non-clothing report carries a generic
  // factor_scores map + rubric_key (migration 00231); clothing/legacy reports
  // use the 5 typed columns. Both render through the rubric's factor defs, so
  // clothing certificates are unchanged.
  const clothingColumnScore: Record<string, number> = {
    fabric_condition: gradeReport.fabric_condition_score,
    structural_integrity: gradeReport.structural_integrity_score,
    cosmetic_appearance: gradeReport.cosmetic_appearance_score,
    functional_elements: gradeReport.functional_elements_score,
    odor_cleanliness: gradeReport.odor_cleanliness_score,
  };
  const activeRubric = rubricForKey(
    gradeReport.factor_scores && gradeReport.rubric_key
      ? gradeReport.rubric_key
      : "clothing",
  );
  const factorScores = activeRubric.factors.map((f) => ({
    key: f.key,
    label: f.label,
    weight: f.weight,
    score: gradeReport.factor_scores?.[f.key] ?? clothingColumnScore[f.key] ?? 0,
  }));

  // US-328: genuine defects, worst-first. Empty for clean items / historical
  // grades that never persisted structured defects.
  const defects = [...(gradeReport.defects_found ?? [])].sort(
    (a, b) =>
      (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3)
  );

  // US-1287: PSA-style defect callouts. The grader localizes most defects to a
  // normalized bbox (exposed on the public view, migration 00313). Number them
  // across images and keep only groups whose source photo we have a URL for.
  // Defects with no bbox aren't drawn — they stay in the text list above.
  const annotatedGroups = buildAnnotatedGroups(gradeReport.defect_annotations);
  const urlByImageType = new Map<string, string>();
  for (const img of images) {
    const url = imageUrls[img.id];
    if (url && !urlByImageType.has(img.image_type)) {
      urlByImageType.set(img.image_type, url);
    }
  }
  const renderableAnnotations = annotatedGroups.filter((g) =>
    urlByImageType.has(g.image_type)
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

  // US-433: one trail powers both the visible breadcrumb and the BreadcrumbList
  // JSON-LD, mirroring the cert SSR Pages Function (functions/cert/[id].ts).
  const breadcrumbTrail = [
    { name: "GradeThread", url: `${SITE_URL}/` },
    { name: "Grade Certificate", url: `${SITE_URL}/cert/${id ?? ""}` },
  ];

  // PSA-style public number: ONLY the stored, verifiable cert number (00307).
  // US-1945: never fall back to a UUID-derived look-alike — that code isn't
  // stored and would fail the /verify lookup, so a report without a real number
  // simply shows none (it's still identified by its /cert/<id> URL + QR).
  const certNumber = gradeReport.certificate_number ?? null;

  // US-3060 AC7. A visitor who arrived from an on-marketplace badge already has
  // the extension, so the note tells them what they are looking at rather than
  // selling them anything. Null on every ordinary visit, and null on a badge
  // link naming a platform we do not recognise — "seen via the extension"
  // without saying where adds nothing and still has to be read.
  //
  // ⚠ AC7 also asks to HIDE "the existing install CTA" here. There is none:
  // this page does not use MarketingLayout, which is what renders
  // ExtensionInstallCta, so there was never a CTA on a certificate to hide.
  // isExtensionInstalled() is used anyway, to suppress the note for someone who
  // reached a badge URL WITHOUT the extension (a shared or pasted link), where
  // "seen via the extension" would be describing something that did not happen.
  const arrivalNote = isExtensionInstalled()
    ? badgeArrivalNote(badgeArrival(searchParams))
    : null;

  return (
    <div className="min-h-screen bg-background">
      <SEO
        title={`Grade Certificate - ${gradeReport.grade_tier} (${gradeReport.overall_score.toFixed(1)}/10)`}
        description={`Verified GradeThread grade certificate for ${submission?.title ?? "garment"}. Grade: ${gradeReport.grade_tier} (${gradeReport.overall_score.toFixed(1)}/10).`}
        ogType="product"
        canonicalUrl={`https://gradethread.com/cert/${id}`}
        jsonLd={[
          certificateLd({
            id: id ?? "",
            title: submission?.title ?? "Graded garment",
            overallScore: gradeReport.overall_score,
            gradeTier: gradeReport.grade_tier,
            category: submission?.garment_category ?? null,
            brand: submission?.brand ?? null,
            // US-2206: mirrors the SSR path exactly — the full ordered
            // gallery as stable /cert-photo urls, never the signed ones.
            images: certGalleryImageUrls(id ?? "", images.length),
            datePublished: gradeReport.created_at,
            // US-2392 / US-2071 AC3: dateModified ONLY when the certified
            // content actually changed. NULL on an unrevised certificate — and
            // omitting it is the truthful answer, because a regrade mints a NEW
            // certificate_id whose modification date IS its publication date.
            // Emitting one there would tell a crawler that a fresh certificate
            // had been edited.
            dateModified: gradeReport.certified_content_updated_at ?? null,
          }),
          breadcrumbLd(breadcrumbTrail),
        ]}
      />
      {/* US-3060: where this visit came from, when it came from a badge on a
          marketplace listing. print:hidden — it describes the arrival, not the
          certificate, so it has no place on a printed copy. */}
      {arrivalNote ? (
        <div className="border-b bg-muted/30 print:hidden">
          <p className="mx-auto max-w-3xl px-6 py-2 text-center text-xs text-muted-foreground">
            {arrivalNote}
          </p>
        </div>
      ) : null}
      {/* Header with branding (hidden when printing — replaced by a clean
          print-only title below). */}
      <div className="bg-brand-navy py-6 text-white print:hidden">
        <div className="mx-auto flex max-w-3xl flex-col items-center gap-3 px-6">
          <div className="flex items-center gap-3">
            <img
              src="/logo_white.png"
              width={1806}
              height={376}
              alt="GradeThread"
              className="h-8"
            />
          </div>
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            <div>
              <h1 className="text-lg font-bold sm:text-xl">
                {submission?.title
                  ? `${submission.title} — Grade ${gradeReport.overall_score.toFixed(1)} Certificate`
                  : `Grade ${gradeReport.overall_score.toFixed(1)} Certificate`}
              </h1>
              {certNumber && (
                <p className="font-mono text-xs text-white/70">
                  Certificate No. {certNumber}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Print-only header (US-767): keeps GradeThread branding on the PDF
          without the dark banner that doesn't render on white paper. */}
      <div className="mx-auto hidden max-w-3xl px-6 pt-6 print:block">
        <p className="text-xl font-bold text-brand-navy dark:text-foreground">GradeThread</p>
        <p className="text-sm text-muted-foreground">
          Verified Grade Certificate
        </p>
        {certNumber && (
          <p className="font-mono text-xs text-muted-foreground">
            Certificate No. {certNumber}
          </p>
        )}
      </div>

      {/* Main content */}
      <main className="mx-auto max-w-3xl space-y-6 px-6 py-8">
        {/* US-433: visible breadcrumb matching the BreadcrumbList JSON-LD.
            Hidden on print to keep the certificate PDF clean. */}
        <Breadcrumbs items={breadcrumbTrail} className="print:hidden" />
        {/* Share / save actions (US-767) — interactive, so dropped on print.
            US-1806: entitled buyers can watch this certificate for condition
            alerts (the button renders nothing for everyone else). */}
        <div className="flex flex-wrap items-center justify-end gap-2 print:hidden">
          <WatchButton
            targetType="certificate"
            targetId={id ?? ""}
            label={submission?.title ?? "Graded garment"}
            brand={submission?.brand ?? null}
          />
          <CertShareActions
            certificateId={id ?? ""}
            title={submission?.title ?? "Graded garment"}
            score={gradeReport.overall_score}
            tier={gradeReport.grade_tier}
          />
        </div>
        {/* US-1095: Garment Passport carry-forward. When this certificate is
            linked to a passport, surface the full ownership/condition history so
            a buyer can open it and claim the item after purchase. */}
        {passportSlug && (
          <Link
            to={`/passport/${passportSlug}`}
            className="flex items-center justify-between gap-3 rounded-lg border border-brand-navy/20 bg-brand-navy/5 px-4 py-3 transition-colors hover:bg-brand-navy/10 print:hidden dark:border-blue-400/20 dark:bg-blue-400/5"
          >
            <span className="flex flex-col gap-1.5 text-sm font-medium text-brand-navy dark:text-blue-300">
              <span className="flex items-center gap-2">
                <History className="h-4 w-4" />
                View this garment's full Passport — provenance &amp; ownership history
              </span>
              {/* US-1102: this grade is a VERIFIED (deterministic) link in the
                  chain — show its confidence with the taxonomy tooltip. */}
              <Badge
                variant="outline"
                className="w-fit gap-1 border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300"
                title={confidenceInfo("deterministic").tooltip}
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                {confidenceInfo("deterministic").label} grade
              </Badge>
            </span>
            <ArrowRight className="h-4 w-4 flex-shrink-0 text-brand-navy dark:text-blue-300" />
          </Link>
        )}
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
                {/* US-2871: the band the tier stands for, from the one
                    GRADE_TIER_BANDS table. */}
                <p className="mt-1 text-sm text-muted-foreground">
                  Scores {tierBandRange(gradeReport.grade_tier)} out of 10
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

        {/* US-1665: "What does a {grade} grade mean?" — varies by band, links to
            the canonical scale (the flywheel back to /grading/scale). */}
        <Card>
          <CardContent className="pt-6">
            <h2 className="text-base font-semibold">
              What does a {gradeReport.overall_score.toFixed(1)} grade mean?
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {gradeBandMeaning(gradeReport.overall_score)} It sits on the
              GradeThread Scale, the standardized 1.0–10.0 system for pre-owned
              clothing condition.
            </p>
            <Link
              to="/grading/scale"
              className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand-navy hover:underline dark:text-blue-300"
            >
              See the full grading scale
              <ArrowRight className="h-4 w-4" />
            </Link>
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
                          loading="lazy"
                          decoding="async"
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

        {/* US-1287: Defect callouts — the stored bounding boxes drawn over the
            relevant photos, PSA-style, so a buyer sees exactly WHERE each flaw
            is, not just a text list. Defects the grader couldn't localize stay
            in the "Condition & Flaws" list below. */}
        {renderableAnnotations.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Defect Callouts</CardTitle>
              <CardDescription>
                Each documented flaw highlighted on the photo, labeled by type
                and severity — the same defects detailed in the report below.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {renderableAnnotations.map((group) => (
                <AnnotatedDefectPhoto
                  key={group.image_type}
                  imageType={group.image_type}
                  url={urlByImageType.get(group.image_type)!}
                  annotations={group.annotations}
                />
              ))}
            </CardContent>
          </Card>
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
                {/* US-1787: per-grade circularity impact estimate. */}
                <CertImpactLine garmentType={submission.garment_type} />
              </CardContent>
            </Card>
          )}

        {/* Factor Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Factor Breakdown</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* US-2225 AC3. On a handbag the condition grade and the
                authenticity add-on land on the same certificate — every tell
                pack we hold is a bag brand — so a number beside a luxury logo
                reads as a verdict on the logo unless this says otherwise. It
                sits INSIDE the breakdown card, above the factors, rather than
                in a footer: the separation has to be adjacent to the number it
                qualifies, or it is a disclaimer nobody reaches. */}
            {needsAuthenticitySeparation(gradeReport.rubric_key) && (
              <p className="rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
                {CONDITION_NOT_AUTHENTICITY_DISCLOSURE}
              </p>
            )}
            {factorScores.map(({ key, label, weight, score }) => {
              return (
                <div key={key} className="space-y-1.5">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">
                      {label}{" "}
                      <span className="text-muted-foreground">
                        ({(weight * 100).toFixed(0)}%)
                      </span>
                    </span>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 font-semibold",
                        getScoreColor(score)
                      )}
                    >
                      <ScoreBandIcon score={score} />
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
            <ScoreExplainer
              factors={factorScores}
              overallScore={gradeReport.overall_score}
              className="mt-2"
            />
          </CardContent>
        </Card>

        {/* Condition report (US-759) — the longer buyer-facing write-up when
            present, else the short AI summary. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {gradeReport.buyer_writeup ? "Condition Report" : "AI Analysis Summary"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">
              {gradeReport.buyer_writeup || gradeReport.ai_summary}
            </p>
          </CardContent>
        </Card>

        {/* US-1278: photo-coverage badge + silhouette heatmap. Shows what
            fraction of the garment the seller documented and which zones are
            outside the grade/guarantee scope. Degrades gracefully — hidden on
            older certificates (pre-00308) that carry no coverage record. */}
        {gradeReport.coverage && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Coverage</CardTitle>
              <CardDescription>
                How much of the garment the seller&apos;s photos documented. The
                grade and Grade Accuracy Guarantee cover only documented zones.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CoverageHeatmap coverage={gradeReport.coverage} />
            </CardContent>
          </Card>
        )}

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
              <Gauge className="mt-0.5 h-5 w-5 flex-shrink-0 text-brand-navy dark:text-foreground" />
              <div>
                <p className="text-sm font-medium">
                  Grade confidence: {confidenceLabel(gradeReport.confidence_label)}
                </p>
                {/* US-2399: this used to read "low-confidence grades are routed
                    to a human reviewer", which implied review is the EXCEPTION.
                    Since 00312 review is mandatory for every certified grade, so
                    that wording both understated the process and contradicted the
                    AI disclosure lower down the page. Describe confidence itself
                    and let the Human-reviewed row below make the review claim,
                    per-grade. */}
                <p className="text-xs text-muted-foreground">
                  How strongly the seller&apos;s photos supported the automated
                  assessment.
                </p>
              </div>
            </div>

            {/* Human review */}
            {gradeReport.human_reviewed && (
              <div className="flex items-start gap-3">
                <UserCheck className="mt-0.5 h-5 w-5 flex-shrink-0 text-green-600 dark:text-green-400" />
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
                  <ShieldAlert className="mt-0.5 h-5 w-5 flex-shrink-0 text-yellow-600 dark:text-yellow-400" />
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
                  <ShieldCheck className="mt-0.5 h-5 w-5 flex-shrink-0 text-green-600 dark:text-green-400" />
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

            {/* US-1281: 360-Verified badge — the premium photogrammetric/LiDAR
                capture tier. Shown only when a guided 360 capture proved true
                geometric coverage of the garment (every inspection zone
                documented). An orthogonal coverage signal — it can appear
                alongside the Live-Verified / Verified Capture badges. */}
            {gradeReport.verified_360_badge && (
              <div className="flex items-start gap-3">
                <Box className="mt-0.5 h-5 w-5 flex-shrink-0 text-brand-navy dark:text-brand-red-text" />
                <div>
                  <p className="text-sm font-medium">360-Verified</p>
                  <p className="text-xs text-muted-foreground">
                    Shot with a guided scan from every angle, using depth
                    where the phone has it. Every part of the garment is on
                    camera, so the grade and the guarantee cover the whole
                    item rather than the few spots a flat photo shows.
                  </p>
                </div>
              </div>
            )}

            {/* US-1762: Video-Verified badge — the walk-around-clip capture
                tier. Shown only when this grade was read off frames the SERVER
                extracted from one continuous clip, with no suspected
                manipulation and no cross-account reuse. Orthogonal to the badges
                around it: it speaks to where the VIEWS came from, not to device
                attestation or geometric coverage, so it can appear alongside
                them. Its absence is never a negative claim. */}
            {gradeReport.video_capture_verified && (
              <div className="flex items-start gap-3">
                <Video className="mt-0.5 h-5 w-5 flex-shrink-0 text-brand-navy dark:text-brand-red-text" />
                <div>
                  <p className="text-sm font-medium">
                    Video-Verified
                    {gradeReport.video_live_capture_verified && " · recorded live"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Every view below was pulled by GradeThread out of a single
                    continuous walk-around video of this item. The angles were
                    chosen by us, not staged one at a time, so no single shot
                    could be swapped for a better-looking garment.
                    {gradeReport.video_live_capture_verified &&
                      " The seller recorded that video inside the GradeThread app, so the footage never existed as a file beforehand."}
                  </p>
                </div>
              </div>
            )}

            {/* US-1283: Live-Verified badge — the flagship fraud-proof tier.
                Shown only when every photo was captured live in-app
                (device-attested), provenance verified, and no manipulation was
                detected. Un-fakeable condition proof: it can't be Photoshopped or
                pulled from a stock listing. Stronger than (and shown instead of)
                the standard Verified Capture badge below. */}
            {gradeReport.live_capture_verified && (
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 h-5 w-5 flex-shrink-0 text-brand-red-text dark:text-brand-red-text" />
                <div>
                  <p className="text-sm font-medium">Live-Verified</p>
                  <p className="text-xs text-muted-foreground">
                    Every photo was captured live in the GradeThread app —
                    device-attested and timestamped, with verified provenance and
                    no signs of manipulation. Un-fakeable condition proof that
                    can&apos;t be edited or pulled from a stock listing.
                  </p>
                </div>
              </div>
            )}

            {/* US-340: Verified Capture badge — shown only when the seller's
                opt-in provenance checks passed (consistent, recent, unedited
                device capture; no reused photos). A positive trust signal; its
                absence is never a negative. Suppressed when the stronger
                Live-Verified badge above is present (it supersedes this one). */}
            {!gradeReport.live_capture_verified &&
              gradeReport.verified_capture_passed && (
              <div className="flex items-start gap-3">
                <BadgeCheck className="mt-0.5 h-5 w-5 flex-shrink-0 text-green-600 dark:text-green-400" />
                <div>
                  <p className="text-sm font-medium">Verified Capture</p>
                  <p className="text-xs text-muted-foreground">
                    These photos were captured with verified provenance —
                    consistent, recent device metadata and no reused images.
                  </p>
                </div>
              </div>
            )}

            {/* US-861: "Original photos verified" badge — shown only when the
                photo-reuse scan ran and found no cross-account match (the
                stock/stolen-listing tell). A positive-only trust signal; its
                absence is never a negative claim, and flagged/reused submissions
                stay withheld from this public surface entirely. */}
            {gradeReport.original_photos_verified && (
              <div className="flex items-start gap-3">
                <ImageIcon className="mt-0.5 h-5 w-5 flex-shrink-0 text-green-600 dark:text-green-400" />
                <div>
                  <p className="text-sm font-medium">Original photos verified</p>
                  <p className="text-xs text-muted-foreground">
                    These images were checked against our database and don&apos;t
                    match photos from any other seller — they&apos;re the
                    seller&apos;s own, not stock or reused listing photos.
                  </p>
                </div>
              </div>
            )}

            {/* US-1912: the grader's Grade Integrity standing. Distinct from
                every badge above it — those describe THIS capture, while this
                describes how often buyers, after delivery, confirmed that a
                grade from this seller matched. Positive-only in the same way:
                a seller below the anti-gaming floor sends null and nothing
                renders, so its absence is never a negative claim. */}
            {sellerIntegrity && (
              <div className="flex items-start gap-3">
                <BadgeCheck className="mt-0.5 h-5 w-5 flex-shrink-0 text-brand-navy dark:text-foreground" />
                <div className="space-y-1">
                  <p className="text-sm font-medium" title={INTEGRITY_TIER_BASIS}>
                    Graded by a {sellerIntegrity.label}
                  </p>
                  {/* US-1913 AC2: the level flair beside the tier — the same
                      pair the seller's public profile shows. Kept visually
                      secondary, and tooltipped separately, because the two say
                      different things: a level is how much they do, a tier is
                      how right they have been proven. */}
                  {sellerIntegrity.level && (
                    <p
                      className="text-xs font-medium text-brand-navy dark:text-foreground"
                      title={LEVEL_FLAIR_BASIS}
                    >
                      Level {sellerIntegrity.level.level} ·{" "}
                      {sellerIntegrity.level.tier_name}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {INTEGRITY_TIER_BASIS}{" "}
                    <Link
                      to={`/verified/${sellerIntegrity.handle}`}
                      className="underline underline-offset-2"
                    >
                      See this seller&apos;s record
                    </Link>
                  </p>
                </div>
              </div>
            )}

            {/* US-601: premium authenticity / counterfeit-confidence add-on.
                Shown only when the seller purchased it. A SEPARATE garment-
                authenticity signal — clearly distinct from the "Authenticity
                check" (photo-tamper) above. A confidence estimate, with its
                limitations disclosed. */}
            {gradeReport.authenticity_addon_included && (
              <div className="flex items-start gap-3">
                <ShieldCheck
                  className={cn(
                    "mt-0.5 h-5 w-5 flex-shrink-0",
                    gradeReport.authenticity_counterfeit_risk === "low"
                      ? "text-green-600 dark:text-green-400"
                      : gradeReport.authenticity_counterfeit_risk === "high"
                        ? "text-red-600 dark:text-red-400"
                        : "text-yellow-600 dark:text-yellow-400"
                  )}
                />
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    Authenticity check (counterfeit confidence)
                    {gradeReport.authenticity_confidence_label
                      ? ` — ${gradeReport.authenticity_confidence_label} confidence`
                      : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {gradeReport.authenticity_summary ||
                      "Garment authenticity was assessed against the claimed brand."}
                  </p>
                  {gradeReport.authenticity_limitations && (
                    <p className="text-xs italic text-muted-foreground">
                      {gradeReport.authenticity_limitations}
                    </p>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* US-514: AI-transparency disclosure. Buyers must be clearly told how
            the grade was produced. US-2399 moved the wording into the shared
            <AiDisclosure> so the certificate, the embed page and the partner
            widget can never drift apart, and made it per-grade: a mandatory-review
            grade (00312) is described as human-finalized, a legacy AI-only grade
            is not. Wording mirrors Terms §5. */}
        <AiDisclosure humanReviewed={gradeReport.human_reviewed} />

        {/* Intentional design features — buyers see distressing was assessed
            as styling, not counted against the condition grade. */}
        {gradeReport.detected_style_attributes &&
          gradeReport.detected_style_attributes.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Design Features</CardTitle>
                <CardDescription>
                  Things the maker put there on purpose. They are read as
                  style, not as damage, and the grade is against how the
                  garment left the factory.
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
          <Card className="print:hidden">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ImageIcon className="h-5 w-5 text-brand-navy dark:text-foreground" />
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
          <Card className="print:hidden">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <BadgeCheck className="h-5 w-5 text-brand-navy dark:text-foreground" />
                Add this badge to your listing
              </CardTitle>
              <CardDescription>
                Paste it into your eBay, Poshmark, Mercari, Depop or Grailed
                listing — or your own store or blog. Buyers see the verified
                grade and can tap to confirm it here.
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
                label="Script (websites &amp; blogs — Shopify, your own store)"
                value={certBadgeScriptEmbed(id)}
              />
              <CopyField
                label="HTML image (marketplace listing descriptions)"
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
        <IntegrityPanel
          state={verify}
          onRetry={runVerify}
          certificateId={id ?? ""}
        />

        {/* US-867: buyer trust guarantee — let a buyer who received an item
            materially not as graded file a mediation claim against this cert. */}
        {id && (
          <div className="rounded-lg border bg-muted/30 p-4 text-center text-sm text-muted-foreground print:hidden">
            Bought this item and it&apos;s materially not as graded?{" "}
            <a
              href={`/buyer-guarantee/claim?cert=${encodeURIComponent(id)}`}
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              File a buyer-guarantee claim
            </a>
            . Read the{" "}
            <a
              href="/buyer-guarantee"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              guarantee policy
            </a>
            .
          </div>
        )}

        {/* US-1111: conversion CTAs on the most-shared public surface — turn
            certificate viewers into graders (buyers) and resellers instead of
            dead-ending. Reuses the measurable, dismissable cross-surface nudge;
            crossSurfacePromosEnabled defaults true so anonymous visitors see
            the grade-your-own path. */}
        <div className="space-y-3 print:hidden">
          <CrossSurfaceNudge
            nudgeId="cert-grade-your-own"
            icon={Camera}
            title="Grade your own garment"
            description="Get an objective 1.0–10.0 condition grade and a shareable certificate buyers trust — in minutes."
            cta={{ label: "Grade an item", to: "/whats-it-worth" }}
            context={{ surface: "certificate", certificate_id: id }}
          />
          <CrossSurfaceNudge
            nudgeId="cert-list-on-flipdesk"
            icon={Store}
            title="Sell it faster with FlipDesk"
            description="List across marketplaces with the grade built into your listing — fewer “not as described” returns."
            cta={{ label: "See FlipDesk", to: "/for-resellers" }}
            context={{ surface: "certificate", certificate_id: id }}
          />
        </div>

        {/* Powered by footer */}
        <div className="pb-4 text-center">
          <p className="text-xs text-muted-foreground">
            Powered by{" "}
            <a
              href="/"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              GradeThread
            </a>{" "}
            — The Standard for Clothing Condition Grading
          </p>
        </div>
      </main>
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
