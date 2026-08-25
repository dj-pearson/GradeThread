import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Droplets, Leaf, Recycle, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { summarizeClosetImpact, formatCo2e, formatWater, formatLandfill } from "@/lib/impact";

// US-1787: "your resale diverted X" aggregate tile. Counts the signed-in user's
// GRADED garments by type (RLS-scoped client read) and sums the per-type impact
// (public endpoint) into a closet total — no authed server aggregation. Every
// figure is an estimate with a methodology note. Renders nothing until the user
// has graded at least one item.

export function ImpactTile({ shareUtm = "dashboard" }: { shareUtm?: string }) {
  const userId = useAuthStore((s) => s.user?.id) ?? null;

  const { data: counts } = useQuery<Record<string, number>>({
    queryKey: ["impact-garment-counts", userId],
    enabled: Boolean(userId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("submissions")
        .select("garment_type")
        .eq("status", "completed");
      if (error) throw error;
      const map: Record<string, number> = {};
      for (const r of (data as Array<{ garment_type: string | null }>) ?? []) {
        if (r.garment_type) map[r.garment_type] = (map[r.garment_type] ?? 0) + 1;
      }
      return map;
    },
  });

  const { data: summary } = useQuery({
    queryKey: ["impact-summary", counts],
    enabled: Boolean(counts && Object.keys(counts).length > 0),
    queryFn: () => summarizeClosetImpact(counts as Record<string, number>),
    staleTime: 60 * 60 * 1000,
  });

  const shareText = useMemo(() => {
    if (!summary) return "";
    return `My graded closet has diverted ${summary.garment_count} items and an estimated ${formatCo2e(summary.co2e_kg)} from buying new — via GradeThread.`;
  }, [summary]);

  if (!userId || !summary || summary.garment_count === 0) return null;

  async function onShare() {
    const origin = typeof window !== "undefined" ? window.location.origin : "https://gradethread.com";
    const url = `${origin}/?utm_source=impact&utm_medium=${encodeURIComponent(shareUtm)}`;
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (typeof nav.share === "function") {
      try {
        await nav.share({ title: "My GradeThread impact", text: shareText, url });
        return;
      } catch {
        /* dismissed */
      }
    }
    try {
      await navigator.clipboard.writeText(`${shareText} ${url}`);
    } catch {
      /* clipboard blocked */
    }
  }

  const stats = [
    { icon: Leaf, label: formatCo2e(summary.co2e_kg), tone: "text-emerald-600 dark:text-emerald-400" },
    { icon: Droplets, label: formatWater(summary.water_liters), tone: "text-sky-600 dark:text-sky-400" },
    { icon: Recycle, label: formatLandfill(summary.landfill_kg), tone: "text-amber-600 dark:text-amber-400" },
  ];

  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Your circularity impact</p>
          <p className="text-xs text-muted-foreground">
            Estimated impact avoided by keeping {summary.garment_count} graded item
            {summary.garment_count === 1 ? "" : "s"} in use instead of buying new.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void onShare()}>
          <Share2 className="mr-1 h-4 w-4" /> Share
        </Button>
      </div>
      <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {stats.map((s) => (
          <div key={s.label} className="flex items-center gap-2 rounded-lg border p-3">
            <s.icon className={`h-5 w-5 flex-shrink-0 ${s.tone}`} />
            <dd className="text-sm font-semibold">{s.label}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-[11px] text-muted-foreground">
        Rough figures, worked out from published studies of how clothing is
        made. They show the size of the saving, not exact numbers.
      </p>
    </div>
  );
}
