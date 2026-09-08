// US-3161: the desktop half of phone-as-camera. Scan this, shoot on the phone.
//
// The code IS the credential, so this dialog treats it like one: it is drawn
// once from a URL the server returned, it is never written to a field anybody
// can copy out of the page by accident, and closing or finishing the dialog
// ends the session on the server rather than merely hiding it.
//
// The countdown is not decoration. A code lives fifteen minutes, and a seller
// who set the phone down should see it running out rather than discover it by a
// photo failing.

import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Loader2, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { edgeFetch } from "@/lib/edge-fetch";
import {
  type CaptureFetch,
  type CapturePhoto,
  type CaptureStartResult,
  CAPTURE_POLL_MS,
  endCapture,
  readCaptureStatus,
  startCapture,
  timeLeft,
} from "@/lib/phone-capture-client";

const fetchEdge: CaptureFetch = (path, init) =>
  edgeFetch(path, {
    method: init?.method,
    body: init?.body,
    json: init?.json,
    unauthenticated: init?.unauthenticated,
  });

export interface PhoneCaptureDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetKind: "item" | "batch";
  targetId: string;
  /** Each newly arrived photo. Awaited, so the poll waits for the item to save. */
  onPhotos: (photos: CapturePhoto[]) => void | Promise<void>;
}

export function PhoneCaptureDialog({
  open,
  onOpenChange,
  targetKind,
  targetId,
  onPhotos,
}: PhoneCaptureDialogProps) {
  const [session, setSession] = useState<CaptureStartResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [live, setLive] = useState(true);
  const [now, setNow] = useState(Date.now());

  const seenRef = useRef<Set<string>>(new Set());
  const onPhotosRef = useRef(onPhotos);
  onPhotosRef.current = onPhotos;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setSession(null);
    setError(null);
    setCount(0);
    setLive(true);
    seenRef.current = new Set();
    void startCapture(fetchEdge, targetKind, targetId)
      .then((s) => {
        if (alive) setSession(s);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : "Could not start the phone camera.");
      });
    return () => {
      alive = false;
    };
  }, [open, targetKind, targetId]);

  // Poll while the dialog is open. Only NEW photo ids are handed up, so a poll
  // that returns the same three photos does not add them three times.
  useEffect(() => {
    if (!open || !session) return;
    let alive = true;
    const tick = async () => {
      try {
        const status = await readCaptureStatus(fetchEdge, session.sessionId);
        if (!alive) return;
        setCount(status.photoCount);
        setLive(status.live);
        const fresh = status.photos.filter((p) => !seenRef.current.has(p.id));
        if (fresh.length > 0) {
          for (const p of fresh) seenRef.current.add(p.id);
          await onPhotosRef.current(fresh);
        }
      } catch {
        // A dropped poll is not worth a message; the next one is CAPTURE_POLL_MS
        // away and the phone is still uploading regardless.
      }
    };
    void tick();
    const id = setInterval(() => void tick(), CAPTURE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [open, session]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Closing ENDS the code rather than hiding it. A code left alive after the
  // seller thinks they are finished is an upload credential nobody is watching.
  const finish = useCallback(() => {
    if (session) void endCapture(fetchEdge, session.sessionId);
    onOpenChange(false);
  }, [session, onOpenChange]);

  const remaining = session ? timeLeft(session.expiresAt, now) : null;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : finish())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Use your phone as the camera</DialogTitle>
          <DialogDescription>
            Point your phone camera at this code. A page opens on the phone. Take
            the photos there and they appear here.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="py-8 text-center text-sm text-destructive">{error}</p>
        ) : !session ? (
          <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            Making a code…
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 py-2">
            <div className="rounded-lg bg-white p-4">
              <QRCodeSVG value={session.url} size={200} />
            </div>
            <p className="text-center text-sm text-muted-foreground">
              {live
                ? remaining
                  ? `This code works for another ${remaining}.`
                  : "This code has run out. Close and start again."
                : "This code is finished."}
            </p>
            <p className="flex items-center gap-2 text-sm">
              <Smartphone className="h-4 w-4 text-muted-foreground" />
              {count === 0
                ? "Waiting for the first photo…"
                : `${count} ${count === 1 ? "photo" : "photos"} so far`}
            </p>
          </div>
        )}

        <DialogFooter>
          <Button type="button" onClick={finish}>
            {count > 0 ? "Done" : "Cancel"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
