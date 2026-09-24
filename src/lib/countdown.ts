// SUB-15: "in 3 h 12 min", "in 12 min", "any minute now".
export function formatCountdown(ms: number): string {
  const min = Math.ceil(ms / 60_000);
  if (min <= 1) return "any minute now";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `in ${m} min`;
  return m === 0 ? `in ${h} h` : `in ${h} h ${m} min`;
}
