import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Camera, Loader2, Sparkles, BadgeCheck, Store, Info } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useSnap } from "@/hooks/use-snap";

function dollars(cents: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

function gradeClasses(grade: number): string {
  if (grade >= 8) return "text-green-600";
  if (grade >= 6) return "text-yellow-600";
  return "text-red-600";
}

export function SnapToValuePage() {
  const [dataUri, setDataUri] = useState<string | null>(null);
  const [brand, setBrand] = useState("");
  const [keyword, setKeyword] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const snap = useSnap();
  const result = snap.data;

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setDataUri(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(file);
    snap.reset();
  }

  function valueIt() {
    if (!dataUri) return;
    snap.mutate({ imageDataUri: dataUri, brand: brand.trim() || undefined, keyword: keyword.trim() || undefined });
  }

  const limitReached = snap.error?.code === "SNAP_LIMIT_REACHED";

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Sparkles className="h-6 w-6 text-brand-red" /> What's it worth?
        </h1>
        <p className="text-muted-foreground">
          Snap a photo of any garment and get an instant AI condition grade plus a
          condition-adjusted resale value range — in seconds, free.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={onFile}
          />

          {dataUri ? (
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

          {dataUri && (
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
            What's it worth?
          </Button>
        </CardContent>
      </Card>

      {snap.isError && (
        <Card className={cn(limitReached ? "border-amber-300" : "border-destructive/40")}>
          <CardContent className="space-y-3 p-4 text-sm">
            <p className={limitReached ? "text-amber-800" : "text-destructive"}>{snap.error.message}</p>
            {limitReached && (
              <Button asChild size="sm">
                <Link to="/dashboard/billing">Upgrade for more snaps</Link>
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {result && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your estimate</CardTitle>
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
                    : brand || keyword
                      ? "not enough comps to value yet"
                      : "add a brand/item to see value"}
                </div>
              </div>
            </div>

            <div className="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-xs text-amber-800">
              <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{result.disclaimer}</span>
            </div>

            {/* US-614 conversion CTAs */}
            <div className="grid gap-2 sm:grid-cols-2">
              <Button asChild variant="default">
                <Link to="/dashboard/submissions/new">
                  <BadgeCheck className="mr-2 h-4 w-4" /> Get a certified grade
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
    </div>
  );
}
