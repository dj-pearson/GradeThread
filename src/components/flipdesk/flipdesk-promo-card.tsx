import { useState } from "react";
import { useNavigate } from "react-router";
import { ArrowRight, X, Compass, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
import { useAuthStore } from "@/stores/auth-store";
import type { UserUpdate } from "@/types/database";

// Cross-promotion callout for FlipDesk shown on the GradeThread dashboard.
// Only surfaces for users with no inventory yet (i.e. not active FlipDesk
// users), and stays hidden once dismissed (US-136).
export function FlipdeskPromoCard({ itemCount }: { itemCount: number | undefined }) {
  const navigate = useNavigate();
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
    <Card className="border-brand-red/30 bg-gradient-to-r from-brand-navy/5 to-brand-red/5">
      <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md bg-brand-navy/10">
            <Compass className="h-5 w-5 text-brand-navy dark:text-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium">
              New: FlipDesk — your reseller command center
            </p>
            <p className="text-xs text-muted-foreground">
              Source, catalog, grade, list, and reconcile every flip in one
              place. Built right into GradeThread.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => navigate("/dashboard/flipdesk")}>
            Explore FlipDesk
            <ArrowRight className="ml-1.5 h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void dismiss()}
            disabled={dismissing}
            aria-label="Dismiss"
          >
            {dismissing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <X className="h-4 w-4" />
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
