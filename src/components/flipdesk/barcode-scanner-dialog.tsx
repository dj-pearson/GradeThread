// US-598: web barcode/UPC scanner for intake autofill.
//
// Two capture paths, no extra dependencies:
//   1. Camera — the native Barcode Detection API (Chromium/Android). Feature-
//      detected; absent in Firefox/Safari, where we fall back to (2).
//   2. Manual / hardware scanner — a focused text box. USB/Bluetooth barcode
//      guns act as keyboards: they "type" the digits and press Enter, which
//      submits the form. Resellers can also just type a code.
import { useCallback, useEffect, useRef, useState } from "react";
import { ScanBarcode, Camera, CameraOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Minimal typing for the native Barcode Detection API (not in lib.dom yet).
interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): BarcodeDetectorLike;
}

function getBarcodeDetectorCtor(): BarcodeDetectorCtor | null {
  const w = window as unknown as { BarcodeDetector?: BarcodeDetectorCtor };
  return w.BarcodeDetector ?? null;
}

const SCAN_FORMATS = [
  "upc_a",
  "upc_e",
  "ean_13",
  "ean_8",
  "code_128",
  "code_39",
  "itf",
  "qr_code",
];

export function BarcodeScannerDialog({
  open,
  onOpenChange,
  onDetected,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDetected: (code: string) => void;
}) {
  const [manual, setManual] = useState("");
  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const cameraSupported = getBarcodeDetectorCtor() != null;

  const stopCamera = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setScanning(false);
  }, []);

  const emit = useCallback(
    (code: string) => {
      const trimmed = code.trim();
      if (!trimmed) return;
      stopCamera();
      onDetected(trimmed);
    },
    [stopCamera, onDetected]
  );

  const startCamera = useCallback(async () => {
    const Ctor = getBarcodeDetectorCtor();
    if (!Ctor) {
      setCameraError(
        "This browser can't scan with the camera. Type or scan the code into the box below."
      );
      return;
    }
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      video.srcObject = stream;
      await video.play();
      setScanning(true);
      const detector = new Ctor({ formats: SCAN_FORMATS });
      const tick = async () => {
        if (!streamRef.current || !videoRef.current) return;
        try {
          const codes = await detector.detect(videoRef.current);
          const first = codes[0]?.rawValue;
          if (first) {
            emit(first);
            return;
          }
        } catch {
          /* transient decode error — keep polling */
        }
        timerRef.current = window.setTimeout(tick, 250);
      };
      timerRef.current = window.setTimeout(tick, 250);
    } catch {
      setCameraError(
        "Couldn't access the camera. Check permissions, or type the code below."
      );
      stopCamera();
    }
  }, [emit, stopCamera]);

  // Tear the camera down whenever the dialog closes or the component unmounts.
  useEffect(() => {
    if (!open) {
      stopCamera();
      setManual("");
      setCameraError(null);
    }
    return () => stopCamera();
  }, [open, stopCamera]);

  function handleManualSubmit(e: React.FormEvent) {
    e.preventDefault();
    emit(manual);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScanBarcode className="h-5 w-5 text-primary" />
            Scan barcode / UPC
          </DialogTitle>
          <DialogDescription>
            Scan a UPC/EAN or sneaker style code to autofill brand and product
            details.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {cameraSupported && (
            <div className="space-y-2">
              <div className="relative overflow-hidden rounded-lg border bg-muted">
                <video
                  ref={videoRef}
                  className={
                    scanning
                      ? "aspect-video w-full object-cover"
                      : "hidden"
                  }
                  muted
                  playsInline
                />
                {!scanning && (
                  <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 text-muted-foreground">
                    <Camera className="h-8 w-8" />
                    <span className="text-sm">Camera is off</span>
                  </div>
                )}
                {scanning && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div className="h-24 w-3/4 rounded-md border-2 border-primary/80" />
                  </div>
                )}
              </div>
              {scanning ? (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={stopCamera}
                >
                  <CameraOff className="mr-2 h-4 w-4" />
                  Stop camera
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={startCamera}
                >
                  <Camera className="mr-2 h-4 w-4" />
                  Scan with camera
                </Button>
              )}
            </div>
          )}

          {cameraError && (
            <p className="text-sm text-destructive">{cameraError}</p>
          )}

          <form onSubmit={handleManualSubmit} className="space-y-2">
            <Label htmlFor="barcode-manual">
              {cameraSupported ? "Or enter a code" : "Enter or scan a code"}
            </Label>
            <div className="flex gap-2">
              <Input
                id="barcode-manual"
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                placeholder="e.g. 193151000000 or CW2288-111"
                autoFocus={!cameraSupported}
                inputMode="text"
                autoComplete="off"
              />
              <Button type="submit" disabled={!manual.trim()}>
                Look up
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              USB/Bluetooth barcode scanners type the code here and submit
              automatically.
            </p>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
