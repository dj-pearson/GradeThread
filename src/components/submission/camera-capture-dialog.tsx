// US-947: in-browser camera capture for the web grading submission flow.
//
// Lets a seller shoot a photo straight into a slot via getUserMedia/WebRTC
// instead of leaving for the native camera + file picker. The captured frame is
// handed back as a JPEG File and runs through the SAME validate → compress →
// EXIF path as a manual upload (see processFile in photo-upload.tsx) — no
// bypass. getUserMedia frames are already display-oriented (no EXIF rotation),
// so orientation is correct on iOS Safari without any extra transform.
//
// Graceful degradation: a denied permission or an unsupported browser shows a
// clear inline message plus a "Choose a file instead" button that drops the
// seller onto the existing file input (no dead-end).
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, ImageUp, RefreshCw, SwitchCamera } from "lucide-react";
import {
  captureGuidanceFor,
  overlayFillFraction,
} from "@/lib/macro-capture-guidance";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Feature-detect once: getUserMedia is gated to secure contexts (https /
// localhost), so this is false on insecure origins and old browsers too.
export function isCameraCaptureSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function"
  );
}

type CameraStatus = "starting" | "ready" | "capturing" | "error";

interface CameraCaptureDialogProps {
  open: boolean;
  slotLabel: string;
  // US-2137: the slot's server photo_type, when known. Drives the framing
  // overlay + distance/lighting cue. Optional so a caller without a slot
  // (generic capture) still works, just without guidance.
  photoType?: string | null;
  onOpenChange: (open: boolean) => void;
  // The captured frame as a JPEG File — caller routes it through processFile.
  onCapture: (file: File) => void;
  // Seller opted out of live capture (denied/unsupported) — caller opens the
  // matching file input so they can pick a photo instead.
  onFallback: () => void;
}

export function CameraCaptureDialog({
  open,
  slotLabel,
  photoType,
  onOpenChange,
  onCapture,
  onFallback,
}: CameraCaptureDialogProps) {
  const guidance = captureGuidanceFor(photoType);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<CameraStatus>("starting");
  const [error, setError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<"environment" | "user">(
    "environment"
  );

  const stopCamera = useCallback(() => {
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const startCamera = useCallback(
    async (mode: "environment" | "user") => {
      setStatus("starting");
      setError(null);
      stopCamera();

      if (!isCameraCaptureSupported()) {
        setError(
          "This browser doesn't support in-app camera capture. Upload a photo from your device instead."
        );
        setStatus("error");
        return;
      }

      try {
        // Ask for a high-resolution frame so the capture clears the
        // 1200×1200 minimum validateImage enforces; the browser falls back to
        // the best the camera can do if it can't hit the ideal.
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: mode,
            width: { ideal: 2400 },
            height: { ideal: 2400 },
          },
          audio: false,
        });
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        video.srcObject = stream;
        await video.play().catch(() => {
          /* autoplay can reject on some browsers; the frame still renders */
        });
        setStatus("ready");
      } catch (err) {
        const name =
          err instanceof DOMException ? err.name : (err as Error)?.name;
        let message = "Couldn't open the camera. Upload a photo instead.";
        if (name === "NotAllowedError" || name === "SecurityError") {
          message =
            "Camera permission was blocked. Allow camera access, or upload a photo from your device instead.";
        } else if (
          name === "NotFoundError" ||
          name === "DevicesNotFoundError" ||
          name === "OverconstrainedError"
        ) {
          message =
            "No usable camera was found on this device. Upload a photo instead.";
        }
        setError(message);
        setStatus("error");
        stopCamera();
      }
    },
    [stopCamera]
  );

  // Start when the dialog opens or the chosen camera changes; tear the stream
  // down on close and unmount so the camera light never lingers.
  useEffect(() => {
    if (open) {
      startCamera(facingMode);
    } else {
      stopCamera();
      setStatus("starting");
      setError(null);
    }
    return () => stopCamera();
  }, [open, facingMode, startCamera, stopCamera]);

  const handleCapture = useCallback(() => {
    const video = videoRef.current;
    if (!video || status !== "ready") return;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) {
      setError("The camera isn't ready yet. Try again in a moment.");
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setError("Couldn't capture the photo. Upload a photo instead.");
      return;
    }
    ctx.drawImage(video, 0, 0, width, height);

    setStatus("capturing");
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setError("Couldn't capture the photo. Try again.");
          setStatus("ready");
          return;
        }
        const safe = slotLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const file = new File([blob], `camera-${safe || "photo"}.jpg`, {
          type: "image/jpeg",
        });
        stopCamera();
        onCapture(file);
      },
      "image/jpeg",
      0.92
    );
  }, [status, slotLabel, onCapture, stopCamera]);

  const handleFallback = useCallback(() => {
    stopCamera();
    onFallback();
  }, [stopCamera, onFallback]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Camera className="h-5 w-5 text-primary" />
            Take {slotLabel} photo
          </DialogTitle>
          <DialogDescription>
            Frame the garment and capture — the photo runs through the same
            checks as an upload.
          </DialogDescription>
        </DialogHeader>

        {status === "error" ? (
          <div className="space-y-3">
            <p className="text-sm text-destructive">{error}</p>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={handleFallback}
            >
              <ImageUp className="mr-2 h-4 w-4" />
              Choose a file instead
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="relative overflow-hidden rounded-lg border bg-black">
              <video
                ref={videoRef}
                className="aspect-square w-full object-cover"
                muted
                playsInline
                autoPlay
              />
              {/* US-2137: framing overlay. A macro shot fails on distance far
                  more often than on anything else, and "get closer" is hard to
                  judge against nothing. The box is sized so that FILLING IT
                  clears the US-2136 quality floors at the US-2135 upload caps —
                  a guide you can satisfy and still be rejected is worse than
                  none. Purely decorative: the capture is the full frame, so the
                  box constrains composition, never the saved pixels. */}
              {status === "ready" && guidance && (
                <div
                  className="pointer-events-none absolute inset-0 flex items-center justify-center"
                  aria-hidden="true"
                >
                  <div
                    className="rounded-lg border-2 border-dashed border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.25)]"
                    style={{
                      width: `${overlayFillFraction(guidance.framing) * 100}%`,
                      aspectRatio: "1 / 1",
                    }}
                  />
                </div>
              )}

              {status !== "ready" && (
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
                    {status === "capturing"
                      ? "Capturing…"
                      : "Starting camera…"}
                  </span>
                </div>
              )}
            </div>

            {/* US-2137: distance and lighting, in that order — distance is what
                sellers get wrong most, and lighting is what they never think
                about. Rendered as instructions, not labels: the existing
                photo-profiles hint already says WHAT the shot is. */}
            {guidance && (
              <div className="space-y-0.5 text-xs leading-tight text-muted-foreground">
                <p>{guidance.distance}</p>
                <p>{guidance.lighting}</p>
              </div>
            )}

            <div className="flex items-center gap-2">
              <Button
                type="button"
                className="flex-1"
                onClick={handleCapture}
                disabled={status !== "ready"}
              >
                <Camera className="mr-2 h-4 w-4" />
                Capture
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Switch camera"
                title="Switch camera"
                disabled={status === "starting"}
                onClick={() =>
                  setFacingMode((m) =>
                    m === "environment" ? "user" : "environment"
                  )
                }
              >
                <SwitchCamera className="h-4 w-4" />
              </Button>
            </div>

            <DialogFooter className="sm:justify-start">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={handleFallback}
              >
                <RefreshCw className="mr-2 h-3.5 w-3.5" />
                Upload a file instead
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
