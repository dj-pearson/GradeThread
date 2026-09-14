import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildArgs, classifyResult, codexCommand } from "./run-codex.mjs";
import { acquireLock } from "./loop-lock.mjs";

const success = { code: 0, completed: true, failed: false, aborted: false, sessionId: "session-1", final: "<promise>STORY_DONE</promise>" };
describe("Codex completion", () => {
  it("requires successful process and completed turn before closing a story", () => {
    expect(classifyResult(success).done).toBe(true);
    for (const failure of [{ code: 1 }, { completed: false }, { failed: true }, { aborted: true }]) {
      expect(classifyResult({ ...success, ...failure })).toMatchObject({ done: false, fatal: true });
    }
  });
  it("does not treat a quoted token as completion", () => {
    expect(classifyResult({ ...success, final: "Do not output <promise>STORY_DONE</promise> yet" }).done).toBe(false);
  });
  it("keeps human-blocked stories open", () => {
    expect(classifyResult({ ...success, final: "<promise>STORY_BLOCKED</promise> Reconnect eBay" }))
      .toMatchObject({ done: false, blocked: true, fatal: false, blockedReason: "Reconnect eBay" });
  });
  it("retains the session for an incomplete attempt", () => {
    expect(classifyResult({ ...success, final: "Tests still need fixing" }))
      .toMatchObject({ done: false, blocked: false, fatal: false, sessionId: "session-1" });
  });
});

describe("Codex invocation", () => {
  it("uses the configured model instead of Claude's story model", () => {
    const args = buildArgs({ model: "configured default", output: "a path/output.txt" });
    expect(args).not.toContain("--model");
    expect(args).toContain('sandbox_mode="workspace-write"');
    expect(args.at(-1)).toBe("-");
  });
  it("resumes only the specified story session", () => {
    const args = buildArgs({ model: "chosen-model", resumeId: "specific-session", output: "out.txt" });
    expect(args).toContain("resume");
    expect(args).toContain("specific-session");
    expect(args).not.toContain("--last");
    expect(args).toContain("chosen-model");
  });
  it("accepts an executable override without shell expansion", () => {
    expect(codexCommand({ RALPH_CODEX_BIN: "C:/some path/codex.exe" }, "win32"))
      .toEqual({ command: "C:/some path/codex.exe", prefix: [] });
  });
});

it("refuses a second loop while the first owns the lock", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ralph-lock-test-"));
  const file = path.join(dir, "lock");
  try {
    const release = acquireLock(file);
    expect(() => acquireLock(file)).toThrow("already running");
    release();
    acquireLock(file)();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
