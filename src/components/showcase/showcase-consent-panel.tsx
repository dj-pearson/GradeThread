import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSetShowcaseConsent } from "@/hooks/use-showcase";

// US-1855: the per-item Showcase consent control.
//
// Consent is PER FIND, not per account. A public verified profile is consent to
// be found; it is not consent to have one particular garment reposted into a
// browsable feed, so this switch defaults off on every item and inherits nothing.
//
// Only rendered once a certificate exists — there is nothing to showcase before
// that, and the public feed's own view refuses uncertified reports anyway.

export function ShowcaseConsentPanel({
  submissionId,
  optIn,
  valueCents,
}: {
  submissionId: string;
  optIn: boolean;
  valueCents: number | null;
}) {
  const setConsent = useSetShowcaseConsent();
  // SUB-14: the switch used to follow the prop alone, which only changed when
  // a realtime event happened to arrive. Flip it at once, settle it from the
  // server's answer, and put it back if the call fails.
  const [checked, setChecked] = useState(optIn);
  useEffect(() => setChecked(optIn), [optIn]);
  const save = (next: boolean, cents: number | null) => {
    const before = checked;
    setChecked(next);
    setConsent.mutate(
      { submissionId, optIn: next, valueCents: cents },
      {
        onSuccess: (showcase) => setChecked(showcase.opt_in),
        onError: () => setChecked(before),
      },
    );
  };
  const [value, setValue] = useState(
    valueCents != null ? (valueCents / 100).toFixed(2) : "",
  );

  const parsedCents = (): number | null => {
    const raw = value.trim();
    if (!raw) return null;
    const dollars = Number(raw);
    if (!Number.isFinite(dollars) || dollars < 0) return null;
    return Math.round(dollars * 100);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-5 w-5 text-brand-navy dark:text-foreground" />
          Show this in the public Finds feed
        </CardTitle>
        <CardDescription>
          Put this find on{" "}
          <Link to="/finds" className="font-medium hover:underline">
            the public Finds feed
          </Link>{" "}
          — the photo, the grade and a link to the certificate. Nothing private is
          shared, and you can take it down at any time.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="showcase-opt-in" className="text-sm font-medium">
            {checked ? "Showing in the feed" : "Not in the feed"}
          </Label>
          <Switch
            id="showcase-opt-in"
            checked={checked}
            disabled={setConsent.isPending}
            onCheckedChange={(next) => save(next, next ? parsedCents() : null)}
          />
        </div>

        {checked ? (
          <div className="space-y-2">
            <Label htmlFor="showcase-value" className="text-sm">
              Value to show (optional)
            </Label>
            <div className="flex gap-2">
              <Input
                id="showcase-value"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                placeholder="e.g. 125.00"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="max-w-[10rem]"
              />
              <Button
                variant="outline"
                disabled={setConsent.isPending}
                onClick={() => save(true, parsedCents())}
              >
                Save
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              This is your own number, shown as the seller's stated value. Leave
              it blank to show no price.
            </p>
          </div>
        ) : null}

        <p className="text-xs text-muted-foreground">
          If your{" "}
          <Link to="/verified" className="font-medium hover:underline">
            Verified profile
          </Link>{" "}
          is public, your find links back to it. If not, it appears without a
          seller name.
        </p>
      </CardContent>
    </Card>
  );
}
