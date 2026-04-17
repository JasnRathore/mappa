import React, { useEffect, useRef, useState, useCallback } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Play, Pause, SkipBack, SkipForward } from "@phosphor-icons/react";
import { useProjectStore } from "../../store/useProjectStore";
import { applyDeterministicTimelineFrameToMap, createMapPlaybackCache } from "../../lib/mapPlayback";
import {
  OPEN_FREEMAP_STYLE_URL,
  createCachedMapTransformRequest,
  installMapResourceCacheProtocol,
} from "../../lib/mapResourceCache";
import { Button } from "../ui/button";

installMapResourceCacheProtocol();

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
    desynchronized: false, // Disabled to prevent blackouts/flickering
  },
};
const MAP_TRANSFORM_REQUEST = createCachedMapTransformRequest();

export const ViewerPanel: React.FC = () => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const preloaderContainer = useRef<HTMLDivElement>(null);
  const viewAreaRef = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const preloaderMap = useRef<maplibregl.Map | null>(null);

  const {
    project,
    timelineElements,
    currentFrame,
    isPlaying,
    setFrame,
    setIsPlaying,
    activeElementId,
    updateTimelineElement,
    trackStates,
  } = useProjectStore();

  const [viewScale, setViewScale] = useState(1);
  const playbackCacheRef = useRef(createMapPlaybackCache());
  const preloaderCacheRef = useRef(createMapPlaybackCache());
  
  // Optimized Playback refs
  const localFrameRef = useRef(currentFrame);
  const lastSyncFrameRef = useRef(currentFrame);
  const surfaceRef = useRef<HTMLDivElement>(null);
  
  // Persistent refs for loop to prevent restarts
  const playbackDepsRef = useRef({ timelineElements, trackStates, project });
  useEffect(() => {
    playbackDepsRef.current = { timelineElements, trackStates, project };
  }, [timelineElements, trackStates, project]);

  // Master Sync Function
  const syncMapToFrame = useCallback((frame: number) => {
    const { timelineElements: elements, trackStates: tracks, project: proj } = playbackDepsRef.current;
    if (!map.current || !proj) return;

    // 1. Update Map
    applyDeterministicTimelineFrameToMap({
      map: map.current,
      frameIndex: frame,
      timelineElements: elements,
      trackStates: tracks,
      fps: proj.fps,
      cache: playbackCacheRef.current,
    });

    // 2. Update Opacity DIRECTLY
    if (surfaceRef.current) {
      const el = elements.find(x => 
        x.type === 'location' && frame >= x.startFrame && frame < x.startFrame + x.durationFrames
      );
      surfaceRef.current.style.opacity = String(el?.locationPayload?.opacity ?? 1);
    }
  }, []);

  // 1. INITIALIZE MAPS
  useEffect(() => {
    if (map.current || !mapContainer.current || !preloaderContainer.current) return;

    // Main Map
    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: OPEN_FREEMAP_STYLE_URL,
      center: [0, 20],
      zoom: 1.5,
      interactive: false,
      transformRequest: MAP_TRANSFORM_REQUEST,
      ...PREVIEW_MAP_OPTIONS,
      pixelRatio: 1, 
    } as maplibregl.MapOptions);

    // Hidden Preloader Map
    preloaderMap.current = new maplibregl.Map({
      container: preloaderContainer.current,
      style: OPEN_FREEMAP_STYLE_URL,
      center: [0, 20],
      zoom: 1.5,
      interactive: false,
      transformRequest: MAP_TRANSFORM_REQUEST,
      ...PREVIEW_MAP_OPTIONS,
      pixelRatio: 0.1, // Tiny pixel ratio for preloader
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
      syncMapToFrame(localFrameRef.current);
    });

    return () => {
      map.current?.remove();
      preloaderMap.current?.remove();
      map.current = null;
      preloaderMap.current = null;
    };
  }, [syncMapToFrame]);

  // Map Resize observer
  useEffect(() => {
    if (!viewAreaRef.current || !project) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const availW = Math.max(10, entry.contentRect.width - 48);
        const availH = Math.max(10, entry.contentRect.height - 108);
        const scaleX = availW / (project.width || 1920);
        const scaleY = availH / (project.height || 1080);
        let newScale = Math.min(scaleX, scaleY);
        if (isNaN(newScale) || !isFinite(newScale)) newScale = 1;
        setViewScale(Math.max(0.05, newScale));
      }
    });
    observer.observe(viewAreaRef.current);
    return () => observer.disconnect();
  }, [project]);

  // Handle manual frame changes (Scrubbing)
  useEffect(() => {
    if (!isPlaying) {
      localFrameRef.current = currentFrame;
      syncMapToFrame(currentFrame);
    }
  }, [currentFrame, isPlaying, syncMapToFrame]);

  // Force resize on scale change
  useEffect(() => {
    if (map.current) {
      map.current.resize();
    }
  }, [viewScale, project]);

  // Auto-capture from map interaction
  const editorStateRef = useRef({ activeElementId, timelineElements, currentFrame });
  useEffect(() => {
    editorStateRef.current = { activeElementId, timelineElements, currentFrame };
  }, [activeElementId, timelineElements, currentFrame]);

  useEffect(() => {
    if (!map.current) return;

    const handleMapUserInteraction = (e: { originalEvent?: Event }) => {
      if (!e.originalEvent) return;
      const state = editorStateRef.current;
      if (!state.activeElementId) return;
      
      const el = state.timelineElements.find(x => x.id === state.activeElementId);
      if (!el || el.type !== "location") return;
      if (state.currentFrame >= el.startFrame && state.currentFrame < el.startFrame + el.durationFrames) {
        if (!map.current) return;
        const center = map.current.getCenter();
        updateTimelineElement(el.id, {
          locationPayload: {
            ...el.locationPayload!,
            center: [center.lng, center.lat],
            zoom: map.current.getZoom(),
            bearing: map.current.getBearing(),
            pitch: map.current.getPitch(),
          }
        });
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
  }, [updateTimelineElement]);

  useEffect(() => {
    const handleManualCapture = () => {
      if (!map.current) return;
      const state = editorStateRef.current;
      if (!state.activeElementId) return;
      const el = state.timelineElements.find(x => x.id === state.activeElementId);
      if (!el || el.type !== "location") return;
      const center = map.current.getCenter();
      updateTimelineElement(el.id, {
        locationPayload: {
          ...el.locationPayload!,
          center: [center.lng, center.lat],
          zoom: map.current.getZoom(),
          bearing: map.current.getBearing(),
          pitch: map.current.getPitch(),
        }
      });
    };
    window.addEventListener("mappa:capture-map-state", handleManualCapture);
    return () => window.removeEventListener("mappa:capture-map-state", handleManualCapture);
  }, [updateTimelineElement]);

  // Playback Loop
  useEffect(() => {
    if (!isPlaying || !project) {
      if (!isPlaying) {
        setFrame(localFrameRef.current);
      }
      return;
    }

    let lastTime = performance.now();
    let frameId: number;
    const msPerFrame = 1000 / project.fps;

    const loop = (time: number) => {
      const delta = time - lastTime;
      if (delta >= msPerFrame) {
        localFrameRef.current += 1;
        if (localFrameRef.current > project.endFrame) {
          localFrameRef.current = project.startFrame;
        }

        // 1. Main Sync
        syncMapToFrame(localFrameRef.current);

        // 2. LEAPING PRELOADER: Sync every 30 frames (approx. 1s)
        // This avoids network congestion during fast movement
        if (preloaderMap.current && localFrameRef.current % 30 === 0) {
          const lookaheadFrame = Math.min(localFrameRef.current + (project.fps * 2), project.endFrame);
          applyDeterministicTimelineFrameToMap({
            map: preloaderMap.current,
            frameIndex: lookaheadFrame,
            timelineElements: playbackDepsRef.current.timelineElements,
            trackStates: playbackDepsRef.current.trackStates,
            fps: project.fps,
            cache: preloaderCacheRef.current,
          });
        }

        // 3. UI SYNC: Throttle to every 15 frames (~250ms)
        // Reduces React re-render spikes
        if (Math.abs(localFrameRef.current - lastSyncFrameRef.current) >= 15) {
          setFrame(localFrameRef.current);
          lastSyncFrameRef.current = localFrameRef.current;
        }

        lastTime = time - (delta % msPerFrame);
      }
      frameId = requestAnimationFrame(loop);
    };
    frameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameId);
  }, [isPlaying, project, setFrame, syncMapToFrame]);

  if (!project) return null;

  return (
    <div className="flex-1 flex flex-col relative bg-zinc-950">
      
      {/* Viewer Viewport Area */}
      <div 
        ref={viewAreaRef} 
        className="flex-1 overflow-hidden relative select-none bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjgiPgo8cmVjdCB3aWR0aD0iOCIgaGVpZ2h0PSI4IiBmaWxsPSIjMWYxZjFmIj48L3JlY3Q+CjxwYXRoIGQ9Ik0wIDBMODggWk04IDBMMCA4WiIgc3Ryb2tlPSIjMjgyODI4IiBzdHJva2Utd2lkdGg9IjEiPjwvcGF0aD4KPC9zdmc+')] bg-repeat"
      >
        <div 
          ref={surfaceRef}
          className="bg-black shadow-[0_0_50px_rgba(0,0,0,0.5)] ring-1 ring-white/10 absolute top-1/2 left-1/2 overflow-hidden"
          style={{
            width: project.width,
            height: project.height,
            transform: `translate(-50%, -50%) scale(${viewScale})`,
            transformOrigin: "center center",
            willChange: "transform, opacity",
          }}
        >
          {/* Main Vector Map Surface */}
          <div ref={mapContainer} className="w-full h-full absolute inset-0" />
        </div>
      </div>

      {/* Hidden Preloader Container */}
      <div 
        ref={preloaderContainer} 
        className="fixed opacity-0 pointer-events-none" 
        style={{ width: 1, height: 1, left: -100, top: -100 }} 
      />

      {/* Transport Controls */}
      <div className="h-12 bg-card border-t flex items-center justify-center px-4 shrink-0 shadow-xl z-10 gap-4">
        {/* Playback Controls */}
        <div className="flex items-center space-x-1">
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" title="Go to Start" onClick={() => setFrame(project.startFrame)}>
            <SkipBack weight="fill" />
          </Button>
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-primary hover:text-primary hover:bg-primary/20" title="Play / Pause" onClick={() => setIsPlaying(!isPlaying)}>
            {isPlaying ? <Pause weight="fill" size={18} /> : <Play weight="fill" size={18} />}
          </Button>
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" title="Go to End" onClick={() => setFrame(project.endFrame)}>
            <SkipForward weight="fill" />
          </Button>
        </div>

        {/* Scrubbing Info */}
        <div className="flex items-center space-x-4 ml-8">
           <span className="font-mono text-xs text-muted-foreground w-16 text-right">
             F {currentFrame}
           </span>
           <span className="font-mono text-xs text-muted-foreground w-20">
             {new Date(currentFrame / project.fps * 1000).toISOString().substr(11, 11)}
           </span>
        </div>
      </div>
    </div>
  );
};
