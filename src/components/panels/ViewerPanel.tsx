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
    desynchronized: true,
  },
};
const MAP_TRANSFORM_REQUEST = createCachedMapTransformRequest();

export const ViewerPanel: React.FC = () => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const viewAreaRef = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);

  const {
    project,
    timelineElements,
    activeElementId,
    currentFrame,
    isPlaying,
    setFrame,
    setIsPlaying,
    updateTimelineElement,
    trackStates,
  } = useProjectStore();

  const [viewScale, setViewScale] = useState(1);
  const playbackCacheRef = useRef(createMapPlaybackCache());

  // 1. INITIALIZE MAP
  useEffect(() => {
    if (map.current || !mapContainer.current) return;

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: OPEN_FREEMAP_STYLE_URL,
      center: [0, 20],
      zoom: 1.5,
      interactive: false,
      transformRequest: MAP_TRANSFORM_REQUEST,
      ...PREVIEW_MAP_OPTIONS,
      pixelRatio: 1, // FORCE 1:1 CSS pixels to internal canvas pixels
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

  // Map Resize observer
  useEffect(() => {
    if (!viewAreaRef.current || !project) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // Subtract padding 
        const availW = Math.max(10, entry.contentRect.width - 48);
        const availH = Math.max(10, entry.contentRect.height - 108); // 48 padding + 60 controls
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

  // Update map state
  const updateMapState = useCallback((frameIndex: number) => {
    if (!map.current || !project) return;
    applyDeterministicTimelineFrameToMap({
      map: map.current,
      frameIndex,
      timelineElements,
      trackStates,
      fps: project.fps,
      cache: playbackCacheRef.current,
    });
  }, [timelineElements, project, trackStates]);

  useEffect(() => {
    updateMapState(currentFrame);
  }, [updateMapState, currentFrame]);

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

  // Handle Manual Capture Event from Inspector
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
    if (!isPlaying || !project) return;

    let lastTime = performance.now();
    let frameId: number;
    const msPerFrame = 1000 / project.fps;

    const loop = (time: number) => {
      const delta = time - lastTime;
      if (delta >= msPerFrame) {
        // Here we read currentFrame from state by using functional update, but since the loop runs fast, we need a ref
        setFrame(editorStateRef.current.currentFrame + 1 > project.endFrame ? project.startFrame : editorStateRef.current.currentFrame + 1);
        lastTime = time - (delta % msPerFrame);
      }
      frameId = requestAnimationFrame(loop);
    };
    frameId = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(frameId);
  }, [isPlaying, project, setFrame]);

  if (!project) return null;

  return (
    <div className="flex-1 flex flex-col relative bg-zinc-950">
      
      {/* Viewer Viewport Area */}
      <div 
        ref={viewAreaRef} 
        className="flex-1 overflow-hidden relative select-none bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjgiPgo8cmVjdCB3aWR0aD0iOCIgaGVpZ2h0PSI4IiBmaWxsPSIjMWYxZjFmIj48L3JlY3Q+CjxwYXRoIGQ9Ik0wIDBMODggWk04IDBMMCA4WiIgc3Ryb2tlPSIjMjgyODI4IiBzdHJva2Utd2lkdGg9IjEiPjwvcGF0aD4KPC9zdmc+')] bg-repeat"
      >
        <div 
          className="bg-black shadow-[0_0_50px_rgba(0,0,0,0.5)] ring-1 ring-white/10 absolute top-1/2 left-1/2 overflow-hidden"
          style={{
            width: project.width,
            height: project.height,
            transform: `translate(-50%, -50%) scale(${viewScale})`,
            transformOrigin: "center center",
            transition: "transform 0.1s ease-out",
            opacity: (() => {
              const el = timelineElements.find(x => 
                x.type === 'location' && currentFrame >= x.startFrame && currentFrame < x.startFrame + x.durationFrames
              );
              return el?.locationPayload?.opacity ?? 1;
            })()
          }}
        >
          {/* Main Vector Map Surface */}
          <div ref={mapContainer} className="w-full h-full absolute inset-0" />
        </div>
      </div>

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
