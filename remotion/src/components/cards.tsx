import React from "react";
import {
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { COLORS, FONT } from "../theme";
import { Wordmark } from "./primitives";

export const TitleCard: React.FC<{
  headline: string;
  sub: string;
  accent?: string;
}> = ({ headline, sub, accent = COLORS.red }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s1 = spring({ frame: frame - 6, fps, config: { damping: 200 } });
  const s2 = spring({ frame: frame - 16, fps, config: { damping: 200 } });
  const s3 = spring({ frame: frame - 26, fps, config: { damping: 200 } });
  const line = interpolate(s2, [0, 1], [0, 260]);
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "0 160px",
        fontFamily: FONT,
      }}
    >
      <div style={{ opacity: s1, transform: `translateY(${(1 - s1) * 30}px)` }}>
        <Wordmark size={40} />
      </div>
      <div
        style={{
          marginTop: 46,
          height: 8,
          width: line,
          background: accent,
          borderRadius: 4,
        }}
      />
      <div
        style={{
          marginTop: 30,
          fontSize: 96,
          fontWeight: 800,
          color: COLORS.white,
          lineHeight: 1.05,
          maxWidth: 1350,
          opacity: s2,
          transform: `translateY(${(1 - s2) * 34}px)`,
        }}
      >
        {headline}
      </div>
      <div
        style={{
          marginTop: 34,
          fontSize: 38,
          color: COLORS.slate,
          maxWidth: 1100,
          opacity: s3,
          transform: `translateY(${(1 - s3) * 24}px)`,
        }}
      >
        {sub}
      </div>
    </div>
  );
};

export const OutroCard: React.FC<{
  headline: string;
  url?: string;
}> = ({ headline, url = "gradethread.com" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s1 = spring({ frame: frame - 4, fps, config: { damping: 200 } });
  const s2 = spring({ frame: frame - 16, fps, config: { damping: 200 } });
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 34,
        fontFamily: FONT,
      }}
    >
      <div style={{ opacity: s1, transform: `scale(${0.9 + s1 * 0.1})` }}>
        <Wordmark size={56} />
      </div>
      <div
        style={{
          fontSize: 54,
          fontWeight: 700,
          color: COLORS.white,
          textAlign: "center",
          maxWidth: 1300,
          opacity: s2,
          transform: `translateY(${(1 - s2) * 24}px)`,
        }}
      >
        {headline}
      </div>
      <div
        style={{
          marginTop: 6,
          fontSize: 34,
          fontWeight: 700,
          color: COLORS.red,
          opacity: s2,
        }}
      >
        {url}
      </div>
    </div>
  );
};
