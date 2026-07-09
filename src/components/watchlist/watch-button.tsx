import { Bell, BellRing, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useBuyerEntitlements } from "@/hooks/use-buyer-entitlements";
import { useWatchlist } from "@/hooks/use-watchlist";
import type { WatchlistItemRow } from "@/types/database";

// US-1806: the shared "Watch" action. Drops onto any surface that shows a
// watchable target — the certificate page, a graded listing, and (later) the
// extension — all writing the same watchlist_items model. Renders NOTHING unless
// the viewer is a signed-in buyer whose plan unlocks condition alerts, so it is
// safe to place on public pages (e.g. a certificate).

export function WatchButton({
  targetType,
  targetId,
  label,
  brand,
  variant = "outline",
  size = "sm",
  className,
}: {
  targetType: WatchlistItemRow["target_type"];
  targetId: string;
  label?: string | null;
  brand?: string | null;
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
  className?: string;
}) {
  const { user } = useAuth();
  const ent = useBuyerEntitlements();
  const { isWatched, watch, unwatch, isMutating, isLoading } = useWatchlist();

  // Gate: only a signed-in buyer entitled to condition alerts sees the action.
  if (!user || !ent.has("conditionAlerts")) return null;

  const watching = isWatched(targetType, targetId);

  async function toggle() {
    try {
      if (watching) {
        await unwatch(targetType, targetId);
        toast.success("Removed from your watchlist");
      } else {
        await watch({ target_type: targetType, target_id: targetId, label, brand });
        toast.success("Watching — we'll alert you on condition matches");
      }
    } catch {
      toast.error("Couldn't update your watchlist. Please try again.");
    }
  }

  return (
    <Button
      type="button"
      variant={watching ? "secondary" : variant}
      size={size}
      onClick={toggle}
      disabled={isMutating || isLoading}
      aria-pressed={watching}
      className={cn("gap-1.5", className)}
    >
      {isMutating ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : watching ? (
        <BellRing className="h-4 w-4" />
      ) : (
        <Bell className="h-4 w-4" />
      )}
      {watching ? "Watching" : "Watch"}
    </Button>
  );
}
