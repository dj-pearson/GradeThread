import { useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
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
  MARKETING_GRANULAR_KEYS,
  NOTIFICATION_TYPES,
  mergePreference,
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

  // What the server last said. Starts from the profile in the store, then
  // tracks the row read back on each save. Nothing is edited locally and saved
  // later: each switch writes itself, so there is nothing to lose on leaving.
  const [fresh, setFresh] = useState<NotificationPreferences | null>(null);
  const serverPrefs =
    fresh ?? withPreferenceDefaults(profile?.notification_preferences);
  // Switches whose write is in flight, with the value they are moving to.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  // Writes run one at a time. Each one reads the row, merges one key and
  // writes it back; two in parallel would each miss the other's key.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const [retryingProfile, setRetryingProfile] = useState(false);

  // Usage-alert thresholds (US-209). Percentages of any plan cap at which a
  // soft upgrade toast fires. Default [80]; the chooser offers 50/80/95.
  const [alertThresholds, setAlertThresholds] = useState<number[]>(() =>
    profile?.usage_alert_thresholds && profile.usage_alert_thresholds.length > 0
      ? profile.usage_alert_thresholds
      : [80]
  );
  const [savingAlerts, setSavingAlerts] = useState(false);

  function channelValue(
    typeKey: keyof NotificationPreferences,
    channel: NotificationChannel,
  ): boolean {
    const k = `${typeKey}.${channel}`;
    if (k in pending) return pending[k]!;
    return (serverPrefs[typeKey] as Record<string, boolean>)[channel] ?? false;
  }

  function saveChannel(
    typeKey: keyof NotificationPreferences,
    channel: NotificationChannel,
    value: boolean,
  ) {
    if (!user) return;
    const k = `${typeKey}.${channel}`;
    setPending((p) => ({ ...p, [k]: value }));
    const run = async () => {
      try {
        const { data, error: readError } = await supabase
          .from("users")
          .select("notification_preferences")
          .eq("id", user.id)
          .single();
        if (readError) throw readError;
        const stored = (data as { notification_preferences?: unknown } | null)
          ?.notification_preferences as
          | Partial<NotificationPreferences>
          | null
          | undefined;
        const merged = mergePreference(stored, typeKey, channel, value);
        const { error } = await supabase
          .from("users")
          .update({ notification_preferences: merged } as never)
          .eq("id", user.id);
        if (error) throw error;
        setFresh(withPreferenceDefaults(merged));
      } catch (err) {
        // Dropping the pending value IS the rollback: the switch falls back
        // to what the server last said.
        toastError(err, "Couldn't save that notification setting");
      } finally {
        setPending((p) => {
          const next = { ...p };
          delete next[k];
          return next;
        });
      }
    };
    queue.current = queue.current.then(run);
    // Keep the auth store's copy in step for readers elsewhere in the app.
    void queue.current.then(() => refreshProfile()).catch(() => {});
  }

  async function handleRetryProfile() {
    setRetryingProfile(true);
    try {
      await refreshProfile();
    } finally {
      setRetryingProfile(false);
    }
  }

  // Each chip saves on click. A failed save puts the chips back.
  async function toggleAlertThreshold(t: number) {
    const previous = alertThresholds;
    const next = previous.includes(t)
      ? previous.filter((x) => x !== t)
      : [...previous, t].sort((a, b) => a - b);
    setAlertThresholds(next);
    setSavingAlerts(true);
    try {
      const res = await edgeFetch("/api/payments/usage-alerts", {
        method: "POST",
        json: { thresholds: next },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Failed to save usage alert settings.");
      }
      // Server normalizes (dedupes/sorts, empty → default 80).
      if (Array.isArray(json.thresholds)) setAlertThresholds(json.thresholds);
      await refreshProfile();
    } catch (err) {
      setAlertThresholds(previous);
      toastError(err, "Failed to save usage alert settings.");
    } finally {
      setSavingAlerts(false);
    }
  }

  const marketingOff = channelValue("marketing", "email") === false;

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
          {!profile ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" />
              <div className="space-y-1">
                <p className="font-medium">
                  Couldn&apos;t load your notification settings
                </p>
                <p className="text-muted-foreground">
                  The switches are hidden until they load, so none of them can
                  show a setting you did not choose.{" "}
                  <button
                    type="button"
                    onClick={() => void handleRetryProfile()}
                    disabled={retryingProfile}
                    className="font-medium underline underline-offset-2"
                  >
                    {retryingProfile ? "Retrying…" : "Retry"}
                  </button>
                </p>
              </div>
            </div>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Each switch saves as soon as you flip it.
              </p>
              {NOTIFICATION_TYPES.map((type, index) => {
                const overridden =
                  marketingOff && MARKETING_GRANULAR_KEYS.includes(type.key);
                return (
                  <div key={type.key} id={`notif-${type.key}`}>
                    {index > 0 && <Separator className="mb-4" />}
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="space-y-0.5">
                        <p className="text-sm font-medium">{type.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {type.description}
                        </p>
                        {overridden && (
                          <p className="text-xs text-muted-foreground">
                            Off while All marketing email is off.
                          </p>
                        )}
                      </div>
                      <div className="flex gap-4">
                        {type.channels.map((channel) => {
                          const checked = channelValue(type.key, channel);
                          const switchId = `${type.key}-${channel}`;
                          const saving = `${type.key}.${channel}` in pending;
                          return (
                            <div
                              key={channel}
                              className="flex items-center gap-2"
                            >
                              <Switch
                                id={switchId}
                                checked={checked}
                                disabled={saving || overridden}
                                aria-label={`${type.label}: ${CHANNEL_LABELS[channel]}`}
                                onCheckedChange={(value) =>
                                  saveChannel(type.key, channel, value)
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
                );
              })}
            </>
          )}
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
            <div className="flex items-center gap-2">
              {[50, 80, 95].map((t) => {
                const active = alertThresholds.includes(t);
                return (
                  <Button
                    key={t}
                    type="button"
                    size="sm"
                    variant={active ? "default" : "outline"}
                    aria-pressed={active}
                    disabled={savingAlerts}
                    onClick={() => void toggleAlertThreshold(t)}
                  >
                    {t}%
                  </Button>
                );
              })}
              {savingAlerts && (
                <Loader2
                  className="h-4 w-4 animate-spin text-muted-foreground"
                  aria-label="Saving"
                />
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Saves when you tap. Defaults to 80%. Each alert fires at most once
              per cap per month. Clear all to keep just the 80% default.
            </p>
          </div>

        </CardContent>
      </Card>
    </>
  );
}
