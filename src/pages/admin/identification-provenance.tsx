import { useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/ui/page-header";
import { AlertTriangle, ScanSearch } from "lucide-react";

// US-2779: is eBay's visual guess any good?
//
// Reads /api/admin/identification-provenance (edge, admin-gated, cross-tenant).
// Nothing identifying comes back — counts only.
//
// The "no verdict" column is the one to read first, and it is deliberately not
// merged into "rejected". A candidate the model never ruled on is a PROMPT
// defect: it was told to report a verdict per candidate and did not. Counting
// it as a rejection would report that bug as a quality signal, and the number
// would look entirely reasonable while pointing at the wrong fix.

const WINDOWS = ["100", "500", "1000", "2000"] as const;

interface FieldSummary {
  field: string;
  offered: number;
  accepted: number;
  rejected: number;
  neverRuled: number;
}

interface ProvenanceReport {
  window: number;
  runs: number;
  runsWithCandidates: number;
  byField: FieldSummary[];
  acceptedByEvidence: Record<string, number>;
  declines: Record<string, number>;
}

/** What each decline reason means, in the words an operator would use. */
const DECLINE_LABELS: Record<string, string> = {
  disabled: "Flag off",
  no_image: "No photo",
  role_not_identifying: "Photo role refused",
  no_matches: "eBay found nothing",
  error: "Search failed",
  other: "Unrecognised",
};

/** Evidence kinds, strongest first — the same order the prompt states them in. */
const EVIDENCE_ORDER = [
  "style_code",
  "tag_wordmark",
  "visual_consensus",
  "model_knowledge",
] as const;

const EVIDENCE_LABELS: Record<string, string> = {
  style_code: "Style code on the tag",
  tag_wordmark: "Wordmark read in a photo",
  visual_consensus: "The visual match alone",
  model_knowledge: "Model's own knowledge",
};

function share(part: number, whole: number): string {
  if (whole === 0) return "n/a";
  return `${Math.round((part / whole) * 100)}%`;
}

export function AdminIdentificationProvenancePage() {
  const [windowSize, setWindowSize] = useState<string>("500");
  const windowSelectId = useId();

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-identification-provenance", windowSize],
    queryFn: async (): Promise<ProvenanceReport> => {
      const res = await edgeFetch(
        `/api/admin/identification-provenance?limit=${encodeURIComponent(windowSize)}`,
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Failed to load identification provenance.");
      }
      return json as ProvenanceReport;
    },
    staleTime: 60 * 1000,
  });

  const totals = useMemo(() => {
    if (!data) return null;
    let offered = 0, accepted = 0, neverRuled = 0;
    for (const f of data.byField) {
      offered += f.offered;
      accepted += f.accepted;
      neverRuled += f.neverRuled;
    }
    return { offered, accepted, neverRuled };
  }, [data]);

  const declineRows = useMemo(() => {
    if (!data) return [];
    return Object.entries(data.declines)
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1]);
  }, [data]);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={ScanSearch}
        title="Visual identification"
        subtitle="What eBay's visual search offered on recent runs, and what the model did with each candidate."
      />

      <div className="flex items-center gap-3">
        <Label htmlFor={windowSelectId} className="text-sm text-muted-foreground">
          Most recent
        </Label>
        <Select value={windowSize} onValueChange={setWindowSize}>
          <SelectTrigger id={windowSelectId} className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WINDOWS.map((w) => (
              <SelectItem key={w} value={w}>
                {w} runs
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error ? (
        <Card>
          <CardContent className="flex items-center gap-3 py-6 text-sm">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            {(error as Error).message}
          </CardContent>
        </Card>
      ) : null}

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : data && totals ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryTile label="Runs" value={String(data.runs)} />
            <SummaryTile
              label="Runs that offered something"
              value={`${data.runsWithCandidates} (${share(data.runsWithCandidates, data.runs)})`}
            />
            <SummaryTile
              label="Candidates accepted"
              value={`${totals.accepted} (${share(totals.accepted, totals.offered)})`}
            />
            <SummaryTile
              label="Offered, no verdict"
              value={`${totals.neverRuled} (${share(totals.neverRuled, totals.offered)})`}
              // Not a quality signal. Anything above zero here is the prompt
              // failing to get an answer, and it is fixed in the prompt.
              tone={totals.neverRuled > 0 ? "text-destructive" : undefined}
            />
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Field</TableHead>
                      <TableHead className="text-right">Offered</TableHead>
                      <TableHead className="text-right">Accepted</TableHead>
                      <TableHead className="text-right">Rejected</TableHead>
                      <TableHead className="text-right">No verdict</TableHead>
                      <TableHead className="text-right">Accept rate</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.byField.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={6}
                          className="py-10 text-center text-sm text-muted-foreground"
                        >
                          Nothing offered in this window. Either the visual pass is
                          off, or every run declined — the breakdown below says which.
                        </TableCell>
                      </TableRow>
                    ) : (
                      data.byField.map((row) => (
                        <TableRow key={row.field}>
                          <TableCell className="font-medium">{row.field}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {row.offered}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {row.accepted}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {row.rejected}
                          </TableCell>
                          <TableCell
                            className={`text-right tabular-nums ${
                              row.neverRuled > 0 ? "text-destructive" : ""
                            }`}
                          >
                            {row.neverRuled}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {share(row.accepted, row.offered)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardContent className="space-y-3 py-5">
                <h2 className="text-sm font-semibold">What accepted the candidate</h2>
                <p className="text-sm text-muted-foreground">
                  An acceptance the model backed with a tag or a style code says the
                  garment was readable. One backed only by the visual match is the
                  provider being taken at its word.
                </p>
                <dl className="space-y-2">
                  {EVIDENCE_ORDER.map((kind) => (
                    <div key={kind} className="flex items-baseline justify-between gap-4">
                      <dt className="text-sm">{EVIDENCE_LABELS[kind]}</dt>
                      <dd className="text-sm font-semibold tabular-nums">
                        {data.acceptedByEvidence[kind] ?? 0}
                      </dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-3 py-5">
                <h2 className="text-sm font-semibold">Runs that offered nothing</h2>
                <p className="text-sm text-muted-foreground">
                  A refused photo role and an empty eBay result are different
                  findings. The first is the gate working; the second is coverage.
                </p>
                {declineRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Every run in this window produced candidates.
                  </p>
                ) : (
                  <dl className="space-y-2">
                    {declineRows.map(([reason, count]) => (
                      <div key={reason} className="flex items-baseline justify-between gap-4">
                        <dt className="text-sm">{DECLINE_LABELS[reason] ?? reason}</dt>
                        <dd className="text-sm font-semibold tabular-nums">{count}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}

function SummaryTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <Card>
      <CardContent className="space-y-1 py-5">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className={`text-2xl font-bold tabular-nums ${tone ?? ""}`}>{value}</p>
      </CardContent>
    </Card>
  );
}
