import React, { useMemo, useState } from "react";
import { useProjectStore } from "../../store/useProjectStore";
import { Playhead } from "./Playhead";
import { MarkerItem } from "./MarkerItem";

function formatTime(frames: number, fps: number) {
  const totalSecs = frames / fps;
  const m = Math.floor(totalSecs / 60).toString().padStart(2, "0");
  const s = Math.floor(totalSecs % 60).toString().padStart(2, "0");
  const f = Math.floor(frames % fps).toString().padStart(2, "0");
  return `${m}:${s}:${f}`;
}

export const TimecodeRuler: React.FC = () => {
  const { project, timelineZoom, setFrame, markers, updateProjectSettings, snapFrame } = useProjectStore();
  const [activeHandle, setActiveHandle] = useState<"start" | "end" | null>(null);

  if (!project) return null;

  const { durationFrames, fps, startFrame, endFrame } = project;
  const totalWidth = durationFrames * timelineZoom;

  // Calculate reasonable tick interval
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
    if (activeHandle) return; // ignore clicks while dragging handles
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const frame = Math.max(0, Math.min(Math.floor(x / timelineZoom), durationFrames - 1));
    setFrame(frame);
  };

  const handleDragHandle = (e: React.MouseEvent, type: "start" | "end") => {
    e.stopPropagation();
    setActiveHandle(type);

    const handleMouseMove = (mv: MouseEvent) => {
      const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
      const x = mv.clientX - rect.left;
      const rawFrame = Math.max(0, type === "end" ? Math.floor(x / timelineZoom) : Math.min(Math.floor(x / timelineZoom), durationFrames));
      const frame = snapFrame(rawFrame);

      if (type === "start") {
        updateProjectSettings({ startFrame: Math.min(frame, project.endFrame - 1) });
      } else {
        updateProjectSettings({ endFrame: Math.max(frame, project.startFrame + 1) });
      }
    };

    const handleMouseUp = () => {
      setActiveHandle(null);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  return (
    <div
      className="relative h-full select-none"
      style={{ minWidth: totalWidth }}
      onClick={handleRulerClick}
    >
      {/* Markers Container */}
      <div className="absolute inset-0 z-10 pointer-events-none">
        {markers.map(marker => (
          <div key={marker.id} className="pointer-events-auto">
            <MarkerItem marker={marker} />
          </div>
        ))}
      </div>

      {/* Range dimming (Overlay over entire ruler height) */}
      <div className="absolute top-0 bottom-0 left-0 bg-black/40 pointer-events-none" 
           style={{ width: startFrame * timelineZoom }} />
      <div className="absolute top-0 bottom-0 right-0 bg-black/40 pointer-events-none" 
           style={{ left: endFrame * timelineZoom, width: (durationFrames - endFrame) * timelineZoom }} />

      {/* Start/End handles */}
      <div 
        onMouseDown={(e) => handleDragHandle(e, "start")}
        className="absolute bottom-0 w-[11px] h-6 cursor-col-resize z-20 group -translate-x-full"
        style={{ left: startFrame * timelineZoom }}
      >
        <div className="absolute right-0 top-0 bottom-0 w-px bg-primary shadow-[0_0_8px_primary]" />
        <div className="absolute top-0 right-0 w-2.5 h-3 bg-primary rounded-bl-sm flex items-center justify-center">
            <span className="text-[7px] text-white font-bold">S</span>
        </div>
      </div>

      <div 
        onMouseDown={(e) => handleDragHandle(e, "end")}
        className="absolute bottom-0 w-[11px] h-6 cursor-col-resize z-20 group"
        style={{ left: endFrame * timelineZoom }}
      >
        <div className="absolute left-0 top-0 bottom-0 w-px bg-primary shadow-[0_0_8px_primary]" />
        <div className="absolute top-0 left-0 w-2.5 h-3 bg-primary rounded-br-sm flex items-center justify-center">
             <span className="text-[7px] text-white font-bold">E</span>
        </div>
      </div>

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

      {/* Playhead */}
      <Playhead />
    </div>
  );
};
