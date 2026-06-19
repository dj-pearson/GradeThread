import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { History, Loader2, XCircle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SEO } from "@/components/seo";
import { supabase } from "@/lib/supabase";
import { edgeApiUrl } from "@/lib/edge-api";

// US-1096: public physical-tag scan landing (/t/:code). Resolves a scanned tag
// to its Garment Passport, then offers to view the timeline or claim the item
// (deterministic Layer-1 handoff). Kept outside /passport/* so it's a pure SPA
// route (no SSR Function); noindex.

type State =
  | { phase: "resolving" }
  | { phase: "resolved"; slug: string }
  | { phase: "claiming" }
  | { phase: "error"; message: string };

export function TagScanPage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ phase: "resolving" });

  useEffect(() => {
    if (!code) {
      setState({ phase: "error", message: "This tag link is missing its code." });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${edgeApiUrl()}/api/passport/tag/${encodeURIComponent(code)}`);
        if (res.status === 404) {
          if (!cancelled) setState({ phase: "error", message: "This tag is invalid or has been revoked." });
          return;
        }
        if (!res.ok) throw new Error(`resolve failed: ${res.status}`);
        const json = (await res.json()) as { passport_slug: string };
        if (!cancelled) setState({ phase: "resolved", slug: json.passport_slug });
      } catch {
        if (!cancelled) setState({ phase: "error", message: "Couldn't read this tag. Please try again." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  const claim = useCallback(async () => {
    if (!code) return;
    setState({ phase: "claiming" });
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
      const res = await fetch(`${edgeApiUrl()}/api/passport/tag/${encodeURIComponent(code)}/claim`, {
        method: "POST",
        headers,
        body: "{}",
      });
      if (!res.ok) throw new Error(`claim failed: ${res.status}`);
      const json = (await res.json()) as { passport_slug?: string | null };
      if (json.passport_slug) {
        navigate(`/passport/${json.passport_slug}`);
      } else {
        setState({ phase: "error", message: "Claimed, but couldn't open the passport." });
      }
    } catch {
      setState({ phase: "error", message: "Couldn't claim this item. Please try again." });
    }
  }, [code, navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-12">
      <SEO title="Garment Passport Tag" noindex />
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center gap-4 p-8 text-center">
          {state.phase === "resolving" || state.phase === "claiming" ? (
            <>
              <Loader2 className="h-10 w-10 animate-spin text-brand-navy" />
              <h1 className="text-xl font-bold">
                {state.phase === "claiming" ? "Claiming this item…" : "Reading tag…"}
              </h1>
            </>
          ) : state.phase === "resolved" ? (
            <>
              <ShieldCheck className="h-12 w-12 text-brand-navy dark:text-blue-300" />
              <h1 className="text-xl font-bold">Garment Passport</h1>
              <p className="text-muted-foreground">
                This item has a verified provenance history. View it, or claim the
                item to become its current owner on the chain.
              </p>
              <div className="mt-2 flex w-full flex-col gap-2">
                <Button asChild variant="outline">
                  <Link to={`/passport/${state.slug}`}>
                    <History className="mr-2 h-4 w-4" />
                    View the passport
                  </Link>
                </Button>
                <Button onClick={claim}>Claim this item</Button>
              </div>
            </>
          ) : (
            <>
              <XCircle className="h-12 w-12 text-brand-red" />
              <h1 className="text-xl font-bold">Tag not available</h1>
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
