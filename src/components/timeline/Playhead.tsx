import React, { useRef, useState, useEffect } from "react";
import { useProjectStore } from "../../store/useProjectStore";

function formatTimecode(frames: number, fps: number) {
  const totalSecs = frames / fps;
  const mins = Math.floor(totalSecs / 60).toString().padStart(2, '0');
  const secs = Math.floor(totalSecs % 60).toString().padStart(2, '0');
  const ff = Math.floor(frames % fps).toString().padStart(2, '0');
  return `${mins}:${secs}:${ff}`;
}

export const Playhead: React.FC = () => {
  const { currentFrame, setFrame, project, timelineZoom } = useProjectStore();
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging || !project) return;
      const tContainer = document.getElementById("timeline-scroll-container");
      if (!tContainer) return;
      
      const rect = tContainer.getBoundingClientRect();
      const scrollLeft = tContainer.scrollLeft;
      const x = e.clientX - rect.left + scrollLeft;
      
      let frame = Math.floor(x / timelineZoom);
      frame = Math.max(0, Math.min(frame, project.durationFrames - 1));
      setFrame(frame);
    };

    const handleMouseUp = () => setIsDragging(false);

    if (isDragging) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    }
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, project, timelineZoom, setFrame]);

  if (!project) return null;

  const leftPosition = currentFrame * timelineZoom;

  return (
    <div 
      className="absolute top-0 bottom-0 z-50 pointer-events-none"
      style={{ left: `${leftPosition}px` }}
    >
      <div 
        className="w-px h-full bg-red-600 shadow-[0_0_10px_rgba(255,0,0,0.5)]" 
      />
      
      <div 
        ref={containerRef}
        onMouseDown={() => setIsDragging(true)}
        className="absolute -top-[1.125rem] -left-1/2 transform -translate-x-1/2 cursor-ew-resize pointer-events-auto"
      >
        <div className="bg-red-600 text-white text-[9px] font-mono font-bold leading-none py-1 px-1.5 rounded-sm shadow-md">
           {formatTimecode(currentFrame, project.fps)}
        </div>
        <div className="w-0 h-0 border-l-[6px] border-r-[6px] border-t-[6px] border-l-transparent border-r-transparent border-t-red-600 mx-auto" />
      </div>
    </div>
  );
};
