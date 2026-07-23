import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { captureException } from "@/lib/sentry";
import { ScrollText } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { signOut } from "@/lib/auth";
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
import { toast } from "sonner";

// US-377 / US-904: clickwrap acceptance gate for authenticated users.
//
// Email signups record consent server-side at account creation (the signup
// metadata → handle_new_user). This gate covers the two remaining cases:
//   1. OAuth (Google) signups — no checkbox survives the redirect, so consent is
//      captured here BEFORE first dashboard access.
//   2. Re-acceptance — when an operator publishes a new ToS/Privacy version with
//      requires_reacceptance (US-904), every affected user must re-accept.
//
// US-904: the gate is SERVER-DRIVEN. Rather than comparing the profile against a
// hardcoded version constant, it asks /api/legal/status, whose answer reflects
// the live legal_documents table. This means publishing a new version forces
// re-acceptance with no frontend deploy.

interface LegalStatus {
  needsAcceptance: boolean;
  current: { tos: string; privacy: string };
  accepted: {
    tosVersion: string | null;
    privacyVersion: string | null;
    tosAt: string | null;
    privacyAt: string | null;
  };
}

export function LegalGate({ children }: { children: React.ReactNode }) {
  const { profile, refreshProfile } = useAuth();
  const queryClient = useQueryClient();
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Only check once a profile is loaded (i.e. the user is signed in).
  const { data: status, isLoading, isError, error } = useQuery<LegalStatus>({
    queryKey: ["legal-status"],
    enabled: !!profile,
    queryFn: async () => {
      const res = await edgeFetch("/api/legal/status", {
        // Acceptance is the individual's, not the active workspace tenant's.
        skipWorkspaceHeader: true,
      });
      if (!res.ok) throw new Error("status failed");
      return (await res.json()) as LegalStatus;
    },
    staleTime: 5 * 60 * 1000,
    // A transient failure must not silently bypass the consent gate — retry so a
    // blip self-heals and the gate appears the moment the status resolves.
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
  });

  // If the status endpoint is persistently failing we intentionally fail OPEN
  // (render the app) rather than lock every user out over a re-acceptance check
  // most of them don't need — the edge still enforces consent on writes. But the
  // pass-through must be OBSERVABLE, not silent: report it so a real outage that
  // is suppressing consent capture gets surfaced instead of hiding.
  useEffect(() => {
    if (isError && error) {
      captureException(error, { tags: { source: "LegalGate.status" } });
    }
  }, [isError, error]);

  // While the status loads (first navigation only — it's cached after), don't
  // block the app behind a spinner. If acceptance is needed the gate appears the
  // moment the status resolves; if it isn't, nothing flashes. On a persistent
  // error `status` is undefined → we fall through here (documented fail-open,
  // reported above; the edge enforces consent on writes regardless).
  if (!profile || isLoading || !status?.needsAcceptance) {
    return <>{children}</>;
  }

  // A prior recorded acceptance means this is a re-acceptance, not a first-ever
  // capture — pick the audit `method` accordingly.
  const isUpdate = !!(
    status.accepted.tosVersion || status.accepted.privacyVersion
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
      // Re-pull both the status (clears the gate) and the profile (keeps the
      // store's accepted-version fields consistent).
      await queryClient.invalidateQueries({ queryKey: ["legal-status"] });
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
