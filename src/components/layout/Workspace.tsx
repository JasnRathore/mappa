import React, { useEffect, useCallback, useState } from "react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  type Modifier,
  pointerWithin,
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
import { TitleBar } from "./TitleBar";

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
    setProject,
    dragPreview,
  } = useProjectStore();
  
  const [activeDragItem, setActiveDragItem] = useState<Active | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragItem(event.active);
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

    const currentRect = active.rect.current.translated;
    if (!currentRect) return;

    if (activeData.type === "new-location" || activeData.type === "new-effect") {
      const relativeX = currentRect.left - rect.left + scrollLeft - TRACK_HEADER_WIDTH;
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
      
      const frameDelta = Math.round((delta?.x || 0) / timelineZoom);
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
  }, [project, timelineZoom]);

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
        
        const currentRect = active.rect.current.translated;
        if (!currentRect) return;

        const x = currentRect.left - rect.left + scrollLeft - TRACK_HEADER_WIDTH;
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
        
        const currentRect = active.rect.current.translated;
        if (!currentRect) return;

        const x = currentRect.left - rect.left + scrollLeft - TRACK_HEADER_WIDTH;
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

  const snapToTimelineModifier: Modifier = useCallback(({ transform, over, active }) => {
    if (!over || !project || !active) return transform;
    
    const overIdStr = over.id.toString();
    const trackMatch = overIdStr.match(/track-(\d+)/);
    if (!trackMatch) return transform;
    const trackIndex = parseInt(trackMatch[1], 10);

    const tContainer = document.getElementById("timeline-scroll-container");
    if (!tContainer) return transform;
    const rect = tContainer.getBoundingClientRect();
    const scrollLeft = tContainer.scrollLeft;

    const data = active.data.current;
    if (!data) return transform;

    const initialRect = active.rect.current.initial;
    if (!initialRect) return transform;

    let startFrame = 0;
    // CRITICAL: Use transform directly to avoid feedback loops with the translated rect
    const currentX = initialRect.left + transform.x;

    if (data.type === "new-location" || data.type === "new-effect") {
      const relativeX = currentX - rect.left + scrollLeft - TRACK_HEADER_WIDTH;
      startFrame = useProjectStore.getState().snapFrame(Math.floor(relativeX / timelineZoom));
    } else if (data.id && (data.type === "location" || data.type === "effect_detail")) {
      const frameDelta = Math.round(transform.x / timelineZoom);
      startFrame = useProjectStore.getState().snapFrame(data.startFrame + frameDelta);
    } else {
      return transform;
    }

    const snappedScreenX = (startFrame * timelineZoom) - scrollLeft + rect.left + TRACK_HEADER_WIDTH;
    const snappedScreenY = rect.top + 24 + trackIndex * 48 + 4 - tContainer.scrollTop;

    // Transform logic: the transform returned is what's added to the INITIAL position of the node.
    // However, since we are using DragOverlay, dnd-kit handles the initial vs current.
    // The most reliable way is to return the x/y that results in the snapped screen position.
    
    // Actually, for DragOverlay, the transform is from the original node's position to the mouse.
    // If we want it at snappedScreenX, and its initial screen position was initialRect.left...
    if (!initialRect) return transform;

    return {
      ...transform,
      x: snappedScreenX - initialRect.left,
      y: snappedScreenY - initialRect.top
    };
  }, [project, timelineZoom]);

  if (!project) return null;

  return (
    <DndContext 
      sensors={sensors} 
      modifiers={[snapToTimelineModifier]}
      collisionDetection={pointerWithin}
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
      <TitleBar onDeliver={handleDeliver} />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-row overflow-hidden bg-background">
        {/* Left - Media Pool / Effects / Index */}
        <aside className="w-80 border-r border-border bg-card shrink-0 flex flex-col overflow-hidden">
          <Tabs defaultValue="media" className="flex-1 flex flex-col">
            <div className="px-2 pt-2 border-b border-border bg-card/50">
              <TabsList className="bg-transparent h-8 w-full justify-start gap-1 p-0">
                <TabsTrigger value="media" className="h-7 text-[10px] gap-1.5 data-[state=active]:bg-accent data-[state=active]:text-primary rounded-none border-b-2 border-transparent data-[state=active]:border-primary px-3">
                  <Folder size={12} weight="bold" /> MEDIA POOL
                </TabsTrigger>
                <TabsTrigger value="effects" className="h-7 text-[10px] gap-1.5 data-[state=active]:bg-accent data-[state=active]:text-primary rounded-none border-b-2 border-transparent data-[state=active]:border-primary px-3">
                  <MagicWand size={12} weight="bold" /> EFFECTS
                </TabsTrigger>
                <TabsTrigger value="index" className="h-7 text-[10px] gap-1.5 data-[state=active]:bg-accent data-[state=active]:text-primary rounded-none border-b-2 border-transparent data-[state=active]:border-primary px-3 ml-auto">
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
        <main className="flex-1 bg-black overflow-hidden relative flex flex-col border-r border-border">
          <ViewerPanel />
        </main>

        {/* Right - Inspector / Metadata */}
        <aside className="w-80 bg-card shrink-0 flex flex-col overflow-hidden">
          <Tabs defaultValue="inspector" className="flex-1 flex flex-col min-h-0">
            <div className="px-2 pt-2 border-b border-border bg-card/50">
              <TabsList className="bg-transparent h-8 w-full justify-start gap-1 p-0">
                <TabsTrigger value="inspector" className="h-7 text-[10px] gap-1.5 data-[state=active]:bg-accent data-[state=active]:text-primary rounded-none border-b-2 border-transparent data-[state=active]:border-primary px-3">
                  <SlidersHorizontal size={12} weight="bold" /> INSPECTOR
                </TabsTrigger>
                <TabsTrigger value="metadata" className="h-7 text-[10px] gap-1.5 data-[state=active]:bg-accent data-[state=active]:text-primary rounded-none border-b-2 border-transparent data-[state=active]:border-primary px-3">
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
      <section className="h-80 border-t border-border bg-background shrink-0 flex flex-col overflow-hidden">
        <Timeline />
      </section>
    </div>
    
    <DragOverlay dropAnimation={null}>
      {activeDragItem ? (
        <div className="opacity-90 scale-100 pointer-events-none">
          {(() => {
            const data = activeDragItem.data.current;
            const isSnapped = !!dragPreview;
            
            if (data?.type === "new-location") {
              return (
                <div 
                  className={`border rounded flex items-center shadow-2xl ${
                    isSnapped 
                      ? "bg-orange-800 border-orange-400 h-10 px-3 ring-2 ring-white/20" 
                      : "bg-card border-primary p-2 w-64"
                  }`}
                  style={{
                    width: isSnapped && dragPreview ? dragPreview.durationFrames * timelineZoom : undefined
                  }}
                >
                  <div className={`truncate ${isSnapped ? "text-[10px] font-bold text-orange-100 uppercase tracking-tight" : "text-xs font-medium text-primary"}`}>
                    {data.payload.name}
                  </div>
                  {!isSnapped && <div className="text-[10px] text-muted-foreground truncate ml-2">{data.payload.display_name}</div>}
                </div>
              );
            }
            
            if (data?.type === "new-effect") {
              return (
                <div 
                  className={`border rounded flex items-center shadow-2xl ${
                    isSnapped 
                      ? "bg-purple-800 border-purple-400 h-10 px-3 ring-2 ring-white/20" 
                      : "bg-card border-primary p-2 w-48"
                  }`}
                  style={{
                    width: isSnapped && dragPreview ? dragPreview.durationFrames * timelineZoom : undefined
                  }}
                >
                  <div className={`flex items-center gap-2 ${isSnapped ? "text-[10px] font-bold text-purple-100 uppercase tracking-tight" : "text-[11px] text-zinc-200"}`}>
                    <MagicWand size={isSnapped ? 12 : 14} weight="bold" className={isSnapped ? "" : "text-primary"} />
                    {data.name}
                  </div>
                </div>
              );
            }
            
            // For existing timeline clips
            if (data?.id && (data.type === "location" || data.type === "effect_detail")) {
               const width = isSnapped && dragPreview ? dragPreview.durationFrames * timelineZoom : (activeDragItem.rect.current.initial?.width ?? 100);
               return (
                <div 
                  className={`h-10 px-3 border border-white rounded-sm flex items-center text-[10px] font-bold uppercase tracking-tight shadow-2xl ring-2 ring-white/20 ${
                    data.type === 'location' ? 'bg-orange-800 border-orange-400 text-orange-100' : 'bg-purple-800 border-purple-400 text-purple-100'
                  }`} 
                  style={{ width }}
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
