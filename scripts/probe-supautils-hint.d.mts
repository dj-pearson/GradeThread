// Type declarations for the US-2403 safe prod probe so the Vitest unit test
// (src/test/supautils-hint-probe.test.ts) imports it without TS7016.

export interface ProbeLeg {
  hintPresent: boolean;
}

export interface ProbeVerdict {
  conclusive: boolean;
  finding: "control_failed" | "hint_path_active" | "hint_path_quiet";
  say: string;
}

export function verdict(input: { control: ProbeLeg; subject: ProbeLeg }): ProbeVerdict;
