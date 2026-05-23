import { supabase } from "@/lib/supabase";
import { rankOf } from "@/lib/workflow";
import type { ItemStatus } from "@/types/database";

// Forward-only item status advance. Returns whether a write was performed:
// no-op when `current` is already at or past `target`. Used by every site
// that advances an item through the pipeline so regressions can't sneak in.
export async function advanceItemStatus(
  itemId: string,
  current: ItemStatus,
  target: ItemStatus,
): Promise<boolean> {
  if (rankOf(current) >= rankOf(target)) return false;
  const { error } = await supabase
    .from("inventory_items")
    .update({ status: target } as never)
    .eq("id", itemId);
  if (error) throw error;
  return true;
}
