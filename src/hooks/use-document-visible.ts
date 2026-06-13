import { useEffect, useState } from "react";

/**
 * Tracks `document.visibilityState`, returning `true` while the tab is visible
 * and `false` once it is hidden (backgrounded, minimized, or another tab is
 * focused). Use it to gate background polling so idle/hidden tabs stop
 * generating edge/DB load. (US-576)
 *
 * For TanStack Query, feed the result into `refetchInterval`:
 *   `refetchInterval: visible ? 30000 : false`
 * Toggling the boolean re-evaluates the query options, so the poll timer is
 * torn down when the tab hides and rescheduled when it returns to the
 * foreground (where `refetchOnWindowFocus` also fires an immediate refresh).
 */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );

  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  return visible;
}
