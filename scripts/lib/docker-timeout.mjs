// US-2788: how long a `docker` call may take before it is a WEDGED DAEMON
// rather than slow work.
//
// The bug this exists to stop: Docker Desktop can sit up, accepting
// connections, and answer nothing. Every subcommand hangs — `info`, `ps`,
// `version`, `exec` — measured over eleven hours on 2026-08-22. A call with no
// timeout then never returns, and because verify.mjs holds verify.lock for the
// whole run, one hung `docker info` blocked every push on the machine for three
// hours while showing 0.1 CPU seconds of work.
//
// THE DISTINCTION THE NUMBERS ENCODE. A probe asks the daemon a question it
// already knows the answer to — is it alive, what containers are running, is
// Postgres accepting connections. Those answer in milliseconds on a healthy
// daemon, so twenty seconds is not a performance budget, it is the point past
// which "slow" has stopped being a plausible explanation. A query runs real SQL
// inside a container, where a slow answer IS plausible, so it gets two minutes:
// long enough that no honest query is killed, short enough that a wedge is
// noticed within one coffee.
//
// DELIBERATELY NOT APPLIED TO THE LANE COMMANDS in verify.mjs `run()`. A build,
// a full vitest with coverage or a cold Gradle run legitimately takes minutes,
// and the ceiling that would not kill honest work on a slow machine is so high
// it would not catch a wedge either. Killing a real build at an arbitrary
// deadline trades a diagnosable hang for a mysterious failure. The lock's
// CPU-time guidance is what covers that case, and it covers it by telling the
// operator how to tell the two apart rather than by guessing for them.

/** Liveness and metadata: `docker info`, `ps`, `logs`, `pg_isready`. */
export const DOCKER_PROBE_MS = 20_000;

/** Real work inside a container: `docker exec … psql -c "…"`. */
export const DOCKER_QUERY_MS = 120_000;

/**
 * Did this spawnSync result die on its timeout?
 *
 * Node reports a timeout as a KILL SIGNAL with a NULL status, never as a
 * non-zero exit code — so `res.status !== 0` reads as a normal command failure
 * and `res.status === 0` reads as success. Both are wrong, and the second is
 * the dangerous one: a wedged daemon would report as a clean run. This is the
 * same trap dockerUp() in verify.mjs handles explicitly.
 */
export function dockerTimedOut(res) {
  return res?.error?.code === "ETIMEDOUT" || (res?.status === null && res?.signal != null);
}

/** The message to throw when one does, so every call site says the same thing. */
export function wedgedDaemonError(what) {
  return new Error(
    `docker did not answer within the timeout while running ${what}. ` +
      "The daemon is wedged (up, accepting connections, answering nothing) " +
      "rather than absent — restart Docker Desktop. See US-2788.",
  );
}
