import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { PENDING_INVITE_KEY } from "@/pages/accept-invite";

export function AuthCallbackPage() {
  const navigate = useNavigate();

  useEffect(() => {
    supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN") {
        // If the user got here through a workspace invitation, send them
        // back to /accept-invite to complete the join. The invite page
        // tolerates double-mounting — peek_workspace_invitation is
        // idempotent.
        const pendingToken = sessionStorage.getItem(PENDING_INVITE_KEY);
        if (pendingToken) {
          navigate(`/accept-invite?token=${pendingToken}`, { replace: true });
          return;
        }
        navigate("/dashboard", { replace: true });
      } else if (event === "SIGNED_OUT") {
        navigate("/login", { replace: true });
      }
    });
  }, [navigate]);

  return (
    <div className="flex h-screen items-center justify-center">
      <div className="text-center">
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <p className="mt-4 text-sm text-muted-foreground">
          Completing sign in...
        </p>
      </div>
    </div>
  );
}
