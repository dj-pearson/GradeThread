// Mark US-176 passed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-176": {
    passes: true,
    notes:
      "Done 2026-05-27. ios/GradeThread/AIExtract/ has the full review surface. AIExtractTypes.swift mirrors the edge wire shape (AIExtractRequest, AIExtractResponse, FieldSuggestion, FieldConflict, ExtractPhoto, KnownFieldValue) with explicit CodingKeys on the snake_case top-level fields. AIExtractService.swift rolls its own URLSession call instead of routing through generic EdgeAPI specifically so the response's suggestions dict (keys 'brand', 'size', 'garment_category', 'garment_type') survive verbatim — EdgeAPI's shared decoder applies convertFromSnakeCase to every key in scope, which would mangle them. Auth-token attachment + error mapping (EdgeAPIError.from) reused. AIExtractStore @Observable drives the phase machine (waitingForUploads / extracting / ready / failed); auto-accepts suggestions with confidence ≥0.8 and toggles measurements on when present. AIExtractView orchestrates: polls PhotoUploadStore.tasks(inventoryItemId:) until every queued upload reaches terminal state (60s timeout), collects uploaded publicURLs into the request, calls service, renders three cards (condition summary, detected fields, estimated measurements) with per-field Accept toggles and a single accept-all switch for measurements. FieldSuggestionRow.swift renders the value + humanised source label ('From tag photo'), a colored confidence badge + bar (≥0.8 navy / 0.5-0.8 orange / <0.5 red), and the checkbox. Apply writes the accepted fields onto inventory_items via supabase-swift's .from('inventory_items').update(...).eq('id', value:), with ai_field_sources entries matching the web's convention — direct field keys for top-level columns and 'measurements.{key}' for each measurement row so MeasurementForm-style UIs can show a per-field AI badge later. Confidence 0.7 stamped on measurement sources, matching snap-catalog.tsx. ai_enriched_at gets the current ISO timestamp. Errors (429 quota, network failure, decode failure) surface a clear screen with 'Skip — I'll fill in manually' fallback. PhotoIntakeView Done now creates the inventory_items row first (resolves US-175's FK gap), enqueues uploads against the new id, then presents AIExtractView as a fullScreenCover; on completion (Apply / Skip / Close) the camera dismisses back to the originating navigation stack. Tests cover the snake_case-preserving response decoding (the bug AIExtractService specifically avoids), empty / null measurement decoding, conflicts decoding, request encoding with item_id snake-case, store apply+toggle+acceptAll+acceptNone semantics, default high-confidence auto-acceptance, acceptedCount math including measurements, display label title-casing, and source label humanisation.",
  },
};

const prd = JSON.parse(fs.readFileSync(PRD, "utf8"));
let touched = 0;
for (const story of prd.userStories) {
  const u = updates[story.id];
  if (!u) continue;
  story.passes = u.passes;
  story.notes = u.notes;
  touched++;
}

fs.writeFileSync(PRD, JSON.stringify(prd, null, 2) + "\n", "utf8");
console.log(`Updated ${touched} stories in prd.json`);
