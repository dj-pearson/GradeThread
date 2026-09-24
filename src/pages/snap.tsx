import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  AlertTriangle,
  BadgeCheck,
  CircleCheck,
  CircleHelp,
  CircleX,
  Camera,
  Clock,
  ImageIcon,
  Info,
  Loader2,
  Sparkles,
  Store,
  Trash2,
} from "lucide-react";
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
  buyVerdict,
  formatMoney,
  formatSnapScore,
  isLowConfidence,
  maxPayForMargin,
  parsePriceToCents,
  verdictAllowed,
  SNAP_COMPRESS,
  SNAP_MAX_SOURCE_BYTES,
  SNAP_MAX_UPLOAD_BYTES,
  snapFileProblem,
  usageLine,
  valueDisplay,
  weakestFirst,
} from "@/lib/snap-format";
import { useSnap, type SnapBridgeState, type SnapResult, type SnapUsage } from "@/hooks/use-snap";
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
import { useAuthStore } from "@/stores/auth-store";
import { PageHelp } from "@/components/help/page-help";
import {
  buildIntakeBridge,
  buildSnapBridge,
  inputsChangedSince,
  sourceHadCompQuery,
  type SnapResultSource,
  type SnapSubmittedInput,
} from "@/lib/snap-bridge";

// SNAP-12: -700 in light mode. yellow-600 at text-xs was about 2.9:1 on white.
function gradeClasses(grade: number): string {
  if (grade >= 8) return "text-green-700 dark:text-green-400";
  if (grade >= 6) return "text-amber-700 dark:text-amber-300";
  return "text-red-700 dark:text-red-400";
}

function tierLabel(tier: string): string {
  return tier.replace(/_/g, " ");
}

function historyLabel(entry: SnapHistoryEntry): string {
  const typed = [entry.brand, entry.keyword].filter(Boolean).join(" ");
  if (typed) return typed;
  const type = entry.result.garment?.category ?? entry.result.garment?.type;
  return type ? `Unlabeled ${type.replace(/_/g, " ")}` : "Unlabeled snap";
}

function historyWhen(at: string): string {
  const d = new Date(at);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString();
}

/** What the live region reads out once a result is on screen. */
function resultAnnouncement(result: SnapResult): string {
  const v = valueDisplay(result.value);
  const grade = `Grade ${formatSnapScore(result.grade)}, ${tierLabel(result.grade.grade_tier)}.`;
  if (v.kind === "priced") return `${grade} Value about ${v.headline}.`;
  return grade;
}

/** Is this a phone or tablet, where a camera button is the fast path? */
function isTouchDevice(): boolean {
  try {
    return typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;
  } catch {
    return false;
  }
}

function readAsDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("read failed"));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

