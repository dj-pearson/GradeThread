import React from "react";
import {
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { COLORS, FONT } from "../theme";

const tierColor = (g: number) =>
  g >= 9 ? COLORS.green : g >= 7 ? "#4ade80" : g >= 5 ? COLORS.amber : COLORS.red;

/** Animated circular grade with a count-up number. */
export const GradeRing: React.FC<{
  grade: number;
  tier: string;
  size?: number;
  delay?: number;
}> = ({ grade, tier, size = 260, delay = 6 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const r = size / 2 - 16;
  const circ = 2 * Math.PI * r;
  const prog = spring({
    frame: frame - delay,
    fps,
    config: { damping: 200 },
    durationInFrames: 45,
  });
  const shown = grade * prog;
  const color = tierColor(grade);
  return (
    <div style={{ width: size, height: size, position: "relative" }}>
      <svg width={size} height={size}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="rgba(255,255,255,0.10)"
          strokeWidth={14}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={14}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - (shown / 10))}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            fontSize: size * 0.34,
            fontWeight: 800,
            color: COLORS.white,
            lineHeight: 1,
          }}
        >
          {shown.toFixed(1)}
        </div>
        <div
          style={{
            marginTop: 8,
            fontSize: size * 0.075,
            fontWeight: 700,
            letterSpacing: 2,
            textTransform: "uppercase",
            color,
          }}
        >
          {tier}
        </div>
      </div>
    </div>
  );
};

/** Animated weighted-factor bar. */
export const FactorBar: React.FC<{
  label: string;
  weight: number;
  score: number;
  index: number;
}> = ({ label, weight, score, index }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const delay = 20 + index * 8;
  const prog = spring({
    frame: frame - delay,
    fps,
    config: { damping: 200 },
    durationInFrames: 40,
  });
  const width = interpolate(prog, [0, 1], [0, (score / 10) * 100]);
  const opacity = interpolate(frame, [delay - 6, delay + 6], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div style={{ opacity, fontFamily: FONT, marginBottom: 26 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <span style={{ color: COLORS.white, fontSize: 27, fontWeight: 600 }}>
          {label}{" "}
          <span style={{ color: COLORS.slate, fontWeight: 500 }}>
            ({weight}%)
          </span>
        </span>
        <span style={{ color: COLORS.green, fontSize: 27, fontWeight: 700 }}>
          {(prog * score).toFixed(1)}
        </span>
      </div>
      <div
        style={{
          height: 14,
          borderRadius: 8,
          background: "rgba(255,255,255,0.08)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${width}%`,
            height: "100%",
            borderRadius: 8,
            background: `linear-gradient(90deg, ${COLORS.green}, #86efac)`,
          }}
        />
      </div>
    </div>
  );
};

/** Native recreation of the grade report — the hero of the GradeThread video. */
export const GradePanel: React.FC<{
  title: string;
  grade: number;
  tier: string;
  confidence: number;
  factors: { label: string; weight: number; score: number }[];
}> = ({ title, grade, tier, confidence, factors }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  const y = interpolate(enter, [0, 1], [40, 0]);
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "0 160px",
        transform: `translateY(${y}px)`,
        fontFamily: FONT,
      }}
    >
      <div style={{ color: COLORS.slate, fontSize: 26, marginBottom: 8 }}>
        {title}
      </div>
      <div style={{ display: "flex", gap: 80, alignItems: "center" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 18,
          }}
        >
          <GradeRing grade={grade} tier={tier} size={300} />
          <div
            style={{
              color: COLORS.white,
              fontSize: 22,
              opacity: 0.8,
            }}
          >
            Overall Condition Grade
          </div>
          <div
            style={{
              marginTop: 4,
              padding: "8px 18px",
              borderRadius: 12,
              background: "rgba(233,69,96,0.12)",
              border: `1px solid ${COLORS.red}55`,
              color: COLORS.white,
              fontSize: 20,
            }}
          >
            Confidence{" "}
            <b style={{ color: COLORS.red }}>{Math.round(confidence * 100)}%</b>
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div
            style={{
              color: COLORS.white,
              fontSize: 30,
              fontWeight: 700,
              marginBottom: 26,
            }}
          >
            Factor Breakdown
            <span
              style={{ color: COLORS.slate, fontSize: 22, fontWeight: 400 }}
            >
              {"  "}· 5 weighted grading criteria
            </span>
          </div>
          {factors.map((f, i) => (
            <FactorBar key={f.label} {...f} index={i} />
          ))}
        </div>
      </div>
    </div>
  );
};
