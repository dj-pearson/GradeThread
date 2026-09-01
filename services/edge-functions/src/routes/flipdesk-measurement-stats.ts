// US-3039: serve the published measurement table for one garment.
//
// GET /api/flipdesk/measurement-stats?brand=&style=&group=&size=&gender=
//   → { cohort: {...} | null, fields: [{ field, label, median, p25, p75,
//       sampleCount, contributorCount }] }
//
// WHY A TABLE AND NOT A VERDICT, and why the composer does the comparing: the
// same reasoning flipdesk-size-bands.ts gives about itself. The edge resolves
// the cohort ONCE and hands back a small table; the composer then autofills and
// checks drift on every keystroke with no network call, and web, iOS and
// Android share one answer because they share one table.
//
// US-268: this route takes NO item id and reads NO tenant table.
// garment_measurement_stats is deny-all reference data with no owner column,
// read through the service-role client, and there is nothing here to scope by.
// An itemId or userId param is REJECTED rather than ignored, so a future caller
// cannot quietly turn a reference lookup into a tenant read. That refusal is
// asserted by a test, not assumed.
//
// ONLY SUFFICIENT COHORTS LEAVE THIS ROUTE. The floor is the promise the
// privacy copy makes, and a client that could ask for thin data is a client
// that will eventually show it.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { brandKeyForRaw } from "../lib/brand-normalize.ts";
import { resolveBrandKnowledgePack } from "../lib/brand-knowledge.ts";
// normalizeSizeLabel is deliberately NOT imported here: resolveMeasurementCohort
// already applies it, and calling it twice at two call sites is how the read
// path and the write path drift into disagreeing about what one size is called.
import { normalizeDepartment } from "../lib/size-systems.ts";
import { resolveMeasurementCohort } from "../lib/measurement-ingest.ts";
import {
  MEASUREMENT_TEMPLATES,
  type MeasurementGroup,
} from "../lib/measurement-templates.ts";

export const flipdeskMeasurementStatsRoutes = new Hono<{
  Variables: { userId: string };
}>();

export interface MeasurementStatField {
  field: string;
  label: string;
  median: number;
  p25: number;
  p75: number;
  sampleCount: number;
  contributorCount: number;
}

export interface MeasurementStatsResponse {
  /** Null when nothing published covers this garment. */
  cohort:
    | {
      brandKey: string;
      styleKey: string;
      department: string;
      group: string;
      sizeLabel: string;
      /** True when the numbers come from the style, not the brand rollup. */
      styleMatched: boolean;
    }
    | null;
  fields: MeasurementStatField[];
}

const EMPTY: MeasurementStatsResponse = { cohort: null, fields: [] };

interface StatRow {
  field_key: string;
  median: number | null;
  p25: number | null;
  p75: number | null;
  sample_count: number;
  contributor_count: number;
}

flipdeskMeasurementStatsRoutes.get("/", async (c) => {
  try {
    // US-268. The only ids this route could take are ids it has no business
    // reading, so it refuses them outright instead of silently dropping them.
    for (const forbidden of ["itemId", "item_id", "userId", "user_id"]) {
      if (c.req.query(forbidden) !== undefined) {
        return c.json(
          {
            error:
              "measurement-stats is a reference lookup and takes no item or " +
              "user id — pass brand, style, group and size only",
          },
          400,
        );
      }
    }

    const brand = (c.req.query("brand") ?? "").trim();
    const style = (c.req.query("style") ?? "").trim();
    const size = (c.req.query("size") ?? "").trim();
    const group = (c.req.query("group") ?? "").trim() as MeasurementGroup;

    // Identical params must produce an identical body, and the published table
    // only moves once a day when the aggregate runs.
    c.header("Cache-Control", "private, max-age=1800");

    if (!brand || !size || !group) return c.json(EMPTY);
    if (!MEASUREMENT_TEMPLATES[group]) return c.json(EMPTY);
    if (!brandKeyForRaw(brand)) return c.json(EMPTY);

    // Resolve the cohort exactly the way the ingest did, so a garment reads
    // back the same bucket its own measurements were filed into. Two different
    // resolutions here would mean the composer silently comparing against a
    // cohort this item never joined.
    const pack = await resolveBrandKnowledgePack(brand);
    const cohort = resolveMeasurementCohort({
      brand,
      style,
      size,
      group,
      styles: pack?.styles ?? [],
    });
    if (!cohort) return c.json(EMPTY);

    // The department can come from the matched style or from an explicit
    // gender param; an unmatched style leaves it empty, which is the brand
    // rollup's own department value.
    const department = cohort.department ||
      normalizeDepartment(c.req.query("gender")) || "";

    const { data, error } = await supabaseAdmin
      .from("garment_measurement_stats")
      .select("field_key, median, p25, p75, sample_count, contributor_count")
      .eq("brand_key", cohort.brandKey)
      .eq("style_key", cohort.styleKey)
      .eq("department", department)
      .eq("measurement_group", cohort.measurementGroup)
      .eq("size_label", cohort.sizeLabel)
      .eq("sufficient", true);

    if (error) {
      console.error("[measurement-stats] read failed:", error.message);
      return c.json(EMPTY);
    }

    const rows = (data ?? []) as unknown as StatRow[];
    if (rows.length === 0) return c.json(EMPTY);

    const labels = new Map(
      (MEASUREMENT_TEMPLATES[group] ?? []).map((f) => [f.key, f.label]),
    );

    const fields: MeasurementStatField[] = rows
      .filter((r) => r.median !== null && r.p25 !== null && r.p75 !== null)
      // A field the template does not know about cannot be rendered next to an
      // input that does not exist, so it is dropped rather than shown loose.
      .filter((r) => labels.has(r.field_key))
      .map((r) => ({
        field: r.field_key,
        label: labels.get(r.field_key)!,
        median: r.median!,
        p25: r.p25!,
        p75: r.p75!,
        sampleCount: r.sample_count,
        contributorCount: r.contributor_count,
      }))
      .sort((a, b) => a.field.localeCompare(b.field));

    if (fields.length === 0) return c.json(EMPTY);

    const response: MeasurementStatsResponse = {
      cohort: {
        brandKey: cohort.brandKey,
        styleKey: cohort.styleKey,
        department,
        group: cohort.measurementGroup,
        sizeLabel: cohort.sizeLabel,
        styleMatched: cohort.styleKey !== "",
      },
      fields,
    };
    return c.json(response);
  } catch (err) {
    console.error(
      "[measurement-stats]:",
      err instanceof Error ? err.message : String(err),
    );
    // A reference lookup that fails is a reference lookup with no answer. The
    // composer treats an empty body and a failure identically, which is what
    // keeps a database hiccup from putting an error banner over someone's
    // listing draft.
    return c.json(EMPTY);
  }
});
