import { useState } from "react";
import { Plus, Tag } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  useDeleteItemPromotion,
  useEbayConnection,
  useEbayPromotions,
} from "@/hooks/use-ebay";
import { EbayPromotionDialog } from "@/components/flipdesk/ebay-promotion-dialog";

// US-1448 (chunk 1): surface the seller's eBay Promotions Manager item promotions
// (order/volume discounts, coupons, sale events). Self-gates on connection.
//
// US-1979 (AC2): now read-WRITE. Create/edit/end run through the item_promotion
// routes; the card previously told sellers to go and do this in eBay Seller Hub,
// because updateItemPromotion/deleteItemPromotion had no routes at all.

const TYPE_LABEL: Record<string, string> = {
  ORDER_DISCOUNT: "Order discount",
  VOLUME_DISCOUNT: "Volume discount",
  CODED_COUPON: "Coupon",
  MARKDOWN_SALE: "Sale (markdown)",
};

// The types this card can create/edit. MARKDOWN_SALE is a different eBay product
// with its own endpoints (item_price_markdown_promotion) — it is shown, since the
// seller has it, but editing it here would silently target the wrong API.
const EDITABLE_TYPES = new Set(["ORDER_DISCOUNT", "VOLUME_DISCOUNT", "CODED_COUPON"]);

function typeLabel(t: string | null): string {
  if (!t) return "Promotion";
  return TYPE_LABEL[t] ?? t.replace(/_/g, " ").toLowerCase();
}

function statusVariant(s: string | null): "default" | "secondary" | "outline" {
  if (s === "RUNNING") return "default";
  if (s === "SCHEDULED") return "secondary";
  return "outline";
}

export function EbayPromotionsCard() {
  const { data: connection } = useEbayConnection();
  const connected = !!connection;
  const { data, isLoading } = useEbayPromotions(connected);
  const del = useDeleteItemPromotion();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState<{ id: string; name: string } | null>(null);

  if (!connected) return null;
  if (isLoading || !data) return null;
  if (data.access === false) return null;

  const promotions = data.promotions ?? [];

  const openCreate = () => {
    setEditingId(null);
    setDialogOpen(true);
  };
  const openEdit = (id: string) => {
    setEditingId(id);
    setDialogOpen(true);
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Tag className="h-4 w-4" />
                eBay promotions
              </CardTitle>
              <CardDescription>
                Order and volume discounts, coupons and sale events, running through
                eBay Promotions Manager.
              </CardDescription>
            </div>
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-1 h-4 w-4" />
              New
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {promotions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No promotions yet. Create an order discount, volume pricing or a coupon
              for your live eBay listings.
            </p>
          ) : (
            <ul className="divide-y">
              {promotions.map((p) => {
                const editable = EDITABLE_TYPES.has(p.promotionType ?? "");
                return (
                  <li
                    key={p.promotionId}
                    className="flex items-center justify-between gap-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">
                        {p.name ?? typeLabel(p.promotionType)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {typeLabel(p.promotionType)}
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                      {p.promotionStatus && (
                        <Badge variant={statusVariant(p.promotionStatus)}>
                          {p.promotionStatus.toLowerCase()}
                        </Badge>
                      )}
                      {editable && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => openEdit(p.promotionId)}
                            aria-label={`Edit ${p.name ?? typeLabel(p.promotionType)}`}
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            aria-label={`End ${p.name ?? typeLabel(p.promotionType)}`}
                            onClick={() =>
                              setConfirmEnd({
                                id: p.promotionId,
                                name: p.name ?? typeLabel(p.promotionType),
                              })
                            }
                          >
                            End
                          </Button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <EbayPromotionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        promotionId={editingId}
      />

      {/* Ending a promotion is irreversible on eBay and immediately removes the
          discount buyers currently see, so it gets a confirm rather than a
          one-click destructive button in a list. */}
      <AlertDialog
        open={!!confirmEnd}
        onOpenChange={(o) => !o && setConfirmEnd(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End this promotion?</AlertDialogTitle>
            <AlertDialogDescription>
              “{confirmEnd?.name}” will stop on eBay right away and buyers will no
              longer get the discount. This can't be undone — you'd need to create a
              new promotion.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmEnd) del.mutate(confirmEnd.id);
                setConfirmEnd(null);
              }}
            >
              End promotion
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
