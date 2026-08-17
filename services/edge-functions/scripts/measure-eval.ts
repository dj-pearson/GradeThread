// US-1580: the measurement-accuracy eval — runs calibrate + extract over the
// golden set and scores it against operator tape-measured ground truth.
//
//   deno run --allow-read --allow-env --allow-net scripts/measure-eval.ts <golden-dir>
//
// <golden-dir> layout (see vault/20-domain/measurement-accuracy.md for the capture protocol):
//   manifest.json          — { garments: [{ id, class, photo, truth: {key: inches} }] }
//   <photo files>          — the MeasureCard flat-lay shots (JPEG/PNG)
//
// Needs ANTHROPIC_API_KEY (the extract pass is a real vision call — each
// garment costs one call; nothing is billed to a tenant). Prints per-key
// stats and the RELEASE GATE verdict (p50 <= 0.25in AND p95 <= 0.5in).
// Until the gate passes, every UI surface keeps the "estimated from photo"
// wording — flipping that copy is a recorded human decision, not automatic.

// Must come FIRST — see the module for why (imports are hoisted).
import "./_placeholder-db-env.ts";
import { Image } from "imagescript";
import { calibrateMeasurePhoto } from "../src/lib/measure-detect.ts";
import { extractMeasurements } from "../src/lib/measure-extract.ts";
import { MEASURE_CARD_VERSIONS } from "../src/lib/measure-card.ts";
import {
  MEASUREMENT_TEMPLATES,
  type MeasurementGroup,
} from "../src/lib/measurement-templates.ts";
import {
  releaseGate,
  summarize,
  type EvalCase,
} from "../src/lib/measure-eval-stats.ts";

interface ManifestGarment {
  id: string;
  class: MeasurementGroup;
  photo: string;
  truth: Record<string, number>;
}

const dir = Deno.args[0];
if (!dir) {
  console.error("usage: deno run --allow-read --allow-env --allow-net scripts/measure-eval.ts <golden-dir>");
  Deno.exit(2);
}

const manifest = JSON.parse(
  await Deno.readTextFile(`${dir}/manifest.json`),
) as { garments: ManifestGarment[] };
if (!Array.isArray(manifest.garments) || manifest.garments.length === 0) {
  console.error("manifest.json has no garments");
  Deno.exit(2);
}
if (manifest.garments.length < 20) {
  console.warn(
    `⚠ golden set has ${manifest.garments.length} garments — the US-1580 gate requires >= 20 for a meaningful verdict`,
  );
}

function toGray(img: Image) {
  const gray = new Uint8Array(img.width * img.height);
  for (let y = 1; y <= img.height; y++) {
    for (let x = 1; x <= img.width; x++) {
      const px = img.getPixelAt(x, y) >>> 0;
      gray[(y - 1) * img.width + (x - 1)] =
        (((px >>> 24) & 0xff) * 299 + ((px >>> 16) & 0xff) * 587 +
          ((px >>> 8) & 0xff) * 114) / 1000;
    }
  }
  return { width: img.width, height: img.height, gray };
}

const cases: EvalCase[] = [];
for (const g of manifest.garments) {
  const bytes = await Deno.readFile(`${dir}/${g.photo}`);
  const img = (await Image.decode(bytes)) as Image;
  const gray = toGray(img);
  const calib = calibrateMeasurePhoto(gray, MEASURE_CARD_VERSIONS);
  if (!calib.ok) {
    console.error(`✗ ${g.id}: calibration failed (${calib.reason}) — all keys count as misses`);
    for (const key of Object.keys(g.truth)) {
      cases.push({
        garmentId: g.id,
        garmentClass: g.class,
        measurementKey: key,
        truthInches: g.truth[key],
        predictedInches: null,
      });
    }
    continue;
  }
  // The eval hits the API directly with a data URL — golden photos are local
  // files, not tenant storage.
  const b64 = btoa(String.fromCharCode(...bytes));
  const mime = g.photo.endsWith(".png") ? "image/png" : "image/jpeg";
  const fields = MEASUREMENT_TEMPLATES[g.class].filter((f) => f.unit === "length");
  const result = await extractMeasurements({
    photoUrl: `data:${mime};base64,${b64}`,
    gray,
    grayScale: 1,
    homography: calib.homography,
    imageWidth: img.width,
    imageHeight: img.height,
    group: g.class,
    fields,
    sizeLabel: null,
  });
  const byKey = new Map(result.measurements.map((m) => [m.key, m.inches]));
  for (const key of Object.keys(g.truth)) {
    cases.push({
      garmentId: g.id,
      garmentClass: g.class,
      measurementKey: key,
      truthInches: g.truth[key],
      predictedInches: byKey.get(key) ?? null,
    });
  }
  console.log(`• ${g.id} (${g.class}): ${result.measurements.length} predicted / ${Object.keys(g.truth).length} truth keys`);
}

console.log("\nPer-measurement error stats (abs inches vs tape):");
console.log("class      key           n   miss  p50    p95    max    bias");
for (const s of summarize(cases)) {
  console.log(
    `${s.garmentClass.padEnd(10)} ${s.measurementKey.padEnd(13)} ${String(s.n).padStart(3)} ${String(s.misses).padStart(5)}  ${s.p50.toFixed(2).padStart(5)}  ${s.p95.toFixed(2).padStart(5)}  ${s.maxAbs.toFixed(2).padStart(5)}  ${s.meanSigned >= 0 ? "+" : ""}${s.meanSigned.toFixed(2)}`,
  );
}

const gate = releaseGate(cases);
console.log(
  `\nRELEASE GATE (p50<=0.25in AND p95<=0.5in): ${gate.pass ? "✅ PASS" : "❌ FAIL"}` +
    ` — p50=${gate.p50.toFixed(2)}in p95=${gate.p95.toFixed(2)}in over n=${gate.n} (${gate.misses} misses)`,
);
if (!gate.pass) {
  for (const r of gate.reasons) console.log(`  - ${r}`);
  console.log('  → all UI copy keeps "estimated from photo — review before listing"');
}
Deno.exit(gate.pass ? 0 : 1);
