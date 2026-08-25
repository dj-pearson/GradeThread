import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  FileSpreadsheet,
  FileArchive,
  Loader2,
  Lock,
  RotateCcw,
  Upload,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { edgeFetch } from "@/lib/edge-fetch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/hooks/use-auth";
import { useBillingSummary } from "@/hooks/use-billing-summary";
import { usePlanUsage } from "@/hooks/use-plan-usage";
import { estimateBulkCost, formatDollars } from "@/lib/bulk-cost-estimate";
import { parseSheet } from "@/lib/csv";
import { readZip, baseName, type ZipEntry } from "@/lib/zip";
import { compressImage } from "@/lib/image-utils";
import {
  GARMENT_TYPES,
  GARMENT_CATEGORIES,
  GRADETHREAD_TIERS,
  FLIPDESK_PLANS,
  type GradeTierKey,
} from "@/lib/constants";
import type { ImageType, FlipdeskPlan as FlipdeskPlanKey } from "@/types/database";

// Plans permitted to use bulk upload (PRD: gate behind the top two tiers).
//
// US-2398: these were the LEGACY user_plan names, checked against the frozen
// users.plan column. Nothing has written that column since the 2024 backfill,
// so it reads 'free' for every account created since — meaning bulk upload was
// locked for every customer who has ever paid for it. Now the live tiers,
// checked against the column entitlements actually use.
// US-2515: typed against the live plan keys, so a renamed or removed tier is a
// tsc error here rather than copy that names a plan nobody can buy.
const ALLOWED_PLANS: FlipdeskPlanKey[] = ["pro", "business"];

// Turnaround tiers a CSV `tier` column / the default-tier selector may name.
// Mirrors GRADETHREAD_TIERS (and the edge GRADE_TIERS allowlist in grade.ts).
const TURNAROUND_TIERS = Object.keys(GRADETHREAD_TIERS) as GradeTierKey[];

function isTurnaroundTier(value: string): value is GradeTierKey {
  return (TURNAROUND_TIERS as string[]).includes(value);
}

// Photos are assigned image types by their position in the photo_filenames
// list. The grading pipeline requires front, back, label and one detail shot.
const IMAGE_TYPE_BY_INDEX: ImageType[] = ["front", "back", "label", "detail"];
const REQUIRED_PHOTO_COUNT = 4;

interface ParsedRow {
  rowNumber: number;
  title: string;
  brand: string;
  garmentType: string;
  garmentCategory: string;
  photoFilenames: string[];
  // Raw, lowercased value from the optional CSV `tier` column ("" when omitted).
  // Resolved to a real GradeTierKey via resolveTier() (falls back to the
  // UI-selected default tier when blank).
  tierRaw: string;
  errors: string[];
}

interface SubmitResult {
  submitted: number;
  // US-2516: the server creates a submission even when payment falls through to
  // checkout (grade.ts returns 201 with payment.paid=false), so "submitted" was
  // counting rows that will sit unpaid and ungraded. Split the two.
  paid: number;
  awaitingPayment: number;
  /**
   * The unpaid rows, with enough to send the seller straight at the retry the
   * detail page already runs on ?pay_retry=1 (submission-detail.tsx:226).
   */
  unpaid: { submissionId: string; title: string; tier: GradeTierKey }[];
  /** True when the seller stopped the batch part-way. */
  cancelled: boolean;
  /** Rows actually attempted — lower than the batch size after a cancel. */
  attempted: number;
  errors: { rowNumber: number; title: string; message: string }[];
  /** Kept so failures can be retried without re-uploading the CSV and ZIP. */
  failedRows: ParsedRow[];
}

