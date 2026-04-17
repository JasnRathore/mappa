import React, { useState } from "react";
import { useProjectStore } from "../../store/useProjectStore";
import type { Marker } from "../../types";

interface MarkerItemProps {
  marker: Marker;
}

export const MarkerItem: React.FC<MarkerItemProps> = ({ marker }) => {
  const { timelineZoom, moveMarker, deleteMarker, snapFrame } = useProjectStore();
  const [isDragging, setIsDragging] = useState(false);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsDragging(true);

    const startX = e.clientX;
    const startFrame = marker.frame;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaFrames = Math.round(deltaX / timelineZoom);
      const nextFrame = snapFrame(startFrame + deltaFrames);
      moveMarker(marker.id, Math.max(0, nextFrame));
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (confirm(`Delete marker "${marker.label}"?`)) {
      deleteMarker(marker.id);
    }
  };

  return (
    <div
      onMouseDown={handleMouseDown}
      onContextMenu={handleContextMenu}
      className={`absolute top-0 w-3 h-full cursor-grab active:cursor-grabbing group transition-opacity ${
        isDragging ? "opacity-100 z-50" : "opacity-80"
      }`}
      style={{ left: marker.frame * timelineZoom - 6 }}
      title={marker.label}
    >
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[5px] border-l-transparent border-r-[5px] border-r-transparent border-t-[8px]"
           style={{ borderTopColor: marker.color }} />
      <div className="absolute top-2 left-1/2 -translate-x-1/2 w-[1px] h-full bg-white/20 group-hover:bg-white/40" />
      
      {/* Label on hover */}
      <div className="absolute -top-6 left-1/2 -translate-x-1/2 bg-zinc-800 text-white text-[9px] px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 whitespace-nowrap pointer-events-none transition-opacity">
        {marker.label}
      </div>
    </div>
  );
};
