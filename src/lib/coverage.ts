// US-1277: frontend consumer of the US-1276 photo-coverage engine.
//
// The submission flow's live coverage meter must score zones IDENTICALLY to the
// server, so this module reuses the PURE, dependency-free engine directly rather
// than re-implementing the zone templates (AC4: no duplicate zone logic in the
// client). The single source of truth stays
// `services/edge-functions/src/lib/coverage.ts`; that file imports nothing and
// touches no Deno globals, so the Vite client can bundle it as-is.
import {
  computeCoverage,
  inspectionTemplate,
  type CoverageResult,
  type CoverageImageSignal,
  type InspectionZone,
} from "../../services/edge-functions/src/lib/coverage";

export { computeCoverage, inspectionTemplate };
export type { CoverageResult, CoverageImageSignal, InspectionZone };

/**
 * Coverage % at/above which a submission earns full guarantee scope. Below it,
 * the guarantee is narrowed to the zones the photos actually document (the
 * coverage-gated guarantee, US-1279/1280). Configurable via
 * `VITE_COVERAGE_GUARANTEE_FLOOR`; defaults to 80.
 */
export const COVERAGE_GUARANTEE_FLOOR: number = (() => {
  const raw = Number(import.meta.env.VITE_COVERAGE_GUARANTEE_FLOOR);
  return Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : 80;
})();

/**
 * Live, view-only coverage for the in-flow meter. Pre-grade we only know each
 * photo's view (`image_type`); the per-image vision zone hints the engine can
 * also use aren't produced until the grading pass runs, so they're omitted here.
 * The engine still returns the exact covered/missing zones + percent for those
 * views — identical to what the server will compute for the same photo set.
 */
export function coverageFromImageTypes(
  garmentCategory: string,
  imageTypes: string[],
): CoverageResult {
  return computeCoverage(
    garmentCategory,
    imageTypes.map((image_type): CoverageImageSignal => ({ image_type })),
  );
}
