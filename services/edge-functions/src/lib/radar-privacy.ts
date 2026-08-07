// US-1861: the PURE half of Thrift Radar's privacy model — geohash coarsening,
// contributor-key rotation, and the shape of a contribution row.
//
// Nothing here touches Supabase or the environment, which is the point: these
// are the three transforms that make a Radar event non-identifying, so they must
// be unit-testable directly rather than only through a route. The impure half
// (consent read, config read, insert) lives in `radar-events.ts`.
//
// Rules this file implements — full text in vault/20-domain/thrift-radar.md:
//   • Rule 4 — no precise coordinate survives venue resolution. A coordinate
//     enters `coarseCell()` and a short cell string comes out; the caller keeps
//     the cell and drops the fix.
//   • Rule 5 — the contributor key is rotating and de-identified. It is a salted
//     digest of (epoch, account), so contributions can be COUNTED as distinct
//     inside a window without being re-joined to a person across windows.

import { minimizeLinkageRef } from "./garment-passport.ts";

/** Standard geohash base32 alphabet (no a, i, l, o). */
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/**
 * Widest cell we will ever store. The DB CHECK on `radar_scan_events.geohash`
 * enforces the same bound, so this constant and the schema agree by design
 * rather than by convention.
 */
export const MIN_GEOHASH_PRECISION = 4;
/**
 * Tightest cell we will ever store (~150 m). The configured default is 6
 * (~1.2 km x 0.6 km) — a thrift-store block, not a doorstep.
 */
export const MAX_GEOHASH_PRECISION = 7;
export const DEFAULT_GEOHASH_PRECISION = 6;

/** Days a contributor digest stays stable before it rotates. */
export const DEFAULT_KEY_ROTATION_DAYS = 7;

const MS_PER_DAY = 86_400_000;

/** Clamp a configured precision into the range the schema will actually accept. */
export function clampPrecision(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw)
    ? Math.round(raw)
    : DEFAULT_GEOHASH_PRECISION;
  return Math.min(MAX_GEOHASH_PRECISION, Math.max(MIN_GEOHASH_PRECISION, n));
}

/**
 * Encode a coordinate as a geohash cell of `precision` characters.
 *
 * This is the ONLY thing a raw coordinate is used for. Returns null for a fix
 * that is out of range or not finite — an unusable coordinate must produce no
 * contribution rather than a wrong one.
 */
export function coarseCell(
  lat: number,
  lng: number,
  precision: number = DEFAULT_GEOHASH_PRECISION,
): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  const chars = clampPrecision(precision);
  let latRange: [number, number] = [-90, 90];
  let lngRange: [number, number] = [-180, 180];
  let isLng = true;
  let bit = 0;
  let value = 0;
  let out = "";

  while (out.length < chars) {
    if (isLng) {
      const mid = (lngRange[0] + lngRange[1]) / 2;
      if (lng >= mid) {
        value = (value << 1) + 1;
        lngRange = [mid, lngRange[1]];
      } else {
        value = value << 1;
        lngRange = [lngRange[0], mid];
      }
    } else {
      const mid = (latRange[0] + latRange[1]) / 2;
      if (lat >= mid) {
        value = (value << 1) + 1;
        latRange = [mid, latRange[1]];
      } else {
        value = value << 1;
        latRange = [latRange[0], mid];
      }
    }
    isLng = !isLng;
    if (++bit === 5) {
      out += BASE32[value];
      bit = 0;
      value = 0;
    }
  }
  return out;
}

/**
 * Which rotation window a timestamp falls in: whole `rotationDays` periods since
 * the Unix epoch. An integer so it stores as one column and sorts.
 */
export function contributorEpoch(
  at: Date,
  rotationDays: number = DEFAULT_KEY_ROTATION_DAYS,
): number {
  const days = rotationDays > 0 ? Math.round(rotationDays) : DEFAULT_KEY_ROTATION_DAYS;
  return Math.floor(at.getTime() / (MS_PER_DAY * days));
}

/**
 * The de-identified, rotating contributor digest.
 *
 * Salted SHA-256 of `<epoch>:<account>` — the epoch is INSIDE the digest, so the
 * same person hashes to an unrelated value in the next window. The salt is a
 * deployment secret, so the digest is not rainbow-tableable back to an account
 * id even by someone holding the table.
 */
export async function contributorKey(
  accountId: string,
  epoch: number,
  salt: string,
): Promise<string> {
  return await minimizeLinkageRef(`${epoch}:${accountId}`, salt);
}

/** Buy/pass verdicts a contribution may carry (mirrors BuyRecommendation). */
export type RadarVerdict = "buy" | "maybe" | "skip" | "unknown";
/** Condition bands a contribution may carry (mirrors bandForGrade). */
export type RadarGradeBand = "high" | "mid" | "low" | "ungraded";

export interface RadarEventInput {
  accountId: string;
  /** Raw fix. Used to derive the cell and then dropped by the caller. */
  lat: number;
  lng: number;
  brand: string | null;
  category: string | null;
  gradeBand: RadarGradeBand;
  verdict: RadarVerdict;
  at: Date;
  salt: string;
  precision?: number;
  rotationDays?: number;
}

/** The row shape written to `radar_scan_events`. Note what is absent. */
export interface RadarEventRow {
  contributor_key: string;
  key_epoch: number;
  geohash: string;
  brand: string | null;
  category: string | null;
  grade_band: RadarGradeBand;
  verdict: RadarVerdict;
  scanned_at: string;
}

/**
 * Build the row a contribution becomes. Returns null when the fix is unusable —
 * an event with no location is not a Radar observation, and inventing one would
 * be worse than dropping it.
 *
 * The returned object is the WHOLE row: there is no coordinate field to forget
 * to strip, and no account field to forget to hash.
 */
export async function buildRadarEventRow(
  input: RadarEventInput,
): Promise<RadarEventRow | null> {
  const cell = coarseCell(input.lat, input.lng, input.precision ?? DEFAULT_GEOHASH_PRECISION);
  if (!cell) return null;
  const epoch = contributorEpoch(input.at, input.rotationDays ?? DEFAULT_KEY_ROTATION_DAYS);
  return {
    contributor_key: await contributorKey(input.accountId, epoch, input.salt),
    key_epoch: epoch,
    geohash: cell,
    brand: input.brand?.trim() ? input.brand.trim().slice(0, 120) : null,
    category: input.category?.trim() ? input.category.trim().slice(0, 120) : null,
    grade_band: input.gradeBand,
    verdict: input.verdict,
    scanned_at: input.at.toISOString(),
  };
}

/**
 * Parse a coordinate pair off a request body. Both must be present and valid —
 * a half-supplied fix is a client bug, and guessing at it would attach a scan to
 * the wrong place.
 */
export function parseFix(
  lat: unknown,
  lng: unknown,
): { lat: number; lng: number } | null {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  // A literal 0,0 is Null Island — an uninitialised struct far more often than a
  // real thrift store in the Gulf of Guinea.
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}
