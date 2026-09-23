import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/lib/supabase";
import type {
  NotificationPreferences,
  NotificationChannel,
} from "@/types/database";
import {
  NOTIFICATION_TYPES,
  withPreferenceDefaults,
} from "@/lib/notification-preferences";
import { edgeFetch } from "@/lib/edge-fetch";
import { toastError } from "@/lib/toast-error";
import { PushNotificationsCard } from "@/components/settings/push-notifications-card";
import { QuietHoursCard } from "@/components/settings/quiet-hours-card";

const CHANNEL_LABELS: Record<string, string> = {
  email: "Email",
  in_app: "In-app",
  push: "Push",
};

// The Notifications tab of /dashboard/settings: per-type channel switches,
// push, quiet hours and usage alerts. Split out of settings.tsx (web-growth
// action 6).
export function NotificationsSettingsTab() {
  const { user, profile, refreshProfile } = useAuth();

  const [prefs, setPrefs] = useState<NotificationPreferences>(() =>
    withPreferenceDefaults(profile?.notification_preferences)
  );
  const [savingPrefs, setSavingPrefs] = useState(false);

  // Usage-alert thresholds (US-209). Percentages of any plan cap at which a
  // soft upgrade toast fires. Default [80]; the chooser offers 50/80/95.
  const [alertThresholds, setAlertThresholds] = useState<number[]>(() =>
    profile?.usage_alert_thresholds && profile.usage_alert_thresholds.length > 0
      ? profile.usage_alert_thresholds
      : [80]
  );
  const [savingAlerts, setSavingAlerts] = useState(false);

  function setChannel(
    typeKey: keyof NotificationPreferences,
    channel: NotificationChannel,
    value: boolean
  ) {
    setPrefs((prev) => {
      const current = prev[typeKey] as Record<string, boolean>;
      return {
        ...prev,
        [typeKey]: { ...current, [channel]: value },
      } as NotificationPreferences;
    });
  }

  async function handleSavePreferences() {
    if (!user) return;
    setSavingPrefs(true);
    try {
      const { error } = await supabase
        .from("users")
        .update({ notification_preferences: prefs } as never)
        .eq("id", user.id);
      if (error) throw error;
      await refreshProfile();
      toast.success("Notification preferences saved");
    } catch (err) {
      toastError(err, "Failed to save preferences");
    } finally {
      setSavingPrefs(false);
    }
  }

  function toggleAlertThreshold(t: number) {
    setAlertThresholds((prev) =>
      prev.includes(t)
        ? prev.filter((x) => x !== t)
        : [...prev, t].sort((a, b) => a - b)
    );
  }

  async function handleSaveAlertThresholds() {
    setSavingAlerts(true);
    try {
      const res = await edgeFetch("/api/payments/usage-alerts", {
        method: "POST",
        json: { thresholds: alertThresholds },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Failed to save usage alert settings.");
      }
      // Server normalizes (dedupes/sorts, empty → default 80).
      if (Array.isArray(json.thresholds)) setAlertThresholds(json.thresholds);
      await refreshProfile();
      toast.success("Usage alert settings saved.");
    } catch (err) {
      toastError(err, "Failed to save usage alert settings.");
    } finally {
      setSavingAlerts(false);
    }
  }

  return (
    <>
          {/* Notification Preferences Section.
              US-2102: id="email-preferences" is the anchor every unsubscribe /
              preference email links to (accountPreferenceCenterUrl). It pointed
              at /dashboard/account#email-preferences, which existed nowhere —
              so the advertised opt-out path dead-ended. The anchor lives here
              because this is where the controls actually are. */}
          <Card id="email-preferences" className="scroll-mt-24">
        <CardHeader>
          <CardTitle>Notification Preferences</CardTitle>
          <CardDescription>
            Choose which notifications you receive and how.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {NOTIFICATION_TYPES.map((type, index) => (
            <div key={type.key}>
              {index > 0 && <Separator className="mb-4" />}
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">{type.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {type.description}
                  </p>
                </div>
                <div className="flex gap-4">
                  {type.channels.map((channel) => {
                    const checked =
                      (prefs[type.key] as Record<string, boolean>)[channel] ??
                      false;
                    const switchId = `${type.key}-${channel}`;
                    return (
                      <div
                        key={channel}
                        className="flex items-center gap-2"
                      >
                        <Switch
                          id={switchId}
                          checked={checked}
                          onCheckedChange={(value) =>
                            setChannel(type.key, channel, value)
                          }
                        />
                        <Label
                          htmlFor={switchId}
                          className="text-xs text-muted-foreground"
                        >
                          {CHANNEL_LABELS[channel]}
                        </Label>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ))}

          <Button onClick={handleSavePreferences} disabled={savingPrefs}>
            {savingPrefs && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Preferences
          </Button>
        </CardContent>
      </Card>

      {/* Push notifications opt-in (US-1901) */}
      <PushNotificationsCard />

      {/* US-2853 / 00669: quiet hours. Directly under the push card because it
          only ever affects push — the in-app row and any email still arrive. */}
      <QuietHoursCard />

      {/* Usage Alerts Section (US-209) */}
      <Card>
        <CardHeader>
          <CardTitle>Usage Alerts</CardTitle>
          <CardDescription>
            Get a heads-up before you hit a plan cap. We'll show a non-blocking
            upgrade tip when any cap (listings, AI actions, included grades,
            marketplaces) reaches the percentages you pick.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-medium">Notify me at</p>
            <div className="flex gap-2">
              {[50, 80, 95].map((t) => {
                const active = alertThresholds.includes(t);
                return (
                  <Button
                    key={t}
                    type="button"
                    size="sm"
                    variant={active ? "default" : "outline"}
                    aria-pressed={active}
                    onClick={() => toggleAlertThreshold(t)}
                  >
                    {t}%
                  </Button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              Defaults to 80%. Each alert fires at most once per cap per month.
              Clear all to keep just the 80% default.
            </p>
          </div>

          <Button onClick={handleSaveAlertThresholds} disabled={savingAlerts}>
            {savingAlerts && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Alert Settings
          </Button>
        </CardContent>
      </Card>
    </>
  );
}
