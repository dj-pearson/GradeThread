import { useEffect, useState } from "react";

// True once `missing` has stayed true for `ms`. The auth store has no
// "profile load failed" flag, and right after signing in the profile is null
// for a moment while it loads (isLoading only covers the very first load), so
// a null profile alone cannot tell loading from failed. A Settings tab reached
// straight from sign-in (the unsubscribe email's deep link) flashed its red
// "Couldn't load" alert every time. This waits before calling it a failure.
export function useMissingTooLong(missing: boolean, ms = 4000): boolean {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (!missing) {
      setExpired(false);
      return;
    }
    const t = setTimeout(() => setExpired(true), ms);
    return () => clearTimeout(t);
  }, [missing, ms]);
  return missing && expired;
}
