// US-2032: warn before navigation destroys unsaved in-memory work.
//
// The motivating case is the grading wizard. It autosaves form fields and a
// photo MANIFEST (name + type) but never the image binaries — a deliberate and
// correct choice, since stashing many multi-MB Files in localStorage is not
// viable. The consequence is that staged photos live only in React state, so a
// sidebar click or a refresh destroys them silently. Photo capture is the
// highest-effort step of the highest-value journey, and re-shooting eight
// garment photos is the most expensive thing this app can ask of someone.
//
// Two distinct escape routes need covering, and they need different mechanisms:
//
//   1. IN-APP navigation (a <Link>, a sidebar click, navigate()). React Router's
//      useBlocker intercepts this and lets us show a real dialog.
//   2. LEAVING THE PAGE (refresh, tab close, back to another origin). Only
//      `beforeunload` can catch that, and the browser shows its own generic
//      prompt — we cannot style it or say how many photos are at stake.
//
// Neither alone is sufficient, which is why both are here.

import { useEffect } from "react";
import { useBlocker } from "react-router-dom";

export interface NavigationGuard {
  /** True when navigation was intercepted and the user must confirm. */
  blocked: boolean;
  /** Discard the work and continue to the requested route. */
  confirmLeave: () => void;
  /** Stay on the page. */
  cancelLeave: () => void;
}

/**
 * Guard against losing unsaved work.
 *
 * @param shouldBlock re-evaluated on every render; pass a condition that is
 *   TRUE only while there is genuinely something to lose. Blocking when there
 *   is nothing at stake trains people to click through the dialog, which is how
 *   a guard stops working.
 */
export function useNavigationGuard(shouldBlock: boolean): NavigationGuard {
  const blocker = useBlocker(shouldBlock);

  useEffect(() => {
    if (!shouldBlock) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Chrome requires returnValue to be set for the prompt to appear at all.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [shouldBlock]);

  // A blocker left in the "blocked" state survives across renders, so if the
  // condition clears (the user submitted, or removed the last photo) while a
  // prompt is open, release it rather than stranding them behind a dialog about
  // work that no longer exists.
  useEffect(() => {
    if (!shouldBlock && blocker.state === "blocked") blocker.reset();
  }, [shouldBlock, blocker]);

  return {
    blocked: blocker.state === "blocked",
    confirmLeave: () => {
      if (blocker.state === "blocked") blocker.proceed();
    },
    cancelLeave: () => {
      if (blocker.state === "blocked") blocker.reset();
    },
  };
}
