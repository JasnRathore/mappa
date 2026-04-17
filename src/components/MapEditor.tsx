import React, { useEffect, useRef, useState, useCallback } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { ProjectSettings, TimelineElement, LocationPayload } from "../types";

interface Props {
  project: ProjectSettings;
  setProject: React.Dispatch<React.SetStateAction<ProjectSettings | null>>;
  timelineElements: TimelineElement[];
  setTimelineElements: React.Dispatch<React.SetStateAction<TimelineElement[]>>;
  onImport: (file: File) => void;
}

const TRACK_HEIGHT = 60;
const TRACK_COUNT = 4;

const MapEditor: React.FC<Props> = ({ project, setProject, timelineElements, setTimelineElements, onImport }) => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapCenterWrapper = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<LocationPayload[]>([]);
  const [isSearching, setIsSearching] = useState(false);

    const [activeElementId, setActiveElementId] = useState<string | null>(null);

  const [currentFrame, setCurrentFrame] = useState(project.startFrame);
  const [isPlaying, setIsPlaying] = useState(false);
  
  const [isRendering, setIsRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);

  const [timelineZoom, setTimelineZoom] = useState(2);
  const timelineRef = useRef<HTMLDivElement>(null);
  const playheadMarkerRef = useRef<HTMLDivElement>(null);

  const [markers, setMarkers] = useState<Marker[]>(project.markers || []);
  const [draggingElementId, setDraggingElementId] = useState<string | null>(null);
  
  const [activeTool, setActiveTool] = useState<"pointer" | "blade">("pointer");
  const [snappingEnabled, setSnappingEnabled] = useState(true);

  const [trimmingElementId, setTrimmingElementId] = useState<string | null>(null);
  const trimState = useRef<{ startX: number; origStart: number; origDuration: number; edge: "left" | "right" } | null>(null);

  useEffect(() => {
    setProject(prev => prev ? { ...prev, markers } : null);
  }, [markers]);

  const getSnapTargets = useCallback(() => {
    const targets = new Set<number>();
    targets.add(currentFrame);
    markers.forEach(m => targets.add(m.frame));
    timelineElements.forEach(el => {
      targets.add(el.startFrame);
      targets.add(el.startFrame + el.durationFrames);
    });
    return Array.from(targets).sort((a,b)=>a-b);
  }, [currentFrame, markers, timelineElements]);

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

  const lastActiveLocationId = useRef<string | null>(null);
  const lastCameraElementId = useRef<string | null>(null);
  const lastDetailLevel = useRef<number | null>(null);
  // store initial drag context
  const dragState = useRef<{ startX: number; startY: number; origStart: number; origTrack: number } | null>(null);
  const wasRendering = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);

  // 1. INITIALIZE VECTOR MAP
  useEffect(() => {
    if (map.current || !mapContainer.current) return;

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: "https://tiles.openfreemap.org/styles/positron",
      center: [0, 20],
      zoom: 1.5,
      antialias: true,
      preserveDrawingBuffer: true,
    });

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

  // 2. PLAYBACK LOOP
  useEffect(() => {
    if (!isPlaying) return;

    let lastTime = performance.now();
    let frameId: number;
    const msPerFrame = 1000 / project.fps;

    const loop = (time: number) => {
      const delta = time - lastTime;
      if (delta >= msPerFrame) {
        setCurrentFrame((prev) => {
          const nextFrame = prev + 1;
          if (nextFrame > project.endFrame) {
            return project.startFrame; // Loop back to start
          }
          return nextFrame;
        });
        lastTime = time - (delta % msPerFrame);
      }
      frameId = requestAnimationFrame(loop);
    };
    frameId = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(frameId);
  }, [isPlaying, project.fps, project.durationFrames]);

  // 3. MAP STATE UPDATE
  const updateMapState = useCallback(() => {
    if (!map.current) return;

    const activeElements = timelineElements.filter(
      (el) => currentFrame >= el.startFrame && currentFrame < el.startFrame + el.durationFrames
    );

    const activeLocations = activeElements.filter((el) => el.type === "location");
    const activeEffect = activeElements
      .filter((el) => el.type === "effect_detail")
      .sort((a, b) => b.trackIndex - a.trackIndex)[0];
    
    // Camera Focus Logic:
    
    const startingLocations = activeLocations
      .filter(el => el.startFrame === currentFrame)
      .sort((a, b) => b.trackIndex - a.trackIndex);
    
    const topActiveLocation = activeLocations
      .sort((a, b) => b.trackIndex - a.trackIndex)[0];

    // Decide which element should control the camera
    let cameraElement = startingLocations.length > 0 ? startingLocations[0] : topActiveLocation;

    const locKey = cameraElement ? `${cameraElement.id}-${cameraElement.locationPayload?.zoom}-${cameraElement.locationPayload?.bearing}-${cameraElement.locationPayload?.pitch}-${cameraElement.locationPayload?.transition}-${cameraElement.locationPayload?.color}-${JSON.stringify(cameraElement.locationPayload?.center)}` : null;

    if (locKey !== lastActiveLocationId.current) {
      lastActiveLocationId.current = locKey;

      if (cameraElement && cameraElement.locationPayload) {
        const loc = cameraElement.locationPayload;
        const transition = loc.transition || "fly";
        
        const clipMs = (cameraElement.durationFrames / project.fps) * 1000;
        const duration = loc.transitionMS || Math.min(2000, clipMs);

        const options = {
          center: loc.center,
          zoom: loc.zoom,
          bearing: loc.bearing || 0,
          pitch: loc.pitch || 0,
          duration: duration,
          essential: true
        };

        switch (transition) {
          case "jump":
            map.current.jumpTo({ 
              center: loc.center, 
              zoom: loc.zoom, 
              bearing: loc.bearing || 0, 
              pitch: loc.pitch || 0 
            });
            break;
          case "ease":
            map.current.easeTo(options);
            break;
          case "pan":
            map.current.panTo(loc.center, { duration, essential: true });
            break;
          case "rotate":
            map.current.easeTo(options);
            break;
          case "tilt":
            map.current.easeTo(options);
            break;
          case "zoom_in":
            map.current.flyTo({ ...options, zoom: loc.zoom + 1 });
            break;
          case "zoom_out":
            map.current.flyTo({ ...options, zoom: loc.zoom - 1 });
            break;
          case "fit_bounds":
            map.current.flyTo(options);
            break;
          case "fly":
          default:
            map.current.flyTo(options);
            break;
        }
      }
    }

    // Update ALL Highlights
    if (map.current.isStyleLoaded()) {
      const source = map.current.getSource("city-area") as maplibregl.GeoJSONSource;
      if (source) {
        const features = activeLocations.map(el => {
          let alpha = 0.4;
          const loc = el.locationPayload;
          if (loc?.highlightEnabled === false) {
             alpha = 0;
          } else if (loc) {
             const fi = loc.fadeInFrames || 0;
             const fo = loc.fadeOutFrames || 0;
             const frameIn = currentFrame - el.startFrame;
             const frameOut = (el.startFrame + el.durationFrames) - currentFrame;
             
             if (fi > 0 && frameIn < fi) {
               alpha = 0.4 * (frameIn / fi);
             } else if (fo > 0 && frameOut <= fo) {
               alpha = 0.4 * (frameOut / fo);
             }
          }
          
          return {
            type: "Feature",
            properties: { 
              color: loc?.color || "#f97316",
              opacity: alpha
            },
            geometry: loc?.geojson || { type: "Point", coordinates: loc?.center },
          };
        });
        
        if (features.length > 0) {
          source.setData({
            type: "FeatureCollection",
            features: features as any,
          });
        } else {
          source.setData({ type: "FeatureCollection", features: [] });
        }
      }
    }

    const detailLevel = activeEffect?.effectPayload?.detailLevel ?? 100;

    if (detailLevel !== lastDetailLevel.current) {
      lastDetailLevel.current = detailLevel;
      if (map.current.isStyleLoaded()) {
        const style = map.current.getStyle();
        if (style && style.layers) {
          style.layers.forEach((layer) => {
            const isLabel = layer.id.includes("label") || layer.id.includes("place");
            const isTransit =
              layer.id.includes("rail") ||
              layer.id.includes("transit") ||
              layer.id.includes("airport");
            const isSmallRoad = layer.id.includes("road") && !layer.id.includes("motorway");
            const isBuilding = layer.id.includes("building");

            let visible = "visible";
            if (detailLevel < 30) {
              if (isLabel || isTransit || isSmallRoad || isBuilding) visible = "none";
            } else if (detailLevel < 70) {
              if (isSmallRoad || isBuilding) visible = "none";
            }

            map.current?.setLayoutProperty(layer.id, "visibility", visible);
          });
        }
      }
    }
  }, [currentFrame, timelineElements]);

  useEffect(() => {
    updateMapState();
  }, [updateMapState]);


  // 3b. AUTO-CAPTURE FROM MAP INTERACTION
  const editorStateRef = useRef({ activeElementId, currentFrame, timelineElements });
  useEffect(() => {
    editorStateRef.current = { activeElementId, currentFrame, timelineElements };
  }, [activeElementId, currentFrame, timelineElements]);

  useEffect(() => {
    if (!map.current) return;
    
    const handleMapUserInteraction = (e: any) => {
      // originalEvent only exists if the interaction was caused by a user (drag, scroll), not code (flyTo)
      if (!e.originalEvent) return;
      
      const state = editorStateRef.current;
      if (!state.activeElementId) return;
      
      const el = state.timelineElements.find(x => x.id === state.activeElementId);
      if (!el || el.type !== "location") return;
      
      // Auto-capture ONLY if playhead is strictly inside this clip boundaries
      if (state.currentFrame >= el.startFrame && state.currentFrame < el.startFrame + el.durationFrames) {
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
        geojson: item.geojson as Record<string, unknown>,
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
            name: payload.name || "Location",
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
      trackIndex: 0, // Put on top track usually
      startFrame: currentFrame,
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
      let frameDelta = Math.round(deltaX / timelineZoom);

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
    const viewportWidth = timelineRef.current.clientWidth;
    
    // Calculate where the playhead is relative to the viewport
    const playheadX = currentFrame * oldZoom;
    const relativeX = playheadX - scrollLeft;

    setTimelineZoom(newZoom);

    // Maintain the playhead's relative position in the viewport
    requestAnimationFrame(() => {
      if (timelineRef.current) {
        const newPlayheadX = currentFrame * newZoom;
        timelineRef.current.scrollLeft = newPlayheadX - relativeX;
      }
    });
  };

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
          frame: currentFrame,
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
        setCurrentFrame(prev => Math.max(0, prev - 1));
      } else if (e.key === "ArrowRight") {
        setCurrentFrame(prev => Math.min(project.durationFrames - 1, prev + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const targets = getSnapTargets().filter(t => t < currentFrame);
        if (targets.length > 0) setCurrentFrame(targets[targets.length - 1]);
        else setCurrentFrame(0);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const targets = getSnapTargets().filter(t => t > currentFrame);
        if (targets.length > 0) setCurrentFrame(targets[0]);
        else setCurrentFrame(project.durationFrames - 1);
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [deleteActiveElement, rippleDeleteActiveElement, currentFrame, getSnapTargets]);

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
    setCurrentFrame(frame);
  }, [project.durationFrames]);

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
    const data = {
      project,
      timelineElements,
      version: "1.0.0",
      exportedAt: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mappa-project-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const startRecording = async () => {
    if (!map.current || isRendering) return;

    const canvas = map.current.getCanvas();
    const stream = canvas.captureStream(project.fps);
    
    // Attempt MP4, fallback to WebM
    let mimeType = "video/mp4";
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = "video/webm";
    }

    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 12000000 // 12Mbps for high quality
    });
    recorderRef.current = recorder;

    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `mappa-render-${Date.now()}.${mimeType.includes("mp4") ? "mp4" : "webm"}`;
      a.click();
      URL.revokeObjectURL(url);
      setIsRendering(false);
      wasRendering.current = false;
      setIsPlaying(false);
    };

    // Prepare for rendering
    setIsPlaying(false);
    setCurrentFrame(project.startFrame);
    setIsRendering(true);
    wasRendering.current = true;
    setRenderProgress(0);

    // Wait for map to settle at frame 0 before starting recorder
    setTimeout(() => {
      recorder.start();
      setIsPlaying(true);
    }, 1000);
  };

  // Monitor rendering progress
  useEffect(() => {
    if (isRendering) {
      const totalToRender = project.endFrame - project.startFrame + 1;
      const done = currentFrame - project.startFrame;
      setRenderProgress(Math.max(0, Math.min(100, (done / totalToRender) * 100)));
    }
  }, [currentFrame, isRendering, project.startFrame, project.endFrame]);

  // Handle auto-stop recorder when rendering ends
  useEffect(() => {
    if (wasRendering.current && isPlaying && currentFrame >= project.endFrame) {
      if (recorderRef.current && recorderRef.current.state === "recording") {
        // Give it a small buffer to capture final frames
        setTimeout(() => {
          recorderRef.current?.stop();
          setIsPlaying(false);
        }, 500);
      }
    }
  }, [isPlaying, currentFrame, project.endFrame]);


  const formatTimecode = (frames: number) => {
    const totalSecs = frames / project.fps;
    const mins = Math.floor(totalSecs / 60).toString().padStart(2, '0');
    const secs = Math.floor(totalSecs % 60).toString().padStart(2, '0');
    const ff = Math.floor(frames % project.fps).toString().padStart(2, '0');
    return `${mins}:${secs}:${ff}`;
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
                  <span className="text-xs font-bold text-zinc-200 truncate">{loc.name}</span>
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
        <main className="flex-1 relative bg-zinc-950 flex flex-col p-6 items-center justify-center overflow-hidden">
          <div className="absolute top-4 left-6 z-10 flex gap-4 items-center">
            <div className="bg-zinc-950/80 px-3 py-1 rounded border border-zinc-700 text-[10px] font-mono shadow-xl text-zinc-400">
              {project.width}x{project.height} @ {project.fps}FPS
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
                  disabled={isRendering}
                  className="px-3 py-1 text-[9px] font-bold text-orange-500 hover:bg-orange-500 hover:text-black transition-colors uppercase flex items-center gap-1.5 disabled:opacity-50"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>
                  {isRendering ? "Rendering..." : "Render MP4"}
                </button>
            </div>
          </div>

          <div
            ref={mapCenterWrapper}
            className="relative border border-zinc-800 shadow-2xl rounded overflow-hidden"
            style={{
              aspectRatio: project.width / project.height,
              width: '100%',
              maxHeight: '100%',
              maxWidth: project.width > project.height ? '100%' : `${100 / (project.height / project.width)}vh`
            }}
          >
            <div ref={mapContainer} className="absolute inset-0 w-full h-full bg-zinc-900" />
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
              onClick={() => setIsPlaying(!isPlaying)}
              className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${isPlaying ? 'bg-orange-500 text-black' : 'bg-zinc-800 hover:bg-zinc-700 text-white'}`}
            >
              {isPlaying ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
              )}
            </button>
            <div className="font-mono text-sm text-zinc-300 bg-black/50 px-3 py-1 rounded border border-zinc-800">
              {formatTimecode(currentFrame)}
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
              const totalWidth = Math.max(totalFrames * timelineZoom, window.innerWidth);
              // Pick an interval so labels are ~80px apart
              const rawInterval = 80 / timelineZoom;
              const niceIntervals = [1,2,5,10,15,20,25,30,50,60,75,100,120,150,200,250,300,500,600,750,1000,1200,1500,2000,3000];
              const interval = niceIntervals.find(n => n >= rawInterval) ?? 3000;
              const ticks: JSX.Element[] = [];
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
              className="absolute top-0 pointer-events-none z-30 flex flex-col items-center"
              style={{ left: currentFrame * timelineZoom }}
            >
              <div
                className="relative -translate-x-1/2 bg-red-500 text-white text-[8px] font-mono font-bold px-1 py-px rounded-sm leading-tight whitespace-nowrap shadow-md"
                style={{ top: 0 }}
              >
                {currentFrame}
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
                  setCurrentFrame(m.frame);
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
              className="absolute top-0 bottom-0 w-[1px] bg-red-500 z-20 pointer-events-none"
              style={{ left: currentFrame * timelineZoom }}
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

      {/* Rendering Overlay */}
      {isRendering && (
          <div className="absolute inset-0 z-[100] bg-zinc-950/90 flex flex-col items-center justify-center backdrop-blur-sm">
             <div className="w-64 space-y-4 text-center">
                <div className="text-orange-500 font-bold text-sm uppercase tracking-widest animate-pulse">
                    Rendering Project
                </div>
                <div className="h-1 w-full bg-zinc-800 rounded-full overflow-hidden">
                    <div 
                        className="h-full bg-orange-500 transition-all duration-300" 
                        style={{ width: `${renderProgress}%` }}
                    />
                </div>
                <div className="text-[10px] font-mono text-zinc-500">
                    {Math.round(renderProgress)}% COMPLETE • {currentFrame} / {project.durationFrames} FRAMES
                </div>
                <div className="pt-4 text-[9px] text-zinc-600 leading-relaxed italic">
                    Please keep this tab active and visible.<br/>
                    Do not resize the window during render.
                </div>
             </div>
          </div>
      )}
    </div>
  );
};

export default MapEditor;
