import React, { useMemo } from "react";
import { useProjectStore } from "../../store/useProjectStore";
import { Playhead } from "./Playhead";

function formatTime(frames: number, fps: number) {
  const totalSecs = frames / fps;
  const m = Math.floor(totalSecs / 60).toString().padStart(2, "0");
  const s = Math.floor(totalSecs % 60).toString().padStart(2, "0");
  const f = Math.floor(frames % fps).toString().padStart(2, "0");
  return `${m}:${s}:${f}`;
}

export const TimecodeRuler: React.FC = () => {
  const { project, timelineZoom, setFrame } = useProjectStore();
  if (!project) return null;

  const { durationFrames, fps } = project;
  const totalWidth = durationFrames * timelineZoom;

  // Calculate reasonable tick interval
  // We want ticks every ~80px min
  const minPixelSpacing = 80;
  const framesPerTick = Math.ceil(minPixelSpacing / timelineZoom / fps) * fps;
  const effectiveFpt = Math.max(fps, framesPerTick);

  const ticks = useMemo(() => {
    const result: { frame: number; label: string }[] = [];
    for (let f = 0; f <= durationFrames; f += effectiveFpt) {
      result.push({ frame: f, label: formatTime(f, fps) });
    }
    return result;
  }, [durationFrames, effectiveFpt, fps]);

  const handleRulerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    let frame = Math.floor(x / timelineZoom);
    frame = Math.max(0, Math.min(frame, durationFrames - 1));
    setFrame(frame);
  };

  return (
    <div
      className="relative h-full cursor-col-resize select-none"
      style={{ minWidth: totalWidth }}
      onClick={handleRulerClick}
    >
      {/* Major ticks & labels */}
      {ticks.map(({ frame, label }) => (
        <div
          key={frame}
          className="absolute top-0 flex flex-col items-start"
          style={{ left: frame * timelineZoom }}
        >
          <span className="text-[9px] font-mono text-zinc-500 pl-0.5 leading-none pt-0.5">
            {label}
          </span>
          <div className="w-px h-2 bg-zinc-600 mt-auto" />
        </div>
      ))}

      {/* Minor ticks (every second) */}
      {Array.from({ length: Math.ceil(durationFrames / fps) }).map((_, i) => {
        const f = i * fps;
        if (f % effectiveFpt === 0) return null; // skip major tick positions
        const px = f * timelineZoom;
        if (px < 0 || px > totalWidth) return null;
        return (
          <div
            key={`m-${i}`}
            className="absolute bottom-0 w-px h-1.5 bg-zinc-700"
            style={{ left: px }}
          />
        );
      })}

      {/* Playhead */}
      <Playhead />
    </div>
  );
};
