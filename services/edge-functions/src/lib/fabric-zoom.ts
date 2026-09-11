// US-3338: a light zoom pass on the fabric close-up, for every grade.
//
// The vision API downscales a phone photo to about 1568 px on its long edge, so
// a 4032 x 3024 fabric close-up reaches the model at under 40% of its pixels,
// and pinholes and early pilling vanish. The paid Forensic add-on already
// re-reads small DEFECTS at high resolution (runDefectZoomPass), but only the
// ones the first pass found, and only for customers who bought it. This reads
// the ONE fabric close-up again at close to native resolution, as a grid of at
// most FABRIC_ZOOM_MAX_TILES tiles, and merges what the tiles see through the
// existing zoom-merge path (mergeZoomIntoIssue).
//
// Rules, in the order they bite:
//   - Off unless GRADING_FABRIC_ZOOM is on. A found flaw moves the defect
//     weighting and so the grade: it ships dark and turns on as a decision.
//   - Never on a Forensic grade. Forensic keeps exactly its own zoom path; this
//     is the light pass for everyone else.
//   - A daily spend cap (GRADING_FABRIC_ZOOM_DAILY_CAP_USD, overridable by the
//     system setting of the same name in lower case). Checked once per grade
//     against today's metered spend on this phase; at or over the cap the pass
//     is skipped and the grade proceeds exactly as it would with the flag off.
//   - A tile issue that lands on a flaw the first pass already found REFINES it
//     (mergeZoomIntoIssue). A new one is added only when it is small
//     (pinhole or small, the point of the pass), genuine and localized, and at
//     most FABRIC_ZOOM_MAX_NEW per grade.
//   - Any failure leaves the first-pass read untouched. A zoom never fails a
//     paid grade.
//
// Every per-image read the pass touched is stamped "+fabriczoom", and its
// tile calls are metered on their own ai_usage_events phase.

import { Image } from "imagescript";
import {
  type DetectedIssue,
  mergeZoomIntoIssue,
  type PerImageAnalysis,
} from "./ai-grading.ts";
import type { AiTokenUsage } from "./ai-usage.ts";
import { uint8ToBase64 } from "./grading-image-encoding.ts";
import { supabaseAdmin } from "./supabase.ts";
import { getSetting } from "./system-settings.ts";

export const FABRIC_ZOOM_FLAG = "GRADING_FABRIC_ZOOM";
export const FABRIC_ZOOM_CAP_ENV = "GRADING_FABRIC_ZOOM_DAILY_CAP_USD";
export const FABRIC_ZOOM_CAP_SETTING = "grading_fabric_zoom_daily_cap_usd";
export const FABRIC_ZOOM_DEFAULT_CAP_USD = 5;
export const FABRIC_ZOOM_PHASE = "per_image_fabric_zoom";
export const FABRIC_ZOOM_MAX_TILES = 4;
/** The long edge the vision API keeps without downscaling. */
export const FABRIC_ZOOM_TILE_EDGE = 1568;
export const FABRIC_ZOOM_MAX_NEW = 5;
export const FABRIC_ZOOM_SUFFIX = "+fabriczoom";

