import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { main, extractBlockedReason } from "./run-sdk.mjs";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "../..");
const LOGS = path.join(HERE, "codex-logs");

export function codexCommand(env = process.env, platform = process.platform) {
  if (env.RALPH_CODEX_BIN) return { command: env.RALPH_CODEX_BIN, prefix: [] };
  if (platform !== "win32") return { command: "codex", prefix: [] };
  // Run the npm entry with Node directly. Never send prompts through cmd.exe.
  const matches = execFileSync("where.exe", ["codex"], { encoding: "utf8" }).trim().split(/\r?\n/);
  for (const match of matches) {
    if (match.endsWith(".exe")) return { command: match, prefix: [] };
    const entry = path.join(path.dirname(match), "node_modules/@openai/codex/bin/codex.js");
    if (existsSync(entry)) return { command: process.execPath, prefix: [entry] };
  }
  throw new Error("Cannot find the Codex executable. Install Codex CLI or set RALPH_CODEX_BIN to its executable.");
}

export function buildArgs({ model, resumeId, output, sandbox = "workspace-write" }) {
  const args = ["exec", "-c", 'approval_policy="never"', "-c", `sandbox_mode="${sandbox}"`];
  if (resumeId) args.push("resume", resumeId);
  args.push("--json", "--output-last-message", output);
  if (model && model !== "configured default") args.push("--model", model);
  args.push("-");
  return args;
}

export function classifyResult({ code, completed, failed, final, aborted, sessionId }) {
  const success = code === 0 && completed && !failed && !aborted;
  const done = success && /^<promise>STORY_DONE<\/promise>\s*$/m.test(final);
  const blocked = success && !done && /^<promise>STORY_BLOCKED<\/promise>/m.test(final);
  return {
    done, blocked, blockedReason: blocked ? extractBlockedReason(final) : "",
    sessionId, aborted, fatal: !success,
    result: success ? { subtype: "success", stop_reason: "completed" } : null,
  };
}

export async function runCodex(story, model, resumeId, overrides = {}) {
  const timeout = Number(process.env.RALPH_ITER_TIMEOUT ?? 2400) * 1000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("RALPH_ITER_TIMEOUT must be positive.");
  mkdirSync(LOGS, { recursive: true });
  const output = path.join(LOGS, `${story.id}-last.txt`);
  rmSync(output, { force: true });
  const { command, prefix } = overrides.command ?? codexCommand();
  const prompt = overrides.prompt ?? readFileSync(path.join(HERE, "CODEX.md"), "utf8");
  const args = [...prefix, ...buildArgs({ model, resumeId, output })];
  let sessionId = resumeId ?? null;
  let completed = false;
  let failed = false;
  let aborted = false;
  let usage = {};
  const started = Date.now();
  const child = spawn(command, args, { cwd: ROOT, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const stopChild = () => {
    if (!child.pid || child.exitCode !== null) return;
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else child.kill("SIGTERM");
  };
  const timer = setTimeout(() => {
    aborted = true;
    try { stopChild(); } catch { child.kill(); }
  }, timeout);
  const interrupt = () => { aborted = true; try { stopChild(); } catch { child.kill(); } };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === "thread.started") sessionId = event.thread_id;
    if (event.type === "turn.completed") { completed = true; usage = event.usage ?? {}; }
    if (event.type === "turn.failed" || event.type === "error") {
      failed = true;
      console.error(event.error?.message ?? event.message ?? "Codex execution failed.");
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      console.log(event.item.text);
    }
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.stdin.on("error", () => {}); // Early auth/launch failure may close stdin.
  const code = await new Promise((resolve) => {
    child.once("error", (err) => { console.error(err.message); resolve(-1); });
    child.once("close", resolve);
    child.stdin.end(prompt);
  });
  clearTimeout(timer);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  lines.close();
  const final = existsSync(output) ? readFileSync(output, "utf8") : "";
  const outcome = classifyResult({ code, completed, failed, final, aborted, sessionId });
  if (outcome.result) Object.assign(outcome.result, { usage, duration_ms: Date.now() - started, num_turns: 1 });
  return outcome;
}

async function start() {
  const count = process.argv[2] ?? "10";
  if (!/^\d+$/.test(count) || Number(count) < 1 || !Number.isSafeInteger(Number(count))) {
    throw new Error("Use a positive attempt count: npm run ralph -- 10");
  }
  const executable = codexCommand();
  execFileSync(executable.command, [...executable.prefix, "login", "status"], { stdio: "inherit" });
  console.log("GradeThread loop provider: Codex. Usage/login/transport errors stop the loop for a manual restart.");
  await main({
    runStory: runCodex,
    resolveModel: () => process.env.RALPH_CODEX_MODEL || "configured default",
    sessionsFile: path.join(HERE, "codex-sessions.json"),
    costsFile: path.join(HERE, "codex-usage.jsonl"),
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  start().catch((err) => { console.error(err.message); process.exitCode = 1; });
}
