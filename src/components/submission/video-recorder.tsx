// US-1766: guided in-app walk-around recorder.
//
// Two jobs, and they are the same job. It records the clip HERE, off the camera
// stream, so the submission can honestly claim the footage never existed as a
// file beforehand (the 'in_app_recorder' provenance marker the certificate's
// live reading rests on). And because it is driving the shoot, it can prompt for
// each required view in turn and timestamp them as they happen — so the seller
// gets the guided front/back/label/detail sequence with three taps instead of
// scrubbing a finished clip four times.
//
// Never a dead end: no MediaRecorder, no camera, a denied permission or a
// browser that records nothing the server accepts all land on the same inline
// message plus the file picker. Recording is the better path, not the only one.
import { useCallback, useEffect, useRef, useState } from "react";
import { Circle, ImageUp, Square, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  MAX_VIDEO_DURATION_SECONDS,
  pickRecorderMimeType,
  recordedClipName,
  segmentMarkSeconds,
  VIDEO_SLOT_PROMPTS,
  type VideoSlotMarks,
} from "@/lib/video-capture";

/**
 * Feature-detect the whole path in one place: secure-context getUserMedia AND a
 * MediaRecorder that can produce a container the edge accepts. Either half
 * missing means the recorder cannot deliver a gradeable clip.
 */
export function isVideoRecordingSupported(): boolean {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) return false;
  if (typeof navigator.mediaDevices.getUserMedia !== "function") return false;
  if (typeof MediaRecorder === "undefined") return false;
  return pickRecorderMimeType((t) => MediaRecorder.isTypeSupported(t)) !== null;
}

type RecorderStatus = "starting" | "ready" | "recording" | "saving" | "error";

export interface VideoRecorderProps {
  /** The finished clip plus the marks taken while it was shot. */
  onRecorded: (file: File, marks: VideoSlotMarks) => void;
  /** Seller backed out, or the camera isn't usable — open the file picker. */
  onFallback: () => void;
  /** Close the recorder without a clip. */
  onCancel: () => void;
}

