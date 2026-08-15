// US-1873 / US-1885 / US-1882: connect the unified browser extension to the
// signed-in account. The extension's popup "Sign in" opens this page with
// `?ext=<id>`. Here we mint a short-lived signed extension token (POST
// /api/buyer/extension-token, US-1838) and hand it to the extension, which stores
// it and re-resolves its capabilities (research quota + the seller Lister gate).
//
// Transport is cross-browser via sendExtensionMessage: Chromium uses
// externally_connectable (targeting the ?ext= id); Firefox uses the gradethread.com
// postMessage bridge (gt-bridge.js). Only the token crosses to the extension — no
// password, no Supabase session, no marketplace credentials.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useAuth } from "@/hooks/use-auth";
import { edgeFetch } from "@/lib/edge-fetch";
import { sendExtensionMessage, listerExtensionId } from "@/lib/lister-extension";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { HelpLink } from "@/components/help/help-link";

type Phase = "checking" | "need-signin" | "connecting" | "connected" | "error";

interface Capabilities {
  authenticated?: boolean;
  sellerEnabled?: boolean;
  buyerPlan?: string;
  flipdeskPlan?: string;
}

const Spinner = () => (
  <div
    className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"
    aria-label="Connecting"
  />
);

export function ConnectExtensionPage() {
  const { user, isLoading } = useAuth();
  const [params] = useSearchParams();
  const extId = params.get("ext") ?? undefined;
  // SECURITY: only deliver the minted token to the CONFIGURED GradeThread
  // extension. A victim lured to /connect-extension?ext=<attacker_ext_id> with a
  // malicious extension installed would otherwise get a valid short-lived
  // account token minted and handed to the attacker's extension. An id that
  // doesn't match falls back to undefined → the configured id / bridge transport.
  const configuredExtId = listerExtensionId();
  const targetExtId =
    extId && configuredExtId && extId === configuredExtId ? extId : undefined;
  const [phase, setPhase] = useState<Phase>("checking");
  const [error, setError] = useState<string>("");
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const attempted = useRef(false);

  const connect = useCallback(async () => {
    setPhase("connecting");
    // 1. Mint the signed extension token for THIS account.
    let token: string;
    try {
      const res = await edgeFetch("/api/buyer/extension-token", {
        method: "POST",
        silentGate: true,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error || "Couldn't create an extension token. Please try again.");
        setPhase("error");
        return;
      }
      token = ((await res.json()) as { token: string }).token;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reach GradeThread.");
      setPhase("error");
      return;
    }
    // 2. Hand it to the extension over the best transport.
    const resp = await sendExtensionMessage<{
      ok?: boolean;
      error?: string;
      capabilities?: Capabilities;
    }>({ type: "GT_SET_TOKEN", token }, { extensionId: targetExtId });
    if (resp.ok) {
      setCaps(resp.capabilities ?? null);
      setPhase("connected");
    } else {
      setError(
        resp.error && !/not detected/i.test(resp.error)
          ? resp.error
          : "We couldn't reach the GradeThread extension. Make sure it's installed and enabled in this browser, then open this page again from its popup.",
      );
      setPhase("error");
    }
  }, [targetExtId]);

  useEffect(() => {
    if (isLoading || attempted.current) return;
    if (!user) {
      setPhase("need-signin");
      return;
    }
    attempted.current = true;
    void connect();
  }, [isLoading, user, connect]);

  const retry = () => {
    attempted.current = true;
    void connect();
  };

  // Resume here after sign-in.
  const nextParam = encodeURIComponent(
    `/connect-extension${extId ? `?ext=${encodeURIComponent(extId)}` : ""}`,
  );

  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-gray px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Connect the GradeThread extension</CardTitle>
          <HelpLink slug="installing-the-browser-extension" label="Help: installing the extension" />
          <CardDescription>
            Link your browser extension to your account to raise your read limit and
            unlock seller tools when you have a FlipDesk plan.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {(phase === "checking" || phase === "connecting") && (
            <div className="flex flex-col items-center gap-3 py-6">
              <Spinner />
              <p className="text-sm text-muted-foreground">
                {phase === "connecting" ? "Connecting your account…" : "Checking…"}
              </p>
            </div>
          )}

          {phase === "need-signin" && (
            <div className="space-y-4 py-2">
              <p className="text-sm text-muted-foreground">
                Sign in to your GradeThread account, then we'll connect the extension
                automatically.
              </p>
              <Button asChild className="w-full">
                <Link to={`/login?next=${nextParam}`}>Sign in to connect</Link>
              </Button>
            </div>
          )}

          {phase === "connected" && (
            <div className="space-y-3 py-2">
              <div className="rounded-lg bg-emerald-50 p-4 text-sm text-emerald-800">
                <p className="font-semibold">Extension connected 🎉</p>
                <p className="mt-1">
                  Signed in as{" "}
                  <span className="font-medium">{user?.email}</span>. You can close
                  this tab and get back to shopping.
                </p>
              </div>
              {caps && (
                <ul className="space-y-1 text-sm text-muted-foreground">
                  <li>
                    Buyer research:{" "}
                    <span className="font-medium capitalize">{caps.buyerPlan || "free"}</span>
                  </li>
                  <li>
                    Seller Lister:{" "}
                    {caps.sellerEnabled ? (
                      <span className="font-medium text-emerald-700">
                        unlocked ({caps.flipdeskPlan})
                      </span>
                    ) : (
                      <span className="font-medium">
                        locked — add a FlipDesk plan to cross-post
                      </span>
                    )}
                  </li>
                </ul>
              )}
            </div>
          )}

          {phase === "error" && (
            <div className="space-y-3 py-2">
              <div className="rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
                {error}
              </div>
              <Button onClick={retry} variant="outline" className="w-full">
                Try again
              </Button>
            </div>
          )}
        </CardContent>

        <CardFooter className="text-xs text-muted-foreground">
          Only a short-lived access token is shared with the extension — never your
          password or marketplace logins.
        </CardFooter>
      </Card>
    </div>
  );
}
