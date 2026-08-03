import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { CheckCircle2, History, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SEO } from "@/components/seo";
import { supabase } from "@/lib/supabase";
import { edgeApiUrl } from "@/lib/edge-api";

// US-1094: public ownership-claim page. A buyer who received a graded item opens
// /claim/:token (link or QR), claims the passport, and ownership transfers to a
// new pseudonymous node. No account is required; if the visitor happens to be
// signed in we forward their bearer token so the new node can be linked to their
// account (a uuid linkage only — never any PII). The claim route lives OUTSIDE
// /passport/* so it stays a pure SPA flow (no SSR Pages Function).

type ClaimState =
  | { phase: "idle" }
  | { phase: "claiming" }
  | { phase: "done"; slug: string | null }
  | { phase: "error"; message: string };

export function PassportClaimPage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<ClaimState>({ phase: "idle" });

  const claim = useCallback(async () => {
    if (!token) {
      setState({ phase: "error", message: "This claim link is missing its token." });
      return;
    }
    setState({ phase: "claiming" });
    try {
      // Optional account association — forward the session bearer if signed in.
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

      const res = await fetch(`${edgeApiUrl()}/api/passport/claim`, {
        method: "POST",
        headers,
        body: JSON.stringify({ token }),
      });
      if (res.status === 410) {
        setState({
          phase: "error",
          message: "This claim link is invalid, expired, or has already been used.",
        });
        return;
      }
      if (!res.ok) throw new Error(`claim failed: ${res.status}`);
      const json = (await res.json()) as { ok?: boolean; passport_slug?: string | null };
      setState({ phase: "done", slug: json.passport_slug ?? null });
    } catch {
      setState({
        phase: "error",
        message: "Something went wrong claiming this passport. Please try again.",
      });
    }
  }, [token]);

  // Guard double-submits in React Strict Mode: claim once on mount.
  useEffect(() => {
    void claim();
  }, [claim]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-12">
      <SEO title="Claim Garment Passport" noindex />
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center gap-4 p-8 text-center">
          {state.phase === "claiming" || state.phase === "idle" ? (
            <>
              <Loader2 className="h-10 w-10 animate-spin text-brand-navy" />
              <h1 className="text-xl font-bold">Claiming this passport…</h1>
              <p className="text-muted-foreground">
                Transferring ownership to you. This only takes a moment.
              </p>
            </>
          ) : state.phase === "done" ? (
            <>
              <CheckCircle2 className="h-12 w-12 text-emerald-600" />
              <h1 className="text-xl font-bold">Passport claimed</h1>
              <p className="text-muted-foreground">
                You're now the current owner on this garment's provenance chain.
                The public timeline reflects the transfer.
              </p>
              {state.slug && (
                <Button asChild className="mt-2">
                  <Link to={`/passport/${state.slug}`}>
                    <History className="mr-2 h-4 w-4" />
                    View the passport
                  </Link>
                </Button>
              )}
            </>
          ) : (
            <>
              <XCircle className="h-12 w-12 text-brand-red-text" />
              <h1 className="text-xl font-bold">Couldn't claim this passport</h1>
              <p className="text-muted-foreground">{state.message}</p>
              <Link
                to="/"
                className="mt-2 text-sm font-medium text-brand-navy hover:underline dark:text-blue-400"
              >
                ← Back to GradeThread
              </Link>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
