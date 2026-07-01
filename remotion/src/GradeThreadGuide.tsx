import React from "react";
import { AbsoluteFill } from "remotion";
import { COLORS } from "./theme";
import { Scene, Screenshot, Caption, Spotlight } from "./components/primitives";
import { TitleCard, OutroCard } from "./components/cards";
import { GradePanel } from "./components/grade";
import { Stack, SceneDef, totalDuration } from "./stack";

const scenes: SceneDef[] = [
  {
    key: "title",
    len: 110,
    el: (
      <Scene>
        <TitleCard
          headline="Grade any garment in seconds"
          sub="GradeThread turns a few photos into a trusted 1.0–10.0 condition grade — so buyers know exactly what they're getting."
        />
      </Scene>
    ),
  },
  {
    key: "dashboard",
    len: 120,
    el: (
      <Scene>
        <Screenshot src="shots/dashboard.jpg" focusY={0.15} />
        <Caption kicker="Step 1" text="Snap photos of any garment" />
      </Scene>
    ),
  },
  {
    key: "submissions",
    len: 120,
    el: (
      <Scene>
        <Screenshot src="shots/submissions.jpg" focusY={0.4} />
        <Spotlight x={1300} y={430} rx={360} ry={120} />
        <Caption kicker="Step 2" text="A clear grade, every time" />
      </Scene>
    ),
  },
  {
    key: "report",
    len: 90,
    el: (
      <Scene>
        <Screenshot src="shots/grade_report.jpg" focusY={0.55} />
        <Caption kicker="Every grade is explained" text="A real, shareable grade report" />
      </Scene>
    ),
  },
  {
    key: "panel",
    len: 180,
    el: (
      <Scene>
        <GradePanel
          title="Vuori Women's Jogger Sweatpants · Bottoms"
          grade={8.5}
          tier="Excellent"
          confidence={0.6}
          factors={[
            { label: "Fabric Condition", weight: 30, score: 8.5 },
            { label: "Structural Integrity", weight: 25, score: 8.5 },
            { label: "Cosmetic Appearance", weight: 20, score: 8.0 },
            { label: "Functional Components", weight: 15, score: 9.0 },
            { label: "Odor & Cleanliness", weight: 10, score: 8.5 },
          ]}
        />
      </Scene>
    ),
  },
  {
    key: "outro",
    len: 95,
    el: (
      <Scene>
        <OutroCard headline="The standard for pre-owned clothing condition" />
      </Scene>
    ),
  },
];

export const GRADETHREAD_DURATION = totalDuration(scenes);

export const GradeThreadGuide: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: COLORS.nightDeep }}>
    <Stack scenes={scenes} />
  </AbsoluteFill>
);
