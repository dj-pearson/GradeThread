import { useState } from "react";
import { Link } from "react-router-dom";
import { ScrollText } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { signOut } from "@/lib/auth";
import { edgeFetch } from "@/lib/edge-fetch";
import { LEGAL_VERSIONS } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { toast } from "sonner";

// US-377: clickwrap acceptance gate for authenticated users.
//
// Email signups record consent server-side at account creation (the signup
// metadata → handle_new_user). This gate covers the two remaining cases:
//   1. OAuth (Google) signups — no checkbox survives the redirect, so consent is
//      captured here BEFORE first dashboard access.
//   2. Re-acceptance — when the ToS/Privacy version bumps, the recorded version
//      no longer matches LEGAL_VERSIONS and every user must re-accept.
//
// It reads the accepted versions off the loaded profile (RLS-protected own-row
// read) and blocks the dashboard until they match the current versions.
export function LegalGate({ children }: { children: React.ReactNode }) {
  const { profile, refreshProfile } = useAuth();
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Only gate once the profile is loaded. If it failed to load, don't trap the
  // user behind the gate — ProtectedRoute already handled the no-session case.
  const needsAcceptance =
    !!profile &&
    (profile.tos_accepted_version !== LEGAL_VERSIONS.tos ||
      profile.privacy_accepted_version !== LEGAL_VERSIONS.privacy);

  if (!needsAcceptance) return <>{children}</>;

  // A prior (now-stale) acceptance means this is a re-acceptance, not a
  // first-ever capture — pick the audit `method` accordingly.
  const isUpdate = !!(
    profile?.tos_accepted_version || profile?.privacy_accepted_version
  );

  async function handleAccept() {
    if (!agreed) {
      toast.error("Please agree to the Terms of Service and Privacy Policy.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await edgeFetch("/api/legal/accept", {
        method: "POST",
        json: { method: isUpdate ? "reacceptance" : "oauth_clickwrap" },
        // Acceptance is the individual's, not the active workspace tenant's.
        skipWorkspaceHeader: true,
      });
      if (!res.ok) throw new Error("accept failed");
      // Re-pull the profile so the updated accepted versions clear the gate.
      await refreshProfile();
      toast.success("Thanks — you're all set.");
    } catch {
      toast.error("Could not record your acceptance. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-gray p-4 dark:bg-brand-night">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-brand-red/10">
            <ScrollText className="h-6 w-6 text-brand-red-text" />
          </div>
          <CardTitle>
            {isUpdate ? "We've updated our terms" : "One last step"}
          </CardTitle>
          <CardDescription>
            {isUpdate
              ? "Our Terms of Service and Privacy Policy have changed. Please review and accept the updated versions to continue."
              : "Please review and accept our Terms of Service and Privacy Policy to start using GradeThread."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label
            htmlFor="legal-gate-consent"
            className="flex items-start gap-2.5 text-sm text-muted-foreground"
          >
            <input
              id="legal-gate-consent"
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-0.5 h-4 w-4 flex-shrink-0 cursor-pointer accent-brand-red"
            />
            <span>
              I agree to the{" "}
              <Link
                to="/terms"
                target="_blank"
                className="underline hover:text-foreground"
              >
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link
                to="/privacy"
                target="_blank"
                className="underline hover:text-foreground"
              >
                Privacy Policy
              </Link>
              .
            </span>
          </label>
          <Button
            className="w-full"
            onClick={handleAccept}
            disabled={!agreed || submitting}
          >
            {submitting ? "Saving..." : "Agree and continue"}
          </Button>
        </CardContent>
        <CardFooter className="justify-center">
          <button
            type="button"
            onClick={() => void signOut()}
            className="text-sm text-muted-foreground hover:underline"
          >
            Sign out
          </button>
        </CardFooter>
      </Card>
    </div>
  );
}
