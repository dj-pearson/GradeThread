import { useState } from "react";
import { Loader2, Pencil } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import {
  useBulkEditListings,
  useEbayPolicies,
  type BulkEditFields,
  type BulkEditItem,
} from "@/hooks/use-ebay";
import {
  bulkEditUndoItems,
  unrevertableEditCount,
} from "@/lib/bulk-status-undo";
import { EBAY_CONDITION_OPTIONS } from "@/lib/constants";

interface BulkEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  listingIds: string[];
  /** Called after a successful apply so the caller can clear its selection. */
  onApplied: () => void;
}

// Sentinel for "don't change this field" in the Select controls (Radix Select
// can't use an empty-string value).
const KEEP = "__keep__";

export function BulkEditDialog({
  open,
  onOpenChange,
  listingIds,
  onApplied,
}: BulkEditDialogProps) {
  const policies = useEbayPolicies(open);
  const bulkEdit = useBulkEditListings();

  const [price, setPrice] = useState("");
  const [condition, setCondition] = useState(KEEP);
  const [shippingPolicy, setShippingPolicy] = useState(KEEP);
  const [paymentPolicy, setPaymentPolicy] = useState(KEEP);
  const [returnPolicy, setReturnPolicy] = useState(KEEP);

  const policyList = policies.data?.policies ?? [];
  const fulfillment = policyList.filter((p) => p.policy_type === "fulfillment");
  const payment = policyList.filter((p) => p.policy_type === "payment");
  const returns = policyList.filter((p) => p.policy_type === "return");

  function reset() {
    setPrice("");
    setCondition(KEEP);
    setShippingPolicy(KEEP);
    setPaymentPolicy(KEEP);
    setReturnPolicy(KEEP);
  }

  function close() {
    onOpenChange(false);
  }

  function buildEdit(): BulkEditFields {
    const edit: BulkEditFields = {};
    const priceNum = Number(price);
    if (price.trim() !== "" && Number.isFinite(priceNum) && priceNum > 0) {
      edit.price = Number(priceNum.toFixed(2));
    }
    if (condition !== KEEP) edit.ebay_condition = condition;
    if (shippingPolicy !== KEEP) edit.shipping_policy_id = shippingPolicy;
    if (paymentPolicy !== KEEP) edit.payment_policy_id = paymentPolicy;
    if (returnPolicy !== KEEP) edit.return_policy_id = returnPolicy;
    return edit;
  }

  const edit = buildEdit();
  const hasChanges = Object.keys(edit).length > 0;

  // US-2172: push every edited listing back to its own former value.
  //
  // This is a real marketplace push, not a local rollback, so it reports its
  // own per-row failures rather than implying a clean revert — a listing eBay
  // refuses on the way back is still at the edited value, and the seller needs
  // to know which one.
  async function runUndo(items: BulkEditItem[]) {
    try {
      const back = await bulkEdit.mutateAsync({
        items: items as { listing_id: string; edit: BulkEditFields }[],
      });
      if (back.summary.error === 0 && back.summary.blocked === 0) {
        toast.success(
          `Put ${back.summary.ok} listing${back.summary.ok === 1 ? "" : "s"} back.`,
        );
      } else {
        const firstErr = back.results.find((r) => r.status === "error")?.error;
        toast.warning(
          `Put ${back.summary.ok} back, ${
            back.summary.error + back.summary.blocked
          } couldn't be reverted.${firstErr ? ` First: ${firstErr}` : ""}`,
          { duration: 14_000 },
        );
      }
    } catch (err) {
      toastError(err, "Undo failed.");
    }
  }

  async function runApply() {
    if (!hasChanges || listingIds.length === 0) return;
    try {
      const result = await bulkEdit.mutateAsync({ listingIds, edit });
      const { ok, blocked, error } = result.summary;
      const parts: string[] = [];
      if (blocked > 0) parts.push(`${blocked} locked (eBay-owned)`);
      if (error > 0) parts.push(`${error} failed`);
      const suffix = parts.length > 0 ? ` (${parts.join(", ")})` : "";

      // US-2172: undo. A bulk edit across a selection can rewrite price,
      // condition and three policies at once, and before this the only way back
      // was to remember every row's former value and retype it.
      //
      // The reverse of a bulk edit is NOT another bulk edit: each listing goes
      // back to its own prior value, which is why the endpoint grew a
      // per-listing `items` shape and returns `previous` per row.
      const undoItems = bulkEditUndoItems(result.results);
      const stuck = unrevertableEditCount(result.results);
      const undoAction = undoItems.length > 0
        ? { label: "Undo", onClick: () => void runUndo(undoItems) }
        : undefined;
      // Only worth saying when SOME of the batch is reversible — if none is,
      // there is no Undo button for the number to qualify.
      const stuckNote = undoItems.length > 0 && stuck > 0
        ? ` ${stuck} can't be put back (no prior value recorded).`
        : "";

      if (error === 0 && blocked === 0) {
        toast.success(
          `Updated ${ok} listing${ok === 1 ? "" : "s"}.${stuckNote}`,
          // Longer than a default toast: undo is only useful while on screen.
          { duration: 15_000, action: undoAction },
        );
      } else if (ok === 0) {
        const firstErr = result.results.find((r) => r.status === "error")?.error;
        toast.warning(
          `No listings updated${suffix}.${firstErr ? ` First: ${firstErr}` : ""}`,
          { duration: 12_000 },
        );
      } else {
        toast.warning(`Updated ${ok}${suffix}.${stuckNote}`, {
          duration: 15_000,
          action: undoAction,
        });
      }
      reset();
      onApplied();
      close();
    } catch (err) {
      toastError(err, "Bulk edit failed.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-5 w-5" />
            Bulk edit {listingIds.length} listing
            {listingIds.length === 1 ? "" : "s"}
          </DialogTitle>
          <DialogDescription>
            Only the fields you change are applied. eBay-originated listings lock
            eBay-owned fields and are reported as skipped.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="bulk-price">Set price (each)</Label>
            <Input
              id="bulk-price"
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              placeholder="Leave blank to keep"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="bulk-edit-condition">Condition</Label>
            <Select value={condition} onValueChange={setCondition}>
              <SelectTrigger id="bulk-edit-condition">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={KEEP}>Keep current</SelectItem>
                {EBAY_CONDITION_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {fulfillment.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="bulk-edit-shipping-policy">Shipping policy</Label>
              <Select value={shippingPolicy} onValueChange={setShippingPolicy}>
                <SelectTrigger id="bulk-edit-shipping-policy">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={KEEP}>Keep current</SelectItem>
                  {fulfillment.map((p) => (
                    <SelectItem key={p.policy_id} value={p.policy_id}>
                      {p.policy_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {payment.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="bulk-edit-payment-policy">Payment policy</Label>
              <Select value={paymentPolicy} onValueChange={setPaymentPolicy}>
                <SelectTrigger id="bulk-edit-payment-policy">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={KEEP}>Keep current</SelectItem>
                  {payment.map((p) => (
                    <SelectItem key={p.policy_id} value={p.policy_id}>
                      {p.policy_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {returns.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="bulk-edit-return-policy">Return policy</Label>
              <Select value={returnPolicy} onValueChange={setReturnPolicy}>
                <SelectTrigger id="bulk-edit-return-policy">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={KEEP}>Keep current</SelectItem>
                  {returns.map((p) => (
                    <SelectItem key={p.policy_id} value={p.policy_id}>
                      {p.policy_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={bulkEdit.isPending}>
            Cancel
          </Button>
          <Button onClick={runApply} disabled={!hasChanges || bulkEdit.isPending}>
            {bulkEdit.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Pencil className="mr-2 h-4 w-4" />
            )}
            Apply to {listingIds.length}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
