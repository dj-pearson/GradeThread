import { useCallback, useEffect, useRef, useState } from "react";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import { registerStepUpHost } from "@/lib/step-up-request";

// Renders the ONE step-up dialog the whole admin area shares, and registers it
// with the broker so edgeFetch can raise it from anywhere (see
// lib/step-up-request.ts). Mounted once in AdminLayout — nothing else needs to
// know about STEP_UP_REQUIRED.
export function StepUpHost() {
  const [open, setOpen] = useState(false);
  // Resolves the promise edgeFetch is awaiting: true when the code verified,
  // false when the admin dismissed the dialog (so the caller sees its 403 and
  // can report the failure honestly rather than hanging).
  const resolveRef = useRef<((verified: boolean) => void) | null>(null);

  const settle = useCallback((verified: boolean) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    resolve?.(verified);
  }, []);

  useEffect(() => {
    registerStepUpHost(
      () =>
        new Promise<boolean>((resolve) => {
          resolveRef.current = resolve;
          setOpen(true);
        }),
    );
    return () => {
      registerStepUpHost(null);
      // Unmounting mid-prompt (route change, sign-out) must not strand a
      // request awaiting a dialog that no longer exists.
      settle(false);
    };
  }, [settle]);

  return (
    <MfaStepUpDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // A successful verify CLOSES the dialog and THEN calls onVerified, so a
        // synchronous settle(false) here would resolve the waiting request as
        // "dismissed" moments before the success arrives. Defer one tick:
        // onVerified settles first and clears the resolver, leaving this a
        // no-op; a genuine dismissal has nothing to race and settles false.
        if (!next) setTimeout(() => settle(false), 0);
      }}
      onVerified={() => settle(true)}
    />
  );
}
