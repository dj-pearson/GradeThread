import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Moon } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import {
  describeQuietWindow,
  parseQuietHours,
  type QuietHours,
} from "@/lib/quiet-hours";

// US-2853 / migration 00669. Push only — the in-app row and the email still
// arrive, which is the sentence that makes this safe to turn on. See the
// migration header for why this mutes rather than defers.
const QUIET_HOURS_KEY = "notification_quiet_hours";

const HOURS = Array.from({ length: 24 }, (_, h) => h);

function hourLabel(h: number): string {
  if (h === 0) return "12:00 AM";
  if (h === 12) return "12:00 PM";
  return h < 12 ? `${h}:00 AM` : `${h - 12}:00 PM`;
}

/** The browser knows the zone; the server that sends the push does not. Store it. */
function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function QuietHoursCard() {
  const userId = useAuthStore((s) => s.user?.id);
  const qc = useQueryClient();

  const { data: saved, isLoading } = useQuery({
    queryKey: [QUIET_HOURS_KEY, userId],
    enabled: !!userId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<QuietHours | null> => {
      const { data } = await supabase
        .from("users")
        .select("notification_quiet_hours")
        .eq("id", userId!)
        .maybeSingle();
      return parseQuietHours(
        (data as { notification_quiet_hours?: unknown } | null)
          ?.notification_quiet_hours,
      );
    },
  });

  const update = useMutation({
    mutationFn: async (next: QuietHours): Promise<void> => {
      if (!userId) throw new Error("Not signed in.");
      const { error } = await supabase
        .from("users")
        .update({
          notification_quiet_hours: {
            enabled: next.enabled,
            start_hour: next.startHour,
            end_hour: next.endHour,
            tz: next.tz,
          },
        } as never)
        .eq("id", userId);
      if (error) throw error;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [QUIET_HOURS_KEY, userId] });
    },
  });

  const [enabled, setEnabled] = useState(false);
  const [startHour, setStartHour] = useState(22);
  const [endHour, setEndHour] = useState(7);

  useEffect(() => {
    if (isLoading) return;
    setEnabled(saved?.enabled ?? false);
    setStartHour(saved?.startHour ?? 22);
    setEndHour(saved?.endHour ?? 7);
  }, [saved, isLoading]);

  async function save(next: Partial<QuietHours>) {
    const merged: QuietHours = {
      enabled,
      startHour,
      endHour,
      tz: saved?.tz || localZone(),
      ...next,
    };
    try {
      await update.mutateAsync(merged);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save.");
    }
  }

  const busy = isLoading || update.isPending;
  const sameHour = startHour === endHour;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Moon className="h-5 w-5 text-primary" />
          Quiet hours
        </CardTitle>
        <CardDescription>
          Stop phone and browser alerts during a window you pick. Nothing is lost:
          the notification still shows up in your bell, and any email still sends.
          You just do not get buzzed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Turn on quiet hours</p>
            <p className="text-xs text-muted-foreground">
              {enabled && !sameHour
                ? describeQuietWindow(startHour, endHour)
                : "Off. Alerts can arrive at any time."}
            </p>
          </div>
          <Switch
            checked={enabled}
            disabled={busy}
            onCheckedChange={(on) => {
              setEnabled(on);
              void save({ enabled: on });
            }}
            aria-label="Turn on quiet hours"
          />
        </div>

        {enabled && (
          <>
            <Separator />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="quietStart">Quiet from</Label>
                <Select
                  value={String(startHour)}
                  onValueChange={(v) => {
                    const h = Number(v);
                    setStartHour(h);
                    void save({ startHour: h });
                  }}
                >
                  <SelectTrigger id="quietStart" disabled={busy}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HOURS.map((h) => (
                      <SelectItem key={h} value={String(h)}>
                        {hourLabel(h)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="quietEnd">Quiet until</Label>
                <Select
                  value={String(endHour)}
                  onValueChange={(v) => {
                    const h = Number(v);
                    setEndHour(h);
                    void save({ endHour: h });
                  }}
                >
                  <SelectTrigger id="quietEnd" disabled={busy}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HOURS.map((h) => (
                      <SelectItem key={h} value={String(h)}>
                        {hourLabel(h)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {sameHour ? (
              <p className="text-xs text-destructive">
                Pick two different times. Setting both the same turns quiet hours
                off rather than silencing the whole day.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Times are in {saved?.tz || localZone()}.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
