import React, { useState, useCallback, useEffect, useRef } from "react";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import type { TimelineElement } from "../../types";
import { useProjectStore } from "../../store/useProjectStore";

interface Props {
  element: TimelineElement;
}

export const TimelineClip: React.FC<Props> = ({ element }) => {
  const { 
    timelineZoom, 
    activeElementId, 
    setActiveElementId, 
    activeTool, 
    splitTimelineElement,
    updateTimelineElement,
    snapFrame,
    trackStates
  } = useProjectStore();
  
  const trackState = trackStates[element.trackIndex] || { locked: false, hidden: false };
  const isLocked = trackState.locked;
  
  const width = element.durationFrames * timelineZoom;
  const left = element.startFrame * timelineZoom;

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: element.id,
    data: element,
    disabled: activeTool === "blade" || isLocked // Disable dragging if blade active or track locked
  });

  const style: React.CSSProperties = {
    position: 'absolute',
    left: `${left}px`,
    width: `${width}px`,
    height: '100%',
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 10 : 1,
    touchAction: 'none'
  };

  const isSelected = activeElementId === element.id;

  // Trimming State
  const [trimEdge, setTrimEdge] = useState<"left" | "right" | null>(null);
  const trimState = useRef<{ startX: number; origStart: number; origDuration: number; isRipple: boolean } | null>(null);

  const handleTrimMouseDown = (e: React.PointerEvent, edge: "left" | "right") => {
    if (isLocked) return;
    e.stopPropagation();
    e.preventDefault();
    setTrimEdge(edge);
    trimState.current = {
      startX: e.clientX,
      origStart: element.startFrame,
      origDuration: element.durationFrames,
      isRipple: e.shiftKey
    };
  };

  useEffect(() => {
    if (!trimEdge) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!trimState.current) return;
      const { startX, origStart, origDuration, isRipple } = trimState.current;
      const deltaX = e.clientX - startX;
      const frameDelta = Math.round(deltaX / timelineZoom);

      if (trimEdge === "left") {
        let newStart = origStart + frameDelta;
        newStart = snapFrame(newStart);
        useProjectStore.getState().trimTimelineElement(element.id, "start", newStart, isRipple);
      } else {
        let potentialEnd = origStart + origDuration + frameDelta;
        potentialEnd = snapFrame(potentialEnd);
        useProjectStore.getState().trimTimelineElement(element.id, "end", potentialEnd, isRipple);
      }
    };

    const handleMouseUp = () => {
      setTrimEdge(null);
      trimState.current = null;
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [trimEdge, element.id, timelineZoom, snapFrame, updateTimelineElement]);

  const handleClipClick = (e: React.MouseEvent) => {
    if (activeTool === "blade") {
      e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const frameOffset = Math.floor(clickX / timelineZoom);
      const splitFrame = element.startFrame + frameOffset;
      const snappedSplit = snapFrame(splitFrame);
      
      if (snappedSplit > element.startFrame && snappedSplit < element.startFrame + element.durationFrames) {
        if (!isLocked) {
          splitTimelineElement(element.id, snappedSplit);
        }
      }
    } else {
      setActiveElementId(element.id);
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`
        rounded-sm border flex items-center overflow-hidden transition-shadow group
        ${activeTool === "blade" ? "cursor-cell" : "cursor-grab active:cursor-grabbing"}
        ${isSelected ? 'border-white shadow-[0_0_0_1px_white]' : 'border-zinc-700/50 hover:border-zinc-500'}
        ${element.type === 'location' ? 'bg-orange-800/80 text-orange-200' : 'bg-purple-800/80 text-purple-200'}
      `}
      onClick={handleClipClick}
      onMouseDown={(e) => {
        if (activeTool !== "blade") {
          e.stopPropagation();
        }
      }}
      {...(activeTool === "blade" ? {} : listeners)}
      {...(activeTool === "blade" ? {} : attributes)}
    >
      <div className="px-2 truncate text-[10px] font-medium leading-tight pointer-events-none">
        {element.name}
      </div>
      
      {/* Visual trim handles */}
      {activeTool === "pointer" && !isLocked && (
        <>
          <div 
            className="absolute left-0 top-0 bottom-0 w-1.5 bg-white/0 hover:bg-white/40 cursor-col-resize z-20"
            onPointerDown={(e) => handleTrimMouseDown(e, "left")}
          />
          <div 
            className="absolute right-0 top-0 bottom-0 w-1.5 bg-white/0 hover:bg-white/40 cursor-col-resize z-20"
            onPointerDown={(e) => handleTrimMouseDown(e, "right")}
          />
        </>
      )}

      {/* Locked Pattern Overlay */}
      {isLocked && (
        <div 
          className="absolute inset-0 pointer-events-none opacity-20"
          style={{
            backgroundImage: `repeating-linear-gradient(45deg, transparent, transparent 5px, rgba(255,255,255,0.5) 5px, rgba(255,255,255,0.5) 10px)`
          }}
        />
      )}
    </div>
  );
};
