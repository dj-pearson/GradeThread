// US-3467: the bulk "Edit fields" form, turned into the columns to write.
//
// A blank box means "leave each item's value alone", which is what a seller
// means when they only filled in one of the two. Clearing is a separate,
// explicit tick, so an empty box can never wipe the bin off 300 items.
export interface BulkFieldsForm {
  bin: string;
  clearBin: boolean;
  brand: string;
  clearBrand: boolean;
}

export type BulkFieldsPatch = { location_bin?: string | null; brand?: string | null };

export function planBulkFields(f: BulkFieldsForm): BulkFieldsPatch {
  const patch: BulkFieldsPatch = {};
  if (f.clearBin) patch.location_bin = null;
  else if (f.bin.trim() !== "") patch.location_bin = f.bin.trim();
  if (f.clearBrand) patch.brand = null;
  else if (f.brand.trim() !== "") patch.brand = f.brand.trim();
  return patch;
}
