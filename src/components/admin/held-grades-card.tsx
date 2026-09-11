import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { edgeFetch } from "@/lib/edge-fetch";

// US-3327: grades held for their paid turnaround (US-3326), and the super
// admin control to release them early. Everyone on the page can see the list;
// only a super_admin can release, and the server enforces that and asks for
// step-up regardless of what this component shows.

interface HeldGrade {
  id: string;
  submission_id: string;
  overall_score: number;
  grade_tier: string;
  release_at: string | null;
  held_modified: boolean | null;
  reviewed_by: string | null;
  submissions?: { title: string | null; service_tier: string | null } | null;
}

const QUERY_KEY = ["admin-grading-held"];

function releaseLabel(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function HeldGradesCard({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const res = await edgeFetch("/api/admin/grading/held-grades");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error || `HTTP ${res.status}`);
      return (json as { held: HeldGrade[] }).held;
    },
    staleTime: 30 * 1000,
  });

  const held = data ?? [];

  async function release(ids: string[]) {
    if (ids.length === 0) return;
    const ok = await confirm({
      title: ids.length === 1 ? "Release this grade now?" : `Release ${ids.length} grades now?`,
      description:
        "The seller sees the grade, the certificate goes public and the final-grade email goes out now, instead of at the paid turnaround time.",
      confirmLabel: "Release now",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = ids.length === 1
        ? await edgeFetch(`/api/admin/grading/held-grades/${ids[0]}/release`, { method: "POST" })
        : await edgeFetch("/api/admin/grading/held-grades/release-batch", {
          method: "POST",
          body: JSON.stringify({ ids }),
        });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error || `HTTP ${res.status}`);
      const released = ids.length === 1 ? 1 : (json as { released: number }).released;
      toast.success(released === 1 ? "Grade released" : `${released} grades released`);
      setSelected(new Set());
    } catch (err) {
      toast.error("Couldn't release", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allSelected = held.length > 0 && held.every((h) => selected.has(h.id));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="h-4 w-4" />
          Held for paid turnaround
        </CardTitle>
        {isSuperAdmin && held.length > 0 && (
          <Button
            size="sm"
            disabled={busy || selected.size === 0}
            onClick={() => release([...selected])}
          >
            Release selected ({selected.size})
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : error ? (
          <p className="text-sm text-destructive">Couldn't load held grades.</p>
        ) : held.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No grades are waiting. Grades appear here when the release hold is on and a
            Standard or Premium grade is finished before its turnaround time.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {isSuperAdmin && (
                    <TableHead className="w-8">
                      <Checkbox
                        aria-label="Select all held grades"
                        checked={allSelected}
                        onCheckedChange={() =>
                          setSelected(allSelected ? new Set() : new Set(held.map((h) => h.id)))}
                      />
                    </TableHead>
                  )}
                  <TableHead>Item</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead>Grade</TableHead>
                  <TableHead>Decision</TableHead>
                  <TableHead>Releases</TableHead>
                  {isSuperAdmin && <TableHead className="text-right">Action</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {held.map((h) => (
                  <TableRow key={h.id}>
                    {isSuperAdmin && (
                      <TableCell>
                        <Checkbox
                          aria-label={`Select ${h.submissions?.title ?? "grade"}`}
                          checked={selected.has(h.id)}
                          onCheckedChange={() => toggle(h.id)}
                        />
                      </TableCell>
                    )}
                    <TableCell className="max-w-[16rem] truncate">
                      {h.submissions?.title ?? "Untitled"}
                    </TableCell>
                    <TableCell className="capitalize">
                      {h.submissions?.service_tier ?? "standard"}
                    </TableCell>
                    <TableCell>
                      {Number(h.overall_score).toFixed(1)} · {h.grade_tier}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {h.held_modified ? "Adjusted" : h.reviewed_by ? "Approved" : "Auto-approved"}
                      </Badge>
                    </TableCell>
                    <TableCell>{releaseLabel(h.release_at)}</TableCell>
                    {isSuperAdmin && (
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => release([h.id])}
                        >
                          Release now
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {!isSuperAdmin && held.length > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            Only a super admin can release a held grade early.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
