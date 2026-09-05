import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { toastError } from "@/lib/toast-error";
import {
  LISTING_BADGE_QUERY_KEY,
  useListingBadgeSetting,
} from "@/lib/listing-badge-setting";

// US-3060: the seller's switch for the on-marketplace verified badge.
//
// With the extension installed, a shopper on eBay, Poshmark or Mercari sees the
// GradeThread grade on a listing that has a certificate. That changes how the
// seller's own listing looks inside a stranger's browser, so it needs an off
// switch — even though the badge only ever shows a fact the seller already made
// public by publishing a certificate.
//
// ⚠ IT MUST SURVIVE ITS OWN COLUMN NOT EXISTING. Migration 00727 is applied
// separately from the deploy, so between the two this component runs against a
// schema with no `listing_badge_opt_out`. The read SWALLOWS the error and
// answers "not opted out", which is the true answer rather than a lenient one:
// with no column and no switch, nobody can have opted out yet. The write is
// what genuinely cannot work, and it says so plainly instead of reporting a
// save that did not happen.
//
// It reads through its OWN query rather than joining the auto-end settings read
// beside it, deliberately: that one throws on error, so folding this column
// into its select would take the auto-end toggle down for the whole window.

export function ListingBadgeToggle() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const { data, isLoading } = useListingBadgeSetting();
  const [pending, setPending] = useState(false);

  const save = useMutation<void, Error, boolean>({
    mutationFn: async (optOut) => {
      if (!user) throw new Error("You must be signed in.");
      const { error } = await supabase
        .from("flipdesk_settings")
        .upsert(
          { user_id: user.id, listing_badge_opt_out: optOut } as never,
          { onConflict: "user_id" },
        );
      if (error) throw error;
    },
    onSuccess: (_v, optOut) => {
      void qc.invalidateQueries({ queryKey: [LISTING_BADGE_QUERY_KEY, user?.id] });
      toast.success(
        optOut
          ? "The badge is off. Your graded listings look the same to everyone."
          : "The badge is on. Shoppers with the extension see your grade.",
      );
    },
    onError: (err) => toastError(err, "Couldn't save the setting."),
    onSettled: () => setPending(false),
  });

  // `checked` is the OPPOSITE of the stored value: the column records opting
  // OUT, and a switch a seller reads as "show my badge" is the one they can
  // answer without thinking about a double negative.
  const showBadge = !(data?.optOut ?? false);
  const writable = data?.writable ?? true;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
      <div className="space-y-0.5">
        <Label htmlFor="listing-badge" className="text-sm font-medium">
          Show your grade on the marketplace listing
        </Label>
        <p className="text-xs text-muted-foreground">
          Shoppers with the GradeThread extension see the grade and a link to the
          certificate on your eBay, Poshmark and Mercari listings. Only listings
          you have graded and published a certificate for.
        </p>
        {!writable && !isLoading ? (
          <p className="text-xs text-muted-foreground">
            This setting is not available yet on this environment.
          </p>
        ) : null}
      </div>
      <Switch
        id="listing-badge"
        checked={showBadge}
        disabled={pending || isLoading || !writable}
        onCheckedChange={(v) => {
          setPending(true);
          save.mutate(!v);
        }}
      />
    </div>
  );
}
