import { useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { useListerLocales } from "@/hooks/use-lister-locales";
import {
  LISTER_LOCALE_DEFAULT,
  MULTI_DOMAIN_PLATFORMS,
  localeOptions,
  normalizeLocaleSelection,
} from "@/lib/lister-locales";
import { MARKETPLACE_LABELS } from "@/lib/constants";

// US-2777: which country's Vinted this seller lists on.
//
// Vinted is one app on 22 country domains. Until this existed the Lister always
// opened the platform default, so a seller outside that market watched a form
// fill on a site they have no account on — no error, just the wrong country.
//
// ONE SETTING, NOT ONE PER LISTING. A seller has one Vinted account and it
// lives on one domain; asking per item would ask the same question forever and
// let them answer it wrong once. It also has to work for the QUEUED path, where
// there is no UI at send time at all — the phone records an instruction and the
// desktop drains it hours later. A per-listing field would have nowhere to come
// from there.

export function ListerLocalePicker() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const { data: stored, isLoading } = useListerLocales();
  const [saving, setSaving] = useState(false);

  async function pick(platform: (typeof MULTI_DOMAIN_PLATFORMS)[number], value: string) {
    if (!user) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from("flipdesk_settings")
        .upsert(
          {
            user_id: user.id,
            lister_locales: normalizeLocaleSelection(stored, platform, value),
          } as never,
          { onConflict: "user_id" },
        );
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["lister_locales", user.id] });
    } catch (err) {
      toast.error(
        `Couldn't save your country: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border p-3 text-sm">
      <div className="space-y-0.5">
        <p className="font-medium">Your marketplace country</p>
        <p className="text-xs text-muted-foreground">
          Some marketplaces run a separate site per country. Pick the one your
          account is on so cross-posting opens the right site.
        </p>
      </div>

      <ul className="space-y-2">
        {MULTI_DOMAIN_PLATFORMS.map((platform) => {
          // The stored value, or the default. The picker always shows a
          // concrete domain rather than a "not set" row: the seller is going to
          // land somewhere either way, and naming it is the point. A saved key
          // the bundled config no longer covers is shown AS ITSELF rather than
          // hidden behind the default — see localeOptions.
          const { value: current, options, strayValue } = localeOptions(stored, platform);
          return (
            <li key={platform} className="flex flex-wrap items-center gap-2">
              <Label
                htmlFor={`locale-${platform}`}
                className="w-24 text-sm font-normal"
              >
                {MARKETPLACE_LABELS[platform] ?? platform}
              </Label>
              <Select
                value={current}
                disabled={saving || isLoading}
                onValueChange={(v) => void pick(platform, v)}
              >
                <SelectTrigger id={`locale-${platform}`} className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {options.map((locale) => (
                    <SelectItem key={locale} value={locale}>
                      {locale}
                      {locale === LISTER_LOCALE_DEFAULT[platform] ? " (default)" : ""}
                      {locale === strayValue ? " (no longer supported)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </li>
          );
        })}
      </ul>

      <p className="text-xs text-muted-foreground">
        This applies to cross-posts you start here and to ones you queue from
        the phone app.
      </p>
    </div>
  );
}
