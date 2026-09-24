import type { DisputeKind } from "@/types/database";

// SUB-04: grade disputes and authenticity appeals share the table. The count
// and each row name which one they are.
export function disputeCountLabel(
  rows: ReadonlyArray<{ kind: DisputeKind }>,
): string {
  const appeals = rows.filter((r) => r.kind === "authenticity").length;
  const grades = rows.length - appeals;
  const parts: string[] = [];
  if (grades > 0) parts.push(`${grades} dispute${grades !== 1 ? "s" : ""}`);
  if (appeals > 0) parts.push(`${appeals} appeal${appeals !== 1 ? "s" : ""}`);
  return parts.join(", ");
}

export const DISPUTE_KIND_LABEL: Record<DisputeKind, string> = {
  grade: "Grade dispute",
  authenticity: "Authenticity appeal",
};
