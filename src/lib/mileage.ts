import { supabase } from "@/lib/supabase";

// US-2989 — the mileage log.
//
// The valuation lives in the database (migration 00695): the rate is looked up
// by trip DATE from a dated table, so a mid-year change is expressible and last
// year cannot silently reprice.
//
// THE UNIT IS TENTHS OF A CENT. 58.5 cents a mile is 585. An integer `cents`
// column cannot hold most of the rates the IRS has actually published, and
// putting 585 in a field called cents means five dollars eighty-five a mile.
// The name carries the unit everywhere it appears.

export interface MileageTrip {
  id: string;
  trip_date: string;
  miles: number;
  purpose: string;
  start_location: string | null;
  end_location: string | null;
  round_trip: boolean;
  source_id: string | null;
  inventory_item_id: string | null;
}

export interface MileageRate {
  tenths_of_cent_per_mile: number;
  is_provisional: boolean;
  note: string;
  effective_from: string;
}

export interface MileageSummary {
  from: string;
  to: string;
  trip_count: number;
  total_miles: number;
  deduction_cents: number;
  /** Trips whose date falls outside every published rate. They deduct nothing. */
  trips_without_a_rate: number;
  trips_on_a_provisional_rate: number;
  miles_on_a_provisional_rate: number;
}

export interface VehicleUseYear {
  id?: string;
  tax_year: number;
  method: "standard" | "actual";
  total_miles: number | null;
  commuting_miles: number | null;
  other_personal_miles: number | null;
  placed_in_service_on: string | null;
}

type Rpc = {
  rpc: ((
    fn: "mileage_summary",
    args: { p_from: string; p_to: string },
  ) => Promise<{ data: MileageSummary | null; error: { message: string } | null }>) &
    ((
      fn: "mileage_rate_on",
      args: { p_date: string },
    ) => Promise<{ data: MileageRate | null; error: { message: string } | null }>);
};

