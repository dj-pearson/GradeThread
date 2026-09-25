// Worth My Time, R1 01/12 (US-3166): read and write the seller's planning
// inputs.
//
//   GET   /api/flipdesk/work-preferences   the effective settings
//   PATCH /api/flipdesk/work-preferences   change some of them
//
// SECURITY (US-268). The edge uses the service-role client, which BYPASSES
// RLS. Both routes resolve the owner from the REQUEST CONTEXT -- the workspace
// owner when the caller is a team member, otherwise the caller -- and no id
// from a body or a query ever chooses whose row is read or written. There is
// no route here that takes a user id at all, which is the cheapest way to make
// that true rather than merely checked (AC4).
//
// WHY PATCH AND NOT PUT. The screen (R1 10/12) saves one control at a time, so
// a whole-object write would make every save a race: two controls changed in
// two tabs and the second one wins on both. A patch also lets an absent key
// mean "leave it alone", which is what makes clearing the hourly target
// expressible -- see the null handling in lib/work-preferences.ts.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe, jsonError } from "../lib/http-errors.ts";
import {
  defaultWorkPreferences,
  parseWorkPreferencesPatch,
  rowToWorkPreferences,
  SETTINGS_VERSION,
  workPreferencesResponse,
  type WorkPreferences,
  type WorkPreferencesPatch,
  type WorkPreferencesRow,
} from "../lib/work-preferences.ts";

export const flipdeskWorkPreferencesRoutes = new Hono<{
  Variables: { userId: string; workspaceOwnerId: string };
}>();

const SELECT_COLUMNS =
  "default_session_minutes, work_context, available_tools, hourly_target_amount, hourly_target_currency, settings_version";

/**
 * The effective settings for this workspace.
 *
 * An absent row is every default rather than a 404: a seller who has never
 * opened the screen has settings, they are just the ones nobody chose. The
 * planner has to be able to run for them on day one.
 */
async function loadPreferences(ownerId: string): Promise<WorkPreferences> {
  const { data, error } = await supabaseAdmin
    .from("flipdesk_work_preferences")
    .select(SELECT_COLUMNS)
    .eq("user_id", ownerId) // US-268
    .maybeSingle();
  if (error) {
    // Before 00817 applies this is an unknown-relation error, and defaults are
    // the right reading: the feature works, it just remembers nothing yet.
    console.warn(
      "[flipdesk-work-preferences] read failed:",
      error.message,
    );
    return defaultWorkPreferences();
  }
  return rowToWorkPreferences(data as WorkPreferencesRow | null);
}

/** The columns a validated patch names, and no others. */
export function patchToColumns(
  patch: WorkPreferencesPatch,
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.defaultSessionMinutes !== undefined) {
    row.default_session_minutes = patch.defaultSessionMinutes;
  }
  if (patch.workContext !== undefined) row.work_context = patch.workContext;
  if (patch.availableTools !== undefined) {
    row.available_tools = patch.availableTools;
  }
  // An explicit null clears the target, so the key test decides, not `??`.
  if ("hourlyTargetAmount" in patch) {
    row.hourly_target_amount = patch.hourlyTargetAmount ?? null;
  }
  if (patch.hourlyTargetCurrency !== undefined) {
    row.hourly_target_currency = patch.hourlyTargetCurrency;
  }
  return row;
}

flipdeskWorkPreferencesRoutes.get("/", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const prefs = await loadPreferences(ownerId);
  return c.json(workPreferencesResponse(prefs));
});

flipdeskWorkPreferencesRoutes.patch("/", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }

  const parsed = parseWorkPreferencesPatch(body);
  if (!parsed.ok) {
    // Every reason, not the first. A screen saving four controls should be
    // told about all four mistakes rather than discovering them one round trip
    // at a time.
    return c.json(
      { error: "Those settings aren't valid.", fields: parsed.errors },
      400,
    );
  }

  // WMT-01: write ONLY the columns the patch names. This used to read the row,
  // merge, and upsert every column -- and the read falls back to defaults on
  // any error, so one failed read turned a minutes save into "camera only, no
  // hourly target". Two single-field saves also overwrote each other. An
  // upsert that names one column updates one column; a first insert takes the
  // 00817 column defaults for the rest.
  const { data, error } = await supabaseAdmin
    .from("flipdesk_work_preferences")
    .upsert(
      {
        user_id: ownerId, // US-268: from the context, never from the body
        ...patchToColumns(parsed.patch),
        settings_version: SETTINGS_VERSION,
      },
      { onConflict: "user_id" },
    )
    .select(SELECT_COLUMNS)
    .single();
  if (error) {
    return failSafe(
      c,
      500,
      "Couldn't save those settings.",
      error,
      "work-preferences.save",
    );
  }

  // The response is what was stored, not a merge the route guessed at.
  return c.json(
    workPreferencesResponse(rowToWorkPreferences(data as WorkPreferencesRow)),
  );
});
