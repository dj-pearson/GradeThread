// US-1873 / US-1885: connect the unified browser extension to the signed-in
// account. The extension's popup "Sign in" opens this page with `?ext=<id>`. Here
// we mint a short-lived signed extension token (POST /api/buyer/extension-token,
// US-1838) and hand it to the extension via externally_connectable messaging
// (GT_SET_TOKEN), so the install becomes account-scoped — its research quota and
// the seller Lister gate now resolve from THIS account's entitlements.
//
// The token is the only thing that crosses to the extension; no marketplace
// credentials, no Supabase session. The extension stores it and re-resolves its
// capabilities immediately.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { edgeFetch } from "@/lib/edge-fetch";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Minimal ambient for the page→extension messaging API Chrome injects when the
// extension's externally_connectable matches this origin. Avoids a hard
// @types/chrome dependency in the web tsconfig (mirrors src/lib/lister-extension.ts).
interface ChromeExtMessaging {
  runtime?: {
    sendMessage?: (
      extensionId: string,
      message: unknown,
      callback: (response: unknown) => void,
    ) => void;
    lastError?: { message?: string };
  };
}
function chromeRuntime(): ChromeExtMessaging["runtime"] | undefined {
  return (globalThis as unknown as { chrome?: ChromeExtMessaging }).chrome?.runtime;
}

type Phase =
  | "checking"
  | "need-signin"
  | "missing-ext"
  | "no-chrome"
  | "connecting"
  | "connected"
  | "error";

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
  const extId = params.get("ext");
  const [phase, setPhase] = useState<Phase>("checking");
  const [error, setError] = useState<string>("");
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const attempted = useRef(false);

  const connect = useCallback(async () => {
    if (!extId) {
      setPhase("missing-ext");
      return;
    }
    const runtime = chromeRuntime();
    if (!runtime?.sendMessage) {
      setPhase("no-chrome");
      return;
    }
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
    // 2. Hand it to the extension.
    runtime.sendMessage(extId, { type: "GT_SET_TOKEN", token }, (response) => {
      if (runtime.lastError) {
        setError(
          runtime.lastError.message ||
            "Couldn't reach the GradeThread extension. Make sure it's installed and enabled.",
        );
        setPhase("error");
        return;
      }
      const resp = (response as { ok?: boolean; capabilities?: Capabilities } | null) ?? null;
      if (resp && resp.ok) {
        setCaps(resp.capabilities ?? null);
        setPhase("connected");
      } else {
        setError("The extension rejected the connection. Update it and try again.");
        setPhase("error");
      }
    });
  }, [extId]);

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

          {phase === "missing-ext" && (
            <p className="text-sm text-muted-foreground py-2">
              Open this page from the GradeThread extension's popup (the{" "}
              <span className="font-medium">Sign in</span> button) so we know which
              install to connect.
            </p>
          )}

          {phase === "no-chrome" && (
            <p className="text-sm text-muted-foreground py-2">
              We couldn't find the GradeThread extension in this browser. Install it,
              then open this page again from its popup. (The extension currently
              supports Chrome and Edge.)
            </p>
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
