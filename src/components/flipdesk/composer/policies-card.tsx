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
          const options = (ebayPolicies?.policies ?? []).filter(
            (p) => p.policy_type === row.type,
          );
          return (
            <div key={row.id} className="space-y-1.5">
              <Label htmlFor={row.id}>{row.label}</Label>
              <Select
                value={row.value ?? "__default"}
                onValueChange={(v) =>
                  row.set(v === "__default" ? null : v)
                }
              >
                <SelectTrigger id={row.id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default">
                    Use account default
                  </SelectItem>
                  {options.map((p) => (
                    <SelectItem key={p.policy_id} value={p.policy_id}>
                      {p.policy_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
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