// US-1867: Thrift Radar — "plan my circuit", the pure half.
//
// An ordered list of stops for one sourcing day, ranked by expected money per
// hour, blending the shared network layer (US-1863's k-floored aggregates) with
// the reseller's own per-store history (US-1864). Greedy nearest-value ordering,
// exactly as the story allows for v1: no route-optimization service, no solver,
// no dependency.
//
// ── Why this runs in the browser ────────────────────────────────────────────
//
// Everything the planner needs is already on the page: `/my-stores` served the
// personal layer and `/radar/venues` served the network layer for the current
// viewport. Planning from those means the START POINT — which is the one genuinely
// precise coordinate in this whole feature — never leaves the device. Sending it
// to us so a server could sort eight stores would be the disclosure
// vault/20-domain/thrift-radar.md rule 4 spends a migration preventing, given away
// for arithmetic a phone can do in a millisecond.
//
// It also means the Pro+ gate is unchanged and still real: the network half of
// every score comes from `/radar/venues`, which 402s a Free seller server-side
// (rule 7). There is no new endpoint here to forget to gate.
//
// ── What "expected $/hour" means ────────────────────────────────────────────
//
// Only ONE of the two layers is denominated in money. The network aggregates
// carry scans, contributors, buy-rate and a weekly rhythm — never dollars, because
// the events they roll up never held a price. So every figure below is anchored on
// the RESELLER'S OWN money (what a visit has historically been worth to them), and
// the network moves that number up or down. A store nobody has money history for
// is priced at their own portfolio average times what the network says about the
// place — a number they can check against their own books, rather than one we
// invented for them. When they have no money history anywhere, the plan says so
// and ranks without dollars instead of printing a made-up figure.

import {
  clamp,
  DAY_LABELS,
  freshnessFactor,
  type BrandWeight,
  type LatLng,
} from "@/lib/radar-map";

// ── Constants ───────────────────────────────────────────────────────────────

/** How long a thrift stop takes. A racked store is 30–40 minutes to walk. */
export const DEFAULT_DWELL_MINUTES = 35;

/** Average door-to-door driving speed, in km/h. Urban errand driving, not motorway. */
export const AVERAGE_SPEED_KMH = 40;

/**
 * Straight line to road distance.
 *
 * Venue centroids are geohash cell centres, so a leg is measured as the crow
 * flies. Real roads are longer; 1.3 is the usual planning multiplier and keeps
 * the circuit from promising a day that does not fit.
 */
export const ROAD_DETOUR_FACTOR = 1.3;

/** Even a store across the car park costs you the parking. */
export const MIN_LEG_MINUTES = 2;

/**
 * How many stops a plan may hold.
 *
 * Not a taste call: a Google Maps directions URL carries an origin, a destination
 * and at most nine intermediate waypoints, so a longer route could be planned and
 * then not open. A plan that cannot be driven is not a plan.
 */
export const MAX_ROUTE_STOPS = 8;

export const TIME_BUDGET_CHOICES = [
  { minutes: 120, label: "2 hours" },
  { minutes: 180, label: "3 hours" },
  { minutes: 240, label: "4 hours" },
  { minutes: 360, label: "6 hours" },
  { minutes: 480, label: "All day (8 hours)" },
] as const;

export const DEFAULT_TIME_BUDGET_MINUTES = 240;

/** Full day names, for prose. `DAY_LABELS` is the three-letter chart form. */
export const DAY_FULL_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/**
 * The stand-in for a per-visit value when the reseller has no money history.
 *
 * Purely a unit so the ranking arithmetic still has something to multiply. It is
 * never shown: a plan with no money basis reports `expectedValueCents: null` and
 * the UI ranks the stops without pricing them.
 */
const NOMINAL_UNIT = 100;

/** How much personal evidence it takes before their own number outweighs the network. */
const PERSONAL_SHRINK = 3;

/** The network always keeps a say — nobody has enough visits to be certain. */
const MAX_PERSONAL_WEIGHT = 0.9;

// ── Geometry ────────────────────────────────────────────────────────────────

const EARTH_RADIUS_KM = 6371;

