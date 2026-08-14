import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { History, Loader2, LogIn, XCircle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { SEO } from "@/components/seo";
import { supabase } from "@/lib/supabase";
import { edgeApiUrl } from "@/lib/edge-api";
import { useAuthStore } from "@/stores/auth-store";
import { claimFailureMessage } from "@/lib/claim-failure";

// US-1096: public physical-tag scan landing (/t/:code). Resolves a scanned tag
// to its Garment Passport, then offers to view the timeline or claim the item
// (deterministic Layer-1 handoff). Kept outside /passport/* so it's a pure SPA
// route (no SSR Function); noindex.
//
// US-2551: claiming now requires an account. The tag is still what AUTHORISES a
// claim — the account is what signs it. Before this, the page offered "Claim
// this item" to anyone who scanned a rack in a shop, sent the POST with no
// Authorization header when signed out, and the server took it: the chain moved
// to a new pseudonymous owner with nothing on the transfer to trace it by. See
// the route comment in services/edge-functions/src/routes/passport.ts.

type State =
  | { phase: "resolving" }
  | { phase: "resolved"; slug: string }
  | { phase: "claiming" }
  // `retry` names WHICH request failed. Without it the Try again button on a
  // failed tag READ would have fired a CLAIM — a different, irreversible
  // request than the one that went wrong.
  | { phase: "error"; message: string; retry?: "resolve" | "claim" };

export function TagScanPage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const [state, setState] = useState<State>({ phase: "resolving" });

  const resolveTag = useCallback(async () => {
    if (!code) {
      setState({ phase: "error", message: "This tag link is missing its code." });
      return;
    }
    setState({ phase: "resolving" });
    try {
      const res = await fetch(`${edgeApiUrl()}/api/passport/tag/${encodeURIComponent(code)}`);
      if (res.status === 404) {
        setState({ phase: "error", message: "This tag is invalid or has been revoked." });
        return;
      }
      if (!res.ok) throw new Error(`resolve failed: ${res.status}`);
      const json = (await res.json()) as { passport_slug: string };
      setState({ phase: "resolved", slug: json.passport_slug });
    } catch {
      setState({
        phase: "error",
        message: "We couldn't reach GradeThread to read this tag.",
        retry: "resolve",
      });
    }
  }, [code]);

  useEffect(() => {
    void resolveTag();
  }, [resolveTag]);

  const claim = useCallback(async () => {
    if (!code) return;
    setState({ phase: "claiming" });
    let status: number | null = null;
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
      status = res.status;
      if (!res.ok) throw new Error(`claim failed: ${res.status}`);
      const json = (await res.json()) as { passport_slug?: string | null };
      if (json.passport_slug) {
        navigate(`/passport/${json.passport_slug}`);
      } else {
        setState({ phase: "error", message: "Claimed, but couldn't open the passport." });
      }
    } catch {
      // The status is what separates "sign in" from "try again" — without it
      // the page gave the same advice to a signed-out visitor, a revoked tag
      // and a dropped connection.
      const { message, canRetry } = claimFailureMessage(status);
      setState({ phase: "error", message, retry: canRetry ? "claim" : undefined });
    }
  }, [code, navigate]);

  const signInHref = `/login?next=${encodeURIComponent(`/t/${code ?? ""}`)}`;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-12">
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
                This item has a verified provenance history. View it, or — if you
                own the item — claim it to become its current owner on the chain.
              </p>
              <div className="mt-2 flex w-full flex-col gap-2">
                <Button asChild variant="outline">
                  <Link to={`/passport/${state.slug}`}>
                    <History className="mr-2 h-4 w-4" />
                    View the passport
                  </Link>
                </Button>
                {user ? (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button>Claim this item</Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          Claim this item as its owner?
                        </AlertDialogTitle>
                        {/* One unconfirmed click used to move the chain. Say what
                            it does before it happens, in the terms that matter:
                            it is public, it names the previous owner as past,
                            and it does not undo itself. */}
                        <AlertDialogDescription asChild>
                          <div className="space-y-2 text-left">
                            <p>
                              This records you as the current owner on the
                              garment&apos;s public provenance chain, and moves the
                              previous owner into its history.
                            </p>
                            <p>
                              Only claim an item you actually own. The transfer is
                              recorded against your account and cannot be undone
                              from here.
                            </p>
                          </div>
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={claim}>
                          Yes, I own this item
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                ) : (
                  <>
                    {/* Signed out, the honest button is the one that works. The
                        old one posted with no auth header and the server took
                        it, which is the whole reason this story exists. */}
                    <Button asChild>
                      <Link to={signInHref}>
                        <LogIn className="mr-2 h-4 w-4" />
                        Sign in to claim
                      </Link>
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      Claiming records a change of ownership on this
                      garment&apos;s public history, so it needs an account.
                    </p>
                  </>
                )}
              </div>
            </>
          ) : (
            <>
              <XCircle className="h-12 w-12 text-brand-red-text" />
              <h1 className="text-xl font-bold">Tag not available</h1>
              <p className="text-muted-foreground">{state.message}</p>
              {state.retry && (
                <Button
                  variant="outline"
                  onClick={state.retry === "claim" ? claim : () => void resolveTag()}
                >
                  Try again
                </Button>
              )}
              {!user && (
                <Button asChild variant="ghost" size="sm">
                  <Link to={signInHref}>
                    <LogIn className="mr-2 h-4 w-4" />
                    Sign in
                  </Link>
                </Button>
              )}
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
    </main>
  );
}
