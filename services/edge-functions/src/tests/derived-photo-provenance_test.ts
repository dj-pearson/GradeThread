// US-2566: provenance for derived evidence assets.
//
// Two of these decisions are destructive and run unattended on every annotation
// pass, so they are the ones worth being certain about:
//
//   • The PRUNE deletes rows. Get it wrong and it removes the seller's own
//     photographs — silently, on a path nobody watches, from a worker.
//   • The IDENTITY check decides whether to render again. Get it wrong and
//     either the pack duplicates on every retry, or US-2567's per-defect crops
//     collide and only the first one is ever attached.
//
// Both used to be substring tests on a filename, which is why neither could be
// tested without a database and a storage bucket. They are pure now.

import { assert, assertEquals } from "@std/assert";
// Imported from the PURE module, not from defect-annotations.ts: that one builds
// the service-role client at import time and throws without SUPABASE_URL, which
// is precisely why these decisions went untested before US-2566.
import {
  type DerivedIdentity,
  type DerivedPhotoRow,
  findAttachedDerivative,
  isLegacyDerivedPath,
  nextSortOrder,
  selectStaleDerivedPhotos,
} from "../lib/derived-photo-provenance.ts";

const REPORT_A = "aaaaaaaa-1111-4111-8111-111111111111";
const REPORT_B = "bbbbbbbb-2222-4222-8222-222222222222";
const OWNER = "cccccccc-3333-4333-8333-333333333333";
const ITEM = "dddddddd-4444-4444-8444-444444444444";
const SRC_FRONT = `${OWNER}/sub-1/front_1700000000.jpg`;
const SRC_BACK = `${OWNER}/sub-1/back_1700000000.jpg`;

function row(over: Partial<DerivedPhotoRow> = {}): DerivedPhotoRow {
  return {
    id: crypto.randomUUID(),
    storage_path: `${OWNER}/${ITEM}/seller-upload.jpg`,
    sort_order: 0,
    derived_from_grade_report_id: null,
    derived_transform: null,
    derived_from_storage_path: null,
    derived_defect_index: null,
    ...over,
  };
}

function derived(report: string, over: Partial<DerivedPhotoRow> = {}): DerivedPhotoRow {
  return row({
    storage_path: `${OWNER}/${ITEM}/disclosure_auto_front_${report.slice(0, 8)}.jpg`,
    derived_from_grade_report_id: report,
    derived_transform: "annotated_full",
    derived_from_storage_path: SRC_FRONT,
    derived_defect_index: null,
    ...over,
  });
}

// ── The prune ──────────────────────────────────────────────────────────────

Deno.test("a seller upload is NEVER pruned", () => {
  // The single most important assertion in this file. A seller upload has a NULL
  // report id, which is the same value a pre-00598 derivative has — so the prune
  // has to tell them apart by something other than the column, and if it ever
  // stops doing that it deletes the photographs the seller took.
  const seller = row();
  assertEquals(selectStaleDerivedPhotos([seller], REPORT_A), []);
});

Deno.test("a seller upload is not pruned even when the CURRENT report changes", () => {
  const seller = row();
  assertEquals(selectStaleDerivedPhotos([seller], REPORT_B), []);
});

Deno.test("an asset from a superseded report is pruned", () => {
  const stale = derived(REPORT_A);
  assertEquals(selectStaleDerivedPhotos([stale], REPORT_B), [stale.id]);
});

Deno.test("an asset from the CURRENT report survives", () => {
  const current = derived(REPORT_A);
  assertEquals(selectStaleDerivedPhotos([current], REPORT_A), []);
});

Deno.test("a pre-00598 derivative IS pruned, on its path marker alone", () => {
  // It carries no report id, so it can never be matched as current and would
  // otherwise linger forever, contradicting the live grade.
  const legacy = row({
    storage_path: `${OWNER}/${ITEM}/disclosure_auto_front_abcd1234.jpg`,
  });
  assertEquals(selectStaleDerivedPhotos([legacy], REPORT_A), [legacy.id]);
});

Deno.test("the legacy marker is matched on the PATH SEGMENT, not anywhere", () => {
  // A seller who names a file "my disclosure_auto_shots.jpg" must not have it
  // deleted. The marker only counts directly after a slash.
  assertEquals(isLegacyDerivedPath(`${OWNER}/${ITEM}/disclosure_auto_front.jpg`), true);
  assertEquals(isLegacyDerivedPath(`${OWNER}/${ITEM}/my-disclosure_auto_shot.jpg`), false);
  assertEquals(isLegacyDerivedPath(null), false);
});

Deno.test("a mixed set prunes only what should go", () => {
  const seller = row({ sort_order: 0 });
  const legacy = row({
    sort_order: 1,
    storage_path: `${OWNER}/${ITEM}/disclosure_auto_back_deadbeef.jpg`,
  });
  const old = derived(REPORT_A, { sort_order: 2 });
  const current = derived(REPORT_B, { sort_order: 3 });

  const stale = selectStaleDerivedPhotos([seller, legacy, old, current], REPORT_B);
  assertEquals(stale.sort(), [legacy.id, old.id].sort());
});

// ── The identity check ─────────────────────────────────────────────────────

function identity(over: Partial<DerivedIdentity> = {}): DerivedIdentity {
  return {
    gradeReportId: REPORT_A,
    transform: "annotated_full",
    sourceStoragePath: SRC_FRONT,
    defectIndex: null,
    ...over,
  };
}

