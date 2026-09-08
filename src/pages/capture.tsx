// US-3161: the page the phone opens after scanning the code.
//
// This page is PUBLIC and has no sign-in, because that is the whole feature: a
// seller at a desk scans a code and shoots, without installing anything or
// typing a password on a phone while holding a jumper. The scanned token is the
// only credential and every limit on it lives on the server.
//
// It is written for someone standing up, holding a garment, on a phone
// connection, who cannot debug anything:
//   • ONE control, as large as the screen allows.
//   • Every refusal is a sentence about what to do next, never a code.
//   • A dead link says the code is finished and to get a new one, which is the
//     only useful thing anybody can do about it.
//   • A failed send is retried once by itself, then names the shot that did not
//     go rather than reporting a number.

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { Camera, Check, Loader2 } from "lucide-react";
import { SEO } from "@/components/seo";
import { Button } from "@/components/ui/button";
import { edgeFetch } from "@/lib/edge-fetch";
import {
  type CaptureFetch,
  type CapturePublicState,
  captureClientKey,
  missingSentence,
  readCapturePublic,
  sendCapturePhotoWithRetry,
  timeLeft,
} from "@/lib/phone-capture-client";

const fetchEdge: CaptureFetch = (path, init) =>
  edgeFetch(path, {
    method: init?.method,
    body: init?.body,
    json: init?.json,
    unauthenticated: init?.unauthenticated,
  });

interface Sent {
  key: string;
  name: string;
  state: "sending" | "sent" | "failed";
}

export function CapturePage() {
  const { token = "" } = useParams<{ token: string }>();
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<CapturePublicState | null>(null);
  const [dead, setDead] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent[]>([]);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    void readCapturePublic(fetchEdge, token).then((r) => {
      if (!alive) return;
      if (r.ok) setState(r.state);
      else setDead(r.reason);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [token]);

  // The countdown is the only thing on this page that moves on its own, and it
  // is worth having: a seller who set the code down for ten minutes should see
  // that it is nearly out rather than find out by a photo failing.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const send = useCallback(
    async (files: FileList) => {
      setBusy(true);
      for (const file of Array.from(files)) {
        const key = captureClientKey();
        setSent((prev) => [...prev, { key, name: file.name, state: "sending" }]);

        // One automatic retry on a failure worth retrying, with the SAME client
        // key — see sendCapturePhotoWithRetry for why that is what makes it safe.
        const result = await sendCapturePhotoWithRetry(fetchEdge, token, file, key);

        setSent((prev) =>
          prev.map((s) => (s.key === key ? { ...s, state: result.ok ? "sent" : "failed" } : s))
        );
        if (result.ok) {
          setState((prev) =>
            prev
              ? {
                ...prev,
                photosTaken: result.photosTaken ?? prev.photosTaken,
                photosLeft: result.photosLeft ?? prev.photosLeft,
                // US-3162: the server recomputes this per upload, so the prompt
                // updates as shots land without a second round trip.
                missingTypes: result.missingTypes ?? prev.missingTypes,
              }
              : prev
          );
        }
        if (result.gone) {
          setDead(result.error ?? "This code is finished. Scan a new one.");
          break;
        }
      }
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    },
    [token],
  );

  const remaining = state ? timeLeft(state.expiresAt, now) : null;
  const stillNeeded = state ? missingSentence(state.missingTypes) : null;
  const failed = sent.filter((s) => s.state === "failed");

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-6 p-6">
      <SEO title="Send photos" noindex />

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          Checking the code…
        </div>
      ) : dead ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <p className="text-lg font-medium">{dead}</p>
          <p className="text-sm text-muted-foreground">
            Go back to the computer and start the phone camera again to get a
            fresh code.
          </p>
        </div>
      ) : (
        <>
          <header className="space-y-1">
            <h1 className="text-2xl font-bold">Send photos</h1>
            <p className="text-sm text-muted-foreground">
              Take the photos here and they appear on the computer.
              {remaining ? ` This code works for another ${remaining}.` : ""}
            </p>
          </header>

          {/* US-3162: what is still missing, in the words the rest of FlipDesk
              uses, so the phone tells the seller what to shoot NEXT rather than
              leaving them to remember. It updates as shots land. */}
          {stillNeeded && (
            <p className="rounded-md bg-muted px-3 py-2 text-sm font-medium">
              {stillNeeded}
            </p>
          )}
          {state && state.targetKind === "item" && state.missingTypes.length === 0 &&
            state.photosTaken > 0 && (
            <p className="rounded-md bg-muted px-3 py-2 text-sm font-medium">
              That is every shot this item needs. Keep going if you want more.
            </p>
          )}

          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            multiple
            className="sr-only"
            aria-label="Take a photo"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) void send(e.target.files);
            }}
          />

          <Button
            type="button"
            size="lg"
            className="h-32 w-full text-lg"
            disabled={busy || (state?.photosLeft ?? 0) <= 0}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? (
              <>
                <Loader2 className="mr-2 h-6 w-6 animate-spin" />
                Sending…
              </>
            ) : (
              <>
                <Camera className="mr-2 h-8 w-8" />
                Take a photo
              </>
            )}
          </Button>

          <p className="text-center text-sm text-muted-foreground">
            {state ? `${state.photosTaken} sent` : ""}
            {state && state.photosLeft <= 0 ? " — that is all this code holds." : ""}
          </p>

          {failed.length > 0 && (
            <div className="rounded-md border border-destructive/40 p-3 text-sm">
              <p className="font-medium">These did not send. Take them again:</p>
              <ul className="mt-1 list-inside list-disc text-muted-foreground">
                {failed.map((s) => (
                  <li key={s.key}>{s.name}</li>
                ))}
              </ul>
            </div>
          )}

          {sent.length > 0 && (
            <ul className="space-y-1 text-sm text-muted-foreground">
              {sent.filter((s) => s.state === "sent").map((s) => (
                <li key={s.key} className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-primary" />
                  <span className="truncate">{s.name}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}

export default CapturePage;
