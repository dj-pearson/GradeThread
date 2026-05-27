// Mark US-177 passed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-177": {
    passes: true,
    notes:
      "Done 2026-05-27. ios/GradeThread/Vision/ holds the on-device fallback. TagTextRecognizer is an actor wrapping VNRecognizeTextRequest at .accurate level (slower than .fast but markedly better at small care-tag print); returns [RecognizedLine] with text + confidence + normalized boundingBox. SizeTagInference parses recognized lines: a curated lowercase brand whitelist (Patagonia / The North Face / Levi's / Adidas / Carhartt / Pendleton / etc.) catches both uppercase- and lowercase-printed brands; a fallback uppercase-ratio heuristic picks the top line as the brand when no whitelist hit, with explicit guards against 'SIZE L' / 'MADE IN USA' / bare alpha-size tokens. Size detection runs four regex passes in priority order: waist×length (W30 L32, 30x32) → 'Size N' / 'Size: M' → bare alpha (S/M/L/XL/XXL/XXXL) → bare numeric (0–60). AIExtractView.runLiveTextFallbackIfNeeded() fires only when Claude returned NO brand OR NO size; pulls the tag-slot capture's UIImage, runs the recognizer, and AIExtractStore.mergeLiveTextSuggestions inserts the missing fields at confidence 0.4 with source 'live-text'. Fallback rows aren't auto-accepted (0.4 < the 0.8 default-accept threshold) — the user has to opt in. A small banner ('On-device OCR filled in the gaps') appears above the field list when the fallback fired. FieldSuggestionEntry.sourceLabel knows the 'live-text' source and reads it as 'On-device OCR'. When Claude's entire extract fails, the fallback still runs and a synthetic Result is built from whatever Live Text produced — partial recovery instead of a hard error. Conflicts between Claude and Live Text aren't synthesized (Live Text only ever fills gaps, never overrides) so the 'conflicts' panel stays exclusive to Claude's text-vs-photo disagreements. Tests in SizeTagInferenceTests cover brand whitelist hits, lowercase brand catch, uppercase heuristic, size-line rejection, all size patterns including waist×length precedence over bare alpha, year-vs-size guard, store merge behavior including non-override on existing fields and no-op when nothing new, and the live-text source label. The recognizer itself isn't hermetically testable (Vision needs real CGImage + handler) — first TestFlight build is the real check.",
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
