import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Zap, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
import { edgeFetch } from "@/lib/edge-fetch";

// US-1792: B2B API overage credits. When a key exceeds its monthly quota, each
// further call draws down these prepaid, never-expiring credits instead of 429.
// Mirrors the edge API_OVERAGE_PACKS (volume discount).
const PACKS: Array<{ key: "10" | "50" | "100" | "200"; price: string; credits: number }> = [
  { key: "10", price: "$10", credits: 2_500 },
  { key: "50", price: "$50", credits: 14_000 },
  { key: "100", price: "$100", credits: 30_000 },
  { key: "200", price: "$200", credits: 65_000 },
];

export function ApiOverageCard() {
  const { user } = useAuth();
  const [pending, setPending] = useState<string | null>(null);

  const { data: balance } = useQuery<number>({
    queryKey: ["api-credit-balance", user?.id],
    enabled: !!user?.id,
    staleTime: 60_000,
    queryFn: async () => {
      const { data } = await supabase
        .from("api_credit_wallet")
        .select("balance")
        .eq("user_id", user!.id)
        .maybeSingle();
      return (data?.balance as number | undefined) ?? 0;
    },
  });

  async function buy(pack: string) {
    setPending(pack);
    try {
      const res = await edgeFetch("/api/payments/api-overage/checkout", {
        method: "POST",
        json: { pack },
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to start checkout");
        return;
      }
      if (json.url) window.location.href = json.url;
    } catch {
      toast.error("Failed to start checkout");
    } finally {
      setPending(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="h-5 w-5" />
          API overage credits
        </CardTitle>
        <CardDescription>
          Balance: <span className="font-medium text-foreground">{(balance ?? 0).toLocaleString()}</span> credits.
          Beyond your monthly quota, each API call spends 1 credit instead of failing. Credits never expire.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-4">
        {PACKS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => buy(p.key)}
            disabled={pending !== null}
            className="flex flex-col items-center rounded-lg border p-4 text-center transition hover:border-primary hover:bg-accent disabled:opacity-60"
          >
            <span className="text-lg font-bold">{p.price}</span>
            <span className="text-xs text-muted-foreground">{p.credits.toLocaleString()} credits</span>
            {pending === p.key && <Loader2 className="mt-1 h-4 w-4 animate-spin" />}
          </button>
        ))}
      </CardContent>
    </Card>
  );
}
