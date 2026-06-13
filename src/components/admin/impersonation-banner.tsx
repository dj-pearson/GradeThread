import { useState } from "react";
import { Eye, Loader2, LogOut } from "lucide-react";
import { useImpersonationStore } from "@/stores/impersonation-store";
import { stopImpersonation } from "@/lib/impersonation";

// Persistent "you are impersonating" banner (US-581). Rendered in the authed
// layouts; only shows while an impersonation record is active. Provides the
// single, unmistakable "hard exit" that restores the admin's own session.
export function ImpersonationBanner() {
  const record = useImpersonationStore((s) => s.record);
  const [exiting, setExiting] = useState(false);

  if (!record) return null;

  async function handleExit() {
    setExiting(true);
    try {
      const targetId = record?.target.id;
      await stopImpersonation();
      // Hard reload back into the admin app as the restored admin session, so no
      // stale target-scoped query state lingers.
      window.location.assign(targetId ? `/admin/users/${targetId}` : "/admin/users");
    } catch {
      setExiting(false);
    }
  }

  const who = record.target.name
    ? `${record.target.name} (${record.target.email})`
    : record.target.email;

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-brand-red px-4 py-2 text-center text-sm font-medium text-white"
    >
      <Eye className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
      <span>
        You are viewing GradeThread as <strong>{who}</strong>. Actions you take
        affect their account.
      </span>
      <button
        onClick={handleExit}
        disabled={exiting}
        className="inline-flex items-center gap-1.5 rounded-md bg-white/20 px-3 py-1 text-xs font-semibold transition-colors hover:bg-white/30 disabled:opacity-60"
      >
        {exiting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <LogOut className="h-3.5 w-3.5" />
        )}
        Exit impersonation
      </button>
    </div>
  );
}
