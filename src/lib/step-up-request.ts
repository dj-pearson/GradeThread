// Global broker for MFA step-up prompts (US-270 follow-up).
//
// Destructive admin endpoints answer 403 { code: "STEP_UP_REQUIRED" } when the
// caller's last MFA verification is older than ADMIN_STEP_UP_MAX_AGE_SEC. Every
// call site used to have to notice that code and open its own dialog, and most
// of them didn't — so those actions just failed, repeatedly, with no way to
// re-verify. The prompt belongs in edgeFetch (one place, every call site), and
// edgeFetch can't render a dialog, so it asks through this broker instead.
//
// <StepUpHost /> (mounted in the admin layout) registers the opener. Anywhere no
// host is mounted, requestStepUp() resolves false and the original 403 flows
// through to the caller unchanged.

/** Opens the step-up dialog; resolves true once verified, false if dismissed. */
type StepUpOpener = () => Promise<boolean>;

let opener: StepUpOpener | null = null;
// Concurrent 403s (a page firing several admin writes at once) must share ONE
// prompt — otherwise the second dialog replaces the first and the user types a
// code into a prompt whose request was already abandoned.
let pending: Promise<boolean> | null = null;

export function registerStepUpHost(next: StepUpOpener | null): void {
  opener = next;
}

export function requestStepUp(): Promise<boolean> {
  if (!opener) return Promise.resolve(false);
  if (!pending) {
    pending = opener().finally(() => {
      pending = null;
    });
  }
  return pending;
}
