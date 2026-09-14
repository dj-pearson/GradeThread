import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

export function acquireLock(file) {
  if (existsSync(file)) {
    const previous = JSON.parse(readFileSync(file, "utf8"));
    let alive = true;
    try { process.kill(previous.pid, 0); } catch (err) { if (err.code === "ESRCH") alive = false; }
    if (alive) throw new Error(`A GradeThread loop is already running (PID ${previous.pid}).`);
    rmSync(file);
  }
  writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: "wx" });
  return () => rmSync(file, { force: true });
}
