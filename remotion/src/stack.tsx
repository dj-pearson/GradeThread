import React from "react";
import { Sequence } from "remotion";
import { OVERLAP } from "./theme";

export type SceneDef = { el: React.ReactNode; len: number; key: string };

export const totalDuration = (scenes: SceneDef[]) =>
  scenes.reduce((a, s) => a + s.len, 0) - (scenes.length - 1) * OVERLAP;

/** Lays scenes back-to-back with an OVERLAP-frame crossfade (each Scene fades itself in). */
export const Stack: React.FC<{ scenes: SceneDef[] }> = ({ scenes }) => {
  let cursor = 0;
  return (
    <>
      {scenes.map((s, i) => {
        const from = i === 0 ? 0 : cursor - OVERLAP;
        cursor = from + s.len;
        return (
          <Sequence key={s.key} from={from} durationInFrames={s.len} layout="none">
            {s.el}
          </Sequence>
        );
      })}
    </>
  );
};
