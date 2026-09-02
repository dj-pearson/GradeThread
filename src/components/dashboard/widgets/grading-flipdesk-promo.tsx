import { FlipdeskPromoCard } from "@/components/flipdesk/flipdesk-promo-card";
import { useInventoryItemCount } from "@/hooks/use-inventory-item-count";

// US-3075 AC1/AC5: the FlipDesk promo, as a widget.
//
// Two gates, and they do different jobs. normalize() takes this widget OFF the
// board entirely once the account has any inventory_items row, because a promo
// for a product you already use is not a widget you should have to hide by
// hand. The card's own itemCount gate stays anyway: normalize() reads a count
// that can still be in flight on the first paint, and the card is the thing
// that knows what to render at zero.

export function GradingFlipdeskPromoWidget() {
  const itemCount = useInventoryItemCount();
  return <FlipdeskPromoCard itemCount={itemCount} />;
}
