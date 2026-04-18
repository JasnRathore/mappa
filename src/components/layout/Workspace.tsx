import React, { useEffect, useCallback, useState } from "react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
} from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent, DragOverEvent, DragMoveEvent, Active } from "@dnd-kit/core";
import type { TimelineElement, TimelineElementType } from "../../types";
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
  const { 
    project, 
    projectName,
    filePath,
    saveProject,
    loadProject,
    isPlaying, 
    setIsPlaying, 
    setFrame, 
    deleteTimelineElement, 
    rippleDeleteTimelineElement, 
    activeElementId, 
    timelineElements, 
    setTimelineElements, 
    timelineZoom, 
    trackStates,
    setProject
  } = useProjectStore();
  
  const [activeDragItem, setActiveDragItem] = useState<Active | null>(null);
  const [initialDragX, setInitialDragX] = useState(0);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragItem(event.active);
    const activator = event.activatorEvent as MouseEvent | TouchEvent;
    const clientX = "clientX" in activator ? activator.clientX : activator.touches[0].clientX;
    setInitialDragX(clientX);
  }, []);

  const updateDragPreview = useCallback((event: DragOverEvent | DragMoveEvent) => {
    const { active, over, delta } = event;
    if (!over || !project) {
      useProjectStore.getState().setDragPreview(null);
      return;
    }

    const overIdStr = over.id.toString();
    const trackMatch = overIdStr.match(/track-(\d+)/);
    if (!trackMatch) {
      useProjectStore.getState().setDragPreview(null);
      return;
    }
    const trackIndex = parseInt(trackMatch[1], 10);

    const activeData = active.data.current;
    if (!activeData) return;

    let startFrame = 0;
    let durationFrames = 0;
    let name = "";
    let type: TimelineElementType = "location";

    const tContainer = document.getElementById("timeline-scroll-container");
    if (!tContainer) return;
    const rect = tContainer.getBoundingClientRect();
    const scrollLeft = tContainer.scrollLeft;

    if (activeData.type === "new-location" || activeData.type === "new-effect") {
      const currentX = initialDragX + delta.x;
      const relativeX = currentX - rect.left + scrollLeft - TRACK_HEADER_WIDTH;
      let projectedFrame = Math.floor(relativeX / timelineZoom);
      if (projectedFrame < 0) projectedFrame = 0;
      startFrame = useProjectStore.getState().snapFrame(projectedFrame);

      if (activeData.type === "new-location") {
        durationFrames = project.fps * 5;
        name = activeData.payload.name || "Location";
        type = "location";
      } else {
        durationFrames = project.fps * 10;
        name = activeData.name || "Effect";
        type = "effect_detail";
      }
    } else if (activeData.id && (activeData.type === "location" || activeData.type === "effect_detail")) {
      durationFrames = activeData.durationFrames;
      name = activeData.name;
      type = activeData.type;
      
      const frameDelta = Math.round(delta.x / timelineZoom);
      let newStart = activeData.startFrame + frameDelta;
      if (newStart < 0) newStart = 0;
      startFrame = useProjectStore.getState().snapFrame(newStart);
    } else {
      useProjectStore.getState().setDragPreview(null);
      return;
    }

    useProjectStore.getState().setDragPreview({
      startFrame,
      trackIndex,
      durationFrames,
      name,
      type
    });
  }, [project, timelineZoom, initialDragX]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    updateDragPreview(event);
  }, [updateDragPreview]);

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    updateDragPreview(event);
  }, [updateDragPreview]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragItem(null);
      useProjectStore.getState().setDragPreview(null);
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
        
        const currentX = initialDragX + delta.x;
        const x = currentX - rect.left + scrollLeft - TRACK_HEADER_WIDTH;
        let startFrame = Math.floor(x / timelineZoom);
        if (startFrame < 0) startFrame = 0;
        startFrame = useProjectStore.getState().snapFrame(startFrame);

        const newEl: TimelineElement = {
          id: `clip-${Date.now()}`,
          name: payload.name || "Location",
          type: "location",
          trackIndex: newTrackIndex,
          startFrame,
          durationFrames: project.fps * 5,
          locationPayload: payload,
        };

        const activator = event.activatorEvent;
        const isInsert = activator instanceof MouseEvent ? activator.altKey : false;
        useProjectStore.getState().addTimelineElement(newEl, isInsert);
        return;
      }

      if (activeData?.type === "new-effect") {
        const tContainer = document.getElementById("timeline-scroll-container");
        if (!tContainer || !project) return;
        const rect = tContainer.getBoundingClientRect();
        const scrollLeft = tContainer.scrollLeft;
        
        const currentX = initialDragX + delta.x;
        const x = currentX - rect.left + scrollLeft - TRACK_HEADER_WIDTH;
        let startFrame = Math.floor(x / timelineZoom);
        if (startFrame < 0) startFrame = 0;
        startFrame = useProjectStore.getState().snapFrame(startFrame);

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

        const activator = event.activatorEvent;
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
        newStart = useProjectStore.getState().snapFrame(newStart);

        if (project && newStart + el.durationFrames > project.durationFrames) {
          newStart = project.durationFrames - el.durationFrames;
        }
        
        const activator = event.activatorEvent;
        const isInsert = activator instanceof MouseEvent ? activator.altKey : false;
        
        useProjectStore.getState().moveTimelineElement(el.id, newStart, newTrackIndex, isInsert);
      }
    },
    [timelineElements, timelineZoom, project, initialDragX]
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
      } else if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveProject();
      } else if (e.key === "o" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        loadProject();
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

  const handleSave = async () => {
    const success = await saveProject();
    if (success) {
      // Maybe show a toast later
    }
  };

  const handleOpen = async () => {
    await loadProject();
  };

  const handleNewProject = () => {
    setProject(null);
  };

  if (!project) return null;

  return (
    <DndContext 
      sensors={sensors} 
      onDragStart={handleDragStart} 
      onDragOver={handleDragOver}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd} 
      onDragCancel={() => {
        setActiveDragItem(null);
        useProjectStore.getState().setDragPreview(null);
      }}
    >
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
          <Button variant="ghost" size="sm" onClick={handleNewProject} className="text-xs h-7 px-2">
            Project Manager
          </Button>
          <div className="h-4 w-px bg-border my-1.5" />
          <Button variant="ghost" size="sm" onClick={handleOpen} className="text-xs h-7 px-2">
            Open
          </Button>
          <Button variant="outline" size="sm" onClick={handleSave} className="text-xs h-7 px-2 border-orange-500/30 text-orange-400 hover:bg-orange-500/10">
            <Export size={12} className="mr-1.5" /> Save
          </Button>
          <div className="h-4 w-px bg-border my-1.5" />
          <Button variant="secondary" size="sm" onClick={handleDeliver} className="h-7 px-4">
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
    
    <DragOverlay dropAnimation={null}>
      {activeDragItem ? (
        <div className="opacity-80 scale-105 transition-transform">
          {(() => {
            const data = activeDragItem.data.current;
            if (data?.type === "new-location") {
              return (
                <div className="p-2 border rounded bg-[#1a1a1a] border-primary shadow-xl w-64">
                  <div className="font-medium text-xs truncate text-primary">{data.payload.name}</div>
                  <div className="text-[10px] text-zinc-500 truncate">{data.payload.display_name}</div>
                </div>
              );
            }
            if (data?.type === "new-effect") {
              return (
                <div className="p-2 border rounded bg-[#1a1a1a] border-primary shadow-xl flex items-center gap-2 w-48">
                  <div className="w-6 h-6 rounded bg-primary/20 flex items-center justify-center text-primary">
                    <MagicWand size={14} weight="bold" />
                  </div>
                  <div className="font-medium text-[11px] text-zinc-200">{data.name}</div>
                </div>
              );
            }
            // For existing timeline clips
            if (data?.id && (data.type === "location" || data.type === "effect_detail")) {
               return (
                <div 
                  className={`h-8 px-2 border border-white rounded-sm flex items-center text-[10px] font-medium shadow-2xl ${
                    data.type === 'location' ? 'bg-orange-800/90 text-orange-100' : 'bg-purple-800/90 text-purple-100'
                  }`} 
                  style={{ width: activeDragItem.rect.current.initial?.width ?? 100 }}
                >
                  {data.name}
                </div>
               );
            }
            return null;
          })()}
        </div>
      ) : null}
    </DragOverlay>
    </DndContext>
  );
};
