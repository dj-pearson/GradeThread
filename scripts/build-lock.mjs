// Cross-process / cross-repo build serializer.
//
// Two autonomous agent loops on one host (e.g. Ralph on GradeThread + a second
// loop on another project) starve each other when their `tsc -b` + `vite build`
// land at the same instant — each peaks at ~2-2.5 GB and pins the CPU. Builds
// are SHORT though (~40s here), so the fix is simply: only one build runs at a
// time. Both repos drop an identical copy of this file and run their build
// through it; they share ONE lock under the OS temp dir, so builds take turns
// automatically and the loser just waits a couple seconds.
//
// Usage:  node scripts/build-lock.mjs <command> [args...]
//   e.g.  node scripts/build-lock.mjs npm run build
//
// Dependency-free. The lock is an atomically-created directory; a lock older
// than STALE_MS is assumed crashed and stolen (builds here are ~40s, so the
// 15-min threshold only trips on a genuinely dead holder).
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCK = join(tmpdir(), 'agent-build.lock'); // SHARED across both repos
const STALE_MS = 15 * 60_000;
const POLL_MS = 1500;
const cmd = process.argv.slice(2);

if (cmd.length === 0) {
  console.error('[build-lock] no command given. Usage: node build-lock.mjs <cmd> [args...]');
  process.exit(2);
}

// Synchronous sleep with no busy-wait and no child process.
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

let waited = 0;
for (;;) {
  try {
    mkdirSync(LOCK); // atomic: throws EEXIST if another build holds it
    try { writeFileSync(join(LOCK, 'owner'), `pid ${process.pid} cmd ${cmd.join(' ')}\n`); } catch {}
    break;
  } catch {
    try {
      if (Date.now() - statSync(LOCK).mtimeMs > STALE_MS) {
        console.error('[build-lock] stealing stale lock (holder looks dead).');
        rmSync(LOCK, { recursive: true, force: true });
        continue;
      }
    } catch { /* lock vanished between calls — retry immediately */ continue; }
    if (waited === 0) console.error('[build-lock] another build is running; waiting…');
    waited += POLL_MS;
    sleep(POLL_MS);
  }
}

if (waited > 0) console.error(`[build-lock] acquired after ${Math.round(waited / 1000)}s.`);
try {
  const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', shell: true });
  process.exit(r.status ?? 1);
} finally {
  rmSync(LOCK, { recursive: true, force: true });
}
