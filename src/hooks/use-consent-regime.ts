import { useEffect, useState } from "react";
import {
  fetchGeo,
  getCachedGeo,
  isGpcEnabled,
  regimeForGeo,
  UNKNOWN_GEO,
  type ConsentRegime,
  type GeoSignal,
} from "@/lib/consent-regime";

export interface ConsentRegimeState {
  /** "opt-in" (GDPR-style) or "opt-out" (US/CCPA-style). */
  regime: ConsentRegime;
  /** Resolved geo signal (UNKNOWN_GEO until ready / on failure). */
  geo: GeoSignal;
  /** Whether the browser is sending Global Privacy Control. */
  isGPC: boolean;
  /** False until the geo lookup has resolved. Banner waits on this. */
  ready: boolean;
}

/**
 * Resolve the visitor's consent regime from /geo.json. Uses a session cache, so
 * after the first lookup it's synchronous. The banner should not render until
 * `ready` is true, so an EU visitor never briefly sees the US opt-out variant.
 */
export function useConsentRegime(): ConsentRegimeState {
  const seed = getCachedGeo(); // object | null (known-unknown) | undefined
  const [geo, setGeo] = useState<GeoSignal | null>(
    seed === undefined ? null : seed,
  );
  const [ready, setReady] = useState<boolean>(seed !== undefined);

  useEffect(() => {
    if (ready) return;
    let active = true;
    void fetchGeo().then((g) => {
      if (!active) return;
      setGeo(g);
      setReady(true);
    });
    return () => {
      active = false;
    };
  }, [ready]);

  const resolved = geo ?? UNKNOWN_GEO;
  return {
    regime: regimeForGeo(resolved),
    geo: resolved,
    isGPC: isGpcEnabled(),
    ready,
  };
}
