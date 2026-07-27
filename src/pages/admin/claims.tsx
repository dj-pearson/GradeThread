import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ShieldCheck,
  Eye,
  Check,
  X,
  Loader2,
  ExternalLink,
  AlertTriangle,
} from "lucide-react";
import { SearchInput } from "@/components/search-input";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
import { ClickableRow } from "@/components/clickable-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// US-867: admin review of buyer trust-guarantee claims. Reads through the
// service-role edge (/api/admin/claims) — the guarantee_claims table is RLS-
// locked (buyer PII), so the browser client can't query it directly. Every
// decision flips status + records a resolution note via the edge; v1 has no
// automated payout.

type ClaimStatus = "submitted" | "under_review" | "approved" | "rejected";

interface ClaimedIssue {
  defect: string;
  severity: string;
  location: string;
}

interface Claim {
  id: string;
  certificate_id: string;
  grade_report_id: string;
  claimant_email: string;
  claimant_name: string | null;
  marketplace: string | null;
  order_reference: string | null;
  reason: string;
  claimed_issues: ClaimedIssue[] | null;
  evidence_urls: string[] | null;
  status: ClaimStatus;
  resolution: string | null;
  reviewed_at: string | null;
  created_at: string;
}

interface Disclosure {
  grade_tier: string;
  overall_score: number;
  defect_count: number;
  has_defects: boolean;
  plain: string;
}

interface EnrichedClaim {
  claim: Claim;
  grade: {
    overall_score: number;
    grade_tier: string;
    ai_summary: string | null;
    buyer_writeup: string | null;
  } | null;
  disclosure: Disclosure | null;
  garment: {
    title: string | null;
    brand: string | null;
    garment_type: string | null;
    garment_category: string | null;
  } | null;
}

const STATUS_COLORS: Record<ClaimStatus, string> = {
  submitted: "bg-yellow-100 text-yellow-700 dark:bg-yellow-950/50 dark:text-yellow-300",
  under_review: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
  approved: "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300",
  rejected: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300",
};

const STATUS_LABELS: Record<ClaimStatus, string> = {
  submitted: "Submitted",
  under_review: "Under Review",
  approved: "Approved",
  rejected: "Rejected",
};

