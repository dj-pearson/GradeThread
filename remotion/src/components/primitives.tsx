import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { COLORS, FONT, OVERLAP } from "../theme";

const brandGradient = `radial-gradient(120% 120% at 15% 10%, ${COLORS.navy} 0%, ${COLORS.night} 55%, ${COLORS.nightDeep} 100%)`;

/** Full-frame scene that crossfades in over OVERLAP frames. */
export const Scene: React.FC<{
  bg?: string;
  gradient?: boolean;
  children: React.ReactNode;
}> = ({ bg = COLORS.nightDeep, gradient = true, children }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, OVERLAP], [0, 1], {
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill
      style={{
        opacity,
        fontFamily: FONT,
        background: gradient ? brandGradient : bg,
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

/** A polished "browser card" holding a real screenshot with a slow Ken-Burns zoom. */
export const Screenshot: React.FC<{
  src: string;
  url?: string;
  zoom?: "in" | "out";
  focusY?: number; // 0..1 object-position vertical
}> = ({ src, url = "gradethread.com", zoom = "in", focusY = 0.5 }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const p = interpolate(frame, [0, durationInFrames], [0, 1], {
    extrapolateRight: "clamp",
  });
  const scale = zoom === "in" ? 1.05 + p * 0.09 : 1.14 - p * 0.09;
  const enter = spring({ frame, fps: 30, config: { damping: 200 } });
  const cardY = interpolate(enter, [0, 1], [40, 0]);

  return (
    <AbsoluteFill
      style={{ justifyContent: "center", alignItems: "center" }}
    >
      <div
        style={{
          width: 1600,
          height: 820,
          transform: `translateY(${cardY}px)`,
          borderRadius: 22,
          overflow: "hidden",
          background: "#0b1220",
          boxShadow:
            "0 40px 120px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06)",
        }}
      >
        {/* faux browser chrome */}
        <div
          style={{
            height: 46,
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "0 18px",
            background: "#111a2e",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          <Dot c="#ff5f57" />
          <Dot c="#febc2e" />
          <Dot c="#28c840" />
          <div
            style={{
              marginLeft: 16,
              flex: 1,
              maxWidth: 520,
              height: 26,
              borderRadius: 13,
              background: "rgba(255,255,255,0.06)",
              color: COLORS.slate,
              fontSize: 15,
              display: "flex",
              alignItems: "center",
              paddingLeft: 16,
            }}
          >
            {url}
          </div>
        </div>
        <div style={{ width: "100%", height: 774, overflow: "hidden" }}>
          <Img
            src={staticFile(src)}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              objectPosition: `50% ${focusY * 100}%`,
              transform: `scale(${scale})`,
            }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};

const Dot: React.FC<{ c: string }> = ({ c }) => (
  <div style={{ width: 13, height: 13, borderRadius: 7, background: c }} />
);

/** Animated lower-third caption with a red accent bar. */
export const Caption: React.FC<{ text: string; kicker?: string }> = ({
  text,
  kicker,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 200 } });
  const y = interpolate(s, [0, 1], [50, 0]);
  const opacity = interpolate(frame, [0, 12], [0, 1], {
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        left: 160,
        bottom: 90,
        transform: `translateY(${y}px)`,
        opacity,
        display: "flex",
        alignItems: "center",
        gap: 22,
      }}
    >
      <div
        style={{ width: 8, height: 74, borderRadius: 4, background: COLORS.red }}
      />
      <div>
        {kicker ? (
          <div
            style={{
              color: COLORS.red,
              fontSize: 22,
              fontWeight: 700,
              letterSpacing: 3,
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            {kicker}
          </div>
        ) : null}
        <div style={{ color: COLORS.white, fontSize: 46, fontWeight: 700 }}>
          {text}
        </div>
      </div>
    </div>
  );
};

/** Darkens the frame except a bright ellipse highlighting a region. */
export const Spotlight: React.FC<{
  x: number;
  y: number;
  rx?: number;
  ry?: number;
  delay?: number;
}> = ({ x, y, rx = 320, ry = 150, delay = 8 }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [delay, delay + 14], [0, 0.62], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(${rx}px ${ry}px at ${x}px ${y}px, rgba(0,0,0,0) 60%, rgba(3,6,16,1) 100%)`,
        opacity,
      }}
    />
  );
};

/** Animated cursor that glides from (x1,y1) to (x2,y2) and clicks. */
export const Cursor: React.FC<{
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  moveStart?: number;
  moveDur?: number;
}> = ({ x1, y1, x2, y2, moveStart = 10, moveDur = 26 }) => {
  const frame = useCurrentFrame();
  const t = interpolate(frame, [moveStart, moveStart + moveDur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const ease = t * t * (3 - 2 * t); // smoothstep
  const x = interpolate(ease, [0, 1], [x1, x2]);
  const y = interpolate(ease, [0, 1], [y1, y2]);
  const clickAt = moveStart + moveDur + 4;
  const ripple = interpolate(frame, [clickAt, clickAt + 18], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const rippleScale = interpolate(ripple, [0, 1], [0.2, 2.4]);
  const rippleOpacity = interpolate(ripple, [0, 0.2, 1], [0, 0.5, 0]);
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: x,
          top: y,
          width: 70,
          height: 70,
          marginLeft: -35,
          marginTop: -35,
          borderRadius: 999,
          border: `4px solid ${COLORS.red}`,
          transform: `scale(${rippleScale})`,
          opacity: rippleOpacity,
        }}
      />
      <svg
        width="46"
        height="46"
        viewBox="0 0 24 24"
        style={{
          position: "absolute",
          left: x,
          top: y,
          filter: "drop-shadow(0 4px 6px rgba(0,0,0,0.5))",
        }}
      >
        <path
          d="M4 2 L4 20 L9 15 L12.5 22 L15 21 L11.5 14 L18 14 Z"
          fill="#ffffff"
          stroke="#0b1220"
          strokeWidth="1"
        />
      </svg>
    </>
  );
};

/** GradeThread wordmark. */
export const Wordmark: React.FC<{ size?: number }> = ({ size = 44 }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 14,
      fontSize: size,
      fontWeight: 800,
      letterSpacing: 1,
    }}
  >
    <Img
      src={staticFile("brand/logo_icon.png")}
      style={{ height: size * 1.25, borderRadius: size * 0.28 }}
    />
    <span style={{ color: COLORS.white }}>
      GRADE<span style={{ color: COLORS.red }}>THREAD</span>
    </span>
  </div>
);
