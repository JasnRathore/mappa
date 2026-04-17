import React, { useEffect, useRef, useState, useCallback } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Geometry } from "geojson";
import type { ProjectSettings, TimelineElement, LocationPayload, Marker } from "../types";
import { saveRenderData } from "../db";
import { applyDeterministicTimelineFrameToMap, createMapPlaybackCache } from "../lib/mapPlayback";
import { createTimelinePreloadKey, preloadTimelineMapResources } from "../lib/mapPreload";
import {
  OPEN_FREEMAP_STYLE_URL,
  createCachedMapTransformRequest,
  installMapResourceCacheProtocol,
} from "../lib/mapResourceCache";

interface Props {
  project: ProjectSettings;
  setProject: React.Dispatch<React.SetStateAction<ProjectSettings | null>>;
  timelineElements: TimelineElement[];
  setTimelineElements: React.Dispatch<React.SetStateAction<TimelineElement[]>>;
  onImport: (file: File) => void;
}

const TRACK_HEIGHT = 60;
const TRACK_COUNT = 4;
const PREVIEW_MAP_OPTIONS: Partial<maplibregl.MapOptions> = {
  fadeDuration: 0,
  refreshExpiredTiles: false,
  cancelPendingTileRequestsWhileZooming: false,
  maxTileCacheZoomLevels: 12,
  maxTileCacheSize: 1024,
  canvasContextAttributes: {
    antialias: false,
    preserveDrawingBuffer: true,
    powerPreference: "high-performance",
    desynchronized: true,
  },
};
const MAP_TRANSFORM_REQUEST = createCachedMapTransformRequest();

installMapResourceCacheProtocol();