function mimeForName(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

function findHeader(headers: string[], candidates: string[]): number {
  const normalized = headers.map((h) => h.trim().toLowerCase());
  for (const candidate of candidates) {
    const idx = normalized.indexOf(candidate);
    if (idx !== -1) return idx;
  }
  return -1;
}

function validateRow(
  row: ParsedRow,
  zipNames: Set<string>
): string[] {
  const errors: string[] = [];
  if (!row.title) errors.push("Missing title");
  if (!row.garmentType) {
    errors.push("Missing garment_type");
  } else if (!GARMENT_TYPES.includes(row.garmentType as never)) {
    errors.push(`Invalid garment_type "${row.garmentType}"`);
  }
  if (!row.garmentCategory) {
    errors.push("Missing category");
  } else if (!GARMENT_CATEGORIES.includes(row.garmentCategory as never)) {
    errors.push(`Invalid category "${row.garmentCategory}"`);
  }
  if (row.tierRaw && !isTurnaroundTier(row.tierRaw)) {
    errors.push(
      `Invalid tier "${row.tierRaw}" (use ${TURNAROUND_TIERS.join(", ")})`
    );
  }
  if (row.photoFilenames.length < REQUIRED_PHOTO_COUNT) {
    errors.push(
      `Needs at least ${REQUIRED_PHOTO_COUNT} photos (front, back, label, detail)`
    );
  }
  for (const name of row.photoFilenames) {
    if (!zipNames.has(baseName(name))) {
      errors.push(`Photo not found in ZIP: ${name}`);
    }
  }
  return errors;
}

export function BulkSubmissionPage() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const csvInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  // US-1625: synchronous double-submit guard (see runBatch).
  const submitLockRef = useRef(false);
  // US-2516: flipped by the Stop button; read at the top of each row so a long
  // batch can be abandoned without closing the tab. A ref, not state, because
  // the loop is already running and would never see a re-render.
  const cancelRef = useRef(false);

  const [csvName, setCsvName] = useState<string>("");
  const [zipName, setZipName] = useState<string>("");
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [zipEntries, setZipEntries] = useState<Map<string, ZipEntry>>(
    new Map()
  );
  const [parseError, setParseError] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [result, setResult] = useState<SubmitResult | null>(null);
  // Default turnaround tier applied to any row that omits a CSV `tier` value.
  const [defaultTier, setDefaultTier] = useState<GradeTierKey>("standard");
  // US-2516: the cost summary the seller has to confirm before anything charges.
  const [confirmOpen, setConfirmOpen] = useState(false);

  const plan = profile?.flipdesk_plan ?? "free";
  const planAllowed = ALLOWED_PLANS.includes(plan);

  const validRows = rows.filter((r) => r.errors.length === 0);
  const invalidRows = rows.filter((r) => r.errors.length > 0);

  // Resolve the tier a row will be submitted at: an explicit, valid CSV tier
  // wins; otherwise the UI-selected default applies. (Invalid CSV tiers are
  // caught in validateRow and never reach submission.)
  function resolveTier(row: ParsedRow): GradeTierKey {
    return isTurnaroundTier(row.tierRaw) ? row.tierRaw : defaultTier;
  }

  // US-2516 — what this batch will cost, worked out the same way the server
  // will work it out, row by row in submission order. The per-submission flow
  // has shown this since US-207; the batch charged blind.
  const { data: billing } = useBillingSummary();
  const usage = usePlanUsage();
  const creditBalance = billing?.grades.credit_balance ?? 0;
  const includedRemaining = usage.includedGrades.unlimited
    ? validRows.length
    : Math.max(0, usage.includedGrades.limit - usage.includedGrades.used);
  const estimate = estimateBulkCost(validRows.map(resolveTier), {
    includedRemaining,
    creditBalance,
  });

  function reparse(
    rawRows: ParsedRow[] | null,
    entries: Map<string, ZipEntry> | null
  ) {
    const sourceRows = rawRows ?? rows;
    const sourceEntries = entries ?? zipEntries;
    if (sourceRows.length === 0) return;
    const zipNames = new Set(sourceEntries.keys());
    setRows(
      sourceRows.map((row) => ({
        ...row,
        errors: validateRow(row, zipNames),
      }))
    );
  }

  async function handleCsvSelect(file: File) {
    setParseError("");
    setResult(null);
    try {
      const text = await file.text();
      const { headers, rows: dataRows } = parseSheet(text);

      const titleIdx = findHeader(headers, ["title", "name"]);
      const brandIdx = findHeader(headers, ["brand"]);
      const typeIdx = findHeader(headers, ["garment_type", "type"]);
      const categoryIdx = findHeader(headers, ["category", "garment_category"]);
      const photosIdx = findHeader(headers, [
        "photo_filenames",
        "photos",
        "photo_files",
      ]);
      const tierIdx = findHeader(headers, ["tier", "turnaround"]);

      if (titleIdx === -1 || typeIdx === -1 || categoryIdx === -1 || photosIdx === -1) {
        setParseError(
          "CSV must include columns: title, garment_type, category, photo_filenames."
        );
        return;
      }

      const zipNames = new Set(zipEntries.keys());
      const parsed: ParsedRow[] = dataRows
        .filter((cells) => cells.some((c) => c.trim() !== ""))
        .map((cells, i) => {
          const photoFilenames = (cells[photosIdx] ?? "")
            .split(/[;|]/)
            .map((s) => s.trim())
            .filter(Boolean);
          const row: ParsedRow = {
            rowNumber: i + 1,
            title: (cells[titleIdx] ?? "").trim(),
            brand: brandIdx === -1 ? "" : (cells[brandIdx] ?? "").trim(),
            garmentType: (cells[typeIdx] ?? "").trim().toLowerCase(),
            garmentCategory: (cells[categoryIdx] ?? "").trim().toLowerCase(),
            photoFilenames,
            tierRaw:
              tierIdx === -1 ? "" : (cells[tierIdx] ?? "").trim().toLowerCase(),
            errors: [],
          };
          row.errors = validateRow(row, zipNames);
          return row;
        });

      if (parsed.length === 0) {
        setParseError("CSV has no data rows.");
        return;
      }

      setCsvName(file.name);
      setRows(parsed);
    } catch {
      setParseError("Failed to read CSV file.");
    }
  }

  async function handleZipSelect(file: File) {
    setParseError("");
    setResult(null);
    try {
      const entries = await readZip(file);
      const map = new Map<string, ZipEntry>();
      for (const entry of entries) {
        map.set(baseName(entry.name), entry);
      }
      if (map.size === 0) {
        setParseError("ZIP file contains no files.");
        return;
      }
      setZipName(file.name);
      setZipEntries(map);
      reparse(null, map);
    } catch (err) {
      setParseError(
        err instanceof Error ? err.message : "Failed to read ZIP file."
      );
    }
  }

  async function buildPhotoFile(
    entry: ZipEntry,
    name: string
  ): Promise<{ file: File; phash: string }> {
    const raw = new File([entry.data as BlobPart], name, {
      type: mimeForName(name),
    });
    const compressed = await compressImage(raw);
    return {
      file: new File([compressed.blob], name, { type: compressed.blob.type }),
      phash: compressed.phash,
    };
  }

  async function runBatch(batch: ParsedRow[]) {
    if (batch.length === 0) return;
    // US-1625: reject a re-entrant double-click synchronously. `disabled={isSubmitting}`
    // only applies on the NEXT render, so two clicks in one frame would both run
    // this loop and POST every row twice (double charge). Mirrors the submitLockRef
    // fix in new-submission.tsx (US-774).
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    cancelRef.current = false;
    setIsSubmitting(true);
    setResult(null);
    setProgress({ current: 0, total: batch.length });

    const errors: SubmitResult["errors"] = [];
    const failedRows: ParsedRow[] = [];
    const unpaid: SubmitResult["unpaid"] = [];
    let submitted = 0;
    let paid = 0;
    let awaitingPayment = 0;
    let attempted = 0;
    let cancelled = false;

    try {
      for (let i = 0; i < batch.length; i++) {
        const row = batch[i]!;
        // US-2516: checked before the row is charged, so Stop never leaves a
        // payment half-made.
        if (cancelRef.current) {
          cancelled = true;
          break;
        }
        attempted++;
        setProgress({ current: i, total: batch.length });
        try {
          const formData = new FormData();
          formData.append("garment_type", row.garmentType);
          formData.append("garment_category", row.garmentCategory);
          formData.append("title", row.title);
          if (row.brand) formData.append("brand", row.brand);
          // Per-row turnaround tier; the edge /submit applies the payment
          // precedence (included → credits → checkout) at this tier (US-207).
          formData.append("tier", resolveTier(row));

          for (let p = 0; p < row.photoFilenames.length; p++) {
            const fileName = row.photoFilenames[p]!;
            const entry = zipEntries.get(baseName(fileName));
            if (!entry) throw new Error(`Photo missing: ${fileName}`);
            const { file: photoFile, phash } = await buildPhotoFile(entry, fileName);
            const imageType =
              IMAGE_TYPE_BY_INDEX[p] ?? ("detail" as ImageType);
            formData.append("images", photoFile);
            formData.append("image_types", imageType);
            formData.append("phashes", phash);
          }

          // US-1632: route through edgeFetch so EACH row gets a freshly-minted
          // access token (and a 401-refresh-retry) — the old code grabbed one
          // token before the loop, so a long batch 401'd mid-way once it lapsed.
          // silentGate: a per-row cap is collected as a row error below, not a
          // modal per row. edgeFetch also adds X-Workspace-Owner.
          const response = await edgeFetch("/api/grade/submit", {
            method: "POST",
            body: formData,
            silentGate: true,
          });
          // US-1632: guard .json() — an HTML 502 from an infra blip isn't JSON
          // and would otherwise throw a confusing SyntaxError mid-batch.
          const json = await response
            .json()
            .catch(
              () =>
                ({}) as {
                  error?: string;
                  submissionId?: string;
                  payment?: { paid?: boolean };
                },
            );
          if (!response.ok) {
            throw new Error(json.error || "Submission failed");
          }
          submitted++;
          // US-2516: a 201 with paid=false means the row exists but nothing has
          // been charged for it, so it will never be graded until the seller
          // pays. Counted apart from the paid rows.
          if (json.payment?.paid) {
            paid++;
          } else {
            awaitingPayment++;
            if (json.submissionId) {
              unpaid.push({
                submissionId: json.submissionId,
                title: row.title,
                tier: resolveTier(row),
              });
            }
          }
        } catch (err) {
          errors.push({
            rowNumber: row.rowNumber,
            title: row.title,
            message:
              err instanceof Error ? err.message : "Unknown error",
          });
          failedRows.push(row);
        }
      }

      setProgress({ current: attempted, total: batch.length });
      setResult({
        submitted,
        paid,
        awaitingPayment,
        unpaid,
        cancelled,
        attempted,
        errors,
        failedRows,
      });

      if (cancelled) {
        toast.info(
          `Stopped after ${submitted} of ${batch.length} garment${
            batch.length === 1 ? "" : "s"
          }.`,
          { description: "Nothing was charged for the rows that never ran." },
        );
      } else if (submitted > 0) {
        toast.success(
          `${submitted} submission${submitted === 1 ? "" : "s"} created.`,
          {
            description:
              errors.length > 0
                ? `${errors.length} row${errors.length === 1 ? "" : "s"} failed.`
                : "Your garments are being graded.",
          }
        );
      } else {
        toast.error("No submissions were created.");
      }
    } catch (err) {
      toastError(err, "Bulk upload failed.");
    } finally {
      submitLockRef.current = false;
      cancelRef.current = false;
      setIsSubmitting(false);
    }
  }

  if (!planAllowed) {
    // US-2515: the cheapest plan that unlocks this, so the CTA can preselect it
    // rather than dropping the seller on the plan picker to work it out.
    const cheapestUnlock = ALLOWED_PLANS[0]!;
    return (
      <div className="space-y-6">
        {/* US-2515: the locked state used to drop this, so a seller who landed
            here had no way back except the browser button. */}
        <Link
          to="/dashboard/submissions"
          className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Submissions
        </Link>
        <PageHeader
          title="Bulk Submission Upload"
          subtitle="Grade large batches of garments at once."
        />
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <div className="rounded-full bg-muted p-3">
              <Lock className="h-6 w-6 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              {/* US-2515: this read "Available on Professional & Enterprise".
                  Neither is a plan you can buy — the tiers are Free, Starter,
                  Pro and Business — so the one screen whose job is to tell a
                  seller what to purchase named two things that do not exist.
                  Built from FLIPDESK_PLANS so a rename cannot strand it again. */}
              <h2 className="text-lg font-semibold">
                Available on{" "}
                {ALLOWED_PLANS.map((p) => FLIPDESK_PLANS[p].name).join(" and ")}
              </h2>
              <p className="max-w-md text-sm text-muted-foreground">
                Bulk upload lets you grade many garments at once with a CSV
                and a ZIP of photos. You're on{" "}
                {FLIPDESK_PLANS[plan as FlipdeskPlanKey]?.name ?? "a plan"} —
                upgrade to unlock it.
              </p>
            </div>
            <Button
              onClick={() =>
                navigate(`/dashboard/account?tab=billing&upgrade=${cheapestUnlock}`)
              }
            >
              Upgrade to {FLIPDESK_PLANS[cheapestUnlock].name}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <Link
          to="/dashboard/submissions"
          className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Submissions
        </Link>
        <PageHeader
          title="Bulk Submission Upload"
          subtitle="Upload a CSV of garment info and a ZIP of photos to grade many items at once."
        />
      </div>

      {/* Step 1: Uploads */}
      <Card>
        <CardHeader>
          <CardTitle>1. Upload files</CardTitle>
          <CardDescription>
            CSV columns: <code>title</code>, <code>brand</code>,{" "}
            <code>garment_type</code>, <code>category</code>,{" "}
            <code>photo_filenames</code> (filenames separated by{" "}
            <code>;</code> or <code>|</code>). Optional <code>tier</code>{" "}
            (<code>standard</code>, <code>premium</code> or{" "}
            <code>express</code>) sets the turnaround per item — rows that omit
            it use the default tier you choose below.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div>
            <input
              ref={csvInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleCsvSelect(file);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => csvInputRef.current?.click()}
              className="flex w-full flex-col items-center gap-2 rounded-lg border-2 border-dashed p-6 text-center transition-colors hover:border-primary hover:bg-muted/50"
            >
              <FileSpreadsheet className="h-8 w-8 text-muted-foreground" />
              <span className="text-sm font-medium">
                {csvName || "Select CSV file"}
              </span>
              <span className="text-xs text-muted-foreground">
                {csvName ? "Click to replace" : "Garment info spreadsheet"}
              </span>
            </button>
          </div>

          <div>
            <input
              ref={zipInputRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleZipSelect(file);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => zipInputRef.current?.click()}
              className="flex w-full flex-col items-center gap-2 rounded-lg border-2 border-dashed p-6 text-center transition-colors hover:border-primary hover:bg-muted/50"
            >
              <FileArchive className="h-8 w-8 text-muted-foreground" />
              <span className="text-sm font-medium">
                {zipName || "Select ZIP file"}
              </span>
              <span className="text-xs text-muted-foreground">
                {zipName
                  ? `${zipEntries.size} photos`
                  : "Archive of garment photos"}
              </span>
            </button>
          </div>

          {parseError && (
            <div className="sm:col-span-2 flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {parseError}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Step 2: Preview */}
      {rows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>2. Preview</CardTitle>
            <CardDescription>
              {validRows.length} valid · {invalidRows.length} invalid (invalid
              rows are skipped).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col gap-1.5 sm:max-w-xs">
              <label
                htmlFor="bulk-default-tier"
                className="text-sm font-medium"
              >
                Default tier
              </label>
              <Select
                value={defaultTier}
                onValueChange={(v) => setDefaultTier(v as GradeTierKey)}
              >
                <SelectTrigger id="bulk-default-tier">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TURNAROUND_TIERS.map((key) => {
                    const t = GRADETHREAD_TIERS[key];
                    return (
                      <SelectItem key={key} value={key}>
                        {t.label} — ${(t.priceCents / 100).toFixed(2)} ·{" "}
                        {t.slaHours}h
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Applied to rows without an explicit <code>tier</code> column
                value.
              </p>
            </div>

            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">#</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Tier</TableHead>
                    <TableHead>Photos</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.rowNumber}>
                      <TableCell className="text-muted-foreground">
                        {row.rowNumber}
                      </TableCell>
                      <TableCell className="font-medium">
                        {row.title || (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>{row.garmentType || "—"}</TableCell>
                      <TableCell>{row.garmentCategory || "—"}</TableCell>
                      <TableCell>
                        {row.tierRaw && !isTurnaroundTier(row.tierRaw) ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span>
                            {GRADETHREAD_TIERS[resolveTier(row)].label}
                            {!row.tierRaw && (
                              <span className="ml-1 text-xs text-muted-foreground">
                                (default)
                              </span>
                            )}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>{row.photoFilenames.length}</TableCell>
                      <TableCell>
                        {row.errors.length === 0 ? (
                          <Badge
                            variant="outline"
                            className="border-green-600/40 text-green-700 dark:text-green-400"
                          >
                            <CheckCircle2 className="mr-1 h-3 w-3" />
                            Valid
                          </Badge>
                        ) : (
                          <span className="flex items-center gap-1 text-xs text-destructive">
                            <XCircle className="h-3 w-3 shrink-0" />
                            {row.errors.join("; ")}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* US-2516: what the batch will cost, before it charges. */}
            {validRows.length > 0 && zipName && !isSubmitting && (
              <CostSummary estimate={estimate} creditBalance={creditBalance} />
            )}

            {isSubmitting && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span>Submitting…</span>
                  <span className="text-muted-foreground">
                    {progress.current} / {progress.total}
                  </span>
                </div>
                <Progress
                  value={
                    progress.total > 0
                      ? (progress.current / progress.total) * 100
                      : 0
                  }
                />
                <div className="flex justify-end">
                  {/* US-2516: an 80-row batch used to be unstoppable short of
                      closing the tab, and every row it kept going through cost
                      money. Stop takes effect before the next row is charged. */}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      cancelRef.current = true;
                      toast.info("Stopping after the current garment…");
                    }}
                  >
                    <Ban className="mr-2 h-4 w-4" />
                    Stop batch
                  </Button>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {zipName
                  ? `${validRows.length} garment${
                      validRows.length === 1 ? "" : "s"
                    } ready to submit`
                  : "Upload a ZIP of photos to continue"}
              </p>
              <Button
                onClick={() => setConfirmOpen(true)}
                disabled={
                  isSubmitting || validRows.length === 0 || !zipName
                }
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Submitting…
                  </>
                ) : (
                  <>
                    <Upload className="mr-2 h-4 w-4" />
                    Review and submit {validRows.length} garment
                    {validRows.length === 1 ? "" : "s"}
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 3: Result summary */}
      {result && (
        <Card>
          <CardHeader>
            <CardTitle>
              {result.cancelled ? "Batch stopped" : "Upload complete"}
            </CardTitle>
            <CardDescription>
              {result.submitted} submission
              {result.submitted === 1 ? "" : "s"} created ·{" "}
              {result.errors.length} failed
              {result.cancelled &&
                ` · stopped after ${result.attempted} of ${validRows.length} row${
                  validRows.length === 1 ? "" : "s"
                }`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {result.awaitingPayment > 0 && (
              <div className="space-y-2 rounded-md bg-amber-500/10 p-3 text-sm">
                <p className="font-medium">
                  {result.awaitingPayment} submission
                  {result.awaitingPayment === 1 ? "" : "s"} still need paying
                </p>
                <p className="text-muted-foreground">
                  Your included grades and credits ran out part-way. These rows
                  were created, but grading does not start until they are paid.
                  Buy credits, then open each one to charge it.
                </p>
                <Link
                  to="/dashboard/account?tab=billing&buy=credits"
                  className="inline-flex items-center gap-1 font-medium underline"
                >
                  <CreditCard className="h-3.5 w-3.5" />
                  Buy credits
                </Link>
                <ul className="space-y-1 pt-1">
                  {result.unpaid.map((u) => (
                    <li key={u.submissionId}>
                      {/* ?pay_retry=1 is the param submission-detail.tsx already
                          acts on — it re-runs the payment precedence on arrival,
                          so a paid-up balance settles the row in one click. */}
                      <Link
                        to={`/dashboard/submissions/${u.submissionId}?pay_retry=1&tier=${u.tier}`}
                        className="inline-flex items-center gap-1 underline"
                      >
                        <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                        {u.title || "Untitled"} (
                        {GRADETHREAD_TIERS[u.tier].label})
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result.errors.length > 0 && (
              <>
                <div className="space-y-1">
                  <h3 className="text-sm font-medium text-destructive">
                    Failed rows
                  </h3>
                  <ul className="space-y-1 text-sm">
                    {result.errors.map((e) => (
                      <li
                        key={e.rowNumber}
                        className="flex items-start gap-2"
                      >
                        <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                        <span>
                          Row {e.rowNumber} ({e.title || "untitled"}):{" "}
                          {e.message}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                <Separator />
              </>
            )}
            <div className="flex flex-wrap gap-2">
              {/* US-2516: the failed rows are still in memory with their photos,
                  so a retry costs a click instead of re-picking the CSV and the
                  ZIP. Only the failures re-run, so nothing is charged twice. */}
              {result.failedRows.length > 0 && (
                <Button
                  onClick={() => void runBatch(result.failedRows)}
                  disabled={isSubmitting}
                >
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Retry {result.failedRows.length} failed row
                  {result.failedRows.length === 1 ? "" : "s"}
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => navigate("/dashboard/submissions")}
              >
                View Submissions
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* US-2516: nothing charges until this is confirmed. */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Submit {estimate.rows} garment{estimate.rows === 1 ? "" : "s"}?
            </DialogTitle>
            <DialogDescription>
              Here is what this batch will use before anything is charged.
            </DialogDescription>
          </DialogHeader>
          <CostSummary estimate={estimate} creditBalance={creditBalance} />
          {estimate.checkoutRows > 0 && (
            <p className="text-sm text-muted-foreground">
              The last {estimate.checkoutRows} row
              {estimate.checkoutRows === 1 ? "" : "s"} will be created unpaid.
              Buying{" "}
              <Link
                to="/dashboard/account?tab=billing&buy=credits"
                className="underline"
                target="_blank"
                rel="noreferrer"
              >
                credits
              </Link>{" "}
              in another tab first keeps this upload in place.
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirmOpen(false);
                void runBatch(validRows);
              }}
            >
              <Upload className="mr-2 h-4 w-4" />
              Submit {estimate.rows} garment{estimate.rows === 1 ? "" : "s"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// US-2516 — the same cost breakdown in the preview card and in the confirm
// dialog, so what the seller approves is what they were shown.
function CostSummary({
  estimate,
  creditBalance,
}: {
  estimate: ReturnType<typeof estimateBulkCost>;
  creditBalance: number;
}) {
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <div className="flex items-center justify-between font-medium">
        <span>What this batch costs</span>
        <span>
          {estimate.checkoutCents > 0
            ? formatDollars(estimate.checkoutCents)
            : "No charge"}
        </span>
      </div>
      <ul className="space-y-1 text-muted-foreground">
        <li className="flex items-center justify-between">
          <span>Covered by this month's included grades</span>
          <span>{estimate.includedRows}</span>
        </li>
        <li className="flex items-center justify-between">
          <span>
            Paid with credits ({creditBalance} on hand,{" "}
            {estimate.creditBalanceAfter} left after)
          </span>
          <span>
            {estimate.creditRows}
            {estimate.creditsSpent > 0 && ` (${estimate.creditsSpent} credits)`}
          </span>
        </li>
        <li className="flex items-center justify-between">
          <span>Needs paying by card</span>
          <span>
            {estimate.checkoutRows}
            {estimate.checkoutCents > 0 &&
              ` (${formatDollars(estimate.checkoutCents)})`}
          </span>
        </li>
      </ul>
    </div>
  );
}
