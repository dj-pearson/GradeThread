import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { CREDIT_PACKS, GRADETHREAD_TIERS } from "@/lib/constants";
import type { CreditPackSize } from "@/lib/constants";
import { useBillingSummary, useBuyCreditPack } from "@/hooks/use-billing-summary";
import { cn } from "@/lib/utils";
import { Loader2, Sparkles } from "lucide-react";

// Anchor price per Standard grade — used to compute pack savings.
const STANDARD_PRICE_CENTS = GRADETHREAD_TIERS.standard.priceCents;

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

function pricePerCredit(pack: { credits: number; priceCents: number }): number {
  return pack.priceCents / pack.credits;
}

function savingsPct(pack: { credits: number; priceCents: number }): number {
  const list = pack.credits * STANDARD_PRICE_CENTS;
  return ((list - pack.priceCents) / list) * 100;
}

interface CreditPackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreditPackDialog({ open, onOpenChange }: CreditPackDialogProps) {
  const { data: summary } = useBillingSummary();
  const buyPack = useBuyCreditPack();

  const balance = summary?.grades.credit_balance ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Buy GradeThread credits</DialogTitle>
          <DialogDescription>
            Current balance: <span className="font-semibold tabular-nums">{balance}</span>{" "}
            credit{balance === 1 ? "" : "s"}. Credits never expire.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {CREDIT_PACKS.map((pack) => {
            const isBest = pack.credits === 100;
            const isBuying =
              buyPack.isPending && buyPack.variables?.packSize === pack.credits;

            return (
              <Card
                key={pack.credits}
                className={cn(
                  "relative flex flex-col",
                  isBest && "border-brand-red border-2",
                )}
              >
                {isBest && (
                  <Badge
                    variant="default"
                    className="bg-brand-red absolute -top-2 right-3 z-10"
                  >
                    <Sparkles className="mr-1 h-3 w-3" />
                    Best value
                  </Badge>
                )}
                <CardContent className="flex flex-1 flex-col gap-3 pt-6">
                  <div className="space-y-1">
                    <div className="text-3xl font-bold tabular-nums">
                      {pack.credits}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      credit{pack.credits === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div className="space-y-0.5">
                    <div className="text-2xl font-semibold">
                      ${dollars(pack.priceCents)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      ${dollars(Math.round(pricePerCredit(pack)))}/credit
                    </div>
                  </div>
                  <Badge variant="secondary" className="self-start">
                    Save {savingsPct(pack).toFixed(0)}%
                  </Badge>
                  <Button
                    className="mt-auto w-full"
                    onClick={() =>
                      buyPack.mutate({ packSize: pack.credits as CreditPackSize })
                    }
                    disabled={buyPack.isPending}
                  >
                    {isBuying ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : null}
                    Buy {pack.credits} credits
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <div className="mt-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          <strong className="text-foreground">How credits work:</strong> 1 credit
          = 1 Standard grade. Premium = 3 credits. Express = 5 credits. Credits
          never expire — use them whenever you need a grade.
        </div>
      </DialogContent>
    </Dialog>
  );
}
