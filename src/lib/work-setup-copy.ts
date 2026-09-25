// Worth My Time (WMT-06): the words for the seller's setup.

import type { WorkTool } from "@/lib/work-candidates";

/** The order the chips appear in. Mirrors WORK_TOOLS on the edge. */
export const WORK_TOOL_ORDER: readonly WorkTool[] = [
  "measuring_tape",
  "steamer",
  "packing_supplies",
  "camera",
];

export const WORK_TOOL_LABELS: Record<WorkTool, string> = {
  measuring_tape: "Tape measure",
  steamer: "Steamer",
  packing_supplies: "Packing supplies",
  camera: "Camera",
};

/** The tool inside a sentence: "9 jobs need a tape measure." */
export const WORK_TOOL_NEED: Record<WorkTool, string> = {
  measuring_tape: "a tape measure",
  steamer: "a steamer",
  packing_supplies: "packing supplies",
  camera: "a camera",
};

/** "9 jobs need a tape measure." Counted per tool, never summed across. */
export function gatedToolLine(tool: WorkTool, count: number): string {
  return `${count} ${count === 1 ? "job needs" : "jobs need"} ${WORK_TOOL_NEED[tool]}.`;
}
