// US-1861: the IMPURE half of Thrift Radar contribution — consent, config, and
// the insert. The transforms that make an event non-identifying are in
// `radar-privacy.ts` and are unit-tested there without a database.
//
// Two properties this module exists to guarantee:
//
//   • FIRE-AND-FORGET (rule 8). `recordScanLocation` never throws and is never
//     awaited by the scan handler. Radar is a by-product; the scan result is the
//     product, and a Radar write that fails, times out, or is rate-limited must
//     not be something the reseller standing in the aisle can feel.
//   • CONSENT BEFORE COLLECTION (rules 2 and 3). The per-user check is
//     `users.radar_contribute` — a toggle that exists only for this, defaults to
//     false, and is read fresh on every scan so a revocation takes effect on the
//     next one. `radar_privacy.contribution_enabled` is the deployment-wide
//     kill-switch above it.
//
// US-1864 added a SECOND write on the same coordinate, with a deliberately
// different gate: the reseller's own visit history (rule 7 — free, plan- and
// consent-independent, useful at n=1). Both writes live in `recordScanLocation`
// so the fix is resolved once and its life stays inside one function.
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
import { matchScanVenue, resolveScanVenue } from "./radar-venue-registry.ts";
import { insertPersonalScan } from "./radar-personal-history.ts";
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

/** What a located scan actually wrote. Both halves are independent. */
export interface RadarScanLocationOutcome {
  /** A row in the reseller's OWN visit history (US-1864). Needs no consent. */
  personal: boolean;
  /** A row in the shared, de-identified event store. Needs consent. */
  contributed: boolean;
}

/**
 * Record everything one located scan produces: the reseller's own visit, and —
 * only with consent — the anonymous contribution to the shared map.
 *
 * ONE function, because there is one coordinate and its whole life belongs in
 * one place. It arrives as an argument, it picks a cell and a venue, and it is
 * gone; neither row that comes out has a field it could have landed in. Splitting
 * this across two call sites would mean two functions holding rule 4, and a rule
 * held in two places is held by whoever last remembered it.
 *
 * The two halves have DIFFERENT gates, and that asymmetry is the story:
 *
 *   • The PERSONAL row is the user's own sourcing history. It is free, available
 *     on every plan, and gated on nothing but a usable fix (rule 7) — a person
 *     does not need permission to be told where they have been.
 *   • The CONTRIBUTION is gated on the deployment kill-switch AND
 *     `users.radar_contribute`, read fresh so a revocation lands on the next scan.
 *   • VENUE RESOLUTION follows the contribution gate, not the personal one. A
 *     contributor's scan may create a candidate venue and advance the count that
 *     confirms it; a non-contributor's may only RECOGNISE a place the map already
 *     knows (`matchScanVenue`). Minting a shared row off a non-contributor's
 *     coordinate would be the widening rule 3 refuses, however coarse the row is.
 *
 * Never throws. Call it WITHOUT awaiting — see `voidRecordScanLocation`.
 */
export async function recordScanLocation(
  input: RadarEmitInput,
): Promise<RadarScanLocationOutcome> {
  const outcome: RadarScanLocationOutcome = {
    personal: false,
    contributed: false,
  };
  try {
    const config = await radarPrivacyConfig();
    const cell = coarseCell(input.lat, input.lng, config.geohash_precision);
    // No usable cell means no locatable scan. Neither row may be invented from a
    // fix we could not place — a wrong location is worse than none.
    if (!cell) return outcome;

    const mayContribute = config.contribution_enabled !== false &&
      await hasRadarConsent(input.accountId);

    const fix = { lat: input.lat, lng: input.lng };
    const venueId = mayContribute
      ? await resolveScanVenue(fix, cell)
      : await matchScanVenue(fix, cell);

    const gradeBand = bandForGrade(input.grade) as RadarGradeBand;
    const at = new Date();

    // US-1864: the personal visit. Written first because it is the one the user
    // is entitled to regardless of what else happens below.
    outcome.personal = await insertPersonalScan({
      accountId: input.accountId,
      venueId,
      cell,
      brand: input.brand,
      category: input.category,
      gradeBand,
      verdict: input.verdict,
      at,
    });

    if (!mayContribute) return outcome;

    const salt = Deno.env.get("RADAR_CONTRIBUTOR_SALT") ??
      Deno.env.get("PASSPORT_LINKAGE_SALT") ?? "";

    const row = await buildRadarEventRow({
      accountId: input.accountId,
      lat: input.lat,
      lng: input.lng,
      brand: input.brand,
      category: input.category,
      gradeBand,
      verdict: input.verdict,
      at,
      salt,
      precision: config.geohash_precision,
      rotationDays: config.key_rotation_days,
      venueId,
    });
    if (!row) return outcome;

    const { error } = await supabaseAdmin
      .from("radar_scan_events")
      .insert(row as never);
    if (error) {
      // Warn, not error: a dropped contribution is a data-completeness problem,
      // never a user-facing one.
      captureException(error, { level: "warn", route: "radar.emit" });
      return outcome;
    }
    outcome.contributed = true;
    return outcome;
  } catch (err) {
    captureException(err, { level: "warn", route: "radar.emit" });
    return outcome;
  }
}

/**
 * Fire-and-forget wrapper. Starts the writes and returns immediately, swallowing
 * any rejection so an unhandled promise can never take the process down.
 *
 * Route code calls THIS, before returning its response, and never awaits it.
 */
export function voidRecordScanLocation(input: RadarEmitInput): void {
  void recordScanLocation(input).catch(() => {});
}
