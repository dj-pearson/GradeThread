// US-596: white-label embeddable grade result. Rendered inside a partner
// platform's <iframe> (snippet generated in the API keys → White-label panel),
// so it deliberately carries NO GradeThread app chrome — just a compact,
// brandable condition-grade card. Branding (company name, color, logo, support
// link) comes from query params baked into the iframe src, so a partner needs
// no server call to theme it.
//
// It reads the column-restricted public_grade_reports view (US-348) — the same
// public-safe source the full /cert/:id page uses — so nothing private is ever
// exposed through the embed.
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { GRADE_FACTORS } from "@/lib/constants";
import type { PublicGradeReportRow, SubmissionRow } from "@/types/database";

const BRAND_NAVY = "#0F3460";

function scoreColor(score: number): string {
  if (score > 7) return "#10B981"; // emerald
  if (score >= 5) return "#F59E0B"; // amber
  return "#F03D5F"; // crimson
}

const FACTOR_KEYS = [
  "fabric_condition",
  "structural_integrity",
  "cosmetic_appearance",
  "functional_elements",
  "odor_cleanliness",
] as const;

export function EmbedGradePage() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const [report, setReport] = useState<PublicGradeReportRow | null>(null);
  const [submission, setSubmission] = useState<SubmissionRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const company = params.get("company");
  const logo = params.get("logo");
  const support = params.get("support");
  const color = /^#[0-9a-fA-F]{6}$/.test(params.get("color") ?? "")
    ? (params.get("color") as string)
    : BRAND_NAVY;

  const certUrl =
    typeof window !== "undefined" ? `${window.location.origin}/cert/${id}` : `/cert/${id}`;

  useEffect(() => {
    if (!id) return;
    let active = true;
    (async () => {
      setLoading(true);
      const { data: reportData, error: reportError } = await supabase
        .from("public_grade_reports")
        .select("*")
        .eq("certificate_id", id)
        .single();
      if (!active) return;
      if (reportError || !reportData) {
        setError(true);
        setLoading(false);
        return;
      }
      const r = reportData as PublicGradeReportRow;
      setReport(r);
      const { data: subData } = await supabase
        .from("submissions")
        .select("*")
        .eq("id", r.submission_id)
        .single();
      if (!active) return;
      if (subData) setSubmission(subData as SubmissionRow);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [id]);

  if (loading) {
    return (
      <div className="flex min-h-[200px] items-center justify-center bg-white p-6 text-sm text-slate-500">
        Loading grade…
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="flex min-h-[200px] items-center justify-center bg-white p-6 text-center text-sm text-slate-500">
        This condition grade could not be found.
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white p-4 font-sans text-slate-900">
      <div className="mx-auto max-w-md overflow-hidden rounded-xl border border-slate-200 shadow-sm">
        {/* Partner-branded header */}
        <div className="flex items-center gap-3 px-5 py-4" style={{ backgroundColor: color }}>
          {logo ? (
            // Partner-supplied logo; alt uses the company name when present.
            <img src={logo} alt={company ?? "Partner"} className="h-7 w-auto" />
          ) : (
            <ShieldCheck className="h-6 w-6 text-white" />
          )}
          <div className="text-white">
            <p className="text-sm font-semibold leading-tight">
              {company ?? "Verified Condition Grade"}
            </p>
            <p className="text-[11px] opacity-80">Condition grade</p>
          </div>
        </div>

        <div className="space-y-5 p-5">
          {/* Score + tier */}
          <div className="flex items-center gap-4">
            <div
              className="flex h-20 w-20 flex-shrink-0 items-center justify-center rounded-full border-4"
              style={{ borderColor: scoreColor(report.overall_score) }}
            >
              <span className="text-3xl font-bold" style={{ color: scoreColor(report.overall_score) }}>
                {report.overall_score.toFixed(1)}
              </span>
            </div>
            <div>
              <span
                className="inline-block rounded-full px-2.5 py-0.5 text-xs font-medium"
                style={{ backgroundColor: `${scoreColor(report.overall_score)}1a`, color: scoreColor(report.overall_score) }}
              >
                {report.grade_tier}
              </span>
              {submission && (
                <p className="mt-1 text-sm font-medium">
                  {submission.title}
                  {submission.brand && <span className="text-slate-500"> — {submission.brand}</span>}
                </p>
              )}
              <p className="text-xs text-slate-500">Out of 10.0</p>
            </div>
          </div>

          {/* Factor breakdown */}
          <div className="space-y-2.5">
            {FACTOR_KEYS.map((key) => {
              const factor = GRADE_FACTORS[key];
              const score = report[`${key}_score` as keyof PublicGradeReportRow] as number;
              return (
                <div key={key}>
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium">{factor.label}</span>
                    <span className="tabular-nums" style={{ color: scoreColor(score) }}>
                      {score.toFixed(1)}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${score * 10}%`, backgroundColor: scoreColor(score) }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Attribution — keeps the result independently trustworthy even when
              branded. Links to the full GradeThread certificate. */}
          <div className="flex items-center justify-between border-t border-slate-100 pt-3 text-[11px] text-slate-500">
            <a href={certUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:underline">
              <ShieldCheck className="h-3.5 w-3.5" />
              Verified by GradeThread
            </a>
            {support && (
              <a href={support} target="_blank" rel="noopener noreferrer" className="hover:underline">
                Support
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
