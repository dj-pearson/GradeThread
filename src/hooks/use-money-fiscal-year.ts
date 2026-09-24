import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@/stores/auth-store";
import {
  TAX_PROFILE_DEFAULTS,
  fetchTaxProfile,
  periodRange,
  ymd,
} from "@/lib/tax-profile";

/**
 * Today, recomputed when the tab comes back into view on a different day.
 *
 * A Date memoised at mount is still "yesterday" for a seller who leaves Money
 * open overnight, and in the first week of a new fiscal year that puts every
 * figure on the old year.
 */
export function useToday(): Date {
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== "visible") return;
      const now = new Date();
      setToday((prev) => (ymd(prev) === ymd(now) ? prev : now));
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  return today;
}

/**
 * The seller's fiscal year as the P&L computes it (periodRange "year" on the
 * profile's start month). The Money tab badge and the Overview both use this,
 * so the count on the tab is the count of the list the P&L shows.
 */
export function useMoneyFiscalYear() {
  const user = useAuthStore((s) => s.user);
  const profileQuery = useQuery({
    queryKey: ["tax-profile", user?.id],
    enabled: !!user,
    queryFn: fetchTaxProfile,
    staleTime: 30 * 60 * 1000,
  });
  const startMonth =
    profileQuery.data?.fiscal_year_start_month ??
    TAX_PROFILE_DEFAULTS.fiscal_year_start_month;
  const today = useToday();
  const fiscal = useMemo(
    () => periodRange("year", startMonth, today),
    [startMonth, today],
  );
  return { profileQuery, startMonth, today, fiscal };
}
