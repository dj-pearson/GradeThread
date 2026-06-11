#!/usr/bin/env node
// Cross-platform launcher for the Ralph loop (scripts/ralph/ralph.sh).
//
// Why this exists: on Windows, a bare `bash` often resolves to WSL's bash
// (C:\Windows\System32\bash.exe), which fails here ("execvpe(/bin/bash) failed").
// We need Git Bash instead. This script finds a working bash and execs ralph.sh
// through it, forwarding any extra args (e.g. `npm run ralph -- 10`).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'ralph.sh');

function resolveBash() {
  if (process.platform !== 'win32') return 'bash';
  // Prefer Git Bash; skip the WSL/Store shims on PATH.
  const candidates = [
    process.env.GIT_BASH, // optional override
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  // Last resort: hope a non-WSL bash is on PATH.
  return 'bash';
}

const bash = resolveBash();
const args = [script, ...process.argv.slice(2)];
const res = spawnSync(bash, args, { stdio: 'inherit' });
if (res.error) {
  console.error(`Failed to launch ralph.sh via "${bash}":`, res.error.message);
  process.exit(1);
}
process.exit(res.status ?? 1);
