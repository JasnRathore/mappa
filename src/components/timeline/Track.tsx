import React from "react";
import { useDroppable } from "@dnd-kit/core";
import { TimelineClip } from "./TimelineClip";
import { useProjectStore } from "../../store/useProjectStore";
import { Eye, EyeSlash, Lock, LockOpen } from "@phosphor-icons/react";

interface Props {
  trackIndex: number;
}

const TRACK_HEADER_WIDTH = 96;

export const Track: React.FC<Props> = ({ trackIndex }) => {
  const { timelineElements, project, timelineZoom, trackStates, toggleTrackState } = useProjectStore();
  const elements = timelineElements.filter((e) => e.trackIndex === trackIndex);
  const trackState = trackStates[trackIndex] || { locked: false, hidden: false };

  const { setNodeRef, isOver } = useDroppable({
    id: `track-${trackIndex}`,
    data: { trackIndex },
  });

  const totalWidth = project ? project.durationFrames * timelineZoom : 0;

  return (
    <div className="flex" style={{ height: 48 }}>
      {/* Track Label */}
      <div
        className="shrink-0 flex items-center justify-between px-2 select-none"
        style={{
          width: TRACK_HEADER_WIDTH,
          background: "#1c1c1c",
          borderRight: "1px solid #2a2a2a",
          borderBottom: "1px solid #222",
        }}
      >
        <span className={`text-[10px] font-bold ${trackState.locked ? 'text-orange-500/70' : 'text-zinc-500'}`}>
          V{trackIndex + 1}
        </span>
        <div className="flex gap-1.5">
          <button 
            onClick={() => toggleTrackState(trackIndex, "hidden")}
            className={`transition-colors ${trackState.hidden ? 'text-blue-500' : 'text-zinc-600 hover:text-zinc-400'}`}
          >
            {trackState.hidden ? <EyeSlash size={14} weight="fill" /> : <Eye size={14} />}
          </button>
          <button 
            onClick={() => toggleTrackState(trackIndex, "locked")}
            className={`transition-colors ${trackState.locked ? 'text-orange-500' : 'text-zinc-600 hover:text-zinc-400'}`}
          >
            {trackState.locked ? <Lock size={14} weight="fill" /> : <LockOpen size={14} />}
          </button>
        </div>
      </div>

      {/* Drop Area */}
      <div
        ref={setNodeRef}
        className="flex-1 relative"
        style={{
          minWidth: totalWidth,
          borderBottom: "1px solid #222",
          background: isOver
            ? "rgba(255,255,255,0.04)"
            : trackIndex % 2 === 0
            ? "#161616"
            : "#141414",
          transition: "background 0.1s",
        }}
      >
        {/* Second-grid lines */}
        {project && (
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              backgroundImage: `repeating-linear-gradient(
                to right,
                transparent,
                transparent ${project.fps * timelineZoom - 1}px,
                rgba(255,255,255,0.04) ${project.fps * timelineZoom - 1}px,
                rgba(255,255,255,0.04) ${project.fps * timelineZoom}px
              )`,
            }}
          />
        )}

        {/* Clips */}
        <div className="absolute top-1 bottom-1 left-0 right-0">
          {elements.map((el) => (
            <TimelineClip key={el.id} element={el} />
          ))}
        </div>
      </div>
    </div>
  );
};
