// Mark US-178 passed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-178": {
    passes: true,
    notes:
      "Done 2026-05-27. ios/GradeThread/DetailsIntake/ holds the manual intake surface, reached from the Add tab → 'Details-first (manual form)'. FlipdeskConstants.swift mirrors src/types/database.ts enums verbatim — FlipdeskCategory (item_category), IntakeStatus (curated subset of item_status valid as entry points), FlipdeskSourceType (flipdesk_source_type). Each enum maps Swift camel-case names to the snake_case wire values via raw-value strings. CurrencyFormatter.swift wraps NumberFormatter for locale-aware parse + display (handles 'en_US' $ → '$12.50', 'de_DE' € → '1.234,56', stripped currency-symbol input, grouping separators). IntakeFormState @MainActor @Observable owns every field; resetForBatchAddAnother() clears item identity + notes but explicitly preserves source_id + container + sourced_by + purchase_date so a thrift trip's batch flow doesn't retype the haul context (matches src/pages/flipdesk/intake.tsx). SourceStore refreshes sources from PostgREST and upserts into the existing LocalSource SwiftData cache; addSource() inserts via supabase-swift and returns the new id for picker auto-select. AddSourceSheet.swift presents a modal form (name + FlipdeskSourceType picker + optional notes) and on save returns the id via onAdded. DetailsIntakeView is a SwiftUI Form with three sections — Item, Sourcing, Notes — plus a save action section. Source picker uses an '__add_new__' sentinel tag and an onChange watcher to drive the AddSourceSheet without losing the rest of the Picker UX. Notes use TextEditor-style multi-line TextField with autoFocus disabled per the AC. Save flow: builds an ItemInsertPayload (nullifies empty strings so Postgres NULL semantics are preserved), POSTs via supabase-swift's .from('inventory_items').insert(...).execute(); on network failure (URLError or 'offline'/'timed out' string match) enqueues a LocalPendingMutation(kind: .createInventoryItem) so US-172's SyncEngine can replay on reconnect — banner reads 'Saved offline — will sync when you reconnect'. Application-level failures (RLS / enum mismatch) surface as-is so the user can fix and retry. 'Save & Add another' calls resetForBatchAddAnother(), haptic feedbacks, and keeps the form open. IntakePlaceholder(.detailsFirst) → DetailsIntakeView is wired into ContentView's navigationDestination. Tests cover IntakeFormState reset semantics (preserve vs. clear), CurrencyFormatter happy paths + de_DE / en_US locale fidelity + symbol stripping + garbage rejection, and FlipdeskConstants raw-value wire fidelity for every snake_case enum the form writes.",
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
