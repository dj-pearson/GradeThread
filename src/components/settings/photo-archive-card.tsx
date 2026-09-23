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
      if (r.archived === 0) {
        toast.info("No photos eligible for archival yet.");
      } else if (r.errors.length === 0) {
        toast.success(
          `Archived ${r.archived} photo${r.archived === 1 ? "" : "s"} · freed ${freedMB} MB.`,
        );
      } else {
        toastWarning(
          r.errors[0],
          `Archived ${r.archived}, ${r.errors.length} failed.`,
          { duration: 14_000 },
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
          Photos for items in a terminal state (sold, shipped, returned,
          completed) older than 30 days can be moved off Supabase to
          cold-storage on Cloudflare R2. Photos stay viewable — the URL
          just points elsewhere.
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
