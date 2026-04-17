import React, { useCallback } from "react";
import { restrictToWindowEdges } from "@dnd-kit/modifiers";
import { Track } from "./Track";
import { TimecodeRuler } from "./TimecodeRuler";
import { useProjectStore } from "../../store/useProjectStore";
import type { TimelineElement } from "../../types";
import {
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  Scissors,
  Cursor,
  ArrowCounterClockwise,
  MapPin,
} from "@phosphor-icons/react";

const TRACK_COUNT = 4;
const TRACK_HEADER_WIDTH = 96;
const TRACK_HEIGHT = 48;

export const Timeline: React.FC = () => {
  const {
    project,
    currentFrame,
    setTimelineElements,
    timelineZoom,
    setTimelineZoom,
    activeTool,
    setActiveTool,
    snappingEnabled,
    setSnappingEnabled,
    addMarker,
    updateProjectSettings,
  } = useProjectStore();

  if (!project) return null;

  const totalWidth = project.durationFrames * timelineZoom;

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input
      if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.key.toLowerCase() === "m") {
        addMarker(currentFrame);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [addMarker, currentFrame]);

  return (
      <div
        className="flex-1 flex flex-col overflow-hidden"
        style={{ background: "#161616" }}
      >
        {/* Timeline Toolbar */}
        <div
          className="h-8 shrink-0 flex items-center justify-between px-2 border-b"
          style={{ background: "#1a1a1a", borderColor: "#2a2a2a" }}
        >
          {/* Left: Tool toggles */}
          <div className="flex items-center gap-1">
            <button
              title="Pointer (V)"
              onClick={() => setActiveTool("pointer")}
              className={`h-6 w-6 flex items-center justify-center rounded transition-colors text-xs ${
                activeTool === "pointer"
                  ? "bg-primary text-primary-foreground"
                  : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
              }`}
            >
              <Cursor size={13} weight={activeTool === "pointer" ? "fill" : "regular"} />
            </button>
            <button
              title="Blade (B)"
              onClick={() => setActiveTool("blade")}
              className={`h-6 w-6 flex items-center justify-center rounded transition-colors text-xs ${
                activeTool === "blade"
                  ? "bg-primary text-primary-foreground"
                  : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
              }`}
            >
              <Scissors size={13} weight={activeTool === "blade" ? "fill" : "regular"} />
            </button>

            <div className="w-px h-4 bg-zinc-700 mx-1" />

            <button
              title="Toggle Snapping (N)"
              onClick={() => setSnappingEnabled(!snappingEnabled)}
              className={`h-6 px-2 flex items-center justify-center rounded transition-colors text-[10px] font-semibold tracking-wide ${
                snappingEnabled
                  ? "bg-zinc-700 text-zinc-100"
                  : "text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800"
              }`}
            >
              SNAP
            </button>

            <div className="w-px h-4 bg-zinc-700 mx-1" />

            <button
              title="Add Marker (M)"
              onClick={() => addMarker(currentFrame)}
              className="h-6 w-6 flex items-center justify-center rounded transition-colors text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
            >
              <MapPin size={13} weight="fill" />
            </button>

            <div className="w-px h-4 bg-zinc-700 mx-1" />

            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1">
                <span className="text-[9px] font-bold text-zinc-600 uppercase tracking-tighter">Start</span>
                <input
                  type="number"
                  value={project.startFrame}
                  onChange={(e) => updateProjectSettings({ startFrame: Math.max(0, Number(e.target.value)) })}
                  className="w-12 h-5 bg-zinc-800 border-none rounded text-[10px] font-mono text-zinc-300 text-center outline-none focus:ring-1 focus:ring-primary/50"
                />
              </div>
              <div className="flex items-center gap-1">
                <span className="text-[9px] font-bold text-zinc-600 uppercase tracking-tighter">End</span>
                <input
                  type="number"
                  value={project.endFrame}
                  onChange={(e) => updateProjectSettings({ endFrame: Math.max(project.startFrame + 1, Number(e.target.value)) })}
                  className="w-12 h-5 bg-zinc-800 border-none rounded text-[10px] font-mono text-zinc-300 text-center outline-none focus:ring-1 focus:ring-primary/50"
                />
              </div>
            </div>
          </div>

          {/* Right: Zoom slider */}
          <div className="flex items-center gap-2 mr-2">
            <button
              className="text-zinc-500 hover:text-zinc-200 transition-colors"
              onClick={() => setTimelineZoom(Math.max(0.5, timelineZoom / 1.5))}
            >
              <MagnifyingGlassMinus size={14} />
            </button>
            <input
              type="range"
              min="0.3"
              max="30"
              step="0.1"
              value={timelineZoom}
              onChange={(e) => setTimelineZoom(parseFloat(e.target.value))}
              className="w-24 h-1 accent-primary cursor-pointer"
            />
            <button
              className="text-zinc-500 hover:text-zinc-200 transition-colors"
              onClick={() => setTimelineZoom(Math.min(30, timelineZoom * 1.5))}
            >
              <MagnifyingGlassPlus size={14} />
            </button>
            <span className="text-[10px] font-mono text-zinc-500 w-8 text-right">
              {timelineZoom.toFixed(1)}x
            </span>
          </div>
        </div>

        {/* Scrollable area: Ruler + Tracks */}
        <div
          id="timeline-scroll-container"
          className="flex-1 overflow-auto relative"
          style={{ scrollbarGutter: "stable" }}
        >
          {/* Ruler Row — sticky at top */}
          <div
            className="sticky top-0 z-20 flex"
            style={{ background: "#1a1a1a", height: 24, borderBottom: "1px solid #2a2a2a" }}
          >
            {/* Track header spacer */}
            <div
              className="shrink-0 flex items-center justify-center"
              style={{ width: TRACK_HEADER_WIDTH, borderRight: "1px solid #2a2a2a" }}
            >
              <ArrowCounterClockwise size={11} className="text-zinc-600" />
            </div>
            {/* Ruler */}
            <div className="flex-1 relative overflow-hidden" style={{ minWidth: totalWidth }}>
              <TimecodeRuler />
            </div>
          </div>

          {/* Track rows */}
          <div className="relative" style={{ paddingBottom: 32 }}>
            {Array.from({ length: TRACK_COUNT }).map((_, i) => (
              <Track key={i} trackIndex={i} />
            ))}
          </div>
        </div>
      </div>
  );
};
