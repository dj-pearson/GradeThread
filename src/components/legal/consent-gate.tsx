import { useState } from "react";
import { Link } from "react-router-dom";
import { Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth-store";
import { supabase } from "@/lib/supabase";
import { signOut } from "@/lib/auth";
import { CURRENT_LEGAL_VERSION } from "@/lib/constants";
import { toast } from "sonner";

// US-377: blocking consent gate. Rendered inside the dashboard layout, it forces
// any authenticated user whose recorded acceptance is missing or stale (OAuth
// signups, pre-existing accounts, or a material legal-document change) to
// affirmatively accept the current Terms + Privacy before using the app. The
// email/password signup checkbox records acceptance up front, so those users
// pass straight through.
export function ConsentGate() {
  const profile = useAuthStore((s) => s.profile);
  const setProfile = useAuthStore((s) => s.setProfile);
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);

  // Wait for the profile to load; once loaded, only block on a version mismatch.
  if (!profile || profile.tos_accepted_version === CURRENT_LEGAL_VERSION) {
    return null;
  }

  const reaccept = profile.tos_accepted_version != null;

  async function accept() {
    if (!agreed || !profile) return;
    setSaving(true);
    const acceptedAt = new Date().toISOString();
    const { error } = await supabase
      .from("users")
      .update({
        tos_accepted_version: CURRENT_LEGAL_VERSION,
        tos_accepted_at: acceptedAt,
      })
      .eq("id", profile.id);
    setSaving(false);
    if (error) {
      toast.error("Couldn't save your acceptance. Please try again.");
      return;
    }
    // Reflect immediately so the gate closes without a refetch.
    setProfile({
      ...profile,
      tos_accepted_version: CURRENT_LEGAL_VERSION,
      tos_accepted_at: acceptedAt,
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="consent-gate-title"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
        <div className="flex items-center gap-2 text-brand-navy">
          <Shield className="h-5 w-5" />
          <h2 id="consent-gate-title" className="text-lg font-semibold">
            {reaccept ? "We've updated our terms" : "Accept our terms to continue"}
          </h2>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          {reaccept
            ? "Our Terms of Service and Privacy Policy have changed. Please review and accept the updated terms to keep using GradeThread."
            : "Before you continue, please review and accept our Terms of Service and Privacy Policy."}
        </p>

        <label className="mt-4 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-input accent-brand-navy"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
          />
          <span>
            I agree to the{" "}
            <Link to="/terms" target="_blank" className="underline hover:text-foreground">
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link to="/privacy" target="_blank" className="underline hover:text-foreground">
              Privacy Policy
            </Link>
            .
          </span>
        </label>

        <div className="mt-6 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => void signOut()}
            className="text-sm text-muted-foreground underline hover:text-foreground"
          >
            Sign out
          </button>
          <Button onClick={() => void accept()} disabled={!agreed || saving}>
            {saving ? "Saving…" : "Accept and continue"}
          </Button>
        </div>
      </div>
    </div>
  );
}
