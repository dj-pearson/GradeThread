import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Compass, Crosshair, Radar, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { RadarMap, RadarMapLegend, type RadarMapMarker } from "@/components/flipdesk/radar-map";
import { RadarVenuePanel } from "@/components/flipdesk/radar-venue-panel";
import {
  RADAR_WINDOWS,
  useRadarMap,
  useRadarVenueDetail,
  type RadarWindowKey,
} from "@/hooks/use-radar-network";
import { useRadarStores, type PersonalStore } from "@/hooks/use-radar-stores";
import { useBillingSummary } from "@/hooks/use-billing-summary";
import { useUpgradeDialogStore } from "@/stores/upgrade-dialog-store";
import { FLIPDESK_PLANS, type FlipdeskPlanKey } from "@/lib/constants";
import {
  brandWeights,
  DEFAULT_ZOOM,
  fitPoints,
  freshnessLabel,
  hotnessScore,
  quantizeBoundingBox,
  viewportBounds,
  weightedActivity,
  type MapViewport,
} from "@/lib/radar-map";

// US-1865: Thrift Radar — the map.
//
// Three layers, three different rules, one surface. Keeping them straight is
// most of what this page is (full rule set: vault/20-domain/thrift-radar.md):
//
//   1. THE PERSONAL LAYER is free, needs no consent and works at n=1 (rule 7).
//      It is drawn first and it is never gated, because it is the cold-start
//      answer: a Radar that is blank until strangers show up never gets the
//      strangers. Every empty state below therefore still has something in it.
//   2. THE NETWORK LAYER is Pro+, gated at the endpoint and mirrored here only
//      so a Free seller does not open the page into a 402 modal. The gate that
//      counts is the server's.
//   3. THE K-ANONYMITY FLOOR is neither of those. It is applied server-side and
//      a below-floor venue is simply ABSENT — so an upgrade does not unlock it
//      and no amount of paying will. What unlocks it is contributions, which is
//      why the empty state pitches the toggle and not the plan.
//
// The brand weighting comes from the reseller's own pipeline history (what they
// have bought and sold, already computed for "My stores"), so it costs no AI
// spend and stores no new preference.

const MAP_SIZE = { width: 900, height: 520 };
const REQUIRED_PLAN: FlipdeskPlanKey = "pro";

/** A store the reseller owns that the registry can place on the map. */
function placeable(store: PersonalStore): store is PersonalStore & { lat: number; lng: number } {
  return typeof store.lat === "number" && typeof store.lng === "number";
}

