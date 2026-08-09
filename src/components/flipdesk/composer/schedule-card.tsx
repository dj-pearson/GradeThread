import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { COMMON_TIMEZONES, DROP_PRESETS, formatInZone, nextPresetUtc } from "@/lib/scheduling";
import { isoToLocalInput, localInputToIso } from "@/lib/utils";
import { toast } from "sonner";
export interface ScheduleCardProps {
  scheduledAt: string;
  setScheduledAt: (next: string) => void;
  dropTimezone: string;
  setDropTimezone: (tz: string) => void;
}
// US-2253: the drop schedule, next to the button that publishes. It used to
// live inside "Condition & price", which it is neither of. The timezone picker only
// controls how the presets are evaluated — the input stays browser-local.
export function ScheduleCard({
  scheduledAt,
  setScheduledAt,
  dropTimezone,
  setDropTimezone,
}: ScheduleCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>When it goes live</CardTitle>
        <CardDescription>
          Publish as soon as you hit the button, or pick a peak buying time
          and let it go live on its own.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1.5">
        <Label htmlFor="schedule-at">Drop time (optional)</Label>
        <div className="flex items-center gap-2">
          <Input
            id="schedule-at"
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
            className="max-w-[16rem]"
          />
          {scheduledAt && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setScheduledAt("")}
            >
              Clear
            </Button>
          )}
        </div>
        {/* US-563: timezone-aware peak-time presets. The picker only
            controls how the presets below are evaluated; the input
            stays in your browser's local time. */}
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <Select value={dropTimezone} onValueChange={setDropTimezone}>
            <SelectTrigger className="h-8 w-[15rem] text-xs" aria-label="Timezone for drop-time presets">
              <SelectValue placeholder="Timezone" />
            </SelectTrigger>
            <SelectContent>
              {(COMMON_TIMEZONES.some((t) => t.id === dropTimezone)
                ? COMMON_TIMEZONES
                : [{ id: dropTimezone, label: `${dropTimezone} (your timezone)` }, ...COMMON_TIMEZONES]
              ).map((tz) => (
                <SelectItem key={tz.id} value={tz.id} className="text-xs">
                  {tz.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {DROP_PRESETS.map((preset) => (
            <Button
              key={preset.id}
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              title={preset.hint}
              onClick={() => {
                const utc = nextPresetUtc(preset, dropTimezone);
                setScheduledAt(isoToLocalInput(utc.toISOString()));
                toast.success(
                  `Drop set for ${formatInZone(utc.toISOString(), dropTimezone)}`,
                );
              }}
            >
              {preset.label}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Leave it empty to go live the moment you hit the button below.
          {scheduledAt && (
            <>
              {" "}Set: this listing goes live{" "}
              <span className="font-medium text-foreground">
                {formatInZone(
                  localInputToIso(scheduledAt) ?? "",
                  dropTimezone,
                )}
              </span>{" "}
              on its own — you don&apos;t need to come back.
            </>
          )}
        </p>
      </CardContent>
    </Card>
  );
}