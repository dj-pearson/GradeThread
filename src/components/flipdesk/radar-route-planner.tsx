import { useMemo, useState } from "react";
import { ExternalLink, MapPin, Navigation, Route } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { BrandWeight, LatLng } from "@/lib/radar-map";
import {
  appleMapsRouteUrl,
  DAY_FULL_LABELS,
  DEFAULT_TIME_BUDGET_MINUTES,
  formatCents,
  formatMinutes,
  googleMapsRouteUrl,
  planCircuit,
  prefersAppleMaps,
  TIME_BUDGET_CHOICES,
  type RouteCandidate,
} from "@/lib/radar-route";

// US-1867: "plan my circuit" — the surface.
//
// A day, a time budget and a starting point in, an ordered list of stops out.
// Everything is computed in this browser from data the page already holds (see
// src/lib/radar-route.ts for why that is a privacy decision and not a shortcut),
// so nothing here fetches and nothing here sends a coordinate anywhere.
//
// Two things this component is careful about:
//
//   • IT SHOWS ITS WORKING. Every stop carries the plain-language reasons it was
//     ranked where it was. A ranking that will not say why is one nobody can
//     catch being wrong, and this one is telling somebody how to spend a Saturday.
//   • IT SAYS WHEN IT IS GUESSING. A circuit with no shared data behind it is
//     still useful, but it is one person's history rather than a crowd's, and the
//     plan says which of the two it is rather than letting the confident layout
//     imply the stronger claim.

export interface RouteStartOption {
  id: string;
  label: string;
  point: LatLng;
}

interface RadarRoutePlannerProps {
  candidates: RouteCandidate[];
  /** The first entry is the default. Always non-empty (the map centre). */
  startOptions: RouteStartOption[];
  weights: readonly BrandWeight[];
  /** "in the last 30 days" — spliced into each stop's rationale. */
  windowLabel: string;
}

export function RadarRoutePlanner({
  candidates,
  startOptions,
  weights,
  windowLabel,
}: RadarRoutePlannerProps) {
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState(() => new Date().getDay());
  const [budget, setBudget] = useState<number>(DEFAULT_TIME_BUDGET_MINUTES);
  const [startId, setStartId] = useState(startOptions[0]?.id ?? "map");

  const start = startOptions.find((o) => o.id === startId) ?? startOptions[0];

  const plan = useMemo(() => {
    if (!open || !start) return null;
    return planCircuit({
      start: start.point,
      day,
      timeBudgetMinutes: budget,
      candidates,
      weights,
      windowLabel,
    });
  }, [open, start, day, budget, candidates, weights, windowLabel]);

  const points = plan?.stops.map((s) => ({ lat: s.lat, lng: s.lng })) ?? [];
  const google = start ? googleMapsRouteUrl(start.point, points) : null;
  const apple = start ? appleMapsRouteUrl(start.point, points) : null;
  const appleFirst = prefersAppleMaps(
    typeof navigator === "undefined" ? undefined : navigator.userAgent,
  );
  const appleLink = {
    key: "apple",
    href: apple,
    label: "Open in Apple Maps",
    icon: MapPin,
  };
  const googleLink = {
    key: "google",
    href: google,
    label: "Open in Google Maps",
    icon: Navigation,
  };
  const mapsLinks = appleFirst ? [appleLink, googleLink] : [googleLink, appleLink];

  const perHour = plan && plan.moneyBasis && plan.totalMinutes > 0
    ? Math.round((plan.totalValueCents ?? 0) / (plan.totalMinutes / 60))
    : null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Route className="mr-2 h-4 w-4" aria-hidden="true" />
          Plan my circuit
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Plan my circuit</DialogTitle>
          <DialogDescription>
            An order to drive the stores in, best money per hour first. Driving
            time between stops is part of the ranking, not an afterthought.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Day">
            <Select value={String(day)} onValueChange={(v) => setDay(Number(v))}>
              <SelectTrigger aria-label="Day of the week">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAY_FULL_LABELS.map((label, index) => (
                  <SelectItem key={label} value={String(index)}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Time you have">
            <Select value={String(budget)} onValueChange={(v) => setBudget(Number(v))}>
              <SelectTrigger aria-label="Time budget">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIME_BUDGET_CHOICES.map((choice) => (
                  <SelectItem key={choice.minutes} value={String(choice.minutes)}>
                    {choice.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Starting from">
            <Select value={start?.id ?? ""} onValueChange={setStartId}>
              <SelectTrigger aria-label="Starting point">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {startOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        {plan && plan.stops.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="font-normal">
              {plan.stops.length} stop{plan.stops.length === 1 ? "" : "s"}
            </Badge>
            <Badge variant="outline" className="font-normal">
              {formatMinutes(plan.totalMinutes)} total ·{" "}
              {formatMinutes(plan.driveMinutes)} driving
            </Badge>
            {plan.moneyBasis && perHour != null && (
              <Badge variant="outline" className="font-normal">
                About {formatCents(plan.totalValueCents ?? 0)} ·{" "}
                {formatCents(perHour)}/hour
              </Badge>
            )}
            {plan.mode === "personal_only" && (
              <Badge variant="outline" className="font-normal">
                Your history only
              </Badge>
            )}
          </div>
        )}

        <ol className="space-y-2">
          {plan?.stops.map((stop, index) => (
            <li key={stop.id} className="rounded-xl bg-muted/40 p-3">
              <div className="flex items-start gap-3">
                <span
                  className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy text-xs font-semibold text-white dark:bg-foreground dark:text-background"
                  aria-hidden="true"
                >
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <p className="font-medium">{stop.name}</p>
                    {stop.valuePerHourCents != null && (
                      <p className="text-sm tabular-nums text-muted-foreground">
                        {formatCents(stop.valuePerHourCents)}/hour
                      </p>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {stop.travelMinutes} min drive · arrive{" "}
                    {formatMinutes(stop.arriveAfterMinutes)} in ·{" "}
                    {stop.dwellMinutes} min inside
                    {stop.expectedValueCents != null &&
                      ` · about ${formatCents(stop.expectedValueCents)} a visit`}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {capitalize(stop.reasons.join("; "))}.
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ol>

        {plan?.notes.map((note) => (
          <p key={note} className="max-w-[68ch] text-sm text-muted-foreground">
            {note}
          </p>
        ))}

        {plan && plan.stops.length > 0 && (
          <p className="max-w-[68ch] text-xs text-muted-foreground">
            Worked out on this device from stores already on your screen. Nothing
            about where you are is sent to GradeThread, and the route only leaves
            when you open it in a maps app.
          </p>
        )}

        {/* Both apps, with the platform's own first. One tap either way — the
            whole ordered route travels in the URL, so there is no in-app
            turn-by-turn to build and no second place for the route to live. */}
        <DialogFooter className="sm:justify-start">
          {mapsLinks.map((link, index) => (
            <Button
              key={link.key}
              asChild={link.href != null}
              type="button"
              size="sm"
              variant={index === 0 ? "default" : "outline"}
              disabled={link.href == null}
            >
              {link.href
                ? (
                  <a href={link.href} target="_blank" rel="noopener noreferrer">
                    <link.icon className="mr-2 h-4 w-4" aria-hidden="true" />
                    {link.label}
                    <ExternalLink className="ml-2 h-3 w-3" aria-hidden="true" />
                  </a>
                )
                : (
                  <span>
                    <link.icon className="mr-2 h-4 w-4" aria-hidden="true" />
                    {link.label}
                  </span>
                )}
            </Button>
          ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