export function haversineKm(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Whole minutes of driving between two points, detour factor included. */
export function legMinutes(
  from: LatLng,
  to: LatLng,
  speedKmh = AVERAGE_SPEED_KMH,
): number {
  const km = haversineKm(from, to) * ROAD_DETOUR_FACTOR;
  const minutes = Math.round((km / Math.max(1, speedKmh)) * 60);
  return Math.max(MIN_LEG_MINUTES, minutes);
}

// ── The inputs ──────────────────────────────────────────────────────────────

/** What the reseller's own books say about a store. All money in cents. */
export interface RoutePersonalFacts {
  visits: number;
  itemsSourced: number;
  spendCents: number;
  realizedProfitCents: number;
  expectedProfitCents: number;
  roiPct: number | null;
}

/** What the shared, k-floored network layer says about a venue. */
export interface RouteNetworkFacts {
  scanCount: number;
  contributorCount: number;
  buyRate: number | null;
  daysSince: number | null;
  /** Seven entries, index 0 = Sunday, in the venue's own approximate local time. */
  activityByDay: number[];
  /** brand key → scans, for the reseller's weighted brands only. */
  brandScans: Readonly<Record<string, number>>;
}

export interface RouteCandidate {
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** Null for a venue the reseller has never sourced from. */
  personal: RoutePersonalFacts | null;
  /** Null below the k-floor, outside the plan, or when nobody has scanned here. */
  network: RouteNetworkFacts | null;
}

export interface PlanCircuitInput {
  start: LatLng;
  /** 0 = Sunday, matching `activityByDay`. */
  day: number;
  timeBudgetMinutes: number;
  candidates: readonly RouteCandidate[];
  weights: readonly BrandWeight[];
  /** "in the last 30 days" — spliced into the rationale, so it reads as prose. */
  windowLabel: string;
  dwellMinutes?: number;
  speedKmh?: number;
  maxStops?: number;
}

// ── Money ───────────────────────────────────────────────────────────────────

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return abs >= 1000
    ? `${sign}$${Math.round(abs / 100).toLocaleString("en-US")}`
    : `${sign}$${(abs / 100).toFixed(2)}`;
}

export type PersonalValueBasis = "visits" | "items";

export interface PersonalValue {
  /** What one visit to this store has been worth, in cents. May be zero. */
  cents: number;
  basis: PersonalValueBasis;
  /** Visits (or items, when that is the basis) behind the figure. */
  evidence: number;
}

/**
 * How many items a trip to a store yields, from this reseller's OWN data.
 *
 * Only stores with both visits and items contribute, so this is measured rather
 * than assumed. It exists to price a store they have bought from but never
 * scanned at: profit-per-item is known, trips are not, and their own average is
 * the only honest bridge. Null when nothing can measure it.
 */
export function measuredItemsPerVisit(
  candidates: readonly RouteCandidate[],
): number | null {
  let items = 0;
  let visits = 0;
  for (const c of candidates) {
    if (!c.personal) continue;
    if (c.personal.visits > 0 && c.personal.itemsSourced > 0) {
      items += c.personal.itemsSourced;
      visits += c.personal.visits;
    }
  }
  if (visits <= 0 || items <= 0) return null;
  return items / visits;
}

/**
 * What one visit to this store has been worth, in cents.
 *
 * Total profit (realized plus what unsold stock is expected to clear at the price
 * THEY set — never a comp lookup, same rule as US-1864) divided by trips. Trips
 * come from recorded visits where there are any; otherwise from items and their
 * measured items-per-visit. Null when neither is available, which is what stops
 * a store with no history being priced as if it had one.
 */
export function personalValuePerVisit(
  personal: RoutePersonalFacts | null,
  itemsPerVisit: number | null,
): PersonalValue | null {
  if (!personal) return null;
  const profit = personal.realizedProfitCents + personal.expectedProfitCents;
  if (personal.visits > 0) {
    return {
      cents: Math.round(profit / personal.visits),
      basis: "visits",
      evidence: personal.visits,
    };
  }
  if (personal.itemsSourced > 0 && itemsPerVisit && itemsPerVisit > 0) {
    const perItem = profit / personal.itemsSourced;
    return {
      cents: Math.round(perItem * itemsPerVisit),
      basis: "items",
      evidence: personal.itemsSourced,
    };
  }
  return null;
}

/**
 * The reseller's average value per visit across every store they can price.
 *
 * This is the anchor that turns the network's activity signal into dollars. It is
 * their number, from their books, so a store they have never been to is quoted at
 * "a normal visit for you, adjusted for what the network says about this place".
 */
