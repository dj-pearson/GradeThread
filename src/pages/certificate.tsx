import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import { Shield, AlertTriangle, Calendar, Cpu } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { GRADE_FACTORS } from "@/lib/constants";
import { supabase } from "@/lib/supabase";
import type {
  GradeReportRow,
  SubmissionRow,
  SubmissionImageRow,
} from "@/types/database";

function getScoreColor(score: number): string {
  if (score > 7) return "text-green-600";
  if (score >= 5) return "text-yellow-600";
  return "text-red-600";
}

function getScoreBorderColor(score: number): string {
  if (score > 7) return "border-green-500";
  if (score >= 5) return "border-yellow-500";
  return "border-red-500";
}

function getTierBadgeClasses(score: number): string {
  if (score > 7) return "bg-green-100 text-green-800 border-green-200";
  if (score >= 5) return "bg-yellow-100 text-yellow-800 border-yellow-200";
  return "bg-red-100 text-red-800 border-red-200";
}

function getProgressColor(score: number): string {
  if (score > 7) return "[&>div]:bg-green-500";
  if (score >= 5) return "[&>div]:bg-yellow-500";
  return "[&>div]:bg-red-500";
}

function formatLabel(value: string): string {
  return value
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
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
  const [gradeReport, setGradeReport] = useState<GradeReportRow | null>(null);
  const [submission, setSubmission] = useState<SubmissionRow | null>(null);
  const [images, setImages] = useState<SubmissionImageRow[]>([]);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const certificateUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/cert/${id}`
      : "";

  useEffect(() => {
    if (!id) return;

    async function fetchCertificate() {
      setLoading(true);
      setError(null);

      // Fetch grade report by certificate_id (public via RLS)
      const { data: reportData, error: reportError } = await supabase
        .from("grade_reports")
        .select("*")
        .eq("certificate_id", id!)
        .single();

      if (reportError || !reportData) {
        setError("Certificate not found");
        setLoading(false);
        return;
      }

      const report = reportData as GradeReportRow;
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
            .createSignedUrl(img.storage_path, 3600);
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

  return (
    <div className="min-h-screen bg-background">
      {/* Header with branding */}
      <div className="bg-brand-navy py-6 text-white">
        <div className="mx-auto flex max-w-3xl flex-col items-center gap-3 px-6">
          <div className="flex items-center gap-3">
            <img
              src="/logo_white.svg"
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

        {/* Photo Gallery */}
        {images.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Garment Photos</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {images.map((img) => (
                  <div key={img.id} className="space-y-1.5">
                    <div className="aspect-square overflow-hidden rounded-lg border bg-muted">
                      {imageUrls[img.id] ? (
                        <img
                          src={imageUrls[img.id]}
                          alt={`${img.image_type} photo`}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center">
                          <Skeleton className="h-full w-full" />
                        </div>
                      )}
                    </div>
                    <Badge variant="outline" className="text-xs">
                      {formatLabel(img.image_type)}
                    </Badge>
                  </div>
                ))}
              </div>
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
              fgColor="#0F3460"
              level="M"
            />
            <p className="text-xs text-muted-foreground">Scan to verify</p>
          </div>
        </div>

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
            — AI-Powered Clothing Condition Grading
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
