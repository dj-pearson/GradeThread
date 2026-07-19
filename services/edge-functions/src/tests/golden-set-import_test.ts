// US-2131: golden-set bulk import — validation, partial success, and the
// coverage warnings that stop a batch from looking more useful than it is.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", "https://example.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "dummy");

const {
  coverageWarnings,
  MAX_IMPORT_ROWS,
  prepareImport,
  validateBatchSize,
} = await import("../lib/golden-set-import.ts");

const img = [{ image_type: "serial", storage_path: "u/1/serial.jpg" }];
const row = (over: Record<string, unknown> = {}) => ({
  label: "Gucci Marmont, boutique",
  brand: "Gucci",
  expected_label: "authentic",
  images: img,
  ...over,
});

Deno.test("a clean batch prepares every row", () => {
  const { prepared, errors } = prepareImport([row(), row({ label: "Second" })]);
  assertEquals(prepared.length, 2);
  assertEquals(errors.length, 0);
  assertEquals(prepared[0].brand_key, "gucci");
});

Deno.test("brand_key is ALIAS-RESOLVED from the brand", () => {
  // An import written "Levi Strauss" must land on the same key as the KB row and
  // as a review-promoted case, or the corpus silently splits.
  const { prepared } = prepareImport([row({ brand: "Levi Strauss" })]);
  assertEquals(prepared[0].brand_key, "levis");
});

Deno.test("an explicit brand_key wins over the derived one", () => {
  const { prepared } = prepareImport([row({ brand: "Gucci", brand_key: "gucci_vintage" })]);
  assertEquals(prepared[0].brand_key, "gucci_vintage");
});

Deno.test("a bad row is REPORTED with its index, and does not fail the batch", () => {
  // The property that matters: re-uploading 50 rows because one had a typo is
  // how people start bypassing validation.
  const { prepared, errors } = prepareImport([
    row(),
    row({ label: "", brand: "Coach" }),
    row({ label: "No images", images: [] }),
    row({ label: "Bad label", expected_label: "probably" }),
    row({ label: "Fine" }),
  ]);

  assertEquals(prepared.length, 2, "good rows still import");
  assertEquals(errors.length, 3);
  assertEquals(errors.map((e) => e.row), [1, 2, 3], "each error names its row index");
  assert(errors[1].error.includes("images"));
  assert(errors[2].error.includes("expected_label"));
  // A row with no label still reports its position, so it is findable.
  assertEquals(errors[0].label, null);
});

Deno.test("coverage warns on an authentic-only brand", () => {
  // 40 genuine cases and no fakes scores beautifully and proves nothing — the
  // gate cannot demonstrate the one error it exists to catch.
  const { prepared } = prepareImport([row(), row({ label: "b" }), row({ label: "c" })]);
  const warnings = coverageWarnings(prepared);
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].brand_key, "gucci");
  assert(warnings[0].message.includes("dangerous miss"));
});

Deno.test("coverage warns on a counterfeit-only brand too", () => {
  // The mirror case: without genuine examples there is no false-positive rate,
  // and that is the error that harms sellers.
  const { prepared } = prepareImport([
    row({ expected_label: "counterfeit" }),
    row({ label: "b", expected_label: "counterfeit" }),
  ]);
  const warnings = coverageWarnings(prepared);
  assertEquals(warnings.length, 1);
  assert(warnings[0].message.includes("false-positive"));
});

Deno.test("a brand with both polarities is not warned", () => {
  const { prepared } = prepareImport([
    row(),
    row({ label: "fake one", expected_label: "counterfeit" }),
  ]);
  assertEquals(coverageWarnings(prepared).length, 0);
});

Deno.test("coverage warnings are per brand", () => {
  const { prepared } = prepareImport([
    row({ brand: "Gucci" }),
    row({ label: "g2", brand: "Gucci", expected_label: "counterfeit" }),
    row({ label: "c1", brand: "Coach" }),
  ]);
  const warnings = coverageWarnings(prepared);
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].brand_key, "coach", "only the one-sided brand is flagged");
});

Deno.test("batch size is guarded", () => {
  assertEquals(validateBatchSize([row()]), null);
  assert(validateBatchSize([])?.includes("No cases"));
  assert(validateBatchSize("nope")?.includes("array"));
  const tooMany = Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => row());
  assert(validateBatchSize(tooMany)?.includes("Split into batches"));
});
