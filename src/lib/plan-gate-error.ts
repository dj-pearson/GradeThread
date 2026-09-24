/**
 * True when a failed read was refused by the plan gate rather than broken.
 *
 * The edge answers 402 (or 403 for a role or feature the account does not
 * have) on the Business-only reconciliation reads. Those are not outages and
 * not empty results: the surface should say the feature is locked, never
 * "all clear" and never "couldn't load".
 */
export function isPlanGateError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  return status === 402 || status === 403;
}
