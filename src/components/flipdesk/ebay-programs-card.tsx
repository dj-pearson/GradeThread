import { Settings2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  EBAY_PROGRAMS,
  useEbayConnection,
  useEbayPrograms,
  useSetEbayProgram,
  type EbayProgramSlug,
} from "@/hooks/use-ebay";

// US-2157: eBay seller-program enrollment. The GET/POST/DELETE /programs routes
// shipped with US-1979 and were fully tenant-scoped, but nothing in the product
// ever called them — sellers had to go to eBay Seller Hub to change these.
//
// Each row is an explicit opt-in and the descriptions carry the DOWNSIDE as well
// as the upside (see the EBAY_PROGRAMS copy): out-of-stock control is right for
// evergreen multi-quantity clothing and wrong for one-of-a-kind thrift items,
// which is most of FlipDesk. This card must not nudge either way.

export function EbayProgramsCard() {
  const { data: connection } = useEbayConnection();
  const connected = !!connection;
  const { data, isLoading, isError } = useEbayPrograms(connected);
  const setProgram = useSetEbayProgram();

  // Self-gates like the other eBay cards — a disconnected seller sees nothing
  // rather than a card full of controls that would 502 on touch.
  if (!connected) return null;

  const optedIn = new Set(data?.programs ?? []);
  // Only the row being toggled should show as busy.
  const pendingSlug = setProgram.isPending
    ? (setProgram.variables?.slug as EbayProgramSlug | undefined)
    : undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Settings2 className="h-4 w-4" />
          eBay programs
        </CardTitle>
        <CardDescription>
          Account-level eBay settings that change how your listings behave.
          These apply to your whole eBay account, not just FlipDesk listings.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-4">
            {EBAY_PROGRAMS.map((p) => (
              <Skeleton key={p.slug} className="h-12 w-full" />
            ))}
          </div>
        ) : isError ? (
          <p className="text-sm text-muted-foreground">
            Couldn't read your eBay programs. Your connection may need a
            reconnect.
          </p>
        ) : (
          <ul className="space-y-4">
            {EBAY_PROGRAMS.map((program) => {
              const checked = optedIn.has(program.apiName);
              const busy = pendingSlug === program.slug;
              const inputId = `ebay-program-${program.slug}`;
              return (
                <li key={program.slug} className="flex items-start gap-3">
                  <Switch
                    id={inputId}
                    checked={checked}
                    disabled={busy}
                    onCheckedChange={(next) =>
                      setProgram.mutate({ slug: program.slug, optIn: next })
                    }
                  />
                  <div className="min-w-0 space-y-0.5">
                    <Label htmlFor={inputId} className="text-sm font-medium">
                      {program.label}
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      {program.description}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
