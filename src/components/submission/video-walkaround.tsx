import { useEffect, useRef, useState } from "react";
import { Check, Film, ImageUp, RotateCcw, ShieldCheck, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import {
  IN_APP_VIDEO_CAPTURE_SOURCE,
  LIBRARY_VIDEO_CAPTURE_SOURCE,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_DURATION_SECONDS,
  VIDEO_ACCEPT,
  VIDEO_SLOT_PROMPTS,
  type VideoCaptureSource,
  type VideoSlotKey,
  type VideoSlotMarks,
} from "@/lib/video-capture";
import {
  isVideoRecordingSupported,
  VideoRecorder,
} from "@/components/submission/video-recorder";

// US-1766: guided walk-around capture.
//
// One clip replaces four staged photos. The seller records (or picks) a short
// video, then scrubs it once and taps "Mark this view" when each of the four
// required views is on screen. Those marks are timestamps the SERVER samples at
// — they are a hint, not a promise: the edge re-validates every mark against the
// real clip duration and falls back to even sampling for anything unmarked, so
// a seller who skips the marking step still gets a graded item.
//
// Photo mode is always one click away and is never presented as the lesser
// path: a clip that yields no usable view of a required angle comes back as
// needs_photos, and the honest thing to offer at that point is photos.

export interface VideoWalkaroundProps {
  file: File | null;
  marks: VideoSlotMarks;
  /** US-1766: how the attached clip entered the app; null when none is attached. */
  source: VideoCaptureSource | null;
  onClipChange: (file: File | null, source: VideoCaptureSource | null) => void;
  onMarksChange: (marks: VideoSlotMarks) => void;
  /** 0..100 while the clip is uploading; null when not uploading. */
  uploadProgress: number | null;
  /** Switch the whole step back to staged photos. */
  onUsePhotos: () => void;
}

function formatSeconds(t: number): string {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, "0")}`;
}

export function VideoWalkaround({
  file,
  marks,
  source,
  onClipChange,
  onMarksChange,
  uploadProgress,
  onUsePhotos,
}: VideoWalkaroundProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  // Feature-detected once per mount: no camera / no MediaRecorder / no format we
  // can grade all mean the same thing here — offer the picker and say nothing
  // about a recorder that isn't there.
  const [canRecord] = useState(() => isVideoRecordingSupported());
  const liveCaptured = source === IN_APP_VIDEO_CAPTURE_SOURCE;

  // Object URLs are a leak if they outlive the element that reads them.
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      setDuration(null);
      setCurrentTime(0);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function handlePick(next: File | null) {
    setError(null);
    if (!next) {
      onClipChange(null, null);
      onMarksChange({});
      return;
    }
    if (next.size > MAX_VIDEO_BYTES) {
      setError(
        `That clip is ${(next.size / 1024 / 1024).toFixed(0)} MB. Keep it under ${
          MAX_VIDEO_BYTES / 1024 / 1024
        } MB — a slow lap around the item is plenty.`,
      );
      return;
    }
    // Marks belong to the clip they were taken from; a new clip starts clean.
    onMarksChange({});
    onClipChange(next, LIBRARY_VIDEO_CAPTURE_SOURCE);
  }

  /**
   * A clip the recorder just produced. It arrives with its views already
   * timestamped — the seller marked them by following the prompts, so there is
   * nothing left to scrub for.
   */
  function handleRecorded(next: File, recordedMarks: VideoSlotMarks) {
    setError(null);
    setRecording(false);
    if (next.size > MAX_VIDEO_BYTES) {
      setError(
        `That recording came out at ${(next.size / 1024 / 1024).toFixed(0)} MB, over the ${
          MAX_VIDEO_BYTES / 1024 / 1024
        } MB limit. Record a shorter lap, or switch to photos.`,
      );
      return;
    }
    onMarksChange(recordedMarks);
    onClipChange(next, IN_APP_VIDEO_CAPTURE_SOURCE);
  }

  function markSlot(slot: VideoSlotKey) {
    const at = videoRef.current?.currentTime;
    if (typeof at !== "number" || !Number.isFinite(at)) return;
    onMarksChange({ ...marks, [slot]: Number(at.toFixed(2)) });
  }

  function clearSlot(slot: VideoSlotKey) {
    const next = { ...marks };
    delete next[slot];
    onMarksChange(next);
  }

  function seekTo(at: number) {
    if (videoRef.current) videoRef.current.currentTime = at;
  }

  const tooLong = duration !== null && duration > MAX_VIDEO_DURATION_SECONDS;
  const uploading = uploadProgress !== null;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border p-4">
        <div className="flex items-start gap-3">
          <Film className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="space-y-1">
            <p className="text-sm font-medium">Record one walk-around</p>
            <p className="text-sm text-muted-foreground">
              Hold the item up and walk around it slowly: front, back, the brand
              or care tag, then a close-up of the fabric. Keep it under{" "}
              {MAX_VIDEO_DURATION_SECONDS} seconds and shoot in even light. We
              pull the still frames out ourselves.
            </p>
          </div>
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={VIDEO_ACCEPT}
        capture="environment"
        className="sr-only"
        onChange={(e) => handlePick(e.target.files?.[0] ?? null)}
      />

      {!file && recording ? (
        <VideoRecorder
          onRecorded={handleRecorded}
          onFallback={() => {
            setRecording(false);
            inputRef.current?.click();
          }}
          onCancel={() => setRecording(false)}
        />
      ) : !file ? (
        <div className="space-y-2">
          {canRecord && (
            <Button
              type="button"
              size="lg"
              className="w-full"
              onClick={() => setRecording(true)}
            >
              <Video className="mr-2 h-4 w-4" />
              Record it here
            </Button>
          )}
          <Button
            type="button"
            size="lg"
            variant={canRecord ? "outline" : "default"}
            className="w-full"
            onClick={() => inputRef.current?.click()}
          >
            <ImageUp className="mr-2 h-4 w-4" />
            Choose a clip from this device
          </Button>
          {canRecord && (
            <p className="text-xs text-muted-foreground">
              Recording here walks you through the four views and timestamps
              each one as you film it. It also earns the stronger
              &ldquo;recorded live&rdquo; note on your certificate, because the
              footage never existed as a file before you sent it. A clip you
              pick is graded exactly the same way.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="overflow-hidden rounded-lg border bg-black">
            {previewUrl && (
              <video
                ref={videoRef}
                src={previewUrl}
                controls
                playsInline
                preload="metadata"
                className="max-h-80 w-full"
                onLoadedMetadata={(e) =>
                  setDuration(e.currentTarget.duration || null)}
                onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
              />
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
              {duration !== null ? ` · ${duration.toFixed(1)}s` : ""}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={uploading}
              // Clear rather than reopen the picker: it returns the seller to
              // both options, so a clip picked once doesn't lock them out of
              // recording.
              onClick={() => handlePick(null)}
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Use a different clip
            </Button>
          </div>

          {liveCaptured && (
            <div className="flex items-start gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <p className="text-xs text-muted-foreground">
                Recorded live in the app. Your certificate will say so — buyers
                see that this footage was never a file on your phone first.
              </p>
            </div>
          )}

          {tooLong && (
            <div className="rounded-md border border-amber-500/30 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              This clip is {duration?.toFixed(1)}s. Clips over{" "}
              {MAX_VIDEO_DURATION_SECONDS}s are rejected — trim it or record a
              quicker lap.
            </div>
          )}

          <div className="space-y-2">
            <p className="text-sm font-medium">
              Mark each view{" "}
              <span className="font-normal text-muted-foreground">
                (optional, but it makes the grade sharper)
              </span>
            </p>
            <p className="text-xs text-muted-foreground">
              Scrub to where the item&apos;s {formatSeconds(currentTime)} mark
              shows each view, then tap it below. Anything you skip, we sample
              for ourselves.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {VIDEO_SLOT_PROMPTS.map((prompt) => {
                const at = marks[prompt.key];
                const marked = at !== undefined;
                return (
                  <div
                    key={prompt.key}
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-lg border p-3",
                      marked && "border-primary/50 bg-primary/5",
                    )}
                  >
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 text-sm font-medium">
                        {marked && <Check className="h-3.5 w-3.5 text-primary" />}
                        {prompt.label}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {marked
                          ? `Marked at ${formatSeconds(at)}`
                          : prompt.hint}
                      </p>
                    </div>
                    {marked ? (
                      <div className="flex shrink-0 gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={uploading}
                          onClick={() => seekTo(at)}
                          aria-label={`Go to the ${prompt.label} mark`}
                        >
                          Go to
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={uploading}
                          onClick={() => clearSlot(prompt.key)}
                          aria-label={`Clear the ${prompt.label} mark`}
                        >
                          Clear
                        </Button>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        disabled={uploading}
                        aria-label={`Mark the ${prompt.label} here`}
                        onClick={() => markSlot(prompt.key)}
                      >
                        Mark here
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {uploading && (
        <div className="space-y-1.5">
          <Progress value={uploadProgress ?? 0} />
          <p className="text-xs text-muted-foreground">
            {(uploadProgress ?? 0) < 100
              ? `Uploading your clip — ${Math.round(uploadProgress ?? 0)}%`
              : "Pulling frames out of your clip…"}
          </p>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Prefer to stage the shots yourself?{" "}
        <button
          type="button"
          className="underline hover:text-foreground"
          onClick={onUsePhotos}
          disabled={uploading}
        >
          Switch to photo mode
        </button>
        . Photos and video grade on the same scale — the clip just saves you the
        setup.
      </p>
    </div>
  );
}
