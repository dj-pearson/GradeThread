import { useState } from "react";
import { Link } from "react-router";
import { ArrowRight, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
import { useAuthStore } from "@/stores/auth-store";
import type { UserUpdate } from "@/types/database";

// Cross-promotion callout for FlipDesk shown on the GradeThread dashboard.
// Only surfaces for users with no inventory yet (i.e. not active FlipDesk
// users), and stays hidden once dismissed (US-136).
//
// Flat, because it renders inside a WidgetFrame that already draws the title:
// no card, no gradient, no icon tile.
export function FlipdeskPromoCard({ itemCount }: { itemCount: number | undefined }) {
  const { profile, refreshProfile } = useAuth();
  const user = useAuthStore((s) => s.user);
  const [dismissing, setDismissing] = useState(false);
  const [localDismissed, setLocalDismissed] = useState(false);

  // Wait for the inventory count, then hide for active users / dismissers.
  if (itemCount === undefined || itemCount > 0) return null;
  if (localDismissed || profile?.dismissed_flipdesk_promo) return null;

  async function dismiss() {
    if (!user) return;
    setDismissing(true);
    setLocalDismissed(true);
    try {
      const update: UserUpdate = { dismissed_flipdesk_promo: true };
      const { error } = await supabase
        .from("users")
        .update(update as never)
        .eq("id", user.id);
      if (error) throw error;
      await refreshProfile();
    } catch {
      // Keep it hidden for the session even if the write failed.
    } finally {
      setDismissing(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-sm font-medium">
          FlipDesk, your reseller workspace
        </p>
        <p className="text-sm text-muted-foreground">
          Source, catalog, grade, list, and reconcile every flip in one place.
          Built right into GradeThread.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" asChild>
          <Link to="/dashboard?view=flipdesk">
            Explore FlipDesk
            <ArrowRight className="ml-1.5 h-3 w-3" aria-hidden="true" />
          </Link>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void dismiss()}
          disabled={dismissing}
          aria-label="Dismiss the FlipDesk suggestion"
        >
          {dismissing ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <X className="h-4 w-4" aria-hidden="true" />
          )}
        </Button>
      </div>
    </div>
  );
}
