import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Ruler } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { measurementGroupFor } from "@/lib/measurement-templates";
import { normalizeBodyMeasurements, type BodyProfile } from "@/lib/body-profile";
import { predictFit, fitVerdictLabel, type FitResult, type FitVerdict } from "@/lib/fit-model";
import type { BodyProfileRow } from "@/types/database";

// US-1779: reusable "Will it fit?" widget. Given a garment's flat-lay
// measurements + category, loads the signed-in buyer's saved body profiles
// (US-1777, RLS) and runs the deterministic fit engine (US-1778). Renders
// nothing when the item has no measurements. The result is ALWAYS framed as an
// estimate with limits disclosed. Drop-in for the FlipDesk item canvas today;
// reusable on public cert/passport surfaces once measurements are exposed there.

const VERDICT_TONE: Record<FitVerdict, string> = {
  too_small: "text-brand-red-text",
  slim: "text-amber-600 dark:text-amber-400",
  true: "text-emerald-600 dark:text-emerald-400",
  relaxed: "text-amber-600 dark:text-amber-400",
  too_big: "text-brand-red-text",
};

function coerceNumbers(m: Record<string, number | string> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(m ?? {})) {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}

export function FitWidget({
  garmentMeasurements,
  category,
}: {
  garmentMeasurements: Record<string, number | string> | null | undefined;
  category: string | null | undefined;
}) {
  const userId = useAuthStore((s) => s.user?.id) ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const garment = useMemo(() => coerceNumbers(garmentMeasurements), [garmentMeasurements]);
  const group = measurementGroupFor(category ?? "");

  const { data: profiles = [], isLoading } = useQuery<BodyProfile[]>({
    queryKey: ["body-profiles", userId],
    enabled: Boolean(userId) && Object.keys(garment).length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("body_profiles")
        .select("id, name, measurements, is_default")
        .order("is_default", { ascending: false });
      if (error) throw error;
      return (data as Pick<BodyProfileRow, "id" | "name" | "measurements" | "is_default">[]).map((r) => ({
        id: r.id,
        name: r.name,
        measurements: normalizeBodyMeasurements(r.measurements),
        is_default: r.is_default,
      }));
    },
  });

  // The widget only appears when the item actually has measurements (AC1).
  if (Object.keys(garment).length === 0) return null;

  const profile = profiles.find((p) => p.id === selectedId) ?? profiles.find((p) => p.is_default) ?? profiles[0] ?? null;
  const result: FitResult | null = profile ? predictFit(group, garment, profile.measurements) : null;

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2">
        <Ruler className="h-4 w-4 text-brand-navy dark:text-foreground" />
        <p className="text-sm font-semibold">Will it fit?</p>
        {profiles.length > 1 && (
          <select
            aria-label="Body profile"
            className="ml-auto rounded border bg-background px-2 py-1 text-xs"
            value={profile?.id ?? ""}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {!userId ? (
        <p className="mt-3 text-sm text-muted-foreground">
          <Link className="text-brand-navy underline dark:text-foreground" to="/login">
            Sign in
          </Link>{" "}
          and save your measurements to check fit.
        </p>
      ) : isLoading ? (
        <div className="mt-3 flex justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : !profile ? (
        <p className="mt-3 text-sm text-muted-foreground">
          <Link className="text-brand-navy underline dark:text-foreground" to="/dashboard/measurements">
            Add your measurements
          </Link>{" "}
          to see if this item will fit you.
        </p>
      ) : result && result.status === "ok" && result.verdict ? (
        <>
          <div className="mt-3 flex items-baseline gap-2">
            <span className={`text-xl font-bold ${VERDICT_TONE[result.verdict]}`}>
              {fitVerdictLabel(result.verdict)}
            </span>
            <span className="text-sm text-muted-foreground">
              · {result.sizeRecommendation}
            </span>
          </div>
          {result.limitingDimension && (
            <p className="mt-1 text-xs text-muted-foreground">
              Limiting dimension: {result.dimensions.find((d) => d.dimension === result.limitingDimension)?.label}
            </p>
          )}
          <dl className="mt-3 grid gap-1 text-xs sm:grid-cols-2">
            {result.dimensions.map((d) => (
              <div key={d.dimension} className="flex items-center justify-between gap-2 rounded border px-2 py-1">
                <dt className="text-muted-foreground">{d.label}</dt>
                <dd className={`font-medium ${VERDICT_TONE[d.verdict]}`}>{fitVerdictLabel(d.verdict)}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">
            An estimate from the item's flat measurements vs your saved body measurements —
            not a guarantee. Cut, fabric stretch, and personal preference all affect real fit.
            {Math.round(result.confidence * 100)}% confidence from {result.dimensions.length} dimension
            {result.dimensions.length === 1 ? "" : "s"}.
          </p>
        </>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          {result?.reason ?? "Not enough shared measurements to check fit."}{" "}
          <Link className="text-brand-navy underline dark:text-foreground" to="/dashboard/measurements">
            Add more measurements
          </Link>
          .
        </p>
      )}
    </div>
  );
}