export function portfolioValuePerVisit(
  candidates: readonly RouteCandidate[],
  itemsPerVisit: number | null,
): number {
  let total = 0;
  let counted = 0;
  for (const c of candidates) {
    const value = personalValuePerVisit(c.personal, itemsPerVisit);
    if (!value) continue;
    total += value.cents;
    counted++;
  }
  if (counted === 0 || total <= 0) return 0;
  return Math.round(total / counted);
}

// ── The network signal ──────────────────────────────────────────────────────

/**
 * How much busier than an average day this venue is on the chosen day.
 *
 * 1 means "a typical day here". Clamped both ways because seven numbers off a
 * small sample can say 100% of activity was on a Tuesday, and a route should not
 * be reordered by one enthusiastic Tuesday.
 */
export function dayFactor(
  counts: readonly number[] | undefined,
  day: number,
): number {
  if (!counts || counts.length === 0) return 1;
  const total = counts.reduce((sum, n) => sum + Math.max(0, n ?? 0), 0);
  if (total <= 0) return 1;
  const share = Math.max(0, counts[day] ?? 0) / total;
  return clamp(share * DAY_LABELS.length, 0.5, 1.75);
}

/** How much of this venue's activity is in the brands this reseller flips, 0..1. */
export function brandShare(
  network: RouteNetworkFacts,
  weights: readonly BrandWeight[],
): number {
  if (weights.length === 0 || network.scanCount <= 0) return 0;
  let weighted = 0;
  for (const { brand, weight } of weights) {
    weighted += Math.max(0, network.brandScans[brand] ?? 0) * weight;
  }
  return clamp(weighted / network.scanCount, 0, 1);
}

/**
 * The multiplier the network puts on a normal visit, for THIS reseller on THIS day.
 *
 * Four things move it, and each is something the aggregates already publish:
 * the day of the week, how much of the activity is in their brands, how often
 * people there decide something is worth buying, and how stale the picture is.
 * Freshness is the same stepped decay the map colours by, so a store that reads
 * "hot" on the map cannot read "cold" in a plan built from the same numbers.
 */
export function networkFactor(
  network: RouteNetworkFacts,
  day: number,
  weights: readonly BrandWeight[],
): number {
  const dow = dayFactor(network.activityByDay, day);
  const brand = 1 + brandShare(network, weights) * 0.75;
  const buy = network.buyRate == null ? 1 : 0.8 + clamp(network.buyRate, 0, 1) * 0.4;
  const fresh = freshnessFactor(network.daysSince);
  return clamp(dow * brand * buy * fresh, 0.2, 3);
}

/**
 * How much their own number counts against the network's.
 *
 * Shrinkage, not a switch: one visit is an anecdote and twenty is a pattern, and
 * the curve between them should be smooth. It never reaches 1, because a store
 * that was good for a year can go quiet and the network is how you find out.
 */
export function personalWeight(evidence: number): number {
  if (evidence <= 0) return 0;
  return Math.min(
    MAX_PERSONAL_WEIGHT,
    evidence / (evidence + PERSONAL_SHRINK),
  );
}

// ── Scoring ─────────────────────────────────────────────────────────────────

export interface ScoreContext {
  day: number;
  weights: readonly BrandWeight[];
  itemsPerVisit: number | null;
  /** Their portfolio average per visit, in cents. Zero when they have no money history. */
  baselineCents: number;
  /** True when `baselineCents` is real money and figures may be shown as dollars. */
  moneyBasis: boolean;
}

export interface CandidateScore {
  /** Cents when `moneyBasis`, otherwise nominal units. Never shown in the second case. */
  value: number;
  personal: PersonalValue | null;
  networkFactor: number | null;
}

/**
 * What one visit to this store is worth, on the chosen day.
 *
 * Their own per-visit number and the network's implied number, blended by how
 * much personal evidence exists. Both halves are anchored on their own money, so
 * the result is comparable across stores they know and stores they do not.
 */
