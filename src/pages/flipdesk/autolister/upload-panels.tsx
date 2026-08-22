import type { RefObject } from "react";
import {
  FolderOpen,
  Images,
  Loader2,
  RotateCcw,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  useAutolisterUploadStore,
  type UploadTask,
} from "@/stores/autolister-upload-store";
import { cn } from "@/lib/utils";

// US-2520: lifted out of autolister.tsx. Getting photos in is a self-contained
// job — it ends the moment a file is staged — and it was sitting in the middle
// of the same component that owns the grouping grid and the generate pipeline.

/** US-1541: 600 live progress bars is its own kind of jank. */
const UPLOAD_ROWS_CAP = 80;

export function UploadDropzone({
  entitled,
  dragging,
  onDraggingChange,
  fileInputRef,
  folderInputRef,
  onFiles,
  onDropFiles,
  uploading,
  googlePhotos,
}: {
  entitled: boolean;
  dragging: boolean;
  onDraggingChange: (dragging: boolean) => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  folderInputRef: RefObject<HTMLInputElement | null>;
  onFiles: (files: FileList | File[] | null) => void;
  /** Resolves a drop's DataTransfer (folders included) into plain files. */
  onDropFiles: (transfer: DataTransfer) => void;
  uploading: number;
  /** Null when the seller has not connected Google Photos. */
  googlePhotos: {
    importing: boolean;
    progress: { done: number; total: number } | null;
    onImport: () => void;
    onCancel: () => void;
  } | null;
}) {
  return (
    <Card
      className={cn("p-4 transition-shadow", dragging && "ring-2 ring-primary")}
      onDragOver={(e) => {
        if (!entitled) return;
        e.preventDefault();
        onDraggingChange(true);
      }}
      onDragLeave={() => onDraggingChange(false)}
      onDrop={(e) => {
        e.preventDefault();
        onDraggingChange(false);
        if (!entitled) return;
        onDropFiles(e.dataTransfer);
      }}
      onPaste={(e) => {
        if (!entitled) return;
        const files = Array.from(e.clipboardData?.files ?? []).filter(
          (f) => f.type.startsWith("image/") || f.type.startsWith("video/"),
        );
        if (files.length > 0) onFiles(files);
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,.heic,.heif,video/*,.mov,.mp4,.m4v"
        multiple
        className="hidden"
        onChange={(e) => {
          onFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        // webkitdirectory/directory are non-standard but widely supported and
        // not in React's typed attrs — spread them past the type checker.
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={(e) => {
          onFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={!entitled}
        className="flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed py-10 text-muted-foreground transition-colors hover:border-primary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-input disabled:hover:text-muted-foreground"
      >
        {uploading > 0 ? (
          <Loader2 className="h-7 w-7 animate-spin" />
        ) : (
          <Upload className="h-7 w-7" />
        )}
        <span className="text-sm font-medium">
          {uploading > 0
            ? `Uploading ${uploading}…`
            : "Drag photos or a folder here, or click to choose"}
        </span>
        <span className="text-xs">
          iPhone HEIC and Live Photos supported. Resized &amp; compressed in
          your browser before upload.
        </span>
      </button>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => folderInputRef.current?.click()}
          disabled={!entitled}
        >
          <FolderOpen className="mr-1.5 h-4 w-4" />
          Pick a folder
        </Button>
        {googlePhotos && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              if (googlePhotos.importing) googlePhotos.onCancel();
              else googlePhotos.onImport();
            }}
            disabled={!entitled}
          >
            {googlePhotos.importing ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Images className="mr-1.5 h-4 w-4" />
            )}
            {googlePhotos.progress
              ? googlePhotos.progress.total > 0
                ? `Bringing over ${googlePhotos.progress.done} of ${googlePhotos.progress.total} — cancel`
                : "Bringing over your photos — cancel"
              : googlePhotos.importing
                ? "Waiting for your picks — cancel"
                : "Import from Google Photos"}
          </Button>
        )}
      </div>
    </Card>
  );
}

export function UploadProgressPanel({
  tasks,
  uploading,
  onRetry,
  onDismiss,
}: {
  tasks: UploadTask[];
  uploading: number;
  onRetry: (ids: string[]) => void;
  onDismiss: (id: string) => void;
}) {
  if (tasks.length === 0) return null;

  const done = tasks.filter((t) => t.status === "done").length;
  const errors = tasks.filter((t) => t.status === "error");
  const inFlight = tasks.filter(
    (t) => t.status !== "error" && t.status !== "done",
  );
  // US-1541: errors first — they need action. Completed rows are summarized by
  // the header and overflow by the footer.
  const visible = [...errors, ...inFlight].slice(0, UPLOAD_ROWS_CAP);
  const hidden = errors.length + inFlight.length - visible.length;
  const retryable = errors.filter((t) => t.retryable !== false);

  // US-1541: an honest aggregate — "X of N uploaded — Y failed".
  const failedSuffix = errors.length > 0 ? ` — ${errors.length} failed` : "";
  const heading = uploading > 0
    ? `${done} of ${tasks.length} uploaded${failedSuffix}…`
    : errors.length > 0
      ? `${errors.length} photo${errors.length === 1 ? "" : "s"} failed`
      : `All ${done} uploaded.`;

  return (
    <Card className="p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{heading}</span>
        {uploading === 0 && (
          <div className="flex items-center gap-2">
            {retryable.length > 0 && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onRetry(retryable.map((t) => t.id))}
              >
                <RotateCcw className="mr-1 h-4 w-4" />
                Retry failed
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => useAutolisterUploadStore.getState().clearTasks()}
            >
              Dismiss all
            </Button>
          </div>
        )}
      </div>
      <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
        {visible.map((t) => (
          <div key={t.id} className="flex items-center gap-2 text-xs">
            <span className="w-36 shrink-0 truncate sm:w-48" title={t.name}>
              {t.name}
            </span>
            {t.status === "error" ? (
              <>
                <span
                  className="min-w-0 flex-1 truncate text-destructive"
                  title={t.error}
                >
                  {t.error}
                </span>
                {t.retryable !== false && (
                  <button
                    type="button"
                    aria-label={`Retry uploading ${t.name}`}
                    title="Retry this photo"
                    onClick={() => onRetry([t.id])}
                    className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium text-primary hover:bg-muted"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Retry
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`Dismiss the upload error for ${t.name}`}
                  title="Dismiss"
                  onClick={() => onDismiss(t.id)}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted"
                >
                  <X className="h-3 w-3" />
                </button>
              </>
            ) : (
              <>
                <Progress value={t.progress} className="h-1.5 min-w-0 flex-1" />
                <span className="w-20 shrink-0 text-right text-muted-foreground">
                  {t.status === "queued" && "Queued"}
                  {t.status === "processing" && "Processing…"}
                  {t.status === "uploading" && "Uploading…"}
                  {t.status === "done" && "Done"}
                </span>
              </>
            )}
          </div>
        ))}
        {hidden > 0 && (
          <p className="pt-1 text-center text-xs text-muted-foreground">
            …plus {hidden} more in the queue.
          </p>
        )}
      </div>
    </Card>
  );
}
