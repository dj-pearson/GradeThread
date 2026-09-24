import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Camera, Clock, Loader2, Sparkles, BadgeCheck, Store, Info, Trash2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { compressImage } from "@/lib/image-utils";
import {
  SNAP_COMPRESS,
  SNAP_MAX_SOURCE_BYTES,
  SNAP_MAX_UPLOAD_BYTES,
  snapFileProblem,
} from "@/lib/snap-format";
import { useSnap, type SnapBridgeState } from "@/hooks/use-snap";
import { PwaInstallBanner } from "@/components/flipdesk/pwa-install-banner";
import { SnapErrorCard } from "@/components/snap/snap-error-card";
import {
  clearSnapHistory,
  readSnapHistory,
  removeSnapHistoryEntry,
  snapHistoryKey,
  writeSnapHistory,
  type SnapHistoryEntry,
  type SnapHistoryWrite,
} from "@/lib/snap-history";
import { useAuth } from "@/hooks/use-auth";
import { PageHelp } from "@/components/help/page-help";
import {
  buildSnapBridge,
  inputsChangedSince,
  sourceHadCompQuery,
  type SnapResultSource,
  type SnapSubmittedInput,
} from "@/lib/snap-bridge";

function dollars(cents: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

function gradeClasses(grade: number): string {
  if (grade >= 8) return "text-green-600 dark:text-green-400";
  if (grade >= 6) return "text-yellow-600 dark:text-yellow-400";
  return "text-red-600 dark:text-red-400";
}

export function SnapToValuePage() {
  const [dataUri, setDataUri] = useState<string | null>(null);
  const [brand, setBrand] = useState("");
  const [keyword, setKeyword] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  // US-2554: a snap survives a reload now. `revisited` is an entry the seller
  // opened from the list; it takes precedence so the result card shows what
  // they asked to see rather than the last thing they graded.
  //
  // SNAP-01: the history belongs to the signed-in user. It is read under their
  // id, re-read when the id changes, and kept in step with other tabs.
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [historyOwner, setHistoryOwner] = useState(userId);
  const [history, setHistory] = useState<SnapHistoryEntry[]>(() => readSnapHistory(userId));
  const [revisited, setRevisited] = useState<SnapHistoryEntry | null>(null);
  if (historyOwner !== userId) {
    setHistoryOwner(userId);
    setHistory(readSnapHistory(userId));
    setRevisited(null);
  }
  const historyRef = useRef(history);
  historyRef.current = history;
  // SNAP-07: the history write lives in the hook's own onSuccess.
  const snap = useSnap({
    getHistory: () => historyRef.current,
    onHistory: (w) => commitHistory(w),
  });
  useEffect(() => {
    if (!userId) return;
    const key = snapHistoryKey(userId);
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === key) setHistory(readSnapHistory(userId));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [userId]);

  // SNAP-06: every write reports whether it reached storage. The list on screen
  // is the caller's either way; the seller is told when it will not survive.
  function commitHistory(w: SnapHistoryWrite) {
    setHistory(w.entries);
    if (!w.persisted) toast.warning("Couldn't save to this device");
  }

  function removeWithUndo(w: SnapHistoryWrite, previous: SnapHistoryEntry[], message: string) {
    commitHistory(w);
    toast(message, {
      action: {
        label: "Undo",
        onClick: () => commitHistory(writeSnapHistory(userId, previous)),
      },
    });
  }
  const result = revisited?.result ?? snap.data;
  // SNAP-04: what was actually submitted for the live result. The bridge and
  // the value caption read this (or the revisited entry), never the fields as
  // they are typed now.
  const [lastSnapInput, setLastSnapInput] = useState<SnapSubmittedInput | null>(null);
  const source: SnapResultSource | null = revisited
    ? { kind: "revisit", entry: revisited }
    : snap.data && lastSnapInput
      ? { kind: "live", ...lastSnapInput }
      : null;
  const inputsChanged = !revisited && !!snap.data && inputsChangedSince(lastSnapInput, brand, keyword);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    snap.reset();
    setRevisited(null);
    // US-1634: validate + COMPRESS before use. Reading the RAW file as a data
    // URI sent a 3–10 MB base64 blob to /snap AND pushed it into router history
    // `state` (which browsers cap at ~1–2 MB), silently breaking the
    // snap→certified bridge. compressImage also decodes the file, so a
    // non-image is rejected here.
    const problem = snapFileProblem(file);
    if (problem) {
      toast.error(problem);
      return;
    }
    try {
      // SNAP-08: JPEG, long edge 1600. The vision model downsamples to about
      // 1568 anyway, 1600 is still above the certified bridge's 1200 minimum,
      // and JPEG never comes back as a multi-MB PNG on Safari.
      const { blob } = await compressImage(file, SNAP_COMPRESS);
      if (blob.size > SNAP_MAX_UPLOAD_BYTES) {
        toast.error("That photo is too large to check. Try a smaller photo.");
        return;
      }
      const reader = new FileReader();
      reader.onload = () =>
        setDataUri(typeof reader.result === "string" ? reader.result : null);
      reader.readAsDataURL(blob);
    } catch {
      toast.error(
        file.size > SNAP_MAX_SOURCE_BYTES
          ? "That photo is too large to prepare on this device. Try a smaller photo."
          : "Couldn't read that image. Try a different photo.",
      );
    }
  }

  function valueIt() {
    if (!dataUri) return;
    setRevisited(null);
    setLastSnapInput({ dataUri, brand, keyword });
    snap.mutate({
      imageDataUri: dataUri,
      brand: brand.trim() || undefined,
      keyword: keyword.trim() || undefined,
    });
  }

  const bridge = result && source ? buildSnapBridge(result, source) : null;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 p-6">
      <PageHeader
        icon={Sparkles}
        title="Snap to Value"
        subtitle="Snap a photo of any garment and get an instant AI condition grade plus a condition-adjusted resale value range — in seconds, free."
              actions={<PageHelp slug="snap-to-value" />}
      />

      {/* US-744: offer the PWA install affordance on Snap too (mobile capture is
          a real workflow, not just a FlipDesk feature). Renders only when the
          browser reports the app installable and the user hasn't dismissed it. */}
      <PwaInstallBanner variant="snap" />

      <Card>
        <CardContent className="space-y-4 p-4">
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={onFile}
          />

          {revisited ? (
            <div className="flex flex-col items-center gap-2 rounded-md border-2 border-dashed py-6 text-center text-sm text-muted-foreground">
              <span>Showing a past snap. Its photo was not kept.</span>
              <Button variant="outline" size="sm" onClick={() => setRevisited(null)}>
                Back to your photo
              </Button>
            </div>
          ) : dataUri ? (
            <img src={dataUri} alt="Your garment" className="mx-auto max-h-72 rounded-md object-contain" />
          ) : (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex w-full flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed py-12 text-muted-foreground hover:bg-muted/50"
            >
              <Camera className="h-8 w-8" />
              <span className="text-sm font-medium">Take or upload a photo</span>
              <span className="text-xs">JPEG, PNG, or WebP</span>
            </button>
          )}

          {dataUri && !revisited && (
            <div className="flex justify-center">
              <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                Choose a different photo
              </Button>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="snap-brand">Brand (optional — unlocks value)</Label>
              <Input id="snap-brand" placeholder="Patagonia" value={brand} onChange={(e) => setBrand(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="snap-keyword">Item (optional)</Label>
              <Input id="snap-keyword" placeholder="Better Sweater 1/4 zip" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
            </div>
          </div>

          <Button className="w-full" onClick={valueIt} disabled={!dataUri || snap.isPending}>
            {snap.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
            Get my value
          </Button>
        </CardContent>
      </Card>

      {snap.isError && (
        <SnapErrorCard error={snap.error} onRetry={valueIt} canRetry={!!dataUri && !snap.isPending} />
      )}

      {result && source && bridge && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {source.kind === "revisit"
                ? `Snapped ${new Date(source.entry.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
                : "Your estimate"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-around text-center">
              <div>
                <div className={cn("text-4xl font-bold", gradeClasses(result.grade.overall_score))}>
                  {result.grade.overall_score.toFixed(1)}
                </div>
                <div className="text-xs capitalize text-muted-foreground">
                  {result.grade.grade_tier} · {Math.round(result.grade.confidence * 100)}% confidence
                </div>
              </div>
              <div>
                <div className="text-2xl font-bold">
                  {result.value?.sufficient
                    ? `${dollars(result.value.lowCents)}–${dollars(result.value.highCents)}`
                    : "—"}
                </div>
                <div className="text-xs text-muted-foreground">
                  {result.value?.sufficient
                    ? "est. resale value at this condition"
                    : sourceHadCompQuery(source)
                      ? "not enough comps to value yet"
                      : "add a brand/item to see value"}
                </div>
              </div>
            </div>

            {inputsChanged && (
              <p className="text-xs text-muted-foreground">
                Brand changed: tap Get my value to re-price.
              </p>
            )}

            <div className="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{result.disclaimer}</span>
            </div>

            {/* US-614 conversion CTAs. US-952: the certified-grade CTA carries
                the exact snap photo + any AI-detected garment type/category as
                navigation state so new-submission can pre-stage the Front photo
                and prefill the form — zero rework to upgrade. */}
            <div className="grid gap-2 sm:grid-cols-2">
              <Button asChild variant="default">
                <Link
                  to="/dashboard/submissions/new"
                  state={{ snap: bridge } satisfies { snap: SnapBridgeState }}
                >
                  <BadgeCheck className="mr-2 h-4 w-4" />
                  {bridge.imageDataUri ? "Upgrade to certified grade" : "Start a certified grade"}
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link to="/dashboard/flipdesk">
                  <Store className="mr-2 h-4 w-4" /> List it with FlipDesk
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {history.length > 0 && (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="h-4 w-4" />
              Recent snaps
            </CardTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const previous = history;
                removeWithUndo(clearSnapHistory(userId), previous, "Snap history cleared");
                setRevisited(null);
              }}
            >
              Clear
            </Button>
          </CardHeader>
          <CardContent className="space-y-2">
            <ul className="space-y-2">
              {history.map((entry) => {
                const label =
                  [entry.brand, entry.keyword].filter(Boolean).join(" ") ||
                  "Unlabelled snap";
                const open = revisited?.id === entry.id;
                return (
                  <li
                    key={entry.id}
                    className={cn(
                      "flex items-center justify-between gap-3 rounded-md border p-2",
                      open && "border-primary bg-primary/5",
                    )}
                  >
                    <button
                      type="button"
                      aria-pressed={open}
                      onClick={() => setRevisited(open ? null : entry)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="block truncate text-sm font-medium">{label}</span>
                      <span className="block text-xs text-muted-foreground">
                        <span className={gradeClasses(entry.grade)}>
                          {entry.grade.toFixed(1)}
                        </span>{" "}
                        {entry.gradeTier}
                        {entry.valueCents != null
                          ? ` · ~${dollars(entry.valueCents)}`
                          : ""}
                        {" · "}
                        {new Date(entry.at).toLocaleDateString()}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${label} from your snap history`}
                      onClick={() => {
                        removeWithUndo(
                          removeSnapHistoryEntry(userId, history, entry.id),
                          history,
                          "Snap removed",
                        );
                        if (open) setRevisited(null);
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </li>
                );
              })}
            </ul>
            {/* Said plainly rather than implied: this list is not an account
                record, and the photos were never stored at all. */}
            <p className="text-xs text-muted-foreground">
              Kept on this device only — the photos themselves are never stored.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