export function scoreCandidate(
  candidate: RouteCandidate,
  ctx: ScoreContext,
): CandidateScore {
  const personal = personalValuePerVisit(candidate.personal, ctx.itemsPerVisit);
  const factor = candidate.network
    ? networkFactor(candidate.network, ctx.day, ctx.weights)
    : null;
  const baseline = ctx.moneyBasis ? ctx.baselineCents : NOMINAL_UNIT;
  const networkValue = baseline * (factor ?? 1);

  if (!ctx.moneyBasis) {
    // No money history anywhere, so there is nothing to blend and nothing to
    // print. Rank on the network signal, nudged by familiarity — a store they
    // keep going back to is evidence of something, even before it is evidence of
    // profit.
    const familiarity = candidate.personal
      ? 1 + 0.1 * Math.min(5, Math.max(candidate.personal.visits, candidate.personal.itemsSourced))
      : 1;
    return { value: networkValue * familiarity, personal, networkFactor: factor };
  }

  const weight = personal ? personalWeight(personal.evidence) : 0;
  const value = weight * (personal?.cents ?? 0) + (1 - weight) * networkValue;
  return { value, personal, networkFactor: factor };
}

// ── The plan ────────────────────────────────────────────────────────────────

export interface PlannedStop {
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** Driving minutes from the previous stop (or from the start, for the first). */
  travelMinutes: number;
  dwellMinutes: number;
  /** Minutes after leaving home that you walk in the door. */
  arriveAfterMinutes: number;
  /** What a visit here is worth. Null when the plan has no money basis. */
  expectedValueCents: number | null;
  /** Value divided by the time this stop costs, travel included. Null likewise. */
  valuePerHourCents: number | null;
  /** Plain-language ranking rationale, most specific first. 1–3 entries. */
  reasons: string[];
  hasNetwork: boolean;
  hasPersonal: boolean;
}

export type RoutePlanMode = "blended" | "personal_only";

export interface RoutePlan {
  stops: PlannedStop[];
  /** "personal_only" when no stop had a network aggregate to blend in. */
  mode: RoutePlanMode;
  moneyBasis: boolean;
  day: number;
  timeBudgetMinutes: number;
  /** Travel plus dwell across the whole circuit. */
  totalMinutes: number;
  driveMinutes: number;
  totalValueCents: number | null;
  /** Candidates that were considered and did not make the cut. */
  skipped: number;
  /** Why the plan looks the way it does. Empty when there is nothing to explain. */
  notes: string[];
}

/**
 * Order a sourcing day, greedily.
 *
 * At every step the next stop is the one with the best value per hour FROM WHERE
 * YOU ARE — so travel time is not a post-hoc penalty, it is inside the comparison
 * that picks each stop. That is the whole of the ordering rule, and it is enough:
 * the story asks for a good circuit, not an optimal one, and a solver would need a
 * service we would have to send the route to.
 *
 * A stop that does not fit in what is left of the budget is passed over rather
 * than ending the plan, because a nearby quick stop can still fit after a distant
 * one has been ruled out.
 */
export function planCircuit(input: PlanCircuitInput): RoutePlan {
  const dwell = Math.max(5, Math.round(input.dwellMinutes ?? DEFAULT_DWELL_MINUTES));
  const maxStops = Math.max(1, Math.min(input.maxStops ?? MAX_ROUTE_STOPS, MAX_ROUTE_STOPS));
  const budget = Math.max(0, Math.round(input.timeBudgetMinutes));
  const day = ((Math.round(input.day) % 7) + 7) % 7;

  const candidates = dedupe(input.candidates);
  const itemsPerVisit = measuredItemsPerVisit(candidates);
  const baselineCents = portfolioValuePerVisit(candidates, itemsPerVisit);
  const ctx: ScoreContext = {
    day,
    weights: input.weights,
    itemsPerVisit,
    baselineCents,
    moneyBasis: baselineCents > 0,
  };

  const scored = new Map<string, CandidateScore>();
  for (const c of candidates) scored.set(c.id, scoreCandidate(c, ctx));

  const remaining = new Map(candidates.map((c) => [c.id, c]));
  const stops: PlannedStop[] = [];
  let position: LatLng = input.start;
  let used = 0;
  let driveMinutes = 0;

  while (stops.length < maxStops && remaining.size > 0) {
    let best: { candidate: RouteCandidate; travel: number; rate: number } | null = null;
    for (const candidate of remaining.values()) {
      const travel = legMinutes(position, candidate, input.speedKmh);
      const cost = travel + dwell;
      if (used + cost > budget) continue;
      const value = scored.get(candidate.id)?.value ?? 0;
      const rate = value / (cost / 60);
      if (!best || rate > best.rate) best = { candidate, travel, rate };
    }
    if (!best) break;

    const { candidate, travel } = best;
    remaining.delete(candidate.id);
    const score = scored.get(candidate.id)!;
    const cost = travel + dwell;
    used += cost;
    driveMinutes += travel;
    stops.push({
      id: candidate.id,
      name: candidate.name,
      lat: candidate.lat,
      lng: candidate.lng,
      travelMinutes: travel,
      dwellMinutes: dwell,
      arriveAfterMinutes: used - dwell,
      expectedValueCents: ctx.moneyBasis ? Math.round(score.value) : null,
      valuePerHourCents: ctx.moneyBasis
        ? Math.round(score.value / (cost / 60))
        : null,
      reasons: stopReasons(candidate, score, {
        day,
        windowLabel: input.windowLabel,
        weights: input.weights,
        moneyBasis: ctx.moneyBasis,
      }),
      hasNetwork: candidate.network != null,
      hasPersonal: candidate.personal != null,
    });
    position = candidate;
  }

  const mode: RoutePlanMode = stops.some((s) => s.hasNetwork)
    ? "blended"
    : "personal_only";
  const totalValueCents = ctx.moneyBasis
    ? stops.reduce((sum, s) => sum + (s.expectedValueCents ?? 0), 0)
    : null;

  return {
    stops,
    mode,
    moneyBasis: ctx.moneyBasis,
    day,
    timeBudgetMinutes: budget,
    totalMinutes: used,
    driveMinutes,
    totalValueCents,
    skipped: remaining.size,
    notes: planNotes({
      candidates: candidates.length,
      stops: stops.length,
      skipped: remaining.size,
      mode,
      moneyBasis: ctx.moneyBasis,
      maxStops,
      budget,
    }),
  };
}

