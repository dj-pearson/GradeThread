import { useQuery } from "@tanstack/react-query";
import { Leaf } from "lucide-react";
import { fetchGarmentImpact, formatCo2e, formatWater } from "@/lib/impact";

// US-1787: per-grade circularity impact line for the certificate. Shows the
// estimated impact avoided by buying THIS item secondhand vs new, for its
// garment type. Always labelled an estimate. Renders nothing for an unknown type.

export function CertImpactLine({ garmentType }: { garmentType: string | null | undefined }) {
  const { data } = useQuery({
    queryKey: ["cert-impact", garmentType],
    enabled: Boolean(garmentType),
    queryFn: () => fetchGarmentImpact(garmentType as string),
    staleTime: 24 * 60 * 60 * 1000,
  });

  if (!data) return null;

  return (
    <div className="mt-4 flex items-start gap-2 rounded-lg border bg-emerald-50/50 p-3 dark:bg-emerald-950/20">
      <Leaf className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600 dark:text-emerald-400" />
      <div>
        <p className="text-sm">
          Buying this secondhand instead of new avoids an estimated{" "}
          <strong>{formatCo2e(data.co2e_kg)}</strong> and{" "}
          <strong>{formatWater(data.water_liters)}</strong>.
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          A rough figure, worked out from published studies of how clothing is
          made. It shows the size of the saving, not an exact number.
        </p>
      </div>
    </div>
  );
}