const MapEditor: React.FC<Props> = ({ project, setProject, timelineElements, setTimelineElements, onImport }) => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapCenterWrapper = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<LocationPayload[]>([]);
  const [isSearching, setIsSearching] = useState(false);

    const [activeElementId, setActiveElementId] = useState<string | null>(null);

  const currentFrameRef = useRef(project.startFrame);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPreloadingPlayback, setIsPreloadingPlayback] = useState(false);

  const [timelineZoom, setTimelineZoom] = useState(2);
  const timelineRef = useRef<HTMLDivElement>(null);

  const [markers, setMarkers] = useState<Marker[]>(project.markers || []);
  const [draggingElementId, setDraggingElementId] = useState<string | null>(null);
  
  const [activeTool, setActiveTool] = useState<"pointer" | "blade">("pointer");
  const [snappingEnabled, setSnappingEnabled] = useState(true);

  const [trimmingElementId, setTrimmingElementId] = useState<string | null>(null);
  const trimState = useRef<{ startX: number; origStart: number; origDuration: number; edge: "left" | "right" } | null>(null);

  const viewAreaRef = useRef<HTMLDivElement>(null);
  const [viewScale, setViewScale] = useState(1);
  const [canvasZoom, setCanvasZoom] = useState(1);

  const timecodeLabelRef = useRef<HTMLDivElement>(null);
  const playheadLineRef = useRef<HTMLDivElement>(null);
  const playheadLabelRef = useRef<HTMLDivElement>(null);
  const playbackCacheRef = useRef(createMapPlaybackCache());
  const previewPreloadKeyRef = useRef<string | null>(null);

  useEffect(() => {
    setProject(prev => prev ? { ...prev, markers } : null);
  }, [markers]);

  const getSnapTargets = useCallback(() => {
    const targets = new Set<number>();
    targets.add(currentFrameRef.current);
    markers.forEach(m => targets.add(m.frame));
    timelineElements.forEach(el => {
      targets.add(el.startFrame);
      targets.add(el.startFrame + el.durationFrames);
    });
    return Array.from(targets).sort((a,b)=>a-b);
  }, [markers, timelineElements]);

  const snapFrame = useCallback((frame: number) => {
    if (!snappingEnabled) return frame;
    const targets = getSnapTargets();
    const threshold = Math.max(1, Math.round(10 / timelineZoom));
    let closest = frame;
    let minDiff = threshold + 1;
    for (const t of targets) {
      if (Math.abs(t - frame) < minDiff) {
        minDiff = Math.abs(t - frame);
        closest = t;
      }
    }
    return closest;
  }, [snappingEnabled, getSnapTargets, timelineZoom]);

  // store initial drag context
  const dragState = useRef<{ startX: number; startY: number; origStart: number; origTrack: number } | null>(null);

  // 1. INITIALIZE VECTOR MAP
  useEffect(() => {
    if (map.current || !mapContainer.current) return;

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: OPEN_FREEMAP_STYLE_URL,
      center: [0, 20],
      zoom: 1.5,
      transformRequest: MAP_TRANSFORM_REQUEST,
      ...PREVIEW_MAP_OPTIONS,
      pixelRatio: 1, // FORCE 1:1 CSS pixels to internal canvas pixels!
    } as maplibregl.MapOptions);

    map.current.on("load", () => {
      if (!map.current) return;
      map.current.addSource("city-area", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      map.current.addLayer({
        id: "city-area-fill",
        type: "fill",
        source: "city-area",
        paint: {
          "fill-color": ["get", "color"],
          "fill-opacity": ["coalesce", ["get", "opacity"], 0.4],
        },
      });

      map.current.resize();
    });

    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  // Update map container on resize
  useEffect(() => {
    const handleResize = () => map.current?.resize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Aspect Ratio & Scale Observer
  useEffect(() => {
    if (!viewAreaRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // Subtract padding (e.g. 48px to account for p-6 which is 24px padding on each side)
        const availW = entry.contentRect.width - 48;
        // Subtract extra vertical space for the top absolute bar
        const availH = entry.contentRect.height - 48 - 60; 
        const scaleX = availW / project.width;
        const scaleY = availH / project.height;
        setViewScale(Math.min(scaleX, scaleY));
      }
    });
    observer.observe(viewAreaRef.current);
    return () => observer.disconnect();
  }, [project.width, project.height]);

  // 2. PLAYBACK LOOP
  useEffect(() => {
    if (!isPlaying) return;

    let lastTime = performance.now();
    let frameId: number;
    const msPerFrame = 1000 / project.fps;

    const loop = (time: number) => {
      const delta = time - lastTime;
      if (delta >= msPerFrame) {
        let nextFrame = currentFrameRef.current + 1;
        if (nextFrame > project.endFrame) nextFrame = project.startFrame;
        setFrameUI(nextFrame);
        lastTime = time - (delta % msPerFrame);
      }
      frameId = requestAnimationFrame(loop);
    };
    frameId = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(frameId);
  }, [isPlaying, project.fps, project.durationFrames]);

  // 3. MAP STATE UPDATE
  const updateMapState = useCallback((frameIndex: number) => {
    if (!map.current) return;
    applyDeterministicTimelineFrameToMap({
      map: map.current,
      frameIndex,
      timelineElements,
      fps: project.fps,
      cache: playbackCacheRef.current,
    });
  }, [timelineElements, project.fps]);

  useEffect(() => {
    updateMapState(currentFrameRef.current);
  }, [updateMapState]);


  // 3b. AUTO-CAPTURE FROM MAP INTERACTION
  const editorStateRef = useRef({ activeElementId, timelineElements });
  useEffect(() => {
    editorStateRef.current = { activeElementId, timelineElements };
  }, [activeElementId, timelineElements]);

  useEffect(() => {
    if (!map.current) return;
    
    const handleMapUserInteraction = (e: { originalEvent?: Event }) => {
      // originalEvent only exists if the interaction was caused by a user (drag, scroll), not code (flyTo)
      if (!e.originalEvent) return;
      
      const state = editorStateRef.current;
      if (!state.activeElementId) return;
      
      const el = state.timelineElements.find(x => x.id === state.activeElementId);
      if (!el || el.type !== "location") return;
      
      // Auto-capture ONLY if playhead is strictly inside this clip boundaries
      if (currentFrameRef.current >= el.startFrame && currentFrameRef.current < el.startFrame + el.durationFrames) {
        if (!map.current) return;
        const center = map.current.getCenter();
        
        setTimelineElements(prev => prev.map(p => {
          if (p.id !== el.id || p.type !== "location" || !p.locationPayload) return p;
          return {
            ...p,
            locationPayload: {
              ...p.locationPayload,
              center: [center.lng, center.lat],
              zoom: map.current!.getZoom(),
              bearing: map.current!.getBearing(),
              pitch: map.current!.getPitch(),
            }
          };
        }));
      }
    };

    const mapInstance = map.current;
    mapInstance.on("dragend", handleMapUserInteraction);
    mapInstance.on("zoomend", handleMapUserInteraction);
    mapInstance.on("pitchend", handleMapUserInteraction);
    mapInstance.on("rotateend", handleMapUserInteraction);

    return () => {
      mapInstance.off("dragend", handleMapUserInteraction);
      mapInstance.off("zoomend", handleMapUserInteraction);
      mapInstance.off("pitchend", handleMapUserInteraction);
      mapInstance.off("rotateend", handleMapUserInteraction);
    };
  }, []);

  // 4. TIMELINE INTERACTIONS

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&limit=5&polygon_geojson=1`
      );
      const data = await response.json();
      const formatted: LocationPayload[] = data.map((item: Record<string, unknown>) => ({
        id: (item.place_id as number).toString() + Math.random(),
        name: (item.display_name as string).split(",")[0],
        display_name: item.display_name as string,
        center: [parseFloat(item.lon as string), parseFloat(item.lat as string)],
        zoom: ["city", "town", "village", "suburb"].includes(item.type as string) ? 12 : 5,
        bearing: 0,
        pitch: 0,
        transition: "fly",
        transitionMS: 2000,
        type: item.type as string,
        color: "#f97316",
        geojson: item.geojson as Geometry | undefined,
      }));
      setSearchResults(formatted);
    } catch (err) {
      console.error(err);
    } finally {
      setIsSearching(false);
    }
  };

  const handleTimelineDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (!timelineRef.current) return;

    const rect = timelineRef.current.getBoundingClientRect();
    const scrollLeft = timelineRef.current.scrollLeft;
    // Account for playhead area + tracks container padding if any.
    // Assuming tracks are simple absolute positioned elements.
    const dropX = e.clientX - rect.left + scrollLeft;
    const dropY = e.clientY - rect.top; // Relative to timelineRef

    let targetTrack = Math.floor((dropY - 30) / TRACK_HEIGHT); // subtract header space if needed
    if (targetTrack < 0) targetTrack = 0;
    if (targetTrack >= TRACK_COUNT) targetTrack = TRACK_COUNT - 1;

    let startFrame = Math.floor(dropX / timelineZoom);
    if (startFrame < 0) startFrame = 0;

    const data = e.dataTransfer.getData("application/json");
    if (data) {
      try {
        const payload = JSON.parse(data);
        // It could be from search pool
        if (payload && payload.type) {
          const newEl: TimelineElement = {
            id: `clip-${Date.now()}`,
            name: payload.display_name || "Location",
            type: "location",
            trackIndex: targetTrack,
            startFrame,
            durationFrames: project.fps * 5,
            locationPayload: payload,
          };
          setTimelineElements(prev => [...prev, newEl]);
        }
      } catch (err) {
        console.warn("Dropped payload not a location", err);
      }
    }
  };

  const addDetailEffect = () => {
    const newEl: TimelineElement = {
      id: `effect-${Date.now()}`,
      name: "Detail Overlay",
      type: "effect_detail",
      trackIndex: 0,
      startFrame: currentFrameRef.current,
      durationFrames: project.fps * 5,
      effectPayload: { detailLevel: 50 },
    };
    setTimelineElements(prev => [...prev, newEl]);
  };

  // Block dragging logic
  const handleBlockMouseDown = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setActiveElementId(id);
    const el = timelineElements.find(t => t.id === id);
    if (!el) return;

    setDraggingElementId(id);
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      origStart: el.startFrame,
      origTrack: el.trackIndex
    };
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!draggingElementId || !dragState.current) return;
      const { startX, startY, origStart, origTrack } = dragState.current;

      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;

      let newTrack = origTrack + Math.round(deltaY / TRACK_HEIGHT);
      if (newTrack < 0) newTrack = 0;
      if (newTrack >= TRACK_COUNT) newTrack = TRACK_COUNT - 1;

      let newStart = origStart + Math.round(deltaX / timelineZoom);
      newStart = snapFrame(newStart);
      if (newStart < 0) newStart = 0;

      setTimelineElements(prev => prev.map(el =>
        el.id === draggingElementId
          ? { ...el, startFrame: newStart, trackIndex: newTrack }
          : el
      ));
    };

    const handleMouseUp = () => {
      setDraggingElementId(null);
      dragState.current = null;
    };

    if (draggingElementId) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingElementId, snapFrame, timelineZoom]);

  // Trim dragging logic
  const handleTrimMouseDown = (e: React.MouseEvent, id: string, edge: "left" | "right") => {
    e.stopPropagation();
    setActiveElementId(id);
    const el = timelineElements.find(t => t.id === id);
    if (!el) return;

    setTrimmingElementId(id);
    trimState.current = {
      startX: e.clientX,
      origStart: el.startFrame,
      origDuration: el.durationFrames,
      edge
    };
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!trimmingElementId || !trimState.current) return;
      const { startX, origStart, origDuration, edge } = trimState.current;

      const deltaX = e.clientX - startX;
      const frameDelta = Math.round(deltaX / timelineZoom);

      setTimelineElements(prev => prev.map(el => {
        if (el.id !== trimmingElementId) return el;
        
        let newStart = origStart;
        let newDuration = origDuration;

        if (edge === "left") {
          let potentialStart = origStart + frameDelta;
          potentialStart = snapFrame(potentialStart);
          const maxStart = origStart + origDuration - 1; // Need at least 1 frame duration
          if (potentialStart > maxStart) potentialStart = maxStart;
          if (potentialStart < 0) potentialStart = 0;
          
          newStart = potentialStart;
          newDuration = origDuration - (newStart - origStart);
        } else if (edge === "right") {
          let potentialEnd = origStart + origDuration + frameDelta;
          potentialEnd = snapFrame(potentialEnd);
          if (potentialEnd <= origStart) potentialEnd = origStart + 1;
          newDuration = potentialEnd - origStart;
        }

        return { ...el, startFrame: newStart, durationFrames: newDuration };
      }));
    };

    const handleMouseUp = () => {
      setTrimmingElementId(null);
      trimState.current = null;
    };

    if (trimmingElementId) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [trimmingElementId, snapFrame, timelineZoom]);

  const handleClipClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (activeTool === "blade") {
      // Perform cut
      const el = timelineElements.find(x => x.id === id);
      if (!el || !timelineRef.current) return;
      const rect = timelineRef.current.getBoundingClientRect();
      const scrollLeft = timelineRef.current.scrollLeft;
      const x = e.clientX - rect.left + scrollLeft;
      const frameX = Math.floor(x / timelineZoom);
      
      const cutFrame = snapFrame(frameX);

      if (cutFrame > el.startFrame && cutFrame < el.startFrame + el.durationFrames) {
        const dur1 = cutFrame - el.startFrame;
        const dur2 = el.durationFrames - dur1;
        
        const newEl: TimelineElement = {
          ...el,
          id: `clip-${Date.now()}`,
          startFrame: cutFrame,
          durationFrames: dur2
        };
        
        setTimelineElements(prev => {
          const mod = prev.map(p => p.id === id ? { ...p, durationFrames: dur1 } : p);
          return [...mod, newEl];
        });
      }
      setActiveTool("pointer");
    } else {
      setActiveElementId(id);
    }
  };


  const handleZoomChange = (newZoom: number) => {
    if (!timelineRef.current) return;
    const oldZoom = timelineZoom;
    const scrollLeft = timelineRef.current.scrollLeft;
    
    // Calculate where the playhead is relative to the viewport
    const playheadX = currentFrameRef.current * oldZoom;
    const relativeX = playheadX - scrollLeft;

    setTimelineZoom(newZoom);

    // Maintain the playhead's relative position in the viewport
    requestAnimationFrame(() => {
      if (timelineRef.current) {
        const newPlayheadX = currentFrameRef.current * newZoom;
        timelineRef.current.scrollLeft = newPlayheadX - relativeX;
      }
    });
  };

  const handleCanvasZoomChange = useCallback((newZoom: number) => {
    const clamped = Math.max(0.5, Math.min(4, Number(newZoom.toFixed(2))));
    setCanvasZoom(clamped);
  }, []);

  const handleCanvasWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (!e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    handleCanvasZoomChange(canvasZoom + (e.deltaY < 0 ? 0.1 : -0.1));
  }, [canvasZoom, handleCanvasZoomChange]);

  const updateActiveElement = (updates: Partial<TimelineElement>) => {
    setTimelineElements(prev => prev.map(el =>
      el.id === activeElementId ? { ...el, ...updates } : el
    ));
  };

  const updateActivePayload = (payloadUpdates: Record<string, unknown>) => {
    setTimelineElements(prev => prev.map(el => {
      if (el.id !== activeElementId) return el;
      if (el.type === "location" && el.locationPayload) {
        return { ...el, locationPayload: { ...el.locationPayload, ...payloadUpdates } };
      }
      if (el.type === "effect_detail" && el.effectPayload) {
        return { ...el, effectPayload: { ...el.effectPayload, ...payloadUpdates } };
      }
      return el;
    }));
  };

  const captureMapState = () => {
    if (!map.current || !activeElementId || activeElement?.type !== "location") return;
    const center = map.current.getCenter();
    updateActivePayload({
      center: [center.lng, center.lat],
      zoom: map.current.getZoom(),
      bearing: map.current.getBearing(),
      pitch: map.current.getPitch(),
    });
  };

  const deleteActiveElement = useCallback(() => {
    if (!activeElementId) return;
    setTimelineElements((prev) => prev.filter((el) => el.id !== activeElementId));
    setActiveElementId(null);
  }, [activeElementId]);

  const rippleDeleteActiveElement = useCallback(() => {
    if (!activeElementId) return;
    const elToDelete = timelineElements.find(e => e.id === activeElementId);
    if (!elToDelete) return;
    
    setTimelineElements(prev => {
      const remaining = prev.filter(e => e.id !== activeElementId);
      return remaining.map(e => {
        if (e.trackIndex === elToDelete.trackIndex && e.startFrame >= elToDelete.startFrame) {
          return { ...e, startFrame: Math.max(0, e.startFrame - elToDelete.durationFrames) };
        }
        return e;
      });
    });
    setActiveElementId(null);
  }, [activeElementId, timelineElements]);

  const formatTimecode = (frames: number) => {
    const totalSecs = frames / project.fps;
    const mins = Math.floor(totalSecs / 60).toString().padStart(2, '0');
    const secs = Math.floor(totalSecs % 60).toString().padStart(2, '0');
    const ff = Math.floor(frames % project.fps).toString().padStart(2, '0');
    return `${mins}:${secs}:${ff}`;
  };

  const setFrameUI = useCallback((frame: number) => {
    currentFrameRef.current = frame;
    if (playheadLineRef.current) {
      playheadLineRef.current.style.left = `${frame * timelineZoom}px`;
    }
    if (playheadLabelRef.current) {
      playheadLabelRef.current.style.left = `${frame * timelineZoom}px`;
      playheadLabelRef.current.children[0].textContent = String(frame);
    }
    if (timecodeLabelRef.current) {
      timecodeLabelRef.current.textContent = formatTimecode(frame);
    }
    updateMapState(frame);
  }, [timelineZoom, updateMapState, project.fps]);

  const handlePreviewPlaybackToggle = useCallback(async () => {
    if (isPlaying) {
      setIsPlaying(false);
      return;
    }

    if (!map.current) {
      return;
    }

    const preloadKey = createTimelinePreloadKey({
      timelineElements,
      fps: project.fps,
      startFrame: project.startFrame,
      endFrame: project.endFrame,
    });

    if (previewPreloadKeyRef.current !== preloadKey) {
      const playbackStartFrame = currentFrameRef.current;
      setIsPreloadingPlayback(true);
      try {
        await preloadTimelineMapResources({
          map: map.current,
          timelineElements,
          fps: project.fps,
          startFrame: project.startFrame,
          endFrame: project.endFrame,
          onProgress: (completed, total, frame) => {
            if (timecodeLabelRef.current) {
              timecodeLabelRef.current.textContent = `CACHE ${completed}/${total}`;
            }
            currentFrameRef.current = frame;
          },
        });
        previewPreloadKeyRef.current = preloadKey;
        setFrameUI(playbackStartFrame);
      } finally {
        setIsPreloadingPlayback(false);
      }
    }

    setIsPlaying(true);
  }, [isPlaying, project.endFrame, project.fps, project.startFrame, setFrameUI, timelineElements]);

  useEffect(() => {
    previewPreloadKeyRef.current = null;
  }, [timelineElements, project.startFrame, project.endFrame, project.fps]);

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") {
        return;
      }

      if (e.key === "Backspace" || e.key === "Delete") {
        if (e.shiftKey) rippleDeleteActiveElement();
        else deleteActiveElement();
      } else if (e.key.toLowerCase() === "m") {
        const newMarker: Marker = {
          id: `marker-${Date.now()}`,
          frame: currentFrameRef.current,
          label: "Marker",
          color: "#ef4444",
        };
        setMarkers(prev => [...prev, newMarker]);
      } else if (e.key.toLowerCase() === "b") {
        setActiveTool("blade");
      } else if (e.key.toLowerCase() === "a" || e.key.toLowerCase() === "v") {
        setActiveTool("pointer");
      } else if (e.key.toLowerCase() === "n") {
        setSnappingEnabled(prev => !prev);
      } else if (e.key === "ArrowLeft") {
        setFrameUI(Math.max(0, currentFrameRef.current - 1));
      } else if (e.key === "ArrowRight") {
        setFrameUI(Math.min(project.durationFrames - 1, currentFrameRef.current + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const targets = getSnapTargets().filter(t => t < currentFrameRef.current);
        if (targets.length > 0) setFrameUI(targets[targets.length - 1]);
        else setFrameUI(0);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const targets = getSnapTargets().filter(t => t > currentFrameRef.current);
        if (targets.length > 0) setFrameUI(targets[0]);
        else setFrameUI(project.durationFrames - 1);
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [deleteActiveElement, rippleDeleteActiveElement, getSnapTargets, setFrameUI]);

  const activeElement = timelineElements.find(e => e.id === activeElementId);

  // Playhead scrub drag
  const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false);
  const handleTimelineHeaderMouseDown = (e: React.MouseEvent) => {
    setIsDraggingPlayhead(true);
    updatePlayheadFromMouse(e.clientX);
  };

  const updatePlayheadFromMouse = useCallback((clientX: number) => {
    if (!timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const scrollLeft = timelineRef.current.scrollLeft;
    const x = clientX - rect.left + scrollLeft;
    let frame = Math.floor(x / timelineZoom);
    if (!isDraggingPlayhead) frame = snapFrame(frame); // Snap on initial click down
    else {
      // Snap during drag
      frame = snapFrame(frame);
    }
    if (frame < 0) frame = 0;
    if (frame >= project.durationFrames) frame = project.durationFrames - 1;
    setFrameUI(frame);
  }, [project.durationFrames, setFrameUI, isDraggingPlayhead, snapFrame, timelineZoom]);

  useEffect(() => {
    const handleMouseUp = () => setIsDraggingPlayhead(false);
    const handleMouseMove = (e: MouseEvent) => {
      if (isDraggingPlayhead) {
        updatePlayheadFromMouse(e.clientX);
      }
    };
    if (isDraggingPlayhead) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    }
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDraggingPlayhead, updatePlayheadFromMouse]);

  // 5. EXPORT AND RENDER LOGIC
  const exportProjectJSON = () => {
    const data = { project, timelineElements, version: "1.0.0", exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mappa-project-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const startRecording = () => {
    try {
      saveRenderData({ project, timelineElements })
        .then(() => {
          const webview = new WebviewWindow("render", {
            url: "?mode=render",
            title: "Mappa Renderer Engine",
            width: 1280, // Using a reasonable default or project.width
            height: 720,
            resizable: true,
            // In Tauri v2, we can't easily set width/height based on project if it's too large for screen, 
            // but 1280x720 is a safe bet for the window itself.
          });

          webview.once("tauri://created", () => {
            console.log("Render window created");
          });

          webview.once("tauri://error", (e) => {
            console.error("Failed to create render window", e);
            alert("Failed to start render engine window. Make sure you have the correct permissions.");
          });
        })
        .catch((err) => {
          console.error("Failed to persist render payload", err);
          alert("Failed to store render data in IndexedDB. Your browser may be blocking local database access.");
        });
    } catch (err) {
      console.error("Failed to start render", err);
      alert("Failed to start render. Check browser storage permissions and try again.");
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-zinc-950 text-zinc-300 overflow-hidden font-sans">
      <div className="flex flex-1 min-h-0">

        {/* LEFT BAR: MEDIA POOL */}
        <aside className="w-72 border-r border-zinc-800 bg-zinc-900 flex flex-col z-20 shrink-0">
          <div className="p-4 border-b border-zinc-800">
            <h2 className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-4">
              Media Pool
            </h2>
            <div className="flex gap-2">
              <input
                className="flex-1 bg-black/40 border border-zinc-700 rounded px-2 py-1.5 text-xs outline-none focus:border-orange-500"
                placeholder="Search location..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              />
              <button
                onClick={handleSearch}
                className="bg-zinc-800 px-3 rounded text-[10px] font-bold hover:bg-zinc-700"
              >
                {isSearching ? "..." : "FIND"}
              </button>
            </div>

            <div className="mt-4 pt-4 border-t border-zinc-800">
              <button
                onClick={addDetailEffect}
                className="w-full py-2 bg-indigo-500/10 text-indigo-400 border border-indigo-500/30 rounded text-xs font-bold hover:bg-indigo-500/20"
              >
                + Detail Effect Overlay
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar">
            {searchResults.map((loc) => (
              <div
                key={loc.id}
                draggable
                onDragStart={(e) =>
                  e.dataTransfer.setData("application/json", JSON.stringify(loc))
                }
                className="p-3 bg-zinc-800/50 border border-zinc-700 rounded-md cursor-grab active:cursor-grabbing hover:border-orange-500/50"
              >
                <div className="flex justify-between items-center mb-1">
                  <span className="text-xs font-bold text-zinc-200 truncate">{loc.display_name}</span>
                  <span className="text-[8px] px-1 bg-orange-500/10 text-orange-400 rounded border border-orange-500/20">
                    {loc.type}
                  </span>
                </div>
                <div className="text-[10px] text-zinc-500 truncate">
                  {loc.display_name}
                </div>
              </div>
            ))}
          </div>
        </aside>

        {/* MAP CENTER */}
        <main ref={viewAreaRef} className="flex-1 relative bg-zinc-950 flex flex-col p-6 items-center justify-center overflow-hidden">
          <div className="absolute top-4 left-6 z-10 flex gap-4 items-center">
            <div className="bg-zinc-950/80 px-3 py-1 rounded border border-zinc-700 text-[10px] font-mono shadow-xl text-zinc-400">
              {project.width}x{project.height} @ {project.fps}FPS
            </div>

            <div className="flex items-center gap-2 bg-zinc-950/80 px-3 py-1 rounded border border-zinc-700 shadow-xl">
              <span className="text-[9px] font-bold uppercase tracking-widest text-zinc-500">Canvas</span>
              <button
                onClick={() => handleCanvasZoomChange(canvasZoom - 0.1)}
                className="w-5 h-5 rounded border border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-500"
              >
                -
              </button>
              <input
                type="range"
                min="0.5"
                max="4"
                step="0.1"
                value={canvasZoom}
                onChange={(e) => handleCanvasZoomChange(parseFloat(e.target.value))}
                className="w-24 h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-orange-500"
              />
              <button
                onClick={() => handleCanvasZoomChange(canvasZoom + 0.1)}
                className="w-5 h-5 rounded border border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-500"
              >
                +
              </button>
              <button
                onClick={() => handleCanvasZoomChange(1)}
                className="px-2 py-0.5 rounded border border-zinc-700 text-[9px] font-bold uppercase text-zinc-400 hover:text-white hover:border-zinc-500"
              >
                Fit
              </button>
              <span className="w-10 text-right text-[10px] font-mono text-orange-400">
                {Math.round(canvasZoom * 100)}%
              </span>
              <span className="text-[9px] text-zinc-500">Alt+Wheel</span>
            </div>
            
            <div className="flex bg-zinc-950/80 rounded border border-zinc-700 shadow-xl overflow-hidden divide-x divide-zinc-800">
                <button 
                  onClick={() => {
                    const input = document.createElement("input");
                    input.type = "file";
                    input.accept = ".json";
                    input.onchange = (e) => {
                      const file = (e.target as HTMLInputElement).files?.[0];
                      if (file) onImport(file);
                    };
                    input.click();
                  }}
                  className="px-3 py-1 text-[9px] font-bold text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors uppercase flex items-center gap-1.5"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  Open
                </button>
                <button 
                  onClick={exportProjectJSON}
                  className="px-3 py-1 text-[9px] font-bold text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors uppercase flex items-center gap-1.5"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  Export JSON
                </button>
                <button 
                  onClick={startRecording}
                  className="px-3 py-1 text-[9px] font-bold text-orange-500 hover:bg-orange-500 hover:text-black transition-colors uppercase flex items-center gap-1.5 disabled:opacity-50"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>
                  Render MP4
                </button>
            </div>
          </div>

          <div className="relative flex-1 w-full overflow-auto" onWheelCapture={handleCanvasWheel}>
            <div className="flex min-w-full min-h-full items-center justify-center">
              <div
                ref={mapCenterWrapper}
                className="relative shadow-2xl bg-zinc-900 border border-zinc-800 overflow-hidden"
                style={{
                  width: `${project.width * viewScale * canvasZoom}px`,
                  height: `${project.height * viewScale * canvasZoom}px`,
                }}
              >
                <div
                  className="absolute left-0 top-0"
                  style={{
                    width: `${project.width}px`,
                    height: `${project.height}px`,
                    transform: `scale(${viewScale * canvasZoom})`,
                    transformOrigin: "top left",
                  }}
                >
                  <div ref={mapContainer} className="absolute inset-0 w-full h-full" />
                </div>
              </div>
            </div>
          </div>
        </main>

        {/* RIGHT BAR: INSPECTOR */}
        <aside className="w-80 border-l border-zinc-800 bg-zinc-900 flex flex-col z-20 shrink-0">
          <div className="p-4 border-b border-zinc-800 flex justify-between items-center">
            <h2 className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">
              Inspector
            </h2>
            {activeElement && (
              <button 
                onClick={deleteActiveElement}
                className="text-[9px] font-bold text-red-500 hover:text-white hover:bg-red-500 px-2 py-1 rounded transition-colors"
              >
                DELETE
              </button>
            )}
          </div>
          <div className="p-4 flex-1 overflow-y-auto">
            {activeElement ? (
              <div className="space-y-6">

                {/* TIMING */}
                <section>
                  <label className="text-[9px] text-zinc-500 font-bold block mb-2 uppercase">
                    Timing Controls
                  </label>
                  <div className="flex gap-2">
                    <div className="flex-1 space-y-1">
                      <span className="text-[8px] text-zinc-500">START FRAME</span>
                      <input
                        type="number"
                        value={activeElement.startFrame}
                        onChange={(e) => updateActiveElement({ startFrame: parseInt(e.target.value) || 0 })}
                        className="w-full bg-black/30 border border-zinc-700 text-xs px-2 py-1 rounded"
                      />
                    </div>
                    <div className="flex-1 space-y-1">
                      <span className="text-[8px] text-zinc-500">DURATION (Frames)</span>
                      <input
                        type="number"
                        value={activeElement.durationFrames}
                        onChange={(e) => updateActiveElement({ durationFrames: parseInt(e.target.value) || 1 })}
                        className="w-full bg-black/30 border border-zinc-700 text-xs px-2 py-1 rounded"
                      />
                    </div>
                  </div>
                </section>

                {/* LOCATION PAYLOAD */}
                {activeElement.type === "location" && activeElement.locationPayload && (
                  <section>
                    <label className="text-[9px] text-orange-500 font-bold block mb-2 uppercase">
                      Map Topology
                    </label>
                    <div className="bg-black/30 p-3 rounded border border-zinc-800 space-y-4">
                      <div>
                        <div className="flex justify-between items-center mb-1">
                          <span className="text-[8px] text-zinc-500">TRANSITION</span>
                        </div>
                        <div className="flex gap-2">
                          <select
                            value={activeElement.locationPayload.transition || "fly"}
                            onChange={(e) => updateActivePayload({ transition: e.target.value })}
                            className="flex-1 bg-zinc-800 border border-zinc-700 text-xs px-2 py-1 rounded outline-none text-zinc-200"
                          >
                            <option value="fly">Fly</option>
                            <option value="ease">Ease</option>
                            <option value="jump">Jump</option>
                            <option value="pan">Pan</option>
                            <option value="zoom_in">Zoom In</option>
                            <option value="zoom_out">Zoom Out</option>
                            <option value="rotate">Rotate</option>
                            <option value="tilt">Tilt</option>
                            <option value="fit_bounds">Fit Bounds</option>
                          </select>
                          <input
                            type="number"
                            placeholder="ms"
                            value={activeElement.locationPayload.transitionMS || 2000}
                            onChange={(e) => updateActivePayload({ transitionMS: parseInt(e.target.value) || 0 })}
                            className="w-16 bg-zinc-800 border border-zinc-700 text-xs px-2 py-1 rounded outline-none text-zinc-200"
                          />
                        </div>
                      </div>

                      <div className="border-t border-zinc-800 pt-3">
                        <button
                          onClick={captureMapState}
                          className="w-full py-1.5 bg-orange-500 text-black text-[10px] font-bold rounded hover:bg-orange-400 transition-colors uppercase tracking-tight"
                        >
                          Capture Current View
                        </button>
                      </div>

                      <div className="border-t border-zinc-800 pt-3">
                        <div className="text-[8px] text-zinc-500 mb-2 uppercase">Camera States</div>
                        <div className="space-y-3">
                          <div>
                            <div className="flex justify-between text-[8px] text-zinc-500 mb-1">
                              <span>ZOOM</span>
                              <span className="text-orange-500 font-mono">{activeElement.locationPayload.zoom.toFixed(1)}</span>
                            </div>
                            <input
                              type="range" min="1" max="22" step="0.1"
                              value={activeElement.locationPayload.zoom}
                              onChange={(e) => updateActivePayload({ zoom: parseFloat(e.target.value) })}
                              className="w-full h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-orange-500"
                            />
                          </div>
                          <div>
                            <div className="flex justify-between text-[8px] text-zinc-500 mb-1">
                              <span>ROTATION</span>
                              <span className="text-orange-500 font-mono">{Math.round(activeElement.locationPayload.bearing || 0)}°</span>
                            </div>
                            <input
                              type="range" min="-180" max="180" step="1"
                              value={activeElement.locationPayload.bearing || 0}
                              onChange={(e) => updateActivePayload({ bearing: parseFloat(e.target.value) })}
                              className="w-full h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-orange-500"
                            />
                          </div>
                          <div>
                            <div className="flex justify-between text-[8px] text-zinc-500 mb-1">
                              <span>TILT</span>
                              <span className="text-orange-500 font-mono">{Math.round(activeElement.locationPayload.pitch || 0)}°</span>
                            </div>
                            <input
                              type="range" min="0" max="85" step="1"
                              value={activeElement.locationPayload.pitch || 0}
                              onChange={(e) => updateActivePayload({ pitch: parseFloat(e.target.value) })}
                              className="w-full h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-orange-500"
                            />
                          </div>
                        </div>
                      </div>

                      <div className="border-t border-zinc-800 pt-3">
                        <div className="flex justify-between items-center mb-2">
                          <label className="text-[8px] text-zinc-500 uppercase flex items-center gap-2 cursor-pointer">
                            <input 
                              type="checkbox" 
                              checked={activeElement.locationPayload.highlightEnabled !== false}
                              onChange={(e) => updateActivePayload({ highlightEnabled: e.target.checked })}
                              className="accent-orange-500"
                            />
                            SHOW HIGHLIGHT
                          </label>
                        </div>
                        
                        {(activeElement.locationPayload.highlightEnabled !== false) && (
                          <div className="space-y-3 mt-2">
                            <div className="flex gap-3 items-center">
                              <input
                                type="color"
                                value={activeElement.locationPayload.color || "#f97316"}
                                onChange={(e) => updateActivePayload({ color: e.target.value })}
                                className="w-10 h-6 bg-transparent border-none cursor-pointer"
                              />
                              <span className="text-xs font-mono">
                                {(activeElement.locationPayload.color || "#f97316").toUpperCase()}
                              </span>
                            </div>
                            
                            <div className="grid grid-cols-2 gap-2 mt-2">
                              <div>
                                <span className="text-[8px] text-zinc-500 block mb-1">FADE IN (frames)</span>
                                <input
                                  type="number"
                                  min="0"
                                  value={activeElement.locationPayload.fadeInFrames || 0}
                                  onChange={(e) => updateActivePayload({ fadeInFrames: parseInt(e.target.value) || 0 })}
                                  className="w-full bg-zinc-800 border border-zinc-700 text-xs px-2 py-1 rounded outline-none text-zinc-200"
                                />
                              </div>
                              <div>
                                <span className="text-[8px] text-zinc-500 block mb-1">FADE OUT (frames)</span>
                                <input
                                  type="number"
                                  min="0"
                                  value={activeElement.locationPayload.fadeOutFrames || 0}
                                  onChange={(e) => updateActivePayload({ fadeOutFrames: parseInt(e.target.value) || 0 })}
                                  className="w-full bg-zinc-800 border border-zinc-700 text-xs px-2 py-1 rounded outline-none text-zinc-200"
                                />
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </section>
                )}

                {/* EFFECT PAYLOAD */}
                {activeElement.type === "effect_detail" && activeElement.effectPayload && (
                  <section>
                    <label className="text-[9px] text-indigo-500 font-bold block mb-2 uppercase">
                      Effect: World Detail
                    </label>
                    <div className="bg-black/30 p-3 rounded border border-zinc-800 space-y-4">
                      <div>
                        <div className="flex justify-between items-center mb-2">
                          <span className="text-[8px] text-zinc-500">DENSITY (%)</span>
                          <span className="text-[10px] font-mono text-indigo-400">
                            {activeElement.effectPayload.detailLevel}
                          </span>
                        </div>
                        <input
                          type="range"
                          min="0" max="100" step="1"
                          value={activeElement.effectPayload.detailLevel}
                          onChange={(e) => updateActivePayload({ detailLevel: parseInt(e.target.value) })}
                          className="w-full h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                        />
                        <div className="flex justify-between mt-1 text-[7px] text-zinc-600 font-mono">
                          <span>WATER ONLY</span>
                          <span>MODERATE</span>
                          <span>ALL ROADS</span>
                        </div>
                      </div>
                    </div>
                  </section>
                )}
              </div>
            ) : (
              <div className="h-40 flex items-center justify-center border border-dashed border-zinc-800 rounded text-[10px] text-zinc-600 uppercase text-center px-10">
                Select a clip on the timeline to inspect
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* BOTTOM: Timeline Area */}
      <footer className="h-72 border-t border-zinc-800 bg-zinc-900 flex flex-col z-30 shrink-0 select-none">
        {/* Timeline Header Toolbar */}
        <div className="h-12 bg-zinc-950 border-b border-zinc-800 flex items-center px-4 justify-between">
          <div className="flex gap-4 items-center">
            <button
              onClick={() => void handlePreviewPlaybackToggle()}
              disabled={isPreloadingPlayback}
              className={`w-8 h-8 rounded flex items-center justify-center transition-colors disabled:opacity-40 ${isPlaying ? 'bg-orange-500 text-black' : 'bg-zinc-800 hover:bg-zinc-700 text-white'}`}
            >
              {isPlaying ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
              )}
            </button>
            <div ref={timecodeLabelRef} className="font-mono text-sm text-zinc-300 bg-black/50 px-3 py-1 rounded border border-zinc-800">
              {formatTimecode(currentFrameRef.current)}
            </div>
            
            <div className="flex bg-zinc-950/80 rounded border border-zinc-800 shadow-inner overflow-hidden">
               <div className="flex items-center gap-2 px-3 border-r border-zinc-900">
                  <span className="text-[9px] font-bold text-zinc-600 uppercase text-zinc-500">Start</span>
                  <input 
                    type="number"
                    value={project.startFrame}
                    onChange={(e) => setProject(prev => prev ? { ...prev, startFrame: parseInt(e.target.value) || 0 } : null)}
                    className="w-12 bg-black/40 border-none text-[10px] font-mono text-orange-400 rounded px-1.5 py-0.5 outline-none"
                  />
               </div>
               <div className="flex items-center gap-2 px-3">
                  <span className="text-[9px] font-bold text-zinc-600 uppercase text-zinc-500">End</span>
                  <input 
                    type="number"
                    value={project.endFrame}
                    onChange={(e) => setProject(prev => prev ? { ...prev, endFrame: parseInt(e.target.value) || 0 } : null)}
                    className="w-12 bg-black/40 border-none text-[10px] font-mono text-orange-400 rounded px-1.5 py-0.5 outline-none"
                  />
               </div>
            </div>
          </div>

          <div className="flex items-center gap-4">
             {/* Tool Actions */}
             <div className="flex bg-zinc-950/80 rounded border border-zinc-800 shadow-inner overflow-hidden">
                <button
                  title="Pointer tool (A)"
                  onClick={() => setActiveTool("pointer")}
                  className={`px-2 py-1 text-xs transition-colors ${activeTool === "pointer" ? "bg-orange-500 text-black" : "text-zinc-500 hover:text-white"}`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg>
                </button>
                <button
                  title="Blade tool (B)"
                  onClick={() => setActiveTool("blade")}
                  className={`px-2 py-1 flex items-center gap-1 text-[10px] font-bold uppercase transition-colors ${activeTool === "blade" ? "bg-orange-500 text-black" : "text-zinc-500 hover:text-white"}`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 3v12"/><path d="M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"/></svg>
                  Cut
                </button>
             </div>
             
             {/* Snapping */}
             <button
               title="Snapping (N)"
               onClick={() => setSnappingEnabled(p => !p)}
               className={`px-2 py-1 rounded border transition-colors ${snappingEnabled ? "bg-orange-500/20 text-orange-400 border-orange-500/50" : "bg-zinc-800/50 text-zinc-500 border-zinc-800 hover:text-zinc-300"}`}
             >
               <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 11V7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4"/><path d="M4 11v10"/><path d="M20 11v10"/><path d="M4 21h4"/><path d="M16 21h4"/></svg>
             </button>

             <div className="flex items-center gap-2 bg-black/40 px-3 py-1 rounded border border-zinc-800">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-500"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
                <input 
                  type="range" min="0.5" max="20" step="0.1" 
                  value={timelineZoom} 
                  onChange={(e) => handleZoomChange(parseFloat(e.target.value))}
                  className="w-24 h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-orange-500"
                />
             </div>
          </div>
        </div>

        {/* Timeline Track Area */}
        <div
          className="relative flex-1 overflow-x-auto overflow-y-hidden timeline-bg"
          ref={timelineRef}
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleTimelineDrop}
        >
          {/* Timeline Header Scrubber Area */}
          <div
            className="sticky top-0 h-7 bg-zinc-950/90 border-b border-zinc-800 z-10 cursor-col-resize overflow-hidden"
            style={{ position: 'sticky' }}
            onMouseDown={handleTimelineHeaderMouseDown}
          >
            {/* Frame number ruler */}
            {(() => {
              const totalFrames = project.durationFrames;
              // Pick an interval so labels are ~80px apart
              const rawInterval = 80 / timelineZoom;
              const niceIntervals = [1,2,5,10,15,20,25,30,50,60,75,100,120,150,200,250,300,500,600,750,1000,1200,1500,2000,3000];
              const interval = niceIntervals.find(n => n >= rawInterval) ?? 3000;
              const ticks: React.ReactNode[] = [];
              for (let f = 0; f <= totalFrames; f += interval) {
                const x = f * timelineZoom;
                ticks.push(
                  <div key={f} className="absolute top-0 bottom-0 flex flex-col items-start pointer-events-none" style={{ left: x }}>
                    <div className="w-px h-2 bg-zinc-600" />
                    <span className="text-[8px] font-mono text-zinc-500 pl-0.5 select-none leading-none mt-px">{f}</span>
                  </div>
                );
              }
              return ticks;
            })()}

            {/* Playhead frame label — floats above the playhead arrow */}
            <div
              ref={playheadLabelRef}
              className="absolute top-0 pointer-events-none z-30 flex flex-col items-center"
              style={{ left: currentFrameRef.current * timelineZoom }}
            >
              <div
                className="relative -translate-x-1/2 bg-red-500 text-white text-[8px] font-mono font-bold px-1 py-px rounded-sm leading-tight whitespace-nowrap shadow-md"
                style={{ top: 0 }}
              >
                {currentFrameRef.current}
              </div>
            </div>

            {/* Markers */}
            {markers.map(m => (
              <div 
                key={m.id}
                className="absolute top-0 bottom-0 w-2 flex flex-col items-center group cursor-pointer"
                style={{ left: m.frame * timelineZoom - 4 }}
                onClick={(e) => {
                  e.stopPropagation();
                  setFrameUI(m.frame);
                }}
              >
                <div className="w-2 h-2 rotate-45 mt-1" style={{ backgroundColor: m.color }} />
                <div className="hidden group-hover:block absolute top-4 bg-zinc-800 text-[8px] px-1 py-0.5 rounded border border-zinc-700 whitespace-nowrap z-50">
                  {m.label} ({m.frame})
                </div>
              </div>
            ))}
          </div>

          {/* Tracks Container */}
          <div className="relative pt-2" style={{ width: Math.max(project.durationFrames * timelineZoom, window.innerWidth), height: TRACK_COUNT * TRACK_HEIGHT }}>
            
            {/* Out-of-Range Background Dimming */}
            <div 
              className="absolute top-0 bottom-0 left-0 bg-black/40 pointer-events-none z-0"
              style={{ width: project.startFrame * timelineZoom }}
            />
            <div 
              className="absolute top-0 bottom-0 right-0 bg-black/40 pointer-events-none z-0"
              style={{ left: (project.endFrame + 1) * timelineZoom, width: Math.max(0, (project.durationFrames - project.endFrame - 1) * timelineZoom) }}
            />

            {/* Playhead Line */}
            <div
              ref={playheadLineRef}
              className="absolute top-0 bottom-0 w-[1px] bg-red-500 z-20 pointer-events-none"
              style={{ left: currentFrameRef.current * timelineZoom }}
            >
              {/* Arrow pointing down from ruler */}
              <div className="absolute top-[-28px] left-[-4px] w-0 h-0 border-l-[4px] border-r-[4px] border-t-[6px] border-transparent border-t-red-500" />
            </div>

            {/* Draw Track Separators */}
            {Array.from({ length: TRACK_COUNT }).map((_, i) => (
              <div
                key={i}
                className="absolute w-full border-b border-zinc-800 pointer-events-none"
                style={{ top: i * TRACK_HEIGHT, height: TRACK_HEIGHT }}
              >
                <span className="absolute left-2 top-1 text-[8px] text-zinc-600 font-mono">TRACK 0{i + 1}</span>
              </div>
            ))}

            {/* Elements */}
            {timelineElements.map((el) => {
              const isSelected = activeElementId === el.id;
              const left = el.startFrame * timelineZoom;
              const width = el.durationFrames * timelineZoom;
              const top = el.trackIndex * TRACK_HEIGHT + 4; // 4px padding

              const baseColor = el.type === "location" ? "border-orange-500/50 bg-orange-500/10" : "border-indigo-500/50 bg-indigo-500/10";
              const selColor = el.type === "location" ? "border-orange-400 bg-orange-500/30" : "border-indigo-400 bg-indigo-500/30";

              return (
                <div
                  key={el.id}
                  onClick={(e) => handleClipClick(e, el.id)}
                  className={`absolute h-[52px] border rounded text-[10px] p-2 overflow-hidden transition-colors z-10 
                          ${isSelected ? selColor : baseColor}
                          ${activeTool === "blade" ? "cursor-[crosshair]" : "cursor-grab active:cursor-grabbing"}
                       `}
                  style={{ left, width, top }}
                >
                  <div
                    onMouseDown={(e) => handleBlockMouseDown(e, el.id)}
                    className="absolute inset-0 z-0"
                  />
                  
                  {/* Left Trim Handle */}
                  <div 
                    onMouseDown={(e) => handleTrimMouseDown(e, el.id, "left")}
                    className="absolute left-0 top-0 bottom-0 w-2 hover:bg-orange-500/50 cursor-col-resize z-20 flex items-center justify-center opacity-0 hover:opacity-100"
                  >
                     <div className="w-[1px] h-3 bg-white" />
                  </div>
                  
                  {/* Right Trim Handle */}
                  <div 
                    onMouseDown={(e) => handleTrimMouseDown(e, el.id, "right")}
                    className="absolute right-0 top-0 bottom-0 w-2 hover:bg-orange-500/50 cursor-col-resize z-20 flex items-center justify-center opacity-0 hover:opacity-100"
                  >
                     <div className="w-[1px] h-3 bg-white" />
                  </div>

                  <div className={`relative z-10 font-bold truncate pointer-events-none ${el.type === "location" ? "text-orange-400" : "text-indigo-400"}`}>
                    {el.name}
                  </div>
                  {el.type === "effect_detail" && el.effectPayload && (
                    <div className="relative z-10 text-[8px] text-zinc-400 mt-1 pointer-events-none">Detail: {el.effectPayload.detailLevel}%</div>
                  )}
                  {el.type === "location" && el.locationPayload && (
                    <div className="relative z-10 mt-1 flex w-full h-1 bg-black/40 rounded-full overflow-hidden pointer-events-none">
                      <div className="h-full opacity-60" style={{ backgroundColor: el.locationPayload.color, width: '100%' }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </footer>
    </div>
  );
};

export default MapEditor;