Deno.test("an already-attached asset is found, so it is not re-rendered", () => {
  const existing = derived(REPORT_A);
  assert(findAttachedDerivative([existing], identity()));
});

Deno.test("a different SOURCE image is a different asset", () => {
  const existing = derived(REPORT_A);
  assertEquals(
    findAttachedDerivative([existing], identity({ sourceStoragePath: SRC_BACK })),
    null,
  );
});

Deno.test("a different REPORT is a different asset", () => {
  const existing = derived(REPORT_A);
  assertEquals(
    findAttachedDerivative([existing], identity({ gradeReportId: REPORT_B })),
    null,
  );
});

Deno.test("two crops from the SAME source under the same report do not collide", () => {
  // This is the case the filename scheme could not express at all — both would
  // have resolved to one destination path, so the second crop was silently
  // dropped. It is the whole reason US-2567 needs this story first.
  const crop0 = derived(REPORT_A, {
    derived_transform: "defect_crop",
    derived_defect_index: 0,
  });
  const crop1Identity = identity({ transform: "defect_crop", defectIndex: 1 });

  assertEquals(
    findAttachedDerivative([crop0], crop1Identity),
    null,
    "defect 1 must not be mistaken for defect 0",
  );
  assert(
    findAttachedDerivative([crop0], identity({ transform: "defect_crop", defectIndex: 0 })),
    "defect 0 must still be recognised as attached",
  );
});

Deno.test("a null defect index and index -1 are the same slot, matching the SQL index", () => {
  // 00598's unique index is on COALESCE(derived_defect_index, -1). If this
  // in-process check disagreed, the code would decide to render and the database
  // would then reject the insert — a 23505 on a path that swallows insert errors,
  // i.e. a silently missing asset.
  const full = derived(REPORT_A, { derived_defect_index: null });
  assert(findAttachedDerivative([full], identity({ defectIndex: null })));
  const negative = derived(REPORT_A, { derived_defect_index: -1 });
  assert(findAttachedDerivative([negative], identity({ defectIndex: null })));
});

Deno.test("a different TRANSFORM from the same source is a different asset", () => {
  const full = derived(REPORT_A, { derived_transform: "annotated_full" });
  assertEquals(
    findAttachedDerivative([full], identity({ transform: "defect_crop" })),
    null,
  );
});

// ── Sort ordering ──────────────────────────────────────────────────────────

Deno.test("the next slot ignores rows that are about to be pruned", () => {
  // Otherwise a regrade leaves a gap that grows on every pass: the pruned rows
  // still push the counter up even though they are being deleted in the same
  // breath.
  const seller = row({ sort_order: 0 });
  const stale = derived(REPORT_A, { sort_order: 7 });
  assertEquals(nextSortOrder([seller, stale], [stale.id]), 1);
  assertEquals(nextSortOrder([seller, stale], []), 8);
});

Deno.test("a null sort_order does not break the next slot", () => {
  const seller = row({ sort_order: null });
  assertEquals(nextSortOrder([seller], []), 0);
});

// ── The module no longer identifies assets by filename ─────────────────────

Deno.test("substring matching on storage_path survives in exactly ONE place", async () => {
  // AC3 asked for it to be gone from the module. It cannot be entirely: a
  // pre-00598 row is indistinguishable from a seller upload by column alone, and
  // the path marker is the only surviving evidence. So the rule became "one
  // named, documented, deletable function" rather than the substring tests that
  // were scattered through the orchestration.
  const pure = await Deno.readTextFile(
    new URL("../lib/derived-photo-provenance.ts", import.meta.url),
  );
  const orchestration = await Deno.readTextFile(
    new URL("../lib/defect-annotations.ts", import.meta.url),
  );

  // Code lines only. Both files describe the old filename scheme in their
  // headers, and a guard that counted prose would fail the moment someone
  // explained the rule better.
  const codeLines = (src: string) =>
    src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

  assertEquals(
    codeLines(pure).filter((l) => l.includes(".includes(")).length,
    1,
    "the pure module should hold exactly one substring test (isLegacyDerivedPath)",
  );
  assertEquals(
    codeLines(orchestration).filter((l) => /storage_path\S*\.includes\(/.test(l)).length,
    0,
    "the orchestration must not identify assets by filename any more",
  );
  assert(
    !/_\$\{reportTag\}\.jpg`\)/.test(orchestration),
    "the `_{reportTag}.jpg` suffix staleness test must be gone — the report id " +
      "is a column now",
  );
});

Deno.test("the orchestration writes every provenance column", async () => {
  // AC1. A row inserted without these is indistinguishable from a seller upload,
  // which means the next prune leaves it behind forever and the evidence pack
  // cannot say what it is.
  const src = await Deno.readTextFile(
    new URL("../lib/defect-annotations.ts", import.meta.url),
  );
  for (const column of [
    "derived_from_grade_report_id:",
    "derived_from_storage_path:",
    "derived_transform:",
    "derived_defect_index:",
    "derived_bbox:",
    "certificate_number:",
  ]) {
    assert(src.includes(column), `item_photos insert must set ${column}`);
  }
  assert(
    src.includes("ensureCertificateNumber("),
    "AC4: the certificate number must be resolved through ensureCertificateNumber " +
      "so a certified report predating migration 00307 is backfilled rather than " +
      "skipped",
  );
});
