// Type declarations for the Node reader of the shared brand-field
// classification, so the Vitest parity case imports it without TS7016.
//
// The shapes here MIRROR src/lib/brand-field-classification.ts. That file is the
// typed reader of the same JSON; this one exists only because a .mjs has no
// types of its own. If they disagree, the JSON is the source of truth and both
// are wrong.

export type BrandFieldClass =
  | "maker"
  | "licensor"
  | "material"
  | "retailer"
  | "descriptor"
  | "unbranded"
  | "unknown"
  | "blank";

export interface BrandFieldClassMeta {
  label: string;
  meaning: string;
  recordsMaker: boolean;
  guidance: string | null;
}

export interface BrandFieldValueEntry {
  key: string;
  label: string;
  class: BrandFieldClass;
  reason: string;
}

export interface BrandFieldVerdict {
  value: string;
  key: string;
  class: BrandFieldClass;
  recordsMaker: boolean;
  reason: string;
  guidance: string | null;
}

export interface BrandFieldTallyRow {
  class: BrandFieldClass;
  values: number;
  items: number;
}

export interface BrandFieldTally {
  rows: BrandFieldTallyRow[];
  totalValues: number;
  totalItems: number;
  itemsWithNoMaker: number;
  valuesWithNoMaker: number;
}

export const CLASSIFICATION_PATH: string;
export const BRAND_FIELD_CLASSIFICATION_VERSION: string;
export const BRAND_FIELD_CLASSES: Record<BrandFieldClass, BrandFieldClassMeta>;
export const BRAND_FIELD_VALUES: BrandFieldValueEntry[];
export const CLASS_ORDER: BrandFieldClass[];

/** The cases both readers must agree on: [value, expected class]. */
export const PARITY_CASES: [string, BrandFieldClass][];

export function brandFieldKey(raw: string | null | undefined): string;
export function classifyBrandField(
  raw: string | null | undefined,
): BrandFieldVerdict;
export function isNonBrandValue(raw: string | null | undefined): boolean;
export function hasNoRecordedMaker(raw: string | null | undefined): boolean;
export function tallyBrandField(
  demand: readonly { brand: string | null | undefined; count: number }[],
): BrandFieldTally;
