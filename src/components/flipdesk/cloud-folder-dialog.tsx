// US-3159: browse a cloud folder and pick the photos to bring over.
//
// One dialog serves every provider — the entries, the paths and the
// breadcrumbs are all provider-shaped strings the edge hands back, so adding
// OneDrive (US-3160) adds a row to the picker and nothing here.
//
// The two things this screen must never do quietly:
//   • Show an empty folder that is not empty. A folder of iPhone HEICs has no
//     importable files, and the edge returns how many it had to leave, so the
//     screen says which rather than looking broken.
//   • Lose the selection on navigation. Photos of one item are routinely split
//     across two folders, so the chosen set is keyed by full path and survives
//     browsing away and back.

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Folder, Home, Image as ImageIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { type CloudEntry, type CloudFolderListing, pathCrumbs } from "@/lib/cloud-folder-import";

export interface CloudFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerId: string;
  providerLabel: string;
  browse: (providerId: string, path: string) => Promise<CloudFolderListing>;
  onImport: (paths: string[]) => void;
  importing: boolean;
  progress: { done: number; total: number } | null;
  onCancel: () => void;
}

export function CloudFolderDialog({
  open,
  onOpenChange,
  providerId,
  providerLabel,
  browse,
  onImport,
  importing,
  progress,
  onCancel,
}: CloudFolderDialogProps) {
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<CloudFolderListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());

  const load = useCallback(
    async (next: string) => {
      setLoading(true);
      setError(null);
      try {
        setListing(await browse(providerId, next));
        setPath(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not read that folder.");
      } finally {
        setLoading(false);
      }
    },
    [browse, providerId],
  );

  // Start at the root every time the dialog opens, and forget the last
  // selection: a set of paths from a previous session is not what the seller
  // means by "the photos I just picked".
  useEffect(() => {
    if (!open) return;
    setChosen(new Set());
    void load("");
  }, [open, load]);

  function toggle(entry: CloudEntry) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
  }

  function chooseAllHere() {
    const here = listing?.files.map((f) => f.path) ?? [];
    setChosen((prev) => {
      const next = new Set(prev);
      const allChosen = here.every((p) => next.has(p));
      for (const p of here) {
        if (allChosen) next.delete(p);
        else next.add(p);
      }
      return next;
    });
  }

  const crumbs = pathCrumbs(path);
  const files = listing?.files ?? [];
  const folders = listing?.folders ?? [];
  const allHereChosen = files.length > 0 && files.every((f) => chosen.has(f.path));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Bring photos over from {providerLabel}</DialogTitle>
          <DialogDescription>
            Open the folder your photos are in, tick the ones you want, then bring
            them over. They land on this item.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded px-1 hover:text-foreground"
            onClick={() => void load("")}
          >
            <Home className="h-3.5 w-3.5" />
            {providerLabel}
          </button>
          {crumbs.map((c) => (
            <span key={c.path} className="inline-flex items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5" />
              <button
                type="button"
                className="rounded px-1 hover:text-foreground"
                onClick={() => void load(c.path)}
              >
                {c.name}
              </button>
            </span>
          ))}
        </div>

        <div className="max-h-80 overflow-y-auto rounded-md border">
          {loading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Reading that folder…
            </div>
          ) : error ? (
            <div className="p-4 text-sm text-destructive">{error}</div>
          ) : (
            <ul className="divide-y">
              {folders.map((f) => (
                <li key={f.path}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/60"
                    onClick={() => void load(f.path)}
                  >
                    <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{f.name}</span>
                  </button>
                </li>
              ))}
              {files.map((f) => (
                <li key={f.path}>
                  <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-muted/60">
                    <Checkbox
                      checked={chosen.has(f.path)}
                      onCheckedChange={() => toggle(f)}
                      aria-label={`Choose ${f.name}`}
                    />
                    <ImageIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{f.name}</span>
                  </label>
                </li>
              ))}
              {folders.length === 0 && files.length === 0 && (
                <li className="p-4 text-sm text-muted-foreground">
                  {listing && listing.unreadable > 0
                    ? `This folder has ${listing.unreadable} ${
                      listing.unreadable === 1 ? "photo" : "photos"
                    } we cannot read yet — HEIC and camera raw files. JPEG, PNG and WebP work.`
                    : "Nothing in this folder."}
                </li>
              )}
            </ul>
          )}
        </div>

        {listing && listing.unreadable > 0 && files.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {listing.unreadable} more {listing.unreadable === 1 ? "file is" : "files are"} in
            here that we cannot read yet — HEIC and camera raw.
          </p>
        )}
        {listing?.truncated && (
          <p className="text-xs text-muted-foreground">
            Showing the first {files.length}. Open a smaller folder to reach the rest.
          </p>
        )}

        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={files.length === 0 || importing}
            onClick={chooseAllHere}
          >
            {allHereChosen ? "Clear this folder" : "Choose all here"}
          </Button>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {chosen.size} chosen
            </span>
            {importing ? (
              <Button type="button" variant="outline" onClick={onCancel}>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {progress
                  ? `Bringing over ${progress.done} of ${progress.total} — stop`
                  : "Bringing them over — stop"}
              </Button>
            ) : (
              <Button
                type="button"
                disabled={chosen.size === 0}
                onClick={() => onImport([...chosen])}
              >
                Bring over {chosen.size > 0 ? chosen.size : ""}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
