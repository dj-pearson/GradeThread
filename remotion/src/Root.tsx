import React from "react";
import { Composition } from "remotion";
import { VIDEO } from "./theme";
import { GradeThreadGuide, GRADETHREAD_DURATION } from "./GradeThreadGuide";
import { FlipDeskGuide, FLIPDESK_DURATION } from "./FlipDeskGuide";

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="GradeThreadGuide"
      component={GradeThreadGuide}
      durationInFrames={GRADETHREAD_DURATION}
      fps={VIDEO.fps}
      width={VIDEO.width}
      height={VIDEO.height}
    />
    <Composition
      id="FlipDeskGuide"
      component={FlipDeskGuide}
      durationInFrames={FLIPDESK_DURATION}
      fps={VIDEO.fps}
      width={VIDEO.width}
      height={VIDEO.height}
    />
  </>
);
