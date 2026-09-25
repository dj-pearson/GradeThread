import { memo } from "react";
import { Loader2, Undo2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { canUndoRun, importOriginLabel, type ImportRun } from "@/hooks/use-import-runs";

// IMP-10: every import this workspace ran, with an honest count and an Undo
// that survives a refresh or a closed tab. The page's own copy promises that
// ("you can undo the whole thing afterwards"); this list is what keeps it.

const STATUS_LABELS: Record<ImportRun["status"], string> = {
  pending: "Starting",
  running: "Importing",
  completed: "Done",
  failed: "Stopped",
  undone: "Undone",
};

function runDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

interface Props {
  runs: ImportRun[];
  onUndo: (run: ImportRun) => void;
  undoingId: string | null;
  canUndo: boolean;
}

export const RecentImportsCard = memo(function RecentImportsCard({
  runs,
  onUndo,
  undoingId,
  canUndo,
}: Props) {
  if (runs.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Recent imports</CardTitle>
        <CardDescription>
          Including closet reads the extension ran on its own. Undo removes what
          an import added and puts back what it filled in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {runs.map((run) => {
            const undoable = run.status === "undone" || run.undone_at ? false : canUndoRun(run);
            const status = run.undone_at ? "undone" : run.status;
            return (
              <li
                key={run.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{importOriginLabel(run.origin)}</span>
                    <Badge variant="outline" className="text-xs">
                      {STATUS_LABELS[status]}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {runDate(run.created_at)}
                    {runDate(run.created_at) ? ". " : ""}
                    {run.inserted_count} new, {run.updated_count} filled,{" "}
                    {run.skipped_count} unchanged, {run.failed_count} failed
                  </p>
                </div>
                {undoable && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onUndo(run)}
                    disabled={!canUndo || undoingId !== null}
                    aria-label={`Undo the ${importOriginLabel(run.origin)} import`}
                  >
                    {undoingId === run.id ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Undo2 className="mr-2 h-4 w-4" />
                    )}
                    Undo
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
});
