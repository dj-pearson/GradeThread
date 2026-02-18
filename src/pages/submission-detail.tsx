import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  ArrowLeft,
  Share2,
  AlertTriangle,
  CheckCircle2,
  Info,
  Flag,
  Clock,
  Loader2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { GRADE_FACTORS } from "@/lib/constants";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";
import type {
  SubmissionRow,
  GradeReportRow,
  SubmissionImageRow,
  DisputeRow,
} from "@/types/database";

function getScoreColor(score: number): string {
  if (score > 7) return "text-green-600";
  if (score >= 5) return "text-yellow-600";
  return "text-red-600";
}

function getTierBadgeClasses(score: number): string {
  if (score > 7) return "bg-green-100 text-green-800 border-green-200";
  if (score >= 5) return "bg-yellow-100 text-yellow-800 border-yellow-200";
  return "bg-red-100 text-red-800 border-red-200";
}

function getConfidenceLabel(score: number): {
  label: string;
  color: string;
  icon: typeof CheckCircle2;
} {
  if (score > 0.85)
    return { label: "High", color: "text-green-600", icon: CheckCircle2 };
  if (score >= 0.75)
    return { label: "Medium", color: "text-yellow-600", icon: Info };
  return { label: "Low", color: "text-red-600", icon: AlertTriangle };
}

function formatLabel(value: string): string {
  return value
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function getProgressColor(score: number): string {
  if (score > 7) return "[&>div]:bg-green-500";
  if (score >= 5) return "[&>div]:bg-yellow-500";
  return "[&>div]:bg-red-500";
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Skeleton className="h-8 w-8" />
        <div className="space-y-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
        <div className="space-y-6">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    </div>
  );
}

