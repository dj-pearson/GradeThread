// GradeThread brand tokens (mirrors src/index.css brand vars)
export const COLORS = {
  navy: "#0F3460",
  red: "#E94560",
  night: "#1A1A2E",
  nightDeep: "#141428",
  gray: "#F5F5F5",
  slate: "#94a3b8",
  white: "#ffffff",
  green: "#22c55e",
  amber: "#f59e0b",
};

// Segoe UI renders reliably in headless Chrome on Windows and is close to the
// brand Inter face. Swap to @remotion/google-fonts/Inter later for exact parity.
export const FONT =
  '"Segoe UI", Inter, system-ui, -apple-system, Arial, sans-serif';

export const VIDEO = { width: 1920, height: 1080, fps: 30 };
export const OVERLAP = 14; // frames of crossfade between scenes