export function VideoRecorder({
  onRecorded,
  onFallback,
  onCancel,
}: VideoRecorderProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number>(0);
  const segmentStartRef = useRef<number>(0);
  const marksRef = useRef<VideoSlotMarks>({});

  const [status, setStatus] = useState<RecorderStatus>("starting");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [step, setStep] = useState(0);

  const stopCamera = useCallback(() => {
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  // Open the camera on mount; tear the stream down on unmount so the camera
  // light never lingers after the seller moves on.
  useEffect(() => {
    let cancelled = false;

    async function start() {
      if (!isVideoRecordingSupported()) {
        setError(
          "This browser can't record video in-app. Choose a clip from your device instead — it grades exactly the same.",
        );
        setStatus("error");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1920 } },
          // No audio: the grade is read off frames, so recording sound would
          // collect something we never look at.
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const el = videoRef.current;
        if (el) {
          el.srcObject = stream;
          await el.play().catch(() => {
            /* autoplay can reject; the preview still renders */
          });
        }
        setStatus("ready");
      } catch (err) {
        const name = err instanceof DOMException ? err.name : (err as Error)?.name;
        setError(
          name === "NotAllowedError" || name === "SecurityError"
            ? "Camera access was blocked. Allow it, or choose a clip from your device instead."
            : name === "NotFoundError" || name === "OverconstrainedError"
            ? "No usable camera was found. Choose a clip from your device instead."
            : "Couldn't open the camera. Choose a clip from your device instead.",
        );
        setStatus("error");
        stopCamera();
      }
    }

    start();
    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [stopCamera]);

  // Elapsed timer while recording. Also the hard stop: a clip over the cap is
  // rejected server-side, so ending it ourselves is kinder than a failed upload.
  useEffect(() => {
    if (status !== "recording") return;
    const id = window.setInterval(() => {
      const secs = (Date.now() - startedAtRef.current) / 1000;
      setElapsed(secs);
      if (secs >= MAX_VIDEO_DURATION_SECONDS) {
        recorderRef.current?.stop();
      }
    }, 200);
    return () => window.clearInterval(id);
  }, [status]);

  /** Timestamp the segment just filmed against the view it was filmed for. */
  const closeSegment = useCallback((atSeconds: number) => {
    const slot = VIDEO_SLOT_PROMPTS[step]?.key;
    if (!slot) return;
    const mark = segmentMarkSeconds(segmentStartRef.current, atSeconds);
    if (mark !== null) marksRef.current = { ...marksRef.current, [slot]: mark };
    segmentStartRef.current = atSeconds;
  }, [step]);

  const handleStart = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || status !== "ready") return;
    const mimeType = pickRecorderMimeType((t) => MediaRecorder.isTypeSupported(t));
    if (!mimeType) {
      setError(
        "This browser can't record a format we can grade. Choose a clip from your device instead.",
      );
      setStatus("error");
      return;
    }

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType });
    } catch {
      setError(
        "Couldn't start recording here. Choose a clip from your device instead.",
      );
      setStatus("error");
      return;
    }

    chunksRef.current = [];
    marksRef.current = {};
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      stopCamera();
      const blob = new Blob(chunksRef.current, { type: mimeType });
      if (blob.size === 0) {
        setError("That recording came back empty. Try again, or choose a clip.");
        setStatus("error");
        return;
      }
      onRecorded(
        new File([blob], recordedClipName(mimeType), { type: mimeType }),
        marksRef.current,
      );
    };

    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    segmentStartRef.current = 0;
    setElapsed(0);
    setStep(0);
    setStatus("recording");
    recorder.start();
  }, [status, onRecorded, stopCamera]);

  const handleNextView = useCallback(() => {
    if (status !== "recording") return;
    closeSegment((Date.now() - startedAtRef.current) / 1000);
    setStep((s) => Math.min(s + 1, VIDEO_SLOT_PROMPTS.length - 1));
  }, [status, closeSegment]);

  const handleStop = useCallback(() => {
    if (status !== "recording") return;
    closeSegment((Date.now() - startedAtRef.current) / 1000);
    setStatus("saving");
    recorderRef.current?.stop();
  }, [status, closeSegment]);

  // VIDEO_SLOT_PROMPTS is a non-empty constant, but the index signature doesn't
  // say so — fall back to the first prompt rather than render an empty cue.
  const prompt = VIDEO_SLOT_PROMPTS[Math.min(step, VIDEO_SLOT_PROMPTS.length - 1)] ??
    VIDEO_SLOT_PROMPTS[0]!;
  const lastStep = step >= VIDEO_SLOT_PROMPTS.length - 1;

  if (status === "error") {
    return (
      <div className="space-y-3 rounded-lg border p-4">
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={onFallback}>
            <ImageUp className="mr-2 h-4 w-4" />
            Choose a clip instead
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-lg border bg-black">
        <video
          ref={videoRef}
          className="max-h-96 w-full object-contain"
          muted
          playsInline
          autoPlay
        />

        {status === "recording" && (
          <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-2 bg-black/55 px-3 py-2 text-white">
            <span className="flex items-center gap-1.5 text-xs font-medium">
              <Circle className="h-2.5 w-2.5 animate-pulse fill-current text-red-400" />
              {elapsed.toFixed(1)}s / {MAX_VIDEO_DURATION_SECONDS}s
            </span>
            <span className="text-xs">
              View {step + 1} of {VIDEO_SLOT_PROMPTS.length}
            </span>
          </div>
        )}

        {status !== "ready" && status !== "recording" && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 text-white"
            role="status"
            aria-live="polite"
          >
            <div
              className="h-6 w-6 animate-spin rounded-full border-2 border-white border-t-transparent"
              aria-hidden="true"
            />
            <span className="text-xs">
              {status === "saving" ? "Saving your clip…" : "Starting camera…"}
            </span>
          </div>
        )}
      </div>

      {/* The guided half. While recording, exactly one instruction is on screen:
          what to point the camera at right now. */}
      <div
        className={cn(
          "rounded-lg border p-3",
          status === "recording" && "border-primary/50 bg-primary/5",
        )}
        aria-live="polite"
      >
        <p className="text-sm font-medium">
          {status === "recording" ? `Now show: ${prompt.label}` : "Ready when you are"}
        </p>
        <p className="text-xs text-muted-foreground">
          {status === "recording"
            ? prompt.hint
            : `Tap record, then follow the prompts: ${VIDEO_SLOT_PROMPTS.map((p) => p.label).join(", ")}. We timestamp each view as you film it.`}
        </p>
      </div>

      {status === "recording" ? (
        <div className="flex gap-2">
          {!lastStep && (
            <Button type="button" className="flex-1" onClick={handleNextView}>
              Next: {VIDEO_SLOT_PROMPTS[step + 1]?.label}
            </Button>
          )}
          <Button
            type="button"
            variant={lastStep ? "default" : "outline"}
            className={cn(lastStep && "flex-1")}
            onClick={handleStop}
          >
            <Square className="mr-2 h-4 w-4" />
            Finish
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            className="flex-1"
            disabled={status !== "ready"}
            onClick={handleStart}
          >
            <Video className="mr-2 h-4 w-4" />
            Start recording
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