export function SnapToValuePage() {
  const navigate = useNavigate();
  const [dataUri, setDataUri] = useState<string | null>(null);
  const [brand, setBrand] = useState("");
  const [keyword, setKeyword] = useState("");
  // SNAP-14: what the tag says. Editable after the result, costs no snap.
  const [tagPrice, setTagPrice] = useState("");
  const libraryRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [touch] = useState(isTouchDevice);
  // SNAP-10: a photo being prepared. The preview shows at once from the file
  // itself; the compressed upload replaces it when ready.
  const [preparing, setPreparing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const pickSeq = useRef(0);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);

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

  // SNAP-09/11: the last usage the server reported, kept across a new photo.
  const [usage, setUsage] = useState<SnapUsage | null>(null);
  useEffect(() => {
    if (snap.data?.usage) setUsage(snap.data.usage);
  }, [snap.data]);

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
        // Never after a sign-out or an account switch: the toast outlives
        // both, and the undo would write this user's list back to a browser
        // the sign-out just wiped (SNAP-01).
        onClick: () => {
          if (useAuthStore.getState().user?.id !== userId) return;
          commitHistory(writeSnapHistory(userId, previous));
        },
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

  // SNAP-12: a result that appears below the fold is scrolled to and its
  // heading focused, on a fresh snap and on opening a history row.
  const shownResult = revisited ?? snap.data ?? null;
  useEffect(() => {
    if (!shownResult) return;
    const h = resultHeadingRef.current;
    if (!h) return;
    try {
      h.scrollIntoView?.({ behavior: "smooth", block: "start" });
    } catch {
      /* older browsers: focus still moves */
    }
    h.focus({ preventScroll: true });
  }, [shownResult]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const busy = preparing || snap.isPending;

  async function handleFile(file: File) {
    if (busy) return;
    const seq = ++pickSeq.current;
    snap.reset();
    setRevisited(null);
    // US-1634: validate + COMPRESS before use. Reading the RAW file as a data
    // URI sent a 3-10 MB base64 blob to /snap AND pushed it into router history
    // `state` (which browsers cap at ~1-2 MB), silently breaking the
    // snap-to-certified bridge. compressImage also decodes the file, so a
    // non-image is rejected here.
    const problem = snapFileProblem(file);
    if (problem) {
      toast.error(problem);
      return;
    }
    setPreparing(true);
    setDataUri(null);
    try {
      setPreviewUrl(URL.createObjectURL(file));
    } catch {
      setPreviewUrl(null);
    }
    try {
      // SNAP-08: JPEG, long edge 1600. See SNAP_COMPRESS.
      const { blob } = await compressImage(file, SNAP_COMPRESS);
      if (seq !== pickSeq.current) return;
      if (blob.size > SNAP_MAX_UPLOAD_BYTES) {
        toast.error("That photo is too large to check. Try a smaller photo.");
        setPreviewUrl(null);
        return;
      }
      const uri = await readAsDataUri(blob);
      // SNAP-10: a slower, older pick never overwrites a newer one.
      if (seq !== pickSeq.current) return;
      setDataUri(uri);
      setPreviewUrl(null);
    } catch {
      if (seq !== pickSeq.current) return;
      setPreviewUrl(null);
      toast.error(
        file.size > SNAP_MAX_SOURCE_BYTES
          ? "That photo is too large to prepare on this device. Try a smaller photo."
          : "Couldn't read that image. Try a different photo.",
      );
    } finally {
      if (seq === pickSeq.current) setPreparing(false);
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // SNAP-10: cleared so picking the same file again (after an error) fires.
    e.target.value = "";
    if (file) void handleFile(file);
  }

  // SNAP-10: paste a photo straight onto the page.
  const handleFileRef = useRef(handleFile);
  handleFileRef.current = handleFile;
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
      if (!file) return;
      e.preventDefault();
      void handleFileRef.current(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = Array.from(e.dataTransfer.files).find(
      (f) => f.type.startsWith("image/") || /\.hei[cf]$/i.test(f.name),
    );
    if (file) void handleFile(file);
  }

  function valueIt() {
    if (!dataUri || busy) return;
    setRevisited(null);
    setLastSnapInput({ dataUri, brand, keyword });
    snap.mutate({
      imageDataUri: dataUri,
      brand: brand.trim() || undefined,
      keyword: keyword.trim() || undefined,
    });
  }

  const bridge = result && source ? buildSnapBridge(result, source) : null;

  // SNAP-13: a "yes" becomes a sourced FlipDesk item with the photo, brand,
  // grade note and target price carried over.
  //
  // The tag price belongs to the result on screen. A history row's "Bought it"
  // carries it only when that row IS the result on screen; otherwise the price
  // typed for one garment would be saved as the cost of another.
  function addToInventory(r: SnapResult, from: SnapResultSource, withTagPrice: boolean) {
    navigate("/dashboard/flipdesk/intake", {
      state: {
        snap: buildIntakeBridge(r, from, withTagPrice ? parsePriceToCents(tagPrice) : null),
      },
    });
  }
  const value = result ? valueDisplay(result.value) : null;
  const lowConfidence = result ? isLowConfidence(result.grade) : false;
  const factors = result ? weakestFirst(result.grade.factor_scores) : [];
  const usageInfo = usageLine(usage);
  const paidCents = parsePriceToCents(tagPrice);
  const showVerdict = result ? verdictAllowed(result) : false;
  const verdict = showVerdict && result ? buyVerdict(result.value?.medianCents, paidCents) : null;
  const payUnder = showVerdict && result && paidCents == null ? maxPayForMargin(result.value?.medianCents) : null;
  const currency = result?.value?.currency ?? "USD";
  const shownPreview = previewUrl ?? dataUri;

  const announcement = snap.isPending
    ? "Grading your photo"
    : result && source
      ? resultAnnouncement(result)
      : "";

  const pickerButtons = touch ? (
    <div className="grid gap-2 sm:grid-cols-2">
      <Button type="button" variant="outline" onClick={() => cameraRef.current?.click()} disabled={busy}>
        <Camera className="mr-2 h-4 w-4" aria-hidden="true" /> Take photo
      </Button>
      <Button type="button" variant="outline" onClick={() => libraryRef.current?.click()} disabled={busy}>
        <ImageIcon className="mr-2 h-4 w-4" aria-hidden="true" /> Choose from library
      </Button>
    </div>
  ) : (
    <div className="flex justify-center">
      <Button type="button" variant="outline" size="sm" onClick={() => libraryRef.current?.click()} disabled={busy}>
        Choose a different photo
      </Button>
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 p-6">
      <PageHeader
        icon={Sparkles}
        title="Snap to Value"
        subtitle="One photo in, a condition grade and a resale value out."
        actions={<PageHelp slug="snap-to-value" />}
      />

      {/* SNAP-12: announced, not just painted. */}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      <Card>
        <CardContent className="p-4">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              valueIt();
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
          >
            <input
              ref={libraryRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={onFile}
              disabled={busy}
            />
            <input
              ref={cameraRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              className="hidden"
              onChange={onFile}
              disabled={busy}
            />

            {revisited ? (
              <div className="flex flex-col items-center gap-2 rounded-md border-2 border-dashed py-6 text-center text-sm text-muted-foreground">
                <span>Showing a past snap. Its photo was not kept.</span>
                <Button type="button" variant="outline" size="sm" onClick={() => setRevisited(null)}>
                  Back to your photo
                </Button>
              </div>
            ) : shownPreview ? (
              <div className="relative" aria-busy={preparing}>
                <img
                  src={shownPreview}
                  alt="Your garment"
                  className={cn("mx-auto max-h-72 rounded-md object-contain", preparing && "opacity-60")}
                />
                {preparing && (
                  <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm font-medium">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Preparing photo...
                  </div>
                )}
              </div>
            ) : touch ? null : (
              <button
                type="button"
                onClick={() => libraryRef.current?.click()}
                disabled={busy}
                aria-busy={preparing}
                className="flex w-full flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed py-12 text-muted-foreground hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {preparing ? (
                  <>
                    <Loader2 className="h-8 w-8 animate-spin" aria-hidden="true" />
                    <span className="text-sm font-medium">Preparing photo...</span>
                  </>
                ) : (
                  <>
                    <Camera className="h-8 w-8" aria-hidden="true" />
                    <span className="text-sm font-medium">Choose, drop or paste a photo</span>
                    <span className="text-xs">JPEG, PNG, or WebP</span>
                  </>
                )}
              </button>
            )}

            {!revisited && (touch || shownPreview) && pickerButtons}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="snap-brand">Brand (optional, unlocks value)</Label>
                <Input
                  id="snap-brand"
                  placeholder="Patagonia"
                  value={brand}
                  maxLength={80}
                  autoCapitalize="words"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  enterKeyHint="next"
                  onChange={(e) => setBrand(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="snap-keyword">Item (optional)</Label>
                <Input
                  id="snap-keyword"
                  placeholder="Better Sweater 1/4 zip"
                  value={keyword}
                  maxLength={200}
                  autoCapitalize="words"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  enterKeyHint="go"
                  onChange={(e) => setKeyword(e.target.value)}
                />
              </div>
            </div>

            <Button type="submit" className="w-full" disabled={!dataUri || busy}>
              {snap.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles className="mr-2 h-4 w-4" aria-hidden="true" />
              )}
              {snap.isPending ? "Grading your photo..." : "Get my value"}
            </Button>
            {usageInfo && (
              <p
                className={cn(
                  "text-center text-xs",
                  usageInfo.low ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground",
                )}
              >
                {usageInfo.text}
              </p>
            )}
          </form>
        </CardContent>
      </Card>

      {snap.isError && (
        <SnapErrorCard error={snap.error} onRetry={valueIt} canRetry={!!dataUri && !busy} />
      )}

      {result && source && bridge && value && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              <h2 ref={resultHeadingRef} tabIndex={-1} className="outline-none">
                {source.kind === "revisit"
                  ? `Snapped ${new Date(source.entry.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
                  : "Your estimate"}
              </h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start justify-around gap-4 text-center">
              <div>
                <div className={cn("text-4xl font-bold", gradeClasses(result.grade.overall_score))}>
                  {formatSnapScore(result.grade)}
                </div>
                <div className="text-xs capitalize text-muted-foreground">
                  {tierLabel(result.grade.grade_tier)}, {Math.round(result.grade.confidence * 100)}% confidence
                </div>
              </div>
              <div>
                {value.kind === "priced" ? (
                  <>
                    <div className="text-3xl font-bold">{value.headline}</div>
                    <div className="text-xs text-muted-foreground">{value.range}</div>
                    <div className="text-xs text-muted-foreground">
                      {[value.comps, value.category].filter(Boolean).join(" in ") ||
                        "est. resale value at this condition"}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-2xl font-bold text-muted-foreground">No price yet</div>
                    <div className="text-xs text-muted-foreground">
                      {value.kind === "insufficient" || sourceHadCompQuery(source)
                        ? "not enough sales to price"
                        : "add a brand or item to see value"}
                    </div>
                  </>
                )}
              </div>
            </div>

            {lowConfidence && (
              <div className="flex items-start gap-2 rounded-md border border-amber-300 p-3 text-xs text-amber-800 dark:border-amber-800 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
                <span>
                  One photo is not enough to be sure. Retake it in better light, or get a certified grade.
                  {result.grade.screenshot_detected
                    ? " This looks like a screenshot; a photo of the garment itself grades better."
                    : ""}
                </span>
              </div>
            )}
            {!lowConfidence && result.grade.screenshot_detected && (
              <p className="text-xs text-muted-foreground">
                This looks like a screenshot; a photo of the garment itself grades better.
              </p>
            )}

            {factors.length > 0 && (
              <ul className="space-y-1.5" aria-label="Condition factors, weakest first">
                {factors.map((f) => (
                  <li key={f.key} className="grid grid-cols-[9rem_1fr_2.5rem] items-center gap-2 text-xs">
                    <span className="truncate text-muted-foreground">{f.label}</span>
                    <span className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                      <span
                        className="block h-full rounded-full bg-primary"
                        style={{ width: `${Math.max(0, Math.min(100, f.score * 10))}%` }}
                      />
                    </span>
                    <span className="text-right tabular-nums">{f.score.toFixed(1)}</span>
                  </li>
                ))}
              </ul>
            )}

            {inputsChanged && (
              <p className="text-xs text-muted-foreground">
                Brand or item changed: tap Get my value to re-price.
              </p>
            )}

            {/* SNAP-14: the question the page exists to answer. Word plus
                icon, so color is never the only cue. */}
            <div className="space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <Label htmlFor="snap-tag-price">Price on the tag</Label>
                  <Input
                    id="snap-tag-price"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="8.00"
                    className="w-28"
                    value={tagPrice}
                    onChange={(e) => setTagPrice(e.target.value)}
                  />
                </div>
                {verdict && (
                  <p
                    className={cn(
                      "flex items-center gap-1.5 text-sm font-semibold",
                      verdict.verdict === "buy" && "text-green-700 dark:text-green-400",
                      verdict.verdict === "maybe" && "text-amber-700 dark:text-amber-300",
                      verdict.verdict === "pass" && "text-red-700 dark:text-red-400",
                    )}
                  >
                    {verdict.verdict === "buy" ? (
                      <CircleCheck className="h-4 w-4" aria-hidden="true" />
                    ) : verdict.verdict === "maybe" ? (
                      <CircleHelp className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <CircleX className="h-4 w-4" aria-hidden="true" />
                    )}
                    {verdict.verdict === "buy" ? "Buy" : verdict.verdict === "maybe" ? "Maybe" : "Pass"}
                  </p>
                )}
              </div>
              {verdict ? (
                <p className="text-xs text-muted-foreground">
                  {verdict.profitCents > 0
                    ? `About ${formatMoney(verdict.profitCents, currency)} profit after eBay fees at the median.`
                    : `About ${formatMoney(-verdict.profitCents, currency)} loss after eBay fees at the median.`}
                </p>
              ) : payUnder != null ? (
                <p className="text-xs text-muted-foreground">
                  Pay under {formatMoney(payUnder, currency)} for a 3x margin.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {lowConfidence
                    ? "No buy call on a grade this unsure."
                    : "No buy call without enough sales to price it."}
                </p>
              )}
            </div>

            <div className="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              <Info className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
              <span>{result.disclaimer}</span>
            </div>

            {/* US-614 conversion CTAs. US-952: the certified-grade CTA carries
                the snap photo and any AI-detected garment type/category as
                navigation state so new-submission can pre-stage the Front photo
                and prefill the form. */}
            <div className="grid gap-2 sm:grid-cols-2">
              <Button asChild variant="default">
                <Link
                  to="/dashboard/submissions/new"
                  state={{ snap: bridge } satisfies { snap: SnapBridgeState }}
                >
                  <BadgeCheck className="mr-2 h-4 w-4" aria-hidden="true" />
                  {bridge.imageDataUri ? "Upgrade to certified grade" : "Start a certified grade"}
                </Link>
              </Button>
              <Button variant="outline" onClick={() => addToInventory(result, source, true)}>
                <Store className="mr-2 h-4 w-4" aria-hidden="true" /> Add to inventory
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* US-744 / SNAP-12: the install offer waits until Snap has proved
          itself once, and sits below the result so it never shifts the
          capture card. */}
      {snap.isSuccess && <PwaInstallBanner variant="snap" />}

      {history.length > 0 && (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="h-4 w-4" aria-hidden="true" />
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
                const label = historyLabel(entry);
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
                        <span className="capitalize">{tierLabel(entry.gradeTier)}</span>
                        {entry.valueCents != null
                          ? `, about ${formatMoney(entry.valueCents, entry.result.value?.currency ?? "USD")}`
                          : ""}
                        {", "}
                        {historyWhen(entry.at)}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Bought it: add ${label} to inventory`}
                      onClick={() => addToInventory(entry.result, { kind: "revisit", entry }, open)}
                    >
                      Bought it
                    </Button>
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
                      <Trash2 className="h-4 w-4 text-destructive" aria-hidden="true" />
                    </Button>
                  </li>
                );
              })}
            </ul>
            {/* Said plainly rather than implied: this list is not an account
                record, and the photos were never stored at all. */}
            <p className="text-xs text-muted-foreground">
              Kept on this device only. The photos themselves are never stored.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
