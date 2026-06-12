// US-538: the pure compositor + annotation selection. No DB/storage calls —
// but defect-annotations.ts also exports the orchestration, which pulls
// lib/supabase at module init, so set dummy env before the dynamic import
// (same pattern as ai-photo-qa_test.ts).
import { assert, assertEquals } from "@std/assert";
import { Image } from "imagescript";
import type { ImageAnnotations, PhotoAnnotation } from "../lib/disclosure.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { compositeAnnotatedPhoto, selectAnnotatableImages } = await import(
  "../lib/defect-annotations.ts"
);

// Build a plain grey JPEG to annotate.
async function sampleJpeg(w: number, h: number): Promise<Uint8Array> {
  const img = new Image(w, h);
  img.fill(0x808080ff);
  return await img.encodeJPEG(90);
}

function ann(
  n: number,
  bbox: [number, number, number, number] | null,
  severity: PhotoAnnotation["severity"] = "moderate",
): PhotoAnnotation {
  return { n, issue: "light pilling", severity, location: "left cuff", bbox };
}

Deno.test("selectAnnotatableImages drops label shots and empty groups", () => {
  const groups: ImageAnnotations[] = [
    { image_type: "front", annotations: [ann(1, [0.1, 0.1, 0.2, 0.2])] },
    // Private grading shot — must never reach the public item-photos bucket.
    { image_type: "label", annotations: [ann(2, [0.3, 0.3, 0.1, 0.1])] },
    { image_type: "back", annotations: [] },
  ];
  const out = selectAnnotatableImages(groups);
  assertEquals(out.map((g) => g.image_type), ["front"]);
});

Deno.test("compositeAnnotatedPhoto downscales wide photos and appends a legend", async () => {
  const src = await sampleJpeg(1200, 1600);
  const out = await compositeAnnotatedPhoto(src, [
    ann(1, [0.1, 0.1, 0.25, 0.2], "major"),
    ann(2, null, "minor"), // unlocalized → legend-only
  ]);

  assert(out.byteLength > 0, "expected non-empty output");
  // JPEG SOI marker.
  assertEquals(out[0], 0xff);
  assertEquals(out[1], 0xd8);

  const decoded = await Image.decode(out);
  assertEquals(decoded.width, 900); // 1200 capped to MAX_W
  const scaledH = Math.round(1600 * (900 / 1200));
  assert(
    decoded.height > scaledH,
    `legend strip should extend the canvas (got ${decoded.height} ≤ ${scaledH})`,
  );
});

Deno.test("compositeAnnotatedPhoto keeps small photos at native width", async () => {
  const src = await sampleJpeg(640, 640);
  const out = await compositeAnnotatedPhoto(src, [ann(1, [0.2, 0.2, 0.3, 0.3])]);
  const decoded = await Image.decode(out);
  assertEquals(decoded.width, 640);
  assert(decoded.height > 640, "legend strip should extend the canvas");
});

Deno.test("compositeAnnotatedPhoto clamps an overflowing bbox instead of throwing", async () => {
  const src = await sampleJpeg(800, 600);
  // The model occasionally returns a bbox that runs past the edge.
  const out = await compositeAnnotatedPhoto(src, [
    ann(1, [0.9, 0.9, 0.4, 0.4], "major"),
    ann(2, [0, 0, 1, 1], "minor"),
  ]);
  const decoded = await Image.decode(out);
  assertEquals(decoded.width, 800);
});
