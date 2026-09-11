import { BRAND_RED } from "@/lib/constants";

// Severity tones mirror the disclosure compositor (annotated-photo.tsx,
// vault/20-domain/brand-design-system.md §3B): crimson for major, amber for moderate, gold for minor.
// Shared by the certificate's photo callouts and its flaw map (US-3336), so a
// flaw is the same colour in both places.
const SEVERITY_COLOR: Record<string, string> = {
  major: BRAND_RED,
  moderate: "#F59E0B",
  minor: "#EAB308",
};

const DEFAULT_SEVERITY_COLOR = BRAND_RED;

export function severityColor(severity: string): string {
  return SEVERITY_COLOR[severity] ?? DEFAULT_SEVERITY_COLOR;
}
