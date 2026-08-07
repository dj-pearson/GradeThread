// US-1861: the IMPURE half of Thrift Radar contribution — consent, config, and
// the insert. The transforms that make an event non-identifying are in
// `radar-privacy.ts` and are unit-tested there without a database.
//
// Two properties this module exists to guarantee:
//
//   • FIRE-AND-FORGET (rule 8). `emitRadarScanEvent` never throws and is never
//     awaited by the scan handler. Radar is a by-product; the scan result is the
//     product, and a Radar write that fails, times out, or is rate-limited must
//     not be something the reseller standing in the aisle can feel.
//   • CONSENT BEFORE COLLECTION (rules 2 and 3). The per-user check is
//     `users.radar_contribute` — a toggle that exists only for this, defaults to
//     false, and is read fresh on every scan so a revocation takes effect on the
//     next one. `radar_privacy.contribution_enabled` is the deployment-wide
//     kill-switch above it.
//
// The raw fix reaches this module and leaves it as a geohash cell. It is not
// logged, not returned, and has no column to land in.

import { supabaseAdmin } from "./supabase.ts";
import { getSetting } from "./system-settings.ts";
import { bandForGrade } from "./resale-condition.ts";
import {
  buildRadarEventRow,
  coarseCell,
  DEFAULT_GEOHASH_PRECISION,
  DEFAULT_KEY_ROTATION_DAYS,
  type RadarGradeBand,
  type RadarVerdict,
} from "./radar-privacy.ts";
import { resolveScanVenue } from "./radar-venue-registry.ts";
import { captureException } from "./observability.ts";

export interface RadarPrivacyConfig {
  contribution_enabled: boolean;
  geohash_precision: number;
  key_rotation_days: number;
  k_anonymity_floor: number;
  raw_event_retention_days: number;
}

export const RADAR_PRIVACY_DEFAULTS: RadarPrivacyConfig = {
  contribution_enabled: true,
  geohash_precision: DEFAULT_GEOHASH_PRECISION,
  key_rotation_days: DEFAULT_KEY_ROTATION_DAYS,
  k_anonymity_floor: 3,
  raw_event_retention_days: 180,
};

export function radarPrivacyConfig(): Promise<RadarPrivacyConfig> {
  return getSetting<RadarPrivacyConfig>("radar_privacy", RADAR_PRIVACY_DEFAULTS);
}

/**
 * True when this account has opted in to contributing. Reads the ONE column that
 * means this and nothing else; a read failure is treated as "no consent",
 * because the failure mode of guessing wrong here is publishing someone's
 * whereabouts.
 */
export async function hasRadarConsent(accountId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("radar_contribute")
    .eq("id", accountId)
    .maybeSingle();
  if (error || !data) return false;
  return (data as { radar_contribute?: boolean }).radar_contribute === true;
}

export interface RadarEmitInput {
  /** The workspace owner the scan is billed to — hashed, never stored. */
  accountId: string;
  /** The fix the client sent. Used to derive a cell, then dropped. */
  lat: number;
  lng: number;
  brand: string | null;
  category: string | null;
  /** Estimated overall grade, or null when grading was skipped/failed. */
  grade: number | null;
  verdict: RadarVerdict;
}

/**
 * Record one contribution. Resolves to true only when a row was actually
 * written; every other outcome (kill-switch off, no consent, unusable fix, DB
 * error) resolves false and is invisible to the caller's response.
 *
 * Call this WITHOUT awaiting — see `voidEmitRadarScanEvent` below, which is what
 * route code should use.
 */
export async function emitRadarScanEvent(input: RadarEmitInput): Promise<boolean> {
  try {
    const config = await radarPrivacyConfig();
    if (config.contribution_enabled === false) return false;
    if (!(await hasRadarConsent(input.accountId))) return false;

    const salt = Deno.env.get("RADAR_CONTRIBUTOR_SALT") ??
      Deno.env.get("PASSPORT_LINKAGE_SALT") ?? "";

    // US-1862: resolve the fix to a named venue BEFORE the row is built, so the
    // coordinate's whole life is contained in this function. It arrives as an
    // argument, it picks a cell and a venue, and it is gone — the row that comes
    // out of buildRadarEventRow has no field it could have landed in.
    //
    // A failure here is not a failure of the contribution: resolveScanVenue
    // returns null and the event keeps its cell, which is the state the
    // `radar_scan_events_located` CHECK was written to allow.
    const cell = coarseCell(input.lat, input.lng, config.geohash_precision);
    const venueId = cell
      ? await resolveScanVenue({ lat: input.lat, lng: input.lng }, cell)
      : null;

    const row = await buildRadarEventRow({
      accountId: input.accountId,
      lat: input.lat,
      lng: input.lng,
      brand: input.brand,
      category: input.category,
      gradeBand: bandForGrade(input.grade) as RadarGradeBand,
      verdict: input.verdict,
      at: new Date(),
      salt,
      precision: config.geohash_precision,
      rotationDays: config.key_rotation_days,
      venueId,
    });
    if (!row) return false;

    const { error } = await supabaseAdmin
      .from("radar_scan_events")
      .insert(row as never);
    if (error) {
      // Warn, not error: a dropped contribution is a data-completeness problem,
      // never a user-facing one.
      captureException(error, { level: "warn", route: "radar.emit" });
      return false;
    }
    return true;
  } catch (err) {
    captureException(err, { level: "warn", route: "radar.emit" });
    return false;
  }
}

/**
 * Fire-and-forget wrapper. Starts the write and returns immediately, swallowing
 * any rejection so an unhandled promise can never take the process down.
 *
 * Route code calls THIS, before returning its response, and never awaits it.
 */
export function voidEmitRadarScanEvent(input: RadarEmitInput): void {
  void emitRadarScanEvent(input).catch(() => {});
}