export function FlipdeskRadarPage() {
  const [windowKey, setWindowKey] = useState<RadarWindowKey>("30d");
  const [viewport, setViewport] = useState<MapViewport | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  // One request serves two purposes: the personal layer itself, and the brand
  // weighting for the network layer. No second source of "what do I flip".
  const { data: personal, isLoading: personalLoading } = useRadarStores("roi");
  const stores = useMemo(() => personal?.stores ?? [], [personal?.stores]);
  const placedStores = useMemo(() => stores.filter(placeable), [stores]);
  const weights = useMemo(() => brandWeights(stores), [stores]);

  const { data: billing } = useBillingSummary();
  const plan = (billing?.subscription.plan as FlipdeskPlanKey) ?? "free";
  const canSeeNetwork = FLIPDESK_PLANS[plan]?.gateFlags.compPulls ?? false;

  // Open on the reseller's own stores. That is the honest default: it is the
  // only place we know they source, and it needs no permission prompt.
  useEffect(() => {
    if (viewport || placedStores.length === 0) return;
    const fitted = fitPoints(placedStores, MAP_SIZE);
    if (fitted) setViewport(fitted);
  }, [viewport, placedStores]);

  const bbox = useMemo(
    () => (viewport ? quantizeBoundingBox(viewportBounds(viewport, MAP_SIZE)) : null),
    [viewport],
  );

  const map = useRadarMap({
    bbox,
    window: windowKey,
    weights,
    enabled: canSeeNetwork,
  });

  const detail = useRadarVenueDetail(selectedId, windowKey, canSeeNetwork);

  // Hotness is relative to the hottest venue currently in view, so the peak has
  // to be recomputed whenever the view or the weighting changes.
  const peak = useMemo(() => {
    let max = 0;
    for (const activity of map.activity.values()) {
      max = Math.max(max, weightedActivity(activity, weights));
    }
    return max;
  }, [map.activity, weights]);

  const markers = useMemo<RadarMapMarker[]>(() => {
    const personalByVenue = new Map(
      placedStores.filter((s) => s.venue_id).map((s) => [s.venue_id!, s]),
    );
    const out: RadarMapMarker[] = [];

    for (const venue of map.venues) {
      const activity = map.activity.get(venue.id);
      const score = activity ? hotnessScore(activity, weights, peak) : 0;
      const mine = personalByVenue.get(venue.id);
      out.push({
        id: venue.id,
        lat: venue.lat,
        lng: venue.lng,
        label: venue.display_name,
        // Freshness travels with the marker, not just in the panel: a busy
        // store nobody has been to in a month is a different recommendation
        // from a busy store somebody scanned this morning, and the colour
        // already folds the two together.
        sublabel: `${venue.network.scan_count} scans, ${venue.network.contributor_count} people. ${
          freshnessLabel(venue.network.days_since_activity)
        }`,
        score,
        personal: Boolean(mine),
      });
      personalByVenue.delete(venue.id);
    }

    // Whatever is left is a store of theirs the network has nothing to say
    // about — below the floor, or nobody else has been. It still belongs on the
    // map: those are the places they actually go.
    for (const store of personalByVenue.values()) {
      if (!placeable(store)) continue;
      out.push({
        id: store.venue_id!,
        lat: store.lat,
        lng: store.lng,
        label: store.name,
        sublabel: "Your store",
        score: null,
        personal: true,
      });
    }
    return out;
  }, [map.venues, map.activity, placedStores, weights, peak]);

  const selectedPersonal = useMemo(
    () => stores.find((s) => s.venue_id && s.venue_id === selectedId) ?? null,
    [stores, selectedId],
  );

  const offMapStores = useMemo(
    () => stores.filter((s) => !placeable(s) && s.items_sourced > 0),
    [stores],
  );

  function useMyLocation() {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      toast.error("This browser cannot share a location.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setViewport({
          centerLat: pos.coords.latitude,
          centerLng: pos.coords.longitude,
          zoom: DEFAULT_ZOOM,
        });
      },
      () => {
        setLocating(false);
        toast.error("Could not get your location. Drag the map instead.");
      },
      { maximumAge: 300_000, timeout: 10_000 },
    );
  }

  const hasAnyMarker = markers.length > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Radar}
        title="Radar"
        subtitle="Where the good stuff is turning up right now — and where it has worked for you before."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={locating}
              onClick={useMyLocation}
            >
              <Crosshair className="mr-2 h-4 w-4" />
              {locating ? "Locating…" : "Use my location"}
            </Button>
            <Select
              value={windowKey}
              onValueChange={(v) => setWindowKey(v as RadarWindowKey)}
            >
              <SelectTrigger className="w-40" aria-label="Activity window">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RADAR_WINDOWS.map((w) => (
                  <SelectItem key={w.key} value={w.key}>
                    {w.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />

      {/* The location prompt only appears when we have nothing to centre on.
          Asking for a location we do not need would be the same widening the
          consent rules refuse — this map runs perfectly on a dragged view. */}
      {!viewport && !personalLoading && (
        <Card>
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-[62ch]">
              <p className="text-sm font-medium">Where are you sourcing?</p>
              <p className="text-sm text-muted-foreground">
                We do not know yet, because you have no stores with a place on
                the map. Share your location once to centre the map, or add a
                source and link it.
              </p>
            </div>
            <div className="flex gap-2">
              <Button type="button" size="sm" disabled={locating} onClick={useMyLocation}>
                <Crosshair className="mr-2 h-4 w-4" />
                Use my location
              </Button>
              <Button asChild type="button" size="sm" variant="outline">
                <Link to="/dashboard/flipdesk/sourcing?tab=stores">My stores</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {!canSeeNetwork && <NetworkUpgradeCard plan={plan} />}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-3">
          <RadarMap
            viewport={viewport ?? { centerLat: 39.5, centerLng: -98.35, zoom: DEFAULT_ZOOM }}
            onViewportChange={setViewport}
            markers={markers}
            selectedId={selectedId}
            onSelect={setSelectedId}
            emptyMessage={
              canSeeNetwork
                ? "No stores here yet. Drag the map, widen the window, or turn on contributions in Settings so your scans start filling this in."
                : "Your own stores appear here once you link them to a place. The shared map of everyone else's finds is on Pro."
            }
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <RadarMapLegend hasPersonal={placedStores.length > 0} />
            {map.kFloor > 0 && (
              <p className="text-xs text-muted-foreground">
                A store appears once {map.kFloor} different people have scanned
                there.
              </p>
            )}
          </div>
          {weights.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Weighted toward{" "}
              {weights.map((w) => (
                <Badge key={w.brand} variant="outline" className="mr-1 font-normal capitalize">
                  {w.brand}
                </Badge>
              ))}
              — the brands your own pipeline says you flip.
            </p>
          )}
          {map.isError && (
            <p className="text-sm text-destructive">
              {map.error?.message ?? "Could not load the map"} — try again in a
              moment.
            </p>
          )}
        </div>

        <div className="space-y-4">
          {selectedId ? (
            <RadarVenuePanel
              detail={detail.data}
              isLoading={detail.isLoading}
              error={(detail.error as Error | null) ?? null}
              personal={selectedPersonal}
            />
          ) : (
            <Card>
              <CardContent className="space-y-2 p-4">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <Compass className="h-4 w-4" aria-hidden="true" />
                  Pick a store
                </p>
                <p className="text-sm text-muted-foreground">
                  {hasAnyMarker
                    ? "Tap a dot to see what people are finding there, what condition it is in, and which days it is busy."
                    : "Nothing is on the map yet. Your own stores show up here as soon as one is linked to a place."}
                </p>
              </CardContent>
            </Card>
          )}

          <ContributionPitch />

          {offMapStores.length > 0 && (
            <Card>
              <CardContent className="space-y-2 p-4">
                <p className="text-sm font-medium">Your stores that are not on the map</p>
                <p className="text-sm text-muted-foreground">
                  These have your money in them but no place yet. Link one on My
                  stores and it joins the map.
                </p>
                <ul className="space-y-1 text-sm">
                  {offMapStores.slice(0, 6).map((store) => (
                    <li key={store.key} className="flex justify-between gap-3">
                      <span className="truncate">{store.name}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {store.items_sourced} item{store.items_sourced === 1 ? "" : "s"}
                      </span>
                    </li>
                  ))}
                </ul>
                <Button asChild type="button" size="sm" variant="outline">
                  <Link to="/dashboard/flipdesk/sourcing?tab=stores">Link a store</Link>
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The plan gate, said plainly.
 *
 * It names what is behind it (other people's scans) and what is NOT (your own
 * stores, which stay on the map), because an upgrade prompt that implies the
 * whole page is paid would be selling something the reseller already has.
 */
function NetworkUpgradeCard({ plan }: { plan: FlipdeskPlanKey }) {
  const show = useUpgradeDialogStore((s) => s.show);
  const required = FLIPDESK_PLANS[REQUIRED_PLAN];
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-[62ch]">
          <p className="text-sm font-medium">
            The shared map is on {required.name}
          </p>
          <p className="text-sm text-muted-foreground">
            Hotness, brand mix and busy days come from everyone else&rsquo;s
            scans. Your own stores and your own numbers stay on this map on every
            plan.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() =>
            // Explicit click, so no rate limit — the throttle exists for the
            // automatic mid-flow 402, not for a button somebody pressed.
            show({
              reason: { type: "feature", feature: "compPulls" },
              currentPlan: plan,
              requiredPlan: REQUIRED_PLAN,
            })}
        >
          See {required.name}
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * The contribution pitch.
 *
 * Shown to everyone, on every plan, and it links to the toggle rather than
 * flipping anything: contributing and viewing are separate consents (rule 1),
 * and a map that enrolled its viewers would collapse a read into a write.
 */
function ContributionPitch() {
  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          Empty map near you?
        </p>
        <p className="text-sm text-muted-foreground">
          Radar only shows a store once enough different people have scanned
          there, so a quiet area means quiet contributors, not a dead area.
          Turning contributions on sends the store and the brand from your
          scans, never a coordinate and never your name.
        </p>
        <Button asChild type="button" size="sm" variant="outline">
          <Link to="/dashboard/settings?tab=flipdesk">Contribution settings</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
