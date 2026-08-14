// US-596: white-label embeddable grade result — a compact, brandable
// condition-grade card that deliberately carries NO GradeThread app chrome.
// Branding (company name, color, logo, support link) comes from query params, so
// a partner needs no server call to theme it.
//
// US-1936: the partner-facing embed is now delivered as a script WIDGET
// (functions/embed/grade/[id].ts), not an iframe — the zone's global
// X-Frame-Options: DENY + frame-ancestors 'none' block cross-site framing. This
// SPA route survives as the standalone TOP-LEVEL view (e.g. opening the embed
// URL directly), where framing restrictions don't apply; the widget renders the
// same card server-side. Keep the two in visual/validation lockstep.
//
// It reads the column-restricted public_grade_reports view (US-348) — the same
// public-safe source the full /cert/:id page uses — so nothing private is ever
// exposed through the embed.
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { History, RefreshCw, ShieldCheck } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { GRADE_FACTORS, SCORE_STOP } from "@/lib/constants";
import { safeEmbedUrl, safeEmbedCompany } from "@/lib/return-to";
import { SEO } from "@/components/seo";
import { AiDisclosure } from "@/components/grade/ai-disclosure";
import type { PublicGradeReportRow, SubmissionRow } from "@/types/database";

const BRAND_NAVY = "#0F3460";

function scoreColor(score: number): string {
  if (score > 7) return SCORE_STOP.high; // emerald
  if (score >= 5) return SCORE_STOP.mid; // amber
  return SCORE_STOP.low; // AA-safe brand red
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
  const [passportSlug, setPassportSlug] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // US-2549: the one branding value that used to pass straight through. See
  // safeEmbedCompany for what it strips and why a text-only field still
  // matters on a page carrying our domain.
  const company = safeEmbedCompany(params.get("company"));
  // US-1925: logo/support ride in the attacker-craftable iframe URL and land in
  // an image src or an anchor href. Restrict to absolute https so a GradeThread-
  // card can't carry a javascript:/data: payload or a phishing Support link;
  // an invalid value drops the image/link rather than rendering it.
  const logo = safeEmbedUrl(params.get("logo"));
  const support = safeEmbedUrl(params.get("support"));
  const color = /^#[0-9a-fA-F]{6}$/.test(params.get("color") ?? "")
    ? (params.get("color") as string)
    : BRAND_NAVY;

  const certUrl =
    typeof window !== "undefined" ? `${window.location.origin}/cert/${id}` : `/cert/${id}`;

  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!id) return;
    let active = true;
    (async () => {
      setLoading(true);
      setError(false);
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
      // US-1095: surface the Garment Passport link when the cert is chain-linked.
      const { data: passportLink } = await supabase
        .from("public_passport_links")
        .select("passport_slug")
        .eq("certificate_id", id)
        .maybeSingle();
      if (active && passportLink) {
        setPassportSlug((passportLink as { passport_slug: string }).passport_slug);
      }
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [id, reloadKey]);

  // The skeleton is hand-rolled rather than the shared <Skeleton>: this card
  // is deliberately on a fixed light palette (see the header comment), and the
  // shared one is themed, so it would vanish or invert here.
  if (loading) {
    return (
      <>
        <EmbedSEO />
        <div className="min-h-screen bg-white p-4 font-sans">
          <div
            className="mx-auto max-w-md overflow-hidden rounded-xl border border-slate-200 shadow-sm"
            role="status"
            aria-live="polite"
            aria-busy="true"
          >
            <span className="sr-only">Loading this condition grade</span>
            <div className="h-[60px] animate-pulse bg-slate-200" aria-hidden="true" />
            <div className="space-y-5 p-5" aria-hidden="true">
              <div className="flex items-center gap-4">
                <div className="h-20 w-20 flex-shrink-0 animate-pulse rounded-full bg-slate-200" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-24 animate-pulse rounded bg-slate-200" />
                  <div className="h-4 w-40 animate-pulse rounded bg-slate-200" />
                </div>
              </div>
              <div className="space-y-3">
                {FACTOR_KEYS.map((key) => (
                  <div key={key} className="space-y-1.5">
                    <div className="h-3 w-32 animate-pulse rounded bg-slate-200" />
                    <div className="h-1.5 w-full animate-pulse rounded-full bg-slate-100" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }

  if (error || !report) {
    return (
      <>
        <EmbedSEO />
        <div className="min-h-screen bg-white p-4 font-sans text-slate-900">
          <div className="mx-auto max-w-md space-y-3 rounded-xl border border-slate-200 p-6 text-center shadow-sm">
            <p className="text-sm font-medium">
              This condition grade could not be loaded.
            </p>
            <p className="text-xs text-slate-500">
              The certificate may have been removed, or the connection dropped on
              the way. Trying again is usually enough.
            </p>
            <div className="flex items-center justify-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => setReloadKey((k) => k + 1)}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Try again
              </button>
              <a
                href="https://gradethread.com"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-slate-700 hover:underline"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                What is GradeThread?
              </a>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
    <EmbedSEO />
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

          {/* US-1095: Garment Passport link — lets a buyer open the full
              provenance history (and claim the item after purchase). */}
          {passportSlug && (
            <a
              href={
                typeof window !== "undefined"
                  ? `${window.location.origin}/passport/${passportSlug}`
                  : `/passport/${passportSlug}`
              }
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-2 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
            >
              <History className="h-3.5 w-3.5" />
              View Garment Passport — full history
            </a>
          )}

          {/* US-2399: AI disclosure. The embed is the surface a BUYER meets on a
              partner's own site, furthest from our Terms — so the disclosure has
              to travel with the grade rather than live a click away. Same shared
              copy as the certificate page. */}
          <AiDisclosure humanReviewed={report.human_reviewed} variant="inline" />

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
    </>
  );
}

/**
 * US-2549: the indexing decision, stated in the page.
 *
 * The REAL mechanism is the `x-robots-tag: noindex, nofollow` header that
 * functions/_shared/spa-shell.ts puts on every SPA-shell response, and this
 * URL is served by that shell (functions/embed/grade/[id].ts delegates any
 * non-`.js` request to it). A header outranks a meta tag and cannot be lost to
 * a template change, so do NOT remove it in favour of this component.
 *
 * This is here for the second reader: the page is a thin duplicate of
 * /cert/:id, and a public route with no stated indexing decision is how one
 * quietly becomes indexable when its serving path changes.
 */
function EmbedSEO() {
  return <SEO title="Condition grade" noindex />;
}