function dedupe(candidates: readonly RouteCandidate[]): RouteCandidate[] {
  const seen = new Set<string>();
  const out: RouteCandidate[] = [];
  for (const c of candidates) {
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) continue;
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

/**
 * What the plan needs to say about itself.
 *
 * The sparse-data case is the important one: a circuit built with no network
 * coverage is still a useful circuit, but it is ranked from one person's history
 * and the reseller has to be told that, or they will read their own averages as a
 * crowd's verdict.
 */
export function planNotes(input: {
  candidates: number;
  stops: number;
  skipped: number;
  mode: RoutePlanMode;
  moneyBasis: boolean;
  maxStops: number;
  budget: number;
}): string[] {
  const notes: string[] = [];
  if (input.candidates === 0) {
    notes.push(
      "No stores to plan from yet. Drag the map over the area you want to source, or link one of your sources to a place on My stores.",
    );
    return notes;
  }
  if (input.stops === 0) {
    notes.push(
      `Nothing fits in ${formatMinutes(input.budget)}. Give the day more time, or move the map closer to where you are starting.`,
    );
    return notes;
  }
  if (input.mode === "personal_only") {
    notes.push(
      "No shared Radar data covers these stores yet, so this circuit is ranked from your own history alone. It is still your best guess — just not the crowd's.",
    );
  }
  if (!input.moneyBasis) {
    notes.push(
      "You have no sourcing profit recorded yet, so the stops are ranked by activity rather than priced. Log what you buy and sell and this turns into dollars per hour.",
    );
  }
  if (input.stops >= input.maxStops && input.skipped > 0) {
    notes.push(
      `Capped at ${input.maxStops} stops — that is the most a Maps link can carry.`,
    );
  } else if (input.skipped > 0) {
    notes.push(
      `${input.skipped} more store${input.skipped === 1 ? "" : "s"} nearby did not fit in ${formatMinutes(input.budget)}.`,
    );
  }
  return notes;
}

/** "3h 25m" — how a circuit's length is read out loud. */
export function formatMinutes(total: number): string {
  const minutes = Math.max(0, Math.round(total));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

// ── Rationale ───────────────────────────────────────────────────────────────

function titleCase(raw: string): string {
  return raw.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

/**
 * Why this store is where it is in the list, in words a person would use.
 *
 * Every clause is traceable to a number on this page — a brand share, a weekday
 * histogram, their own profit per visit. A ranking that cannot say why is a
 * ranking nobody has any reason to trust, and it is also one nobody can catch
 * being wrong.
 */
export function stopReasons(
  candidate: RouteCandidate,
  score: CandidateScore,
  ctx: {
    day: number;
    windowLabel: string;
    weights: readonly BrandWeight[];
    moneyBasis: boolean;
  },
): string[] {
  const reasons: string[] = [];
  const net = candidate.network;

  if (net) {
    const share = brandShare(net, ctx.weights);
    const top = [...ctx.weights]
      .map((w) => ({ brand: w.brand, scans: net.brandScans[w.brand] ?? 0 }))
      .sort((a, b) => b.scans - a.scans)[0];
    if (share >= 0.2 && top && top.scans > 0) {
      reasons.push(
        `strong ${titleCase(top.brand)} density ${ctx.windowLabel}`,
      );
    }

    const df = dayFactor(net.activityByDay, ctx.day);
    if (df >= 1.2) {
      reasons.push(`${DAY_FULL_LABELS[ctx.day]} is one of its busiest days`);
    } else if (df <= 0.7) {
      reasons.push(`${DAY_FULL_LABELS[ctx.day]} is usually quiet here`);
    }

    if (reasons.length < 2) {
      reasons.push(
        `${net.scanCount} scan${net.scanCount === 1 ? "" : "s"} by ${net.contributorCount} people ${ctx.windowLabel}`,
      );
    }
  }

  const personalReason = personalRationale(candidate, score, ctx.moneyBasis);
  if (personalReason) reasons.push(personalReason);

  if (reasons.length === 0) {
    reasons.push(
      "nothing known about this one yet — a cold stop, worth trying because it is on the way",
    );
  }
  return reasons.slice(0, 3);
}

function personalRationale(
  candidate: RouteCandidate,
  score: CandidateScore,
  moneyBasis: boolean,
): string | null {
  const personal = candidate.personal;
  // A store with no network row either is a total unknown, and the caller has a
  // better sentence for that than "you have never sourced here" — which, on its
  // own, would read as the reason it is on the list.
  if (!personal) return candidate.network ? "you have never sourced here" : null;

  const value = score.personal;
  if (moneyBasis && value && value.cents > 0) {
    return value.basis === "visits"
      ? `you average ${formatCents(value.cents)} profit per visit here`
      : `your ${personal.itemsSourced} item${personal.itemsSourced === 1 ? "" : "s"} from here work out to about ${formatCents(value.cents)} a trip`;
  }
  if (personal.itemsSourced > 0) {
    return `you have sourced ${personal.itemsSourced} item${personal.itemsSourced === 1 ? "" : "s"} here with no profit booked yet`;
  }
  if (personal.visits > 0) {
    return `you have been ${personal.visits} time${personal.visits === 1 ? "" : "s"} without buying`;
  }
  return null;
}

// ── Maps hand-off ───────────────────────────────────────────────────────────
//
// The circuit leaves for a maps app and nowhere else. Both builders round to five
// decimal places — a metre, which is more than a cell-centre centroid can honestly
// claim and enough for a driver to be routed to the right car park.

function coord(point: LatLng): string {
  return `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;
}

/**
 * Google Maps directions, origin → waypoints → destination.
 *
 * Nine intermediate waypoints is the documented URL limit, which is why
 * {@link MAX_ROUTE_STOPS} is what it is.
 */
export function googleMapsRouteUrl(
  start: LatLng,
  stops: readonly LatLng[],
): string | null {
  const destination = stops[stops.length - 1];
  if (!destination) return null;
  const waypoints = stops.slice(0, -1);
  const params = new URLSearchParams({
    api: "1",
    origin: coord(start),
    destination: coord(destination),
    travelmode: "driving",
  });
  if (waypoints.length > 0) {
    params.set("waypoints", waypoints.map(coord).join("|"));
  }
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/**
 * Apple Maps, which chains stops with `+to:` rather than a waypoint list.
 *
 * `URLSearchParams` would percent-encode the `+` separators into something Maps
 * does not parse, so the query is assembled by hand from values that are only
 * ever numbers.
 */
export function appleMapsRouteUrl(
  start: LatLng,
  stops: readonly LatLng[],
): string | null {
  if (stops.length === 0) return null;
  const daddr = stops.map(coord).join("+to:");
  return `https://maps.apple.com/?saddr=${coord(start)}&daddr=${daddr}&dirflg=d`;
}

/** True on a device whose native maps app is Apple Maps. */
export function prefersAppleMaps(userAgent: string | undefined): boolean {
  if (!userAgent) return false;
  return /iPhone|iPad|iPod|Macintosh/i.test(userAgent);
}
