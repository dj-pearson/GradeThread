import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { COLORS, FONT } from "./theme";
import { Scene, Screenshot, Caption, Spotlight, Cursor } from "./components/primitives";
import { TitleCard, OutroCard } from "./components/cards";
import { Stack, SceneDef, totalDuration } from "./stack";

/** A highlighted native CTA that "pops" when the cursor clicks it. */
const ConnectButton: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - 6, fps, config: { damping: 200 } });
  const press = interpolate(frame, [40, 44, 50], [1, 0.94, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        left: 960,
        top: 620,
        transform: `translate(-50%,-50%) scale(${enter * press})`,
        padding: "22px 46px",
        borderRadius: 16,
        background: COLORS.navy,
        border: `2px solid ${COLORS.red}`,
        color: COLORS.white,
        fontFamily: FONT,
        fontSize: 34,
        fontWeight: 700,
        boxShadow: `0 20px 60px rgba(233,69,96,0.35)`,
        whiteSpace: "nowrap",
      }}
    >
      Connect eBay account
    </div>
  );
};

const scenes: SceneDef[] = [
  {
    key: "title",
    len: 110,
    el: (
      <Scene>
        <TitleCard
          headline="Automate your eBay listings"
          sub="FlipDesk runs the full eBay lifecycle — connect once, then turn photos into complete listings and publish in a click."
        />
      </Scene>
    ),
  },
  {
    key: "connect",
    len: 135,
    el: (
      <Scene>
        <Screenshot src="shots/marketplaces.png" url="gradethread.com/dashboard/flipdesk" focusY={0.28} />
        <AbsoluteFill style={{ background: "rgba(3,6,16,0.35)" }} />
        <ConnectButton />
        <Cursor x1={1320} y1={880} x2={960} y2={620} moveStart={10} moveDur={26} />
        <Caption kicker="Step 1" text="Connect your eBay account once" />
      </Scene>
    ),
  },
  {
    key: "inventory",
    len: 130,
    el: (
      <Scene>
        <Screenshot src="shots/inventory.jpg" focusY={0.35} />
        <Spotlight x={720} y={470} rx={430} ry={190} delay={12} />
        <Caption kicker="Step 2" text="Bulk-select items to auto-create listings" />
      </Scene>
    ),
  },
  {
    key: "grade",
    len: 125,
    el: (
      <Scene>
        <Screenshot src="shots/grade_report.jpg" focusY={0.55} />
        <Spotlight x={430} y={540} rx={320} ry={170} delay={10} />
        <Caption kicker="Step 3" text="Every listing backed by a condition grade" />
      </Scene>
    ),
  },
  {
    key: "outro",
    len: 95,
    el: (
      <Scene>
        <OutroCard headline="List faster. Sell with trust." />
      </Scene>
    ),
  },
];

export const FLIPDESK_DURATION = totalDuration(scenes);

export const FlipDeskGuide: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: COLORS.nightDeep }}>
    <Stack scenes={scenes} />
  </AbsoluteFill>
);
