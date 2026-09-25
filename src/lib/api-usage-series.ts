// DEV-14: the daily series behind the Developers usage chart.

const CHART_DAYS = 30;

/** UTC "YYYY-MM-DD", the same day boundary the ledger groups by. */
function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The last `days` UTC days ending today, oldest first, with the server's
 * counts dropped in and every missing day as zero. The ledger only returns
 * days that had calls, so drawing it raw would squeeze a quiet month into a
 * handful of bars with no gaps.
 */
export function zeroFillDaily(
  daily: { day: string; count: number }[],
  days = CHART_DAYS,
  now = new Date(),
): { day: string; count: number }[] {
  const counts = new Map(daily.map((d) => [d.day, d.count]));
  const out: { day: string; count: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const key = utcDay(d);
    out.push({ day: key, count: counts.get(key) ?? 0 });
  }
  return out;
}
