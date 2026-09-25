import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { useEbayPolicies } from "@/hooks/use-ebay";

type EbayPolicies = NonNullable<ReturnType<typeof useEbayPolicies>["data"]>;
export interface PoliciesCardProps {
  ebayPolicies: EbayPolicies | undefined;
  shippingPolicyId: string | null;
  setShippingPolicyId: (id: string | null) => void;
  paymentPolicyId: string | null;
  setPaymentPolicyId: (id: string | null) => void;
  returnPolicyId: string | null;
  setReturnPolicyId: (id: string | null) => void;
}
type PolicyRow = EbayPolicies["policies"][number];

export interface PolicySelectRowProps {
  id: string;
  label: string;
  type: PolicyRow["policy_type"];
  /** The chosen policy id, or null for the account default. */
  value: string | null;
  onChange: (id: string | null) => void;
  /** The seller's policies, or undefined while they have not loaded. */
  policies: readonly PolicyRow[] | undefined;
  /** The empty option's text. */
  defaultLabel: string;
  /** Mark the policy eBay treats as the account default with "(eBay default)". */
  markDefault?: boolean;
}

/**
 * One business-policy Select: the account-default option plus the seller's
 * policies of one type. Shared by the composer's PoliciesCard and the listing
 * template editor. A stored id that is not among the loaded policies stays
 * selectable as "Policy not found on eBay", so reopening a row never silently
 * swaps it for the default.
 */
export function PolicySelectRow({
  id,
  label,
  type,
  value,
  onChange,
  policies,
  defaultLabel,
  markDefault = false,
}: PolicySelectRowProps) {
  const options = (policies ?? []).filter((p) => p.policy_type === type);
  // Only once the list is in: before that every stored id would read as gone.
  const missing =
    policies !== undefined && value !== null && !options.some((p) => p.policy_id === value);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value ?? "__default"}
        onValueChange={(v) => onChange(v === "__default" ? null : v)}
      >
        <SelectTrigger id={id} aria-invalid={missing || undefined}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__default">{defaultLabel}</SelectItem>
          {options.map((p) => (
            <SelectItem key={p.policy_id} value={p.policy_id}>
              {markDefault && p.is_default ? `${p.policy_name} (eBay default)` : p.policy_name}
            </SelectItem>
          ))}
          {missing && (
            <SelectItem value={value}>Policy not found on eBay (id {value})</SelectItem>
          )}
        </SelectContent>
      </Select>
      {missing && (
        <p className="text-xs text-destructive">
          This policy is not on your eBay account any more. Pick another one.
        </p>
      )}
    </div>
  );
}

// US-2251: per-listing eBay business policies. Bulk-edit could set these and
// publish has always honoured them, but the single-item composer couldn't — so
// shipping and returns for one item meant a detour through bulk edit or Seller
// Hub. NULL = account default, which is exactly what publish falls back to.
export function PoliciesCard({
  ebayPolicies,
  shippingPolicyId,
  setShippingPolicyId,
  paymentPolicyId,
  setPaymentPolicyId,
  returnPolicyId,
  setReturnPolicyId,
}: PoliciesCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Shipping &amp; returns</CardTitle>
        <CardDescription>
          Which of your eBay business policies this listing uses. Leave
          them on your account default unless this item needs different
          terms.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-3">
        {(
          [
            {
              id: "policy-shipping",
              label: "Shipping",
              type: "fulfillment" as const,
              value: shippingPolicyId,
              set: setShippingPolicyId,
            },
            {
              id: "policy-payment",
              label: "Payment",
              type: "payment" as const,
              value: paymentPolicyId,
              set: setPaymentPolicyId,
            },
            {
              id: "policy-return",
              label: "Returns",
              type: "return" as const,
              value: returnPolicyId,
              set: setReturnPolicyId,
            },
          ]
        ).map((row) => {
          return (
            <PolicySelectRow
              key={row.id}
              id={row.id}
              label={row.label}
              type={row.type}
              value={row.value}
              onChange={row.set}
              policies={ebayPolicies?.policies}
              defaultLabel="Use account default"
            />
          );
        })}
        {(ebayPolicies?.policies ?? []).length === 0 && (
          <p className="text-xs text-muted-foreground sm:col-span-3">
            No business policies loaded yet. Create them in eBay Seller
            Hub, then reconnect on the Marketplaces page.
          </p>
        )}
      </CardContent>
    </Card>
  );
}