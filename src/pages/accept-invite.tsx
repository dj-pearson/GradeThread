import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { removeStored, writeStored } from "@/lib/safe-storage";
import { useAuth } from "@/hooks/use-auth";
import { useAuthStore } from "@/stores/auth-store";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { WORKSPACE_ROLE_LABEL } from "@/lib/workspace-permissions";
import type { WorkspaceInvitationPeek } from "@/types/database";

// Stored across the signup redirect so a brand-new account can pick up the
// invite as soon as they confirm their email and land back on the app.
const PENDING_INVITE_KEY = "gradethread:pendingInviteToken";

// Bound the invitation lookup so a hung RPC can't spin the page forever — the
// user gets a retry-able error instead (US-798, mirroring auth-callback).
const PEEK_TIMEOUT_MS = 15_000;

export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const { user, isLoading: authLoading, refreshProfile } = useAuth();
  const setActiveWorkspaceOwnerId = useAuthStore(
    (s) => s.setActiveWorkspaceOwnerId,
  );

  const [peek, setPeek] = useState<WorkspaceInvitationPeek | null>(null);
  const [peekLoading, setPeekLoading] = useState(true);
  const [peekError, setPeekError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [switchingAccounts, setSwitchingAccounts] = useState(false);
  // Bumped by "Try again" to re-run the lookup effect.
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!token) {
      setPeekError("This invitation link is missing a token.");
      setPeekLoading(false);
      return;
    }
    // Stash so we can resume after signup.
    writeStored(PENDING_INVITE_KEY, token, "session");

    let settled = false;
    setPeekLoading(true);
    setPeekError(null);
    setPeek(null);

    // The Supabase RPC has no client-side timeout, so a stalled request would
    // leave the page spinning indefinitely. Race it against a bounded timer.
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      setPeekError(
        "This is taking longer than expected. Check your connection and try again.",
      );
      setPeekLoading(false);
    }, PEEK_TIMEOUT_MS);

    (
      supabase.rpc as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: WorkspaceInvitationPeek[] | null; error: Error | null }>
    )("peek_workspace_invitation", { invitation_token: token })
      .then(({ data, error }) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (error) {
          setPeekError(error.message);
        } else if (!data || data.length === 0) {
          setPeekError("This invitation is invalid.");
        } else {
          setPeek(data[0] ?? null);
        }
        setPeekLoading(false);
      })
      .catch((err: unknown) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        setPeekError(
          err instanceof Error ? err.message : "Couldn't load this invitation.",
        );
        setPeekLoading(false);
      });

    return () => {
      settled = true;
      window.clearTimeout(timer);
    };
  }, [token, retryKey]);

  async function handleAccept() {
    if (!token || !user) return;
    setAccepting(true);
    const { data, error } = await (
      supabase.rpc as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: string | null; error: Error | null }>
    )("accept_workspace_invitation", { invitation_token: token });
    setAccepting(false);
    if (error) {
      toastError(error);
      return;
    }
    const ownerId = data;
    removeStored(PENDING_INVITE_KEY, "session");
    toast.success("You've joined the workspace");
    if (ownerId && user) {
      setActiveWorkspaceOwnerId(ownerId);
      // US-3376: checked. Joining succeeded either way, but this write is what
      // makes the switch STICK. Dropped, local state moved to the new workspace
      // and a reload (or the same account on a phone) landed back in the old
      // one, after a success toast had already said otherwise.
      //
      // ALSO: `active_workspace_owner_id` has to stay in the public.users
      // self-update allowlist (00526 made these deny-by-default). A column that
      // falls out of it makes this a silent no-op with no error at all, which is
      // why the failure has to be said out loud rather than counted on.
      const { error: switchErr } = await supabase
        .from("users")
        .update({ active_workspace_owner_id: ownerId } as never)
        .eq("id", user.id);
      if (switchErr) {
        toastError(switchErr, "You're in, but we couldn't make this your default workspace.", {
          action: "set active workspace",
          duration: 10_000,
          nextStep: "Pick it from the workspace switcher after you reload.",
        });
      }
    }
    await refreshProfile();
    navigate("/dashboard");
  }

  if (peekLoading || authLoading) {
    return (
      <CenteredCard>
        <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
        <p className="mt-4 text-center text-sm text-muted-foreground">
          Looking up your invitation…
        </p>
      </CenteredCard>
    );
  }

  if (peekError || !peek) {
    return (
      <CenteredCard>
        <Card>
          <CardHeader className="text-center">
            <AlertTriangle className="mx-auto h-10 w-10 text-destructive" />
            <CardTitle className="mt-2">Invitation unavailable</CardTitle>
            <CardDescription>{peekError ?? "We couldn't find this invitation."}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-2 text-center">
            {token && (
              <Button onClick={() => setRetryKey((k) => k + 1)}>Try again</Button>
            )}
            <Button variant="outline" asChild>
              <Link to="/">Go home</Link>
            </Button>
          </CardContent>
        </Card>
      </CenteredCard>
    );
  }

  if (peek.status !== "pending") {
    const statusCopy: Record<"accepted" | "revoked" | "expired", string> = {
      accepted: "This invitation has already been accepted.",
      revoked: "This invitation has been revoked by the workspace owner.",
      expired: "This invitation has expired. Ask the workspace owner to send a new one.",
    };
    return (
      <CenteredCard>
        <Card>
          <CardHeader className="text-center">
            <AlertTriangle className="mx-auto h-10 w-10 text-muted-foreground" />
            <CardTitle className="mt-2">Invitation {peek.status}</CardTitle>
            <CardDescription>{statusCopy[peek.status]}</CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Button variant="outline" asChild>
              <Link to="/dashboard">Continue to dashboard</Link>
            </Button>
          </CardContent>
        </Card>
      </CenteredCard>
    );
  }

  const ownerLabel = peek.owner_full_name || peek.owner_email;

  // Not signed in → send them to signup, prefilled with the invited email.
  if (!user) {
    return (
      <CenteredCard>
        <Card>
          <CardHeader className="text-center">
            <CardTitle>Join {ownerLabel}'s workspace</CardTitle>
            <CardDescription>
              You've been invited as{" "}
              <Badge variant="secondary">{WORKSPACE_ROLE_LABEL[peek.role]}</Badge>.
              Create an account or sign in with{" "}
              <span className="font-medium">{peek.email}</span> to accept.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button asChild className="w-full">
              <Link to={`/signup?email=${encodeURIComponent(peek.email)}&invite=${token}`}>
                Create account
              </Link>
            </Button>
            <Button asChild variant="outline" className="w-full">
              <Link to={`/login?email=${encodeURIComponent(peek.email)}&invite=${token}`}>
                I already have an account
              </Link>
            </Button>
          </CardContent>
        </Card>
      </CenteredCard>
    );
  }

  // Signed in — check email match.
  const emailMismatch =
    user.email && peek.email.toLowerCase() !== user.email.toLowerCase();

  if (emailMismatch) {
    return (
      <CenteredCard>
        <Card>
          <CardHeader className="text-center">
            <AlertTriangle className="mx-auto h-10 w-10 text-destructive" />
            <CardTitle className="mt-2">Email doesn't match</CardTitle>
            <CardDescription>
              This invitation was sent to <span className="font-medium">{peek.email}</span>,
              but you're signed in as <span className="font-medium">{user.email}</span>.
              Sign out and sign back in with the invited email to accept.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center gap-2">
            <Button
              variant="outline"
              disabled={switchingAccounts}
              onClick={async () => {
                setSwitchingAccounts(true);
                await supabase.auth.signOut();
                navigate(`/login?email=${encodeURIComponent(peek.email)}&invite=${token}`);
              }}
            >
              {switchingAccounts ? "Switching…" : "Switch accounts"}
            </Button>
          </CardContent>
        </Card>
      </CenteredCard>
    );
  }

  return (
    <CenteredCard>
      <Card>
        <CardHeader className="text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-primary" />
          <CardTitle className="mt-2">Join {ownerLabel}'s workspace</CardTitle>
          <CardDescription>
            You'll be added as a{" "}
            <Badge variant="secondary">{WORKSPACE_ROLE_LABEL[peek.role]}</Badge>{" "}
            and can switch between workspaces from the header at any time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={handleAccept} disabled={accepting} className="w-full">
            {accepting ? "Joining…" : "Accept invitation"}
          </Button>
        </CardContent>
      </Card>
    </CenteredCard>
  );
}

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <img src="/logo_primary.png" width={1806} height={376} alt="GradeThread" className="h-10" />
        </div>
        {children}
      </div>
    </div>
  );
}

export { PENDING_INVITE_KEY };