export async function fetchMileageSummary(
  from: string,
  to: string,
): Promise<MileageSummary> {
  const client = supabase as unknown as Rpc;
  const { data, error } = await client.rpc("mileage_summary", {
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No mileage summary returned");
  return data;
}

/** The rate in force on a date, or null when none is published for it. */
export async function fetchRateOn(date: string): Promise<MileageRate | null> {
  const client = supabase as unknown as Rpc;
  const { data, error } = await client.rpc("mileage_rate_on", { p_date: date });
  if (error) throw new Error(error.message);
  return data;
}

export async function fetchTrips(
  from: string,
  to: string,
): Promise<MileageTrip[]> {
  const { data, error } = await supabase
    .from("mileage_trips")
    .select(
      "id, trip_date, miles, purpose, start_location, end_location, round_trip, source_id, inventory_item_id",
    )
    .gte("trip_date", from)
    .lt("trip_date", to)
    .order("trip_date", { ascending: false });
  if (error) throw error;
  return (data ?? []) as MileageTrip[];
}

export async function saveTrip(
  userId: string,
  trip: Omit<MileageTrip, "id"> & { id?: string },
): Promise<void> {
  const { error } = await supabase
    .from("mileage_trips")
    .upsert({ user_id: userId, ...trip } as never);
  if (error) throw error;
}

export async function deleteTrip(id: string): Promise<void> {
  const { error } = await supabase.from("mileage_trips").delete().eq("id", id);
  if (error) throw error;
}

export async function fetchVehicleYear(
  taxYear: number,
): Promise<VehicleUseYear | null> {
  const { data, error } = await supabase
    .from("vehicle_use_years")
    .select(
      "id, tax_year, method, total_miles, commuting_miles, other_personal_miles, placed_in_service_on",
    )
    .eq("tax_year", taxYear)
    .maybeSingle();
  if (error) throw error;
  return (data as VehicleUseYear | null) ?? null;
}

export async function saveVehicleYear(
  userId: string,
  year: VehicleUseYear,
): Promise<void> {
  const { error } = await supabase
    .from("vehicle_use_years")
    .upsert({ user_id: userId, ...year } as never, {
      onConflict: "user_id,tax_year",
    });
  if (error) throw error;
}

// ── Pure helpers ───────────────────────────────────────────────────────────

/**
 * One trip's deduction, in whole cents.
 *
 * ROUNDS PER TRIP, matching the ledger, which writes one entry per trip. The
 * summary rounds the same way for the same reason: two 10.4-mile trips at 58.5
 * cents are 608.4 cents each, and rounding once on the total gives 1217 where
 * the ledger gives 1216. A seller who finds two of our screens a cent apart
 * stops believing both.
 */
export function tripDeductionCents(
  miles: number,
  tenthsOfCentPerMile: number,
): number {
  return Math.round((miles * tenthsOfCentPerMile) / 10);
}

/** "70.0 cents a mile", from the stored tenths. */
export function formatRate(tenthsOfCentPerMile: number): string {
  return `${(tenthsOfCentPerMile / 10).toFixed(1)} cents a mile`;
}

export type MileageWarning =
  | { kind: "no_rate"; count: number; text: string }
  | { kind: "provisional"; count: number; miles: number; text: string };

/**
 * What the screen has to disclose about a total before anyone files on it.
 *
 * Both of these are things a seller cannot see in the number itself, and both
 * change what they should do next -- which is the test for whether a warning
 * earns its place.
 */
export function mileageWarnings(s: MileageSummary): MileageWarning[] {
  const out: MileageWarning[] = [];
  if (s.trips_without_a_rate > 0) {
    out.push({
      kind: "no_rate",
      count: s.trips_without_a_rate,
      text:
        `${s.trips_without_a_rate} trip${s.trips_without_a_rate === 1 ? "" : "s"} ` +
        "fall outside every rate we hold, so they add nothing to this total. " +
        "We would rather show you nothing than guess a rate.",
    });
  }
  if (s.trips_on_a_provisional_rate > 0) {
    out.push({
      kind: "provisional",
      count: s.trips_on_a_provisional_rate,
      miles: s.miles_on_a_provisional_rate,
      text:
        `${s.miles_on_a_provisional_rate} mile${s.miles_on_a_provisional_rate === 1 ? "" : "s"} ` +
        "are valued at a rate we carried forward because the IRS had not " +
        "published one yet. Check the published rate before you file.",
    });
  }
  return out;
}

/**
 * Schedule C Part IV, as the four things the form asks for.
 *
 * Business miles come from the log. The other three cannot be derived from it
 * -- only the seller knows how far they drove in total, or to a job, or for
 * themselves -- so a missing one is reported as missing rather than as zero.
 * Zero commuting miles is a real answer and a blank is not the same thing.
 */
export interface PartIvRow {
  line: string;
  label: string;
  value: number | null;
  derived: boolean;
}

export function partIvRows(
  s: MileageSummary,
  year: VehicleUseYear | null,
): PartIvRow[] {
  return [
    {
      line: "44a",
      label: "Business miles",
      value: s.total_miles,
      derived: true,
    },
    {
      line: "44b",
      label: "Commuting miles",
      value: year?.commuting_miles ?? null,
      derived: false,
    },
    {
      line: "44c",
      label: "Other personal miles",
      value: year?.other_personal_miles ?? null,
      derived: false,
    },
    {
      line: "—",
      label: "Total miles driven this year",
      value: year?.total_miles ?? null,
      derived: false,
    },
  ];
}

/**
 * Whether the seller's own figures are internally consistent.
 *
 * Business plus commuting plus personal cannot exceed the total they drove. If
 * it does, one of the numbers is wrong, and saying so is more useful than
 * printing four figures that contradict each other onto a form.
 */
export function partIvConflict(
  s: MileageSummary,
  year: VehicleUseYear | null,
): string | null {
  if (!year?.total_miles) return null;
  const parts =
    s.total_miles +
    (year.commuting_miles ?? 0) +
    (year.other_personal_miles ?? 0);
  if (parts > year.total_miles) {
    const over = Math.round((parts - year.total_miles) * 10) / 10;
    return (
      `Your business, commuting and personal miles add up to ${parts.toFixed(1)}, ` +
      `which is ${over.toFixed(1)} more than the ${year.total_miles.toFixed(1)} ` +
      "you say you drove in total. One of these is wrong."
    );
  }
  return null;
}
