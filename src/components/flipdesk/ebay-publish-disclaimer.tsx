import { useState } from "react";
import { Link } from "react-router";
import { Info, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
import { useAuthStore } from "@/stores/auth-store";
import type { UserUpdate } from "@/types/database";

// US-1061: one-time, dismissable notice shown on a user's FIRST successful eBay
// publish. FlipDesk is the source of truth for a published listing — because it
// syncs with eBay through the eBay API, editing the item directly on eBay can be
// overwritten or desync the two sides. We explain that once and persist the
// dismissed state per user (server-side, survives device change) so it never
// shows again. Mirrors the FlipdeskPromoCard dismissal pattern (US-136).
export function EbayPublishDisclaimer() {
  const { profile, refreshProfile } = useAuth();
  const user = useAuthStore((s) => s.user);
  const [dismissing, setDismissing] = useState(false);
  const [localDismissed, setLocalDismissed] = useState(false);

  if (localDismissed || profile?.dismissed_ebay_publish_disclaimer) return null;

  async function dismiss() {
    if (!user) return;
    setDismissing(true);
    setLocalDismissed(true);
    try {
      const update: UserUpdate = { dismissed_ebay_publish_disclaimer: true };
      const { error } = await supabase
        .from("users")
        .update(update as never)
        .eq("id", user.id);
      if (error) throw error;
      await refreshProfile();
    } catch {
      // Keep it hidden for the session even if the write failed; it will
      // re-surface on a later publish so the user can dismiss it again.
    } finally {
      setDismissing(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-brand-navy/30 bg-brand-navy/5 p-3 text-sm">
      <div className="flex items-start gap-2">
        <Info className="mt-0.5 h-5 w-5 flex-shrink-0 text-brand-navy dark:text-foreground" />
        <div className="space-y-1">
          <div className="font-medium">Manage this item in FlipDesk from now on</div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            FlipDesk is now the source of truth for this listing. It syncs with
            eBay through the eBay API, so editing the item{" "}
            <strong>directly on eBay</strong> — photos, price, title, item
            specifics, or ending and relisting — can be overwritten on the next
            sync or leave the two sides out of step. Make every change here in
            FlipDesk and let it push the update to eBay.{" "}
            <Link
              to="/faq"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-primary underline"
            >
              Learn more
            </Link>
          </p>
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="w-full"
        onClick={() => void dismiss()}
        disabled={dismissing}
      >
        {dismissing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
        Got it
      </Button>
    </div>
  );
}