export function SubmissionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [submission, setSubmission] = useState<SubmissionRow | null>(null);
  const [gradeReport, setGradeReport] = useState<GradeReportRow | null>(null);
  const [images, setImages] = useState<SubmissionImageRow[]>([]);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dispute, setDispute] = useState<DisputeRow | null>(null);
  const [disputeDialogOpen, setDisputeDialogOpen] = useState(false);
  const [disputeReason, setDisputeReason] = useState("");
  const [disputePhotos, setDisputePhotos] = useState<File[]>([]);
  const [submittingDispute, setSubmittingDispute] = useState(false);

  useEffect(() => {
    if (!id) return;

    async function fetchData() {
      setLoading(true);
      setError(null);

      // Fetch submission
      const { data: sub, error: subError } = await supabase
        .from("submissions")
        .select("*")
        .eq("id", id!)
        .single();

      if (subError || !sub) {
        setError("Submission not found.");
        setLoading(false);
        return;
      }
      setSubmission(sub);

      // Fetch grade report
      const { data: reportData } = await supabase
        .from("grade_reports")
        .select("*")
        .eq("submission_id", id!)
        .single();

      if (reportData) {
        setGradeReport(reportData);
      }

      // Fetch submission images
      const { data: imagesRaw } = await supabase
        .from("submission_images")
        .select("*")
        .eq("submission_id", id!);

      const imagesData = (imagesRaw ?? []) as SubmissionImageRow[];
      if (imagesData.length > 0) {
        const sorted = [...imagesData].sort(
          (a, b) => a.display_order - b.display_order
        );
        setImages(sorted);

        // Get signed URLs for images
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

      // Fetch existing dispute for this grade report
      if (reportData) {
        const reportId = (reportData as GradeReportRow).id;
        const { data: disputeData } = await supabase
          .from("disputes")
          .select("*")
          .eq("grade_report_id", reportId)
          .single();

        if (disputeData) {
          setDispute(disputeData as DisputeRow);
        }
      }

      setLoading(false);
    }

    fetchData();
  }, [id]);

  const canDispute =
    submission?.status === "completed" &&
    gradeReport &&
    !dispute &&
    (() => {
      const createdAt = new Date(gradeReport.created_at);
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      return createdAt > sevenDaysAgo;
    })();

  async function handleSubmitDispute() {
    if (!user || !gradeReport) return;

    if (disputeReason.trim().length < 20) {
      toast.error("Please provide a reason of at least 20 characters.");
      return;
    }

    setSubmittingDispute(true);

    try {
      // Upload dispute evidence photos if any
      if (disputePhotos.length > 0 && submission) {
        for (const photo of disputePhotos) {
          const ext = photo.name.split(".").pop() ?? "jpg";
          const path = `${user.id}/${submission.id}/dispute_${Date.now()}.${ext}`;
          await supabase.storage
            .from("submission-images")
            .upload(path, photo);
        }
      }

      const { data: newDispute, error: disputeError } = await supabase
        .from("disputes")
        .insert({
          grade_report_id: gradeReport.id,
          user_id: user.id,
          reason: disputeReason.trim(),
        } as never)
        .select()
        .single();

      if (disputeError) throw disputeError;

      // Update submission status to disputed
      await supabase
        .from("submissions")
        .update({ status: "disputed" } as never)
        .eq("id", submission!.id);

      setDispute(newDispute as DisputeRow);
      setSubmission((prev) =>
        prev ? { ...prev, status: "disputed" as const } : prev
      );
      setDisputeDialogOpen(false);
      setDisputeReason("");
      setDisputePhotos([]);
      toast.success("Dispute submitted successfully. We'll review it shortly.");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to submit dispute"
      );
    } finally {
      setSubmittingDispute(false);
    }
  }

  function getDisputeStatusBadge(status: string) {
    switch (status) {
      case "open":
        return "bg-yellow-100 text-yellow-800 border-yellow-200";
      case "under_review":
        return "bg-blue-100 text-blue-800 border-blue-200";
      case "resolved":
        return "bg-green-100 text-green-800 border-green-200";
      case "rejected":
        return "bg-red-100 text-red-800 border-red-200";
      default:
        return "";
    }
  }

  if (loading) {
    return <LoadingSkeleton />;
  }

  if (error || !submission) {
    return (
      <div className="space-y-6">
        <Link
          to="/dashboard/submissions"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Submissions
        </Link>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <AlertTriangle className="h-12 w-12 text-muted-foreground/50" />
            <h3 className="mt-4 text-lg font-medium">
              {error || "Submission not found"}
            </h3>
          </CardContent>
        </Card>
      </div>
    );
  }

  const factorScores = gradeReport
    ? [
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
      ]
    : [];

  const defects =
    gradeReport?.detailed_notes &&
    typeof gradeReport.detailed_notes === "object"
      ? Object.entries(gradeReport.detailed_notes).filter(
          ([key]) => key.toLowerCase().includes("defect") || key.toLowerCase().includes("issue")
        )
      : [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <Link
            to="/dashboard/submissions"
            className="inline-flex items-center justify-center rounded-md border p-2 hover:bg-muted"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold">{submission.title}</h1>
            <p className="text-sm text-muted-foreground">
              Submitted {new Date(submission.created_at).toLocaleDateString()}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={cn(
              submission.status === "completed" &&
                "border-green-200 bg-green-100 text-green-800",
              submission.status === "processing" &&
                "border-blue-200 bg-blue-100 text-blue-800",
              submission.status === "pending" &&
                "border-yellow-200 bg-yellow-100 text-yellow-800",
              submission.status === "failed" &&
                "border-red-200 bg-red-100 text-red-800"
            )}
          >
            {formatLabel(submission.status)}
          </Badge>
          {gradeReport?.certificate_id && (
            <Button variant="outline" size="sm" asChild>
              <Link to={`/cert/${gradeReport.certificate_id}`}>
                <Share2 className="mr-1 h-4 w-4" />
                Share Certificate
              </Link>
            </Button>
          )}
          {canDispute && (
            <Dialog open={disputeDialogOpen} onOpenChange={setDisputeDialogOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm">
                  <Flag className="mr-1 h-4 w-4" />
                  Dispute Grade
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Dispute This Grade</DialogTitle>
                  <DialogDescription>
                    Explain why you believe this grade is inaccurate. You can also
                    upload additional photos as evidence.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="dispute-reason">
                      Reason for dispute{" "}
                      <span className="text-muted-foreground">
                        (min 20 characters)
                      </span>
                    </Label>
                    <Textarea
                      id="dispute-reason"
                      placeholder="Describe why you believe this grade is inaccurate..."
                      value={disputeReason}
                      onChange={(e) => setDisputeReason(e.target.value)}
                      rows={4}
                    />
                    <p className="text-xs text-muted-foreground">
                      {disputeReason.length}/20 characters minimum
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>Additional evidence (optional)</Label>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const input = document.createElement("input");
                          input.type = "file";
                          input.accept = "image/jpeg,image/png,image/webp";
                          input.multiple = true;
                          input.onchange = (e) => {
                            const files = (e.target as HTMLInputElement).files;
                            if (files) {
                              setDisputePhotos((prev) => [
                                ...prev,
                                ...Array.from(files),
                              ]);
                            }
                          };
                          input.click();
                        }}
                      >
                        <Upload className="mr-1 h-4 w-4" />
                        Upload Photos
                      </Button>
                      {disputePhotos.length > 0 && (
                        <span className="text-sm text-muted-foreground">
                          {disputePhotos.length} photo
                          {disputePhotos.length !== 1 ? "s" : ""} selected
                        </span>
                      )}
                    </div>
                    {disputePhotos.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {disputePhotos.map((photo, i) => (
                          <Badge
                            key={i}
                            variant="secondary"
                            className="cursor-pointer"
                            onClick={() =>
                              setDisputePhotos((prev) =>
                                prev.filter((_, idx) => idx !== i)
                              )
                            }
                          >
                            {photo.name} &times;
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => setDisputeDialogOpen(false)}
                    disabled={submittingDispute}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleSubmitDispute}
                    disabled={
                      submittingDispute || disputeReason.trim().length < 20
                    }
                  >
                    {submittingDispute && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    Submit Dispute
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>

      {/* Garment Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Garment Information</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
            <div>
              <p className="text-muted-foreground">Title</p>
              <p className="font-medium">{submission.title}</p>
            </div>
            {submission.brand && (
              <div>
                <p className="text-muted-foreground">Brand</p>
                <p className="font-medium">{submission.brand}</p>
              </div>
            )}
            <div>
              <p className="text-muted-foreground">Type</p>
              <p className="font-medium">
                {formatLabel(submission.garment_type)}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Category</p>
              <p className="font-medium">
                {formatLabel(submission.garment_category)}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Grade Report */}
      {gradeReport ? (
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Left column: Score + Factors + Summary */}
          <div className="space-y-6 lg:col-span-2">
            {/* Overall Score */}
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-6">
                  <div
                    className={cn(
                      "flex h-24 w-24 flex-shrink-0 items-center justify-center rounded-full border-4",
                      gradeReport.overall_score > 7
                        ? "border-green-500"
                        : gradeReport.overall_score >= 5
                          ? "border-yellow-500"
                          : "border-red-500"
                    )}
                  >
                    <span
                      className={cn(
                        "text-3xl font-bold",
                        getScoreColor(gradeReport.overall_score)
                      )}
                    >
                      {gradeReport.overall_score.toFixed(1)}
                    </span>
                  </div>
                  <div>
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
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Factor Breakdown */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Factor Breakdown</CardTitle>
                <CardDescription>
                  Individual scores across 5 grading criteria
                </CardDescription>
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
          </div>

          {/* Right column: Confidence + Defects + Images */}
          <div className="space-y-6">
            {/* Confidence Score */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Confidence</CardTitle>
              </CardHeader>
              <CardContent>
                {(() => {
                  const conf = getConfidenceLabel(
                    gradeReport.confidence_score
                  );
                  const ConfIcon = conf.icon;
                  return (
                    <div className="flex items-center gap-3">
                      <ConfIcon className={cn("h-5 w-5", conf.color)} />
                      <div>
                        <p className={cn("font-semibold", conf.color)}>
                          {conf.label}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {(gradeReport.confidence_score * 100).toFixed(0)}%
                          confidence
                        </p>
                      </div>
                    </div>
                  );
                })()}
              </CardContent>
            </Card>

            {/* Defects */}
            {gradeReport.detailed_notes &&
              Object.keys(gradeReport.detailed_notes).length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">
                      Detected Issues
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {defects.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {defects.map(([key, value]) => (
                          <Badge key={key} variant="secondary">
                            {value}
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <ul className="space-y-1 text-sm">
                        {Object.entries(gradeReport.detailed_notes).map(
                          ([key, value]) => (
                            <li key={key} className="flex items-start gap-2">
                              <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-muted-foreground" />
                              <span>
                                <span className="font-medium">
                                  {formatLabel(key)}:
                                </span>{" "}
                                {value}
                              </span>
                            </li>
                          )
                        )}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              )}

            {/* Model version */}
            <div className="text-xs text-muted-foreground">
              Graded by model: {gradeReport.model_version}
            </div>
          </div>
        </div>

      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            {submission.status === "processing" ? (
              <>
                <div className="h-12 w-12 animate-spin rounded-full border-4 border-primary border-t-transparent" />
                <h3 className="mt-4 text-lg font-medium">
                  Grading in Progress
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Your garment is being analyzed. This usually takes a few
                  moments.
                </p>
              </>
            ) : submission.status === "failed" ? (
              <>
                <AlertTriangle className="h-12 w-12 text-red-500/50" />
                <h3 className="mt-4 text-lg font-medium">Grading Failed</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Something went wrong while grading this submission. Please try
                  again.
                </p>
              </>
            ) : (
              <>
                <Info className="h-12 w-12 text-muted-foreground/50" />
                <h3 className="mt-4 text-lg font-medium">
                  Grade Report Pending
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  The grade report will appear here once processing is complete.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Dispute Status */}
      {dispute && (
        <Card className="border-l-4 border-l-yellow-500">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Flag className="h-4 w-4" />
                Dispute
              </CardTitle>
              <Badge
                variant="outline"
                className={cn(getDisputeStatusBadge(dispute.status))}
              >
                {formatLabel(dispute.status)}
              </Badge>
            </div>
            <CardDescription>
              Submitted {new Date(dispute.created_at).toLocaleDateString()}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                Reason
              </p>
              <p className="text-sm">{dispute.reason}</p>
            </div>
            {dispute.resolution_notes && (
              <div>
                <p className="text-sm font-medium text-muted-foreground">
                  Resolution
                </p>
                <p className="text-sm">{dispute.resolution_notes}</p>
              </div>
            )}
            {(dispute.status === "open" ||
              dispute.status === "under_review") && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="h-4 w-4" />
                Your dispute is being reviewed. We{"'"}ll notify you when a
                decision is made.
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Image Gallery */}
      {images.length > 0 && (
        <>
          <Separator />
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Submitted Photos</CardTitle>
              <CardDescription>
                {images.length} photo{images.length !== 1 ? "s" : ""} submitted
              </CardDescription>
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
        </>
      )}
    </div>
  );
}
