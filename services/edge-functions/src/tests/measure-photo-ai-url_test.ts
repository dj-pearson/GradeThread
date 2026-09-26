// US-3539: measurement photos reach the vision call through itemPhotoAiUrl,
// which signs private-bucket objects, never a public URL picked by photo type.
import "./_env.ts";
import { assert } from "@std/assert";

const read = (p: string) => Deno.readTextFileSync(new URL(p, import.meta.url));

Deno.test("US-3539: neither measure path builds a public URL from the photo type", () => {
  for (
    const f of ["../lib/measure-autofill.ts", "../routes/flipdesk-measure.ts"]
  ) {
    const src = read(f);
    assert(
      !src.includes("getPublicUrl(photo.storage_path)"),
      `${f} still builds a public URL`,
    );
    assert(
      src.includes("await itemPhotoAiUrl(photo, undefined, { ownerId })"),
      `${f} does not sign`,
    );
  }
});

Deno.test("US-3539: the photo selects carry photo_url, which itemPhotoAiUrl reads", () => {
  assert(
    read("../lib/measure-autofill.ts").includes(
      '"id, storage_path, photo_type, photo_url, measure_calibration, sort_order"',
    ),
  );
  assert(
    read("../routes/flipdesk-measure.ts").includes(
      "storage_path, photo_type, photo_url, measure_calibration",
    ),
  );
});