type StatusFilter = "all" | ClaimStatus;

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function AdminClaimsPage() {
  const queryClient = useQueryClient();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<EnrichedClaim | null>(null);
  const [resolution, setResolution] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-claims"],
    queryFn: async () => {
      const res = await edgeFetch("/api/admin/claims");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load claims.");
      return (json.claims ?? []) as EnrichedClaim[];
    },
    staleTime: 30 * 1000,
  });

  const items = useMemo(() => data ?? [], [data]);

  const filtered = useMemo(() => {
    return items.filter((item) => {
      if (statusFilter !== "all" && item.claim.status !== statusFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        const matches =
          item.claim.claimant_email.toLowerCase().includes(q) ||
          item.claim.certificate_id.toLowerCase().includes(q) ||
          item.claim.reason.toLowerCase().includes(q) ||
          (item.garment?.title?.toLowerCase().includes(q) ?? false);
        if (!matches) return false;
      }
      return true;
    });
  }, [items, statusFilter, search]);

  const counts = useMemo(() => {
    const c = { submitted: 0, under_review: 0, approved: 0, rejected: 0 };
    for (const i of items) c[i.claim.status]++;
    return c;
  }, [items]);

  function openDetail(item: EnrichedClaim) {
    setSelected(item);
    setResolution("");
  }

  async function runAction(
    path: string,
    body: Record<string, unknown> | undefined,
    successMsg: string,
  ) {
    if (!selected) return;
    setActionLoading(true);
    try {
      const res = await edgeFetch(`/api/admin/claims/${selected.claim.id}/${path}`, {
        method: "POST",
        json: body ?? {},
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Action failed.");
      toast.success(successMsg);
      queryClient.invalidateQueries({ queryKey: ["admin-claims"] });
      setSelected(null);
    } catch (err) {
      toast.error("Action failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setActionLoading(false);
    }
  }

  function handleDecision(decision: "approve" | "reject") {
    if (!resolution.trim()) {
      toast.error("Resolution note required", {
        description: "Document the decision and how it was reached.",
      });
      return;
    }
    runAction(
      decision,
      { resolution: resolution.trim() },
      decision === "approve" ? "Claim approved" : "Claim rejected",
    );
  }

  const isOpenStatus =
    selected?.claim.status === "submitted" || selected?.claim.status === "under_review";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-6 w-6 text-brand-red-text" />
          <h1 className="text-2xl font-bold">Guarantee Claims</h1>
          {counts.submitted > 0 && (
            <Badge variant="destructive" className="ml-2">
              {counts.submitted} new
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{counts.under_review} reviewing</Badge>
          <Badge variant="outline">{counts.approved} approved</Badge>
          <Badge variant="outline">{counts.rejected} rejected</Badge>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <SearchInput
              label="Search claims"
              placeholder="Search email, certificate, reason…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
              <SelectTrigger>
                <SelectValue placeholder="All Statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="submitted">Submitted</SelectItem>
                <SelectItem value="under_review">Under Review</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <Card>
          <CardContent className="pt-6">
            <div className="space-y-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Claimant</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Filed</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                      No claims found.
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((item) => (
                    <ClickableRow
                      key={item.claim.id}
                      className="hover:bg-muted/50"
                      onActivate={() => openDetail(item)}
                      activateLabel={`View claim from ${item.claim.claimant_name ?? item.claim.claimant_email}`}
                    >
                      <TableCell className="max-w-[170px] truncate">
                        {item.claim.claimant_name ?? item.claim.claimant_email}
                      </TableCell>
                      <TableCell className="max-w-[180px] truncate font-medium">
                        {item.garment?.title ?? "Graded item"}
                      </TableCell>
                      <TableCell className="max-w-[220px] truncate text-muted-foreground">
                        {item.claim.reason}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className={STATUS_COLORS[item.claim.status]}>
                          {STATUS_LABELS[item.claim.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDate(item.claim.created_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={(e) => {
                            e.stopPropagation();
                            openDetail(item);
                          }}
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </ClickableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-w-3xl max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-brand-red-text" />
              Guarantee Claim
            </DialogTitle>
            <DialogDescription>
              {selected?.claim.claimant_email} &middot; Filed{" "}
              {selected ? formatDate(selected.claim.created_at) : ""}
            </DialogDescription>
          </DialogHeader>

          {selected && (
            <div className="space-y-6">
              <div className="flex items-center gap-2">
                <Badge
                  variant="secondary"
                  className={`${STATUS_COLORS[selected.claim.status]} text-sm px-3 py-1`}
                >
                  {STATUS_LABELS[selected.claim.status]}
                </Badge>
                <a
                  href={`/cert/${selected.claim.certificate_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-brand-navy hover:underline dark:text-foreground"
                >
                  View certificate <ExternalLink className="h-3 w-3" />
                </a>
              </div>

              {/* Buyer's claim */}
              <Card className="border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/50">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                    Buyer&apos;s claim
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <p className="whitespace-pre-wrap">{selected.claim.reason}</p>
                  <div className="flex flex-wrap gap-x-6 gap-y-1 pt-1 text-xs text-muted-foreground">
                    {selected.claim.marketplace && (
                      <span>Marketplace: {selected.claim.marketplace}</span>
                    )}
                    {selected.claim.order_reference && (
                      <span>Order ref: {selected.claim.order_reference}</span>
                    )}
                  </div>
                  {selected.claim.evidence_urls && selected.claim.evidence_urls.length > 0 && (
                    <div className="pt-1">
                      <p className="text-xs font-medium">Evidence:</p>
                      <ul className="mt-1 space-y-0.5">
                        {selected.claim.evidence_urls.map((url) => (
                          <li key={url}>
                            <a
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-xs text-brand-navy hover:underline dark:text-foreground"
                            >
                              {url} <ExternalLink className="h-3 w-3" />
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Certified disclosure — the reference the claim is judged against */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Certified condition disclosure</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {selected.grade ? (
                    <div className="flex items-baseline gap-2">
                      <span className="text-2xl font-bold">
                        {selected.grade.overall_score.toFixed(1)}
                      </span>
                      <Badge variant="secondary">{selected.grade.grade_tier}</Badge>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Grade report unavailable.
                    </p>
                  )}
                  {selected.disclosure && (
                    <p className="whitespace-pre-wrap rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
                      {selected.disclosure.plain}
                    </p>
                  )}
                  {selected.grade?.buyer_writeup && (
                    <div>
                      <p className="text-xs font-medium">Buyer write-up</p>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                        {selected.grade.buyer_writeup}
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Decision */}
              {isOpenStatus ? (
                <div className="space-y-4 border-t pt-4">
                  <h4 className="text-sm font-medium">Decision</h4>
                  {selected.claim.status === "submitted" && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={actionLoading}
                      onClick={() => runAction("under-review", undefined, "Marked as under review")}
                    >
                      {actionLoading ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Eye className="mr-2 h-4 w-4" />
                      )}
                      Mark as Under Review
                    </Button>
                  )}
                  <div>
                    <Label htmlFor="resolution" className="text-sm font-medium">
                      Resolution note
                    </Label>
                    <Textarea
                      id="resolution"
                      placeholder="Document the decision and how it compares to the certified disclosure…"
                      value={resolution}
                      onChange={(e) => setResolution(e.target.value)}
                      rows={3}
                      className="mt-1"
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <Button
                      className="flex-1"
                      disabled={actionLoading}
                      onClick={() => handleDecision("approve")}
                    >
                      {actionLoading ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="mr-2 h-4 w-4" />
                      )}
                      Approve claim
                    </Button>
                    <Button
                      variant="destructive"
                      disabled={actionLoading}
                      onClick={() => handleDecision("reject")}
                    >
                      <X className="mr-2 h-4 w-4" />
                      Reject claim
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    v1 is mediation-only — approving records a confirmed misgrade;
                    it does not issue a refund.
                  </p>
                </div>
              ) : (
                <div
                  className={`rounded-lg border p-4 ${
                    selected.claim.status === "approved"
                      ? "border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/40"
                      : "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/40"
                  }`}
                >
                  <p className="text-sm font-medium">
                    This claim was {selected.claim.status}.
                  </p>
                  {selected.claim.resolution && (
                    <p className="mt-2 text-sm">
                      <strong>Resolution:</strong> {selected.claim.resolution}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
