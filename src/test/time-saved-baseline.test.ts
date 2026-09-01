import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TIME_SAVED_MINUTES,
  TIME_SAVED_TASKS,
  formatMinutes,
} from "@/lib/time-saved";

// US-9207 AC1: the vault note is the contract, the two time-saved.ts files are
// its mirrors (the pricing.md pattern). This parses the note's table and fails
// when any of the three disagrees, in either direction.

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function tableMinutes(md: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of md.split("\n")) {
    const m = /^\|\s*([a-z_]+)\s*\|\s*(\d+)\s*\|\s*(.+?)\s*\|$/.exec(line);
    if (!m) continue;
    out[m[1]!] = Number(m[2]);
    expect(m[3]!.length, `${m[1]} has no source`).toBeGreaterThan(20);
  }
  return out;
}

function edgeMinutes(src: string): Record<string, number> {
  const block = /TIME_SAVED_MINUTES[^{]*\{([\s\S]*?)\}/.exec(src)?.[1] ?? "";
  const out: Record<string, number> = {};
  for (const m of block.matchAll(/(\w+):\s*(\d+)/g)) out[m[1]!] = Number(m[2]);
  return out;
}

describe("time-saved baseline (US-9207)", () => {
  const note = tableMinutes(read("vault/50-business/time-saved-baseline.md"));
  const edge = edgeMinutes(read("services/edge-functions/src/lib/time-saved.ts"));

  it("the note names every task with a positive minute figure and a source", () => {
    expect(Object.keys(note).sort()).toEqual([...TIME_SAVED_TASKS].sort());
    for (const t of TIME_SAVED_TASKS) expect(note[t]).toBeGreaterThan(0);
  });
  it("the web mirror matches the note", () => {
    expect(TIME_SAVED_MINUTES).toEqual(note);
  });
  it("the edge mirror matches the note", () => {
    expect(edge).toEqual(note);
  });
  it("the tile formats minutes as hours and minutes", () => {
    expect(formatMinutes(400)).toBe("6h 40m");
    expect(formatMinutes(40)).toBe("40m");
    expect(formatMinutes(120)).toBe("2h");
    expect(formatMinutes(0)).toBe("0m");
  });
});
