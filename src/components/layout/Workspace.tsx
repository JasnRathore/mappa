import React, { useEffect, useCallback } from "react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import type { TimelineElement } from "../../types";
import { SearchPanel } from "../panels/SearchPanel";
import { ViewerPanel } from "../panels/ViewerPanel";
import { InspectorPanel } from "../panels/InspectorPanel";
import { Timeline } from "../timeline/Timeline";
import { useProjectStore } from "../../store/useProjectStore";
import { Button } from "../ui/button";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { saveRenderData } from "../../db";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../ui/tabs";
import { 
  Folder, 
  MagicWand, 
  List, 
  Info, 
  SlidersHorizontal,
  Export
} from "@phosphor-icons/react";
import { DraggableEffectItem } from "../panels/DraggableEffectItem";

const TRACK_HEADER_WIDTH = 96;

export const Workspace: React.FC = () => {
  const { project, isPlaying, setIsPlaying, setFrame, deleteTimelineElement, rippleDeleteTimelineElement, activeElementId, timelineElements, setTimelineElements, timelineZoom, trackStates } = useProjectStore();
  
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over, delta } = event;
      if (!over) return;
      
      const overIdStr = over.id.toString();
      const trackMatch = overIdStr.match(/track-(\d+)/);
      if (!trackMatch) return;
      const newTrackIndex = parseInt(trackMatch[1], 10);

      const activeData = active.data.current;

      // Handle external drops (Search results / Effects)
      if (activeData?.type === "new-location") {
        const payload = activeData.payload;
        const tContainer = document.getElementById("timeline-scroll-container");
        if (!tContainer || !project) return;
        
        const rect = tContainer.getBoundingClientRect();
        const scrollLeft = tContainer.scrollLeft;
        const activator = event.activatorEvent as MouseEvent | TouchEvent;
        const clientX = "clientX" in activator ? activator.clientX : activator.touches[0].clientX;
        
        const x = clientX - rect.left + scrollLeft - TRACK_HEADER_WIDTH;
        let startFrame = Math.floor(x / timelineZoom);
        if (startFrame < 0) startFrame = 0;

        const newEl: TimelineElement = {
          id: `clip-${Date.now()}`,
          name: payload.name || "Location",
          type: "location",
          trackIndex: newTrackIndex,
          startFrame,
          durationFrames: project.fps * 5,
          locationPayload: payload,
        };

        const isInsert = activator instanceof MouseEvent ? activator.altKey : false;
        useProjectStore.getState().addTimelineElement(newEl, isInsert);
        return;
      }

      if (activeData?.type === "new-effect") {
        const tContainer = document.getElementById("timeline-scroll-container");
        if (!tContainer || !project) return;
        const rect = tContainer.getBoundingClientRect();
        const scrollLeft = tContainer.scrollLeft;
        const activator = event.activatorEvent as MouseEvent | TouchEvent;
        const clientX = "clientX" in activator ? activator.clientX : activator.touches[0].clientX;
        const x = clientX - rect.left + scrollLeft - TRACK_HEADER_WIDTH;
        let startFrame = Math.floor(x / timelineZoom);
        if (startFrame < 0) startFrame = 0;

        const newEl: TimelineElement = {
          id: `clip-${Date.now()}`,
          name: activeData.name || "Effect",
          type: "effect_detail",
          trackIndex: newTrackIndex,
          startFrame,
          durationFrames: project.fps * 10,
          effectPayload: {
            detailLevel: 100
          }
        };

        const isInsert = activator instanceof MouseEvent ? activator.altKey : false;
        useProjectStore.getState().addTimelineElement(newEl, isInsert);
        return;
      }

      // Handle internal moves
      const el = timelineElements.find(e => e.id === active.id);
      if (el) {
        const frameDelta = Math.round(delta.x / timelineZoom);
        let newStart = el.startFrame + frameDelta;
        if (newStart < 0) newStart = 0;
        if (project && newStart + el.durationFrames > project.durationFrames) {
          newStart = project.durationFrames - el.durationFrames;
        }
        
        const activator = event.activatorEvent;
        const isInsert = activator instanceof MouseEvent ? activator.altKey : false;
        
        useProjectStore.getState().moveTimelineElement(el.id, newStart, newTrackIndex, isInsert);
      }
    },
    [timelineElements, timelineZoom, project]
  );

  useEffect(() => {
    if (!project) return;
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") {
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        setIsPlaying(!isPlaying);
      } else if (e.key === "Backspace" || e.key === "Delete") {
        if (activeElementId) {
          if (e.shiftKey) rippleDeleteTimelineElement(activeElementId);
          else deleteTimelineElement(activeElementId);
        }
      } else if (e.key === "[") {
        if (activeElementId) {
          const frame = useProjectStore.getState().currentFrame;
          useProjectStore.getState().trimTimelineElement(activeElementId, "start", frame, e.shiftKey);
        }
      } else if (e.key === "]") {
        if (activeElementId) {
          const frame = useProjectStore.getState().currentFrame;
          useProjectStore.getState().trimTimelineElement(activeElementId, "end", frame, e.shiftKey);
        }
      } else if (e.key === "ArrowLeft") {
        const currentFrame = useProjectStore.getState().currentFrame;
        setFrame(Math.max(0, currentFrame - 1));
      } else if (e.key === "ArrowRight") {
        const currentFrame = useProjectStore.getState().currentFrame;
        setFrame(Math.min(project.durationFrames - 1, currentFrame + 1));
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [isPlaying, project, activeElementId, setIsPlaying, setFrame, deleteTimelineElement, rippleDeleteTimelineElement]);

  const handleDeliver = async () => {
    if (!project) return;
    try {
      await saveRenderData({ project, timelineElements, trackStates });

      const webview = new WebviewWindow("render", {
        url: "?mode=render",
        title: "Mappa Renderer Engine",
        width: 1280,
        height: 720,
        resizable: true,
      });

      webview.once("tauri://error", (e) => {
        console.error("Failed to create render window", e);
        alert("Failed to start render engine window. Make sure you have the correct permissions.");
      });
    } catch (err) {
      console.error("Failed to start render", err);
      alert("Failed to start render. Check browser storage permissions and try again.");
    }
  };

  const handleExportJSON = () => {
    if (!project) return;
    const dataStr = JSON.stringify({ project, timelineElements }, null, 2);
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `project_${project.id}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!project) return null;

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
    <div className="flex flex-col h-screen w-screen bg-background text-foreground overflow-hidden font-sans select-none">
      {/* Header */}
      <header className="h-12 border-b bg-card flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center space-x-4">
          <span className="font-semibold tracking-wide">Mappa Resolve</span>
          <div className="h-4 w-px bg-border mx-2" />
          <span className="text-muted-foreground text-xs">
            {project.width}x{project.height} @ {project.fps}fps
          </span>
        </div>
        
        <div className="flex space-x-2">
          {/* Menu items can go here later */}
          <Button variant="outline" size="sm" onClick={handleExportJSON}>
            <Export size={14} className="mr-1" /> Export JSON
          </Button>
          <Button variant="secondary" size="sm" onClick={handleDeliver}>
            Deliver
          </Button>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-row overflow-hidden bg-[#0a0a0a]">
        {/* Left - Media Pool / Effects / Index */}
        <aside className="w-80 border-r border-[#2a2a2a] bg-[#1a1a1a] shrink-0 flex flex-col overflow-hidden">
          <Tabs defaultValue="media" className="flex-1 flex flex-col">
            <div className="px-2 pt-2 border-b border-[#2a2a2a] bg-[#1e1e1e]">
              <TabsList className="bg-transparent h-8 w-full justify-start gap-1 p-0">
                <TabsTrigger value="media" className="h-7 text-[10px] gap-1.5 data-[state=active]:bg-[#2a2a2a] data-[state=active]:text-primary rounded-none border-b-2 border-transparent data-[state=active]:border-primary px-3">
                  <Folder size={12} weight="bold" /> MEDIA POOL
                </TabsTrigger>
                <TabsTrigger value="effects" className="h-7 text-[10px] gap-1.5 data-[state=active]:bg-[#2a2a2a] data-[state=active]:text-primary rounded-none border-b-2 border-transparent data-[state=active]:border-primary px-3">
                  <MagicWand size={12} weight="bold" /> EFFECTS
                </TabsTrigger>
                <TabsTrigger value="index" className="h-7 text-[10px] gap-1.5 data-[state=active]:bg-[#2a2a2a] data-[state=active]:text-primary rounded-none border-b-2 border-transparent data-[state=active]:border-primary px-3 ml-auto">
                  <List size={12} weight="bold" /> INDEX
                </TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="media" className="flex-1 m-0 overflow-hidden flex flex-col">
              <SearchPanel />
            </TabsContent>
            <TabsContent value="effects" className="flex-1 m-0 p-3 overflow-y-auto">
              <div className="space-y-4">
                <div>
                  <h4 className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-2 px-1">Adjustments</h4>
                  <DraggableEffectItem id="detail-adjuster" name="Detail Level Adjuster" type="detail_level" />
                </div>
              </div>
            </TabsContent>
            <TabsContent value="index" className="flex-1 m-0 p-4 text-[10px] text-muted-foreground italic">
              Timeline index coming soon...
            </TabsContent>
          </Tabs>
        </aside>

        {/* Center - Viewer */}
        <main className="flex-1 bg-black overflow-hidden relative flex flex-col border-r border-[#2a2a2a]">
          <ViewerPanel />
        </main>

        {/* Right - Inspector / Metadata */}
        <aside className="w-80 bg-[#1a1a1a] shrink-0 flex flex-col overflow-hidden">
          <Tabs defaultValue="inspector" className="flex-1 flex flex-col min-h-0">
            <div className="px-2 pt-2 border-b border-[#2a2a2a] bg-[#1e1e1e]">
              <TabsList className="bg-transparent h-8 w-full justify-start gap-1 p-0">
                <TabsTrigger value="inspector" className="h-7 text-[10px] gap-1.5 data-[state=active]:bg-[#2a2a2a] data-[state=active]:text-primary rounded-none border-b-2 border-transparent data-[state=active]:border-primary px-3">
                  <SlidersHorizontal size={12} weight="bold" /> INSPECTOR
                </TabsTrigger>
                <TabsTrigger value="metadata" className="h-7 text-[10px] gap-1.5 data-[state=active]:bg-[#2a2a2a] data-[state=active]:text-primary rounded-none border-b-2 border-transparent data-[state=active]:border-primary px-3">
                  <Info size={12} weight="bold" /> METADATA
                </TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="inspector" className="flex-1 min-h-0 m-0 overflow-y-auto flex flex-col">
              <InspectorPanel />
            </TabsContent>
            <TabsContent value="metadata" className="flex-1 m-0 p-4 text-[10px] text-muted-foreground italic overflow-y-auto">
              {activeElementId ? (
                <div className="space-y-4">
                  <div>
                    <div className="text-zinc-500 uppercase tracking-tighter mb-1 font-bold">Clip ID</div>
                    <div className="text-zinc-300 font-mono select-text">{activeElementId}</div>
                  </div>
                  {/* Additional metadata could go here */}
                </div>
              ) : (
                "Select a clip for metadata."
              )}
            </TabsContent>
          </Tabs>
        </aside>
      </div>

      {/* Bottom - Timeline */}
      <section className="h-80 border-t border-[#2a2a2a] bg-[#141414] shrink-0 flex flex-col overflow-hidden">
        <Timeline />
      </section>
    </div>
    </DndContext>
  );
};
