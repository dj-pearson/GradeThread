import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { useCrossPostChannels } from "@/hooks/use-cross-post-channels";
import {
  isChannelEnabled,
  isChannelSelectable,
  normalizeSelection,
} from "@/lib/cross-post-channels";
import {
  CROSS_LISTING_PLATFORMS,
  MARKETPLACE_EXTENSION_FLOW,
  MARKETPLACE_FLOW_LABEL,
  MARKETPLACE_LABELS,
} from "@/lib/constants";

// US-2721: pick the marketplaces you actually sell on, once, for the account.
//
// A seller on Poshmark and Mercari is offered six channels on every draft, and
// the Listing Kit generates AI fields for all six.
//
// NOTHING SELECTED MEANS ALL. Both "never opened this" and "unticked the last
// box" arrive as an empty selection, and neither of them meant "stop offering
// me marketplaces" — so the setting narrows what is offered and can never turn
// cross-posting off. The copy says so rather than leaving the seller to
// discover it.
//
// A channel whose lister flow is not switched on is shown DISABLED with the
// reason, not hidden: a channel that is simply absent reads as one GradeThread
// does not support, and the seller goes looking for it somewhere else.

export function CrossPostChannelPicker() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const { data: stored, isLoading } = useCrossPostChannels();
  const [saving, setSaving] = useState(false);

  const selectable = useMemo(
    () => CROSS_LISTING_PLATFORMS.filter((p) => isChannelSelectable(p)),
    [],
  );

  async function toggle(platform: string, next: boolean) {
    if (!user) return;
    // Start from what is EFFECTIVE, not from what is stored: with nothing
    // stored every channel is on, so unticking one has to write the other five
    // rather than write a single-entry list that turns five off.
    const current = selectable.filter((p) => isChannelEnabled(p, stored));
    const wanted = next
      ? [...new Set([...current, platform])]
      : current.filter((p) => p !== platform);

    setSaving(true);
    try {
      const { error } = await supabase
        .from("flipdesk_settings")
        .upsert(
          {
            user_id: user.id,
            cross_post_channels: normalizeSelection(wanted, selectable),
          } as never,
          { onConflict: "user_id" },
        );
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["cross_post_channels", user.id] });
    } catch (err) {
      toast.error(
        `Couldn't save your channels: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border p-3 text-sm">
      <div className="space-y-0.5">
        <p className="font-medium">Marketplaces you cross-post to</p>
        <p className="text-xs text-muted-foreground">
          Drafts and the copy kit only offer the channels you pick here. Leave
          them all ticked to keep every channel — turning them all off does the
          same thing, not nothing.
        </p>
      </div>

      <ul className="grid gap-2 sm:grid-cols-2">
        {CROSS_LISTING_PLATFORMS.map((p) => {
          const usable = isChannelSelectable(p);
          const flow = (MARKETPLACE_EXTENSION_FLOW as Record<string, string>)[p];
          return (
            <li key={p} className="flex items-start gap-2">
              <Checkbox
                id={`channel-${p}`}
                className="mt-0.5"
                checked={usable && isChannelEnabled(p, stored)}
                disabled={!usable || saving || isLoading}
                onCheckedChange={(v) => void toggle(p, v === true)}
              />
              <div className="min-w-0">
                <Label
                  htmlFor={`channel-${p}`}
                  className="text-sm font-normal"
                >
                  {MARKETPLACE_LABELS[p] ?? p}
                </Label>
                {!usable && (
                  <p className="text-xs text-muted-foreground">
                    {MARKETPLACE_FLOW_LABEL[
                      flow as keyof typeof MARKETPLACE_FLOW_LABEL
                    ] ?? "Not available yet"}
                    {" — can't be selected until its form check passes."}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {/* Turning a channel off changes what is OFFERED next time. It does not
          reach back into items already listed there, and saying so is cheaper
          than a seller discovering it by looking for a listing they think we
          deleted. */}
      <p className="text-xs text-muted-foreground">
        Items already listed on a channel you turn off stay exactly where they
        are — this only changes what new drafts offer.
      </p>
    </div>
  );
}
