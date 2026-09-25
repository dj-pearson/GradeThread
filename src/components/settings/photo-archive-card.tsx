import { Archive, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useArchivePhotos } from "@/hooks/use-image-archive";
import { toastWarning } from "@/lib/toast-error";

export function PhotoArchiveCard() {
  const archive = useArchivePhotos();

  async function run() {
    try {
      const r = await archive.mutateAsync();
      const freedMB = (r.freed_bytes / (1024 * 1024)).toFixed(1);
      const more = r.remaining === "unknown" || r.remaining > 0;
      const nextBatch = more
        ? {
            toastAction: {
              label: "Archive next batch",
              onClick: () => void run(),
            },
          }
        : {};
      // Errors first: "none eligible" when every photo FAILED hid a broken
      // storage setup behind a message that says all is well.
      if (r.archived === 0 && r.errors.length > 0) {
        toast.warning("No photos were archived", {
          description: `${r.errors.length} failed. ${r.errors[0]?.message ?? ""}`.trim(),
          duration: 14_000,
        });
      } else if (r.archived === 0) {
        toast.info("No photos are ready to archive yet.");
      } else if (r.errors.length === 0) {
        toast.success(
          `Archived ${r.archived} photo${r.archived === 1 ? "" : "s"} · freed ${freedMB} MB.` +
            (more ? " More photos are waiting." : ""),
          nextBatch.toastAction ? { action: nextBatch.toastAction } : undefined,
        );
      } else {
        toastWarning(
          r.errors[0],
          `Archived ${r.archived}, ${r.errors.length} failed.`,
          { duration: 14_000, ...nextBatch },
        );
      }
    } catch {
      /* surfaced by hook */
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Archive className="h-4 w-4" />
          Storage
        </CardTitle>
        <CardDescription>
          Photos of items that finished more than 30 days ago (sold, shipped,
          returned or completed) move to cheaper long-term storage. This runs
          every night on its own; the button runs it now. The photos stay
          viewable at a new address.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button onClick={run} disabled={archive.isPending}>
          {archive.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Archive className="mr-2 h-4 w-4" />
          )}
          Archive eligible photos
        </Button>
      </CardContent>
    </Card>
  );
}