export function fabricZoomEnabled(): boolean {
  const v = (Deno.env.get(FABRIC_ZOOM_FLAG) ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/** The env default for the daily cap; a bad value falls back, never to "no cap". */
export function fabricZoomEnvCap(): number {
  const n = Number.parseFloat(Deno.env.get(FABRIC_ZOOM_CAP_ENV) ?? "");
  return Number.isFinite(n) && n >= 0 ? n : FABRIC_ZOOM_DEFAULT_CAP_USD;
}

/** Pure: may the pass run for this grade? */
export function fabricZoomDecision(input: {
  enabled: boolean;
  forensic: boolean;
  spentTodayUsd: number;
  capUsd: number;
  hasCloseup: boolean;
}): { run: boolean; reason: string } {
  if (!input.enabled) return { run: false, reason: "flag off" };
  if (input.forensic) return { run: false, reason: "forensic grade uses its own zoom" };
  if (!input.hasCloseup) return { run: false, reason: "no fabric close-up" };
  if (!(input.capUsd > 0) || input.spentTodayUsd >= input.capUsd) {
    return { run: false, reason: `daily cap reached (${input.spentTodayUsd.toFixed(2)} of ${input.capUsd.toFixed(2)} USD)` };
  }
  return { run: true, reason: "ok" };
}

export interface CloseupRow {
  image_type: string;
  image_role?: string | null;
  storage_path: string;
  original_storage_path?: string | null;
}

/**
 * Pure: the fabric close-up. A slot the seller marked detail:fabric wins; else
 * the first detail shot. Only one image is ever re-read.
 */
export function pickFabricCloseup<T extends CloseupRow>(images: readonly T[]): T | null {
  const isDetail = (t: string) => t === "detail" || t.startsWith("detail_");
  return images.find((i) => isDetail(i.image_type) && i.image_role === "detail:fabric") ??
    images.find((i) => isDetail(i.image_type)) ??
    null;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Pure: split a W x H image into the fewest tiles whose long edge fits
 * FABRIC_ZOOM_TILE_EDGE, capped at FABRIC_ZOOM_MAX_TILES (past the cap tiles
 * grow and the API downscales them a little, still far less than the whole).
 */
export function tileRects(
  W: number,
  H: number,
  edge = FABRIC_ZOOM_TILE_EDGE,
  maxTiles = FABRIC_ZOOM_MAX_TILES,
): Rect[] {
  if (!(W > 0 && H > 0)) return [];
  let cols = Math.max(1, Math.ceil(W / edge));
  let rows = Math.max(1, Math.ceil(H / edge));
  while (cols * rows > maxTiles) {
    // Shrink along the axis whose tiles are currently smallest.
    if (W / cols <= H / rows && cols > 1) cols--;
    else if (rows > 1) rows--;
    else cols--;
  }
  const out: Rect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = Math.round((c * W) / cols);
      const y = Math.round((r * H) / rows);
      out.push({
        x,
        y,
        w: Math.round(((c + 1) * W) / cols) - x,
        h: Math.round(((r + 1) * H) / rows) - y,
      });
    }
  }
  return out;
}

/** Pure: a tile-normalized bbox, in whole-image normalized coordinates. */
export function mapTileBbox(
  bbox: [number, number, number, number],
  tile: Rect,
  W: number,
  H: number,
): [number, number, number, number] {
  const [x, y, w, h] = bbox;
  const r4 = (n: number) => Math.round(n * 10000) / 10000;
  return [
    r4((tile.x + x * tile.w) / W),
    r4((tile.y + y * tile.h) / H),
    r4((w * tile.w) / W),
    r4((h * tile.h) / H),
  ];
}

function overlaps(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  // Center of either inside the other, each box grown by a quarter.
  const grow = (r: [number, number, number, number]) => {
    const [x, y, w, h] = r;
    return [x - w / 4, y - h / 4, w * 1.5, h * 1.5] as const;
  };
  const inside = (p: [number, number], r: readonly number[]) =>
    p[0] >= r[0] && p[0] <= r[0] + r[2] && p[1] >= r[1] && p[1] <= r[1] + r[3];
  const center = (r: [number, number, number, number]): [number, number] => [r[0] + r[2] / 2, r[1] + r[3] / 2];
  return inside(center(a), grow(b)) || inside(center(b), grow(a));
}

export type FabricZoomIssue = DetectedIssue & { found_by?: "fabric_zoom" };

export interface TileRead {
  tile: Rect;
  read: PerImageAnalysis;
}

/**
 * Pure: fold the tile reads into the close-up's first-pass analysis. Existing
 * flaws are refined through mergeZoomIntoIssue; new small flaws are added, up
 * to `maxNew`. The analysis is stamped "+fabriczoom" when any tile was read.
 */
export function mergeFabricZoom(
  target: PerImageAnalysis,
  tiles: readonly TileRead[],
  W: number,
  H: number,
  maxNew = FABRIC_ZOOM_MAX_NEW,
): PerImageAnalysis {
  if (tiles.length === 0) return target;
  const issues: FabricZoomIssue[] = target.detected_issues.map((d) => ({ ...d }));
  let added = 0;
  for (const { tile, read } of tiles) {
    for (const found of read.detected_issues) {
      if (found.is_intentional || !found.bbox) continue;
      const bbox = mapTileBbox(found.bbox, tile, W, H);
      const hit = issues.findIndex((d) => !d.is_intentional && !!d.bbox && overlaps(d.bbox, bbox));
      if (hit >= 0) {
        issues[hit] = mergeZoomIntoIssue(issues[hit], { ...read, detected_issues: [found] });
        continue;
      }
      const small = found.size_bucket === "pinhole" || found.size_bucket === "small";
      if (!small || added >= maxNew) continue;
      issues.push({ ...found, bbox, zoom_refined: true, found_by: "fabric_zoom" });
      added++;
    }
  }
  return {
    ...target,
    detected_issues: issues,
    prompt_version: `${target.prompt_version ?? ""}${FABRIC_ZOOM_SUFFIX}`,
  };
}

/** Pure: today's spend on this phase from ai_usage_events cost rows. */
export function sumSpend(rows: ReadonlyArray<{ cost_usd: number | string | null }>): number {
  return rows.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
}

/** The daily cap: the system setting when present, else the env default. */
export async function fabricZoomCapUsd(): Promise<number> {
  const v = Number(await getSetting<number | string>(FABRIC_ZOOM_CAP_SETTING, fabricZoomEnvCap()));
  return Number.isFinite(v) && v >= 0 ? v : fabricZoomEnvCap();
}

/**
 * Today's (UTC) metered spend on this phase. Fails CLOSED: if the spend cannot
 * be read it reports infinity, so an unreadable ledger skips the pass rather
 * than spending blind.
 */
export async function fabricZoomSpentTodayUsd(now = new Date()): Promise<number> {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const { data, error } = await supabaseAdmin
    .from("ai_usage_events")
    .select("cost_usd")
    .eq("phase", FABRIC_ZOOM_PHASE)
    .gte("created_at", midnight.toISOString())
    .limit(20000);
  if (error) return Number.POSITIVE_INFINITY;
  return sumSpend((data ?? []) as Array<{ cost_usd: number | string | null }>);
}

/** Download a submission image's bytes, or null. */
export async function downloadSubmissionBytes(path: string): Promise<Uint8Array | null> {
  const { data, error } = await supabaseAdmin.storage.from("submission-images").download(path);
  return error || !data ? null : new Uint8Array(await data.arrayBuffer());
}

export interface FabricZoomDeps {
  download: (path: string) => Promise<Uint8Array | null>;
  analyze: (dataUri: string) => Promise<PerImageAnalysis>;
}

/**
 * Re-read the close-up as tiles and merge. Returns the updated results and the
 * tile calls' usages for metering. Never throws.
 */
export async function runFabricZoomPass(
  results: PerImageAnalysis[],
  closeup: CloseupRow,
  deps: FabricZoomDeps,
): Promise<{ results: PerImageAnalysis[]; usages: AiTokenUsage[]; tiles: number }> {
  const idx = results.findIndex((r) => r.image_type === closeup.image_type);
  if (idx < 0) return { results, usages: [], tiles: 0 };
  try {
    const bytes = await deps.download(closeup.original_storage_path || closeup.storage_path);
    if (!bytes) return { results, usages: [], tiles: 0 };
    const img = (await Image.decode(bytes)) as Image;
    const W = img.width;
    const H = img.height;
    const reads: TileRead[] = [];
    const usages: AiTokenUsage[] = [];
    for (const tile of tileRects(W, H)) {
      try {
        const crop = img.clone().crop(tile.x, tile.y, tile.w, tile.h);
        const long = Math.max(crop.width, crop.height);
        if (long > FABRIC_ZOOM_TILE_EDGE) {
          const s = FABRIC_ZOOM_TILE_EDGE / long;
          crop.resize(Math.max(1, Math.round(crop.width * s)), Math.max(1, Math.round(crop.height * s)));
        }
        const jpeg = await crop.encodeJPEG(92);
        const read = await deps.analyze(`data:image/jpeg;base64,${uint8ToBase64(jpeg)}`);
        reads.push({ tile, read });
        if (read.usage) usages.push(read.usage);
      } catch {
        // One tile failing drops that tile only.
      }
    }
    if (reads.length === 0) return { results, usages, tiles: 0 };
    const next = results.slice();
    next[idx] = mergeFabricZoom(results[idx], reads, W, H);
    return { results: next, usages, tiles: reads.length };
  } catch (err) {
    console.error(
      `[fabric-zoom] pass failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { results, usages: [], tiles: 0 };
  }
}
