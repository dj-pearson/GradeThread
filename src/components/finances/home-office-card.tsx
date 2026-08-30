import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Home } from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/auth-store";
import { toastError } from "@/lib/toast-error";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatCents } from "@/lib/ledger-math";
import {
  describeRate,
  fetchHomeOfficeRate,
  fetchHomeOfficeYear,
  fetchOverlap,
  homeOfficeDeductionCents,
  homeOfficeNotices,
  saveHomeOfficeYear,
} from "@/lib/home-office";

// US-2990 — the simplified home-office deduction.
//
// One screen: how big, how long, and the figure that follows. The complicated
// version is deliberately absent, and the card says so rather than leaving a
// seller to wonder whether we forgot it.

export function HomeOfficeCard() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [sqft, setSqft] = useState("");
  const [months, setMonths] = useState("12");
  const [method, setMethod] = useState<"simplified" | "actual">("simplified");
  const [saving, setSaving] = useState(false);

  const { data: rate } = useQuery({
    queryKey: ["home-office-rate"],
    queryFn: fetchHomeOfficeRate,
    staleTime: 60 * 60 * 1000,
  });

  const { data: saved, isLoading } = useQuery({
    queryKey: ["home-office-year", user?.id, year],
    enabled: !!user,
    queryFn: () => fetchHomeOfficeYear(year),
  });

  const { data: overlap } = useQuery({
    queryKey: ["home-office-overlap", user?.id, year],
    enabled: !!user,
    queryFn: () => fetchOverlap(year),
  });

  useEffect(() => {
    setSqft(saved?.square_feet ? String(saved.square_feet) : "");
    setMonths(String(saved?.months_used ?? 12));
    setMethod(saved?.method ?? "simplified");
  }, [saved]);

  const sqftNum = Number(sqft) || 0;
  const monthsNum = Number(months) || 0;
  // Computed locally as the seller types. The database owns the real figure;
  // this mirrors it so there is no round trip per keystroke, and the two are
  // pinned to each other by tests on both sides.
  const preview = rate ? homeOfficeDeductionCents(sqftNum, monthsNum, rate) : 0;

  const notices = overlap ? homeOfficeNotices(overlap, rate ?? null) : [];

  async function save() {
    if (!user) return;
    setSaving(true);
    try {
      await saveHomeOfficeYear(user.id, {
        tax_year: year,
        square_feet: sqftNum,
        months_used: monthsNum,
        method,
      });
      await qc.invalidateQueries({ queryKey: ["home-office-year"] });
      await qc.invalidateQueries({ queryKey: ["home-office-overlap"] });
      toast.success("Saved. Rebuild your books to put it on the P&L.");
    } catch (err) {
      toastError(err, "Couldn't save that.");
    } finally {
      setSaving(false);
    }
  }

  const years = [0, 1, 2, 3].map((n) => new Date().getFullYear() - n);

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">Working from home</CardTitle>
          <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-muted-foreground">
            If you store stock or photograph items in part of your home, that
            space is probably deductible. Most resellers never claim it.
          </p>
        </div>
        <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
          <SelectTrigger
            className="h-9 w-28"
            aria-label="Tax year for the home office deduction"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {years.map((y) => (
              <SelectItem key={y} value={String(y)}>
                {y}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>

      <CardContent className="space-y-5">
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <>
            {/* AC5. What "regularly and exclusively" means, in a sentence, at
                the point where the seller is deciding whether it applies. This
                is a fact about the rule, not advice about their situation. */}
            <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
              The space has to be used <strong>regularly and only</strong> for
              the business. A corner of the spare room that holds nothing but
              stock counts. The dining table you also eat at does not, and
              neither does a room the family uses at weekends.
            </p>

            <div className="space-y-1">
              <Label htmlFor="ho-method">How you are claiming it</Label>
              <Select
                value={method}
                onValueChange={(v) => setMethod(v as "simplified" | "actual")}
              >
                <SelectTrigger id="ho-method" className="w-full sm:w-80">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="simplified">
                    The simple way, per square foot
                  </SelectItem>
                  <SelectItem value="actual">
                    Actual expenses (Form 8829)
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {method === "actual" ? (
              <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
                Actual expenses means working out your share of mortgage or
                rent, insurance, utilities and depreciation on Form 8829. We do
                not do that one, so there is no figure here for you. Your
                accountant will want your square footage and your total home
                size.
              </p>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2 sm:max-w-xl">
                  <div className="space-y-1">
                    <Label htmlFor="ho-sqft">Square feet used</Label>
                    <Input
                      id="ho-sqft"
                      inputMode="decimal"
                      placeholder="0"
                      value={sqft}
                      onChange={(e) => setSqft(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="ho-months">Months used this year</Label>
                    <Input
                      id="ho-months"
                      inputMode="numeric"
                      value={months}
                      onChange={(e) => setMonths(e.target.value)}
                    />
                  </div>
                </div>

                {rate && (
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className="text-2xl font-semibold tabular-nums">
                      {formatCents(preview)}
                    </span>
                    <span className="text-[13px] text-muted-foreground">
                      {describeRate(rate)}
                      {rate.is_provisional && " (provisional rate)"}
                    </span>
                  </div>
                )}
              </>
            )}

            {notices.map((n) => (
              <p
                key={n.kind}
                className="flex max-w-prose gap-2 text-[13px] leading-relaxed text-amber-700 dark:text-amber-400"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                {n.text}
              </p>
            ))}

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={save} disabled={saving || !user}>
                <Home className="mr-2 h-4 w-4" />
                {saving ? "Saving" : "Save"}
              </Button>
              <p className="text-[13px] text-muted-foreground">
                Goes on Schedule C line 30, which is separate from your other
                running costs.
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
