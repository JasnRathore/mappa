import React, { useEffect, useRef, useState, useCallback } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { ProjectSettings, TimelineElement, LocationPayload } from "../types";

interface Props {
  project: ProjectSettings;
}

const PIXELS_PER_FRAME = 2;
const TRACK_HEIGHT = 60;
const TRACK_COUNT = 4;

const MapEditor: React.FC<Props> = ({ project }) => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapCenterWrapper = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<LocationPayload[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const [timelineElements, setTimelineElements] = useState<TimelineElement[]>([]);
  const [activeElementId, setActiveElementId] = useState<string | null>(null);

  const [currentFrame, setCurrentFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const timelineRef = useRef<HTMLDivElement>(null);
  const [draggingElementId, setDraggingElementId] = useState<string | null>(null);
  const lastActiveLocationId = useRef<string | null>(null);
  const lastDetailLevel = useRef<number | null>(null);
  // store initial drag context
  const dragState = useRef<{ startX: number; startY: number; origStart: number; origTrack: number } | null>(null);

  // 1. INITIALIZE VECTOR MAP
  useEffect(() => {
    if (map.current || !mapContainer.current) return;

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: "https://tiles.openfreemap.org/styles/positron",
      center: [0, 20],
      zoom: 1.5,
      antialias: true,
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
          "fill-opacity": 0.4,
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
          if (nextFrame >= project.durationFrames) {
            setIsPlaying(false);
            return prev;
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

    const activeLocation = activeElements
      .filter((el) => el.type === "location")
      .sort((a, b) => b.trackIndex - a.trackIndex)[0];

    const activeEffect = activeElements
      .filter((el) => el.type === "effect_detail")
      .sort((a, b) => b.trackIndex - a.trackIndex)[0];

    const locKey = activeLocation ? `${activeLocation.id}-${activeLocation.locationPayload?.zoom}-${activeLocation.locationPayload?.bearing}-${activeLocation.locationPayload?.pitch}-${activeLocation.locationPayload?.transition}-${activeLocation.locationPayload?.color}-${JSON.stringify(activeLocation.locationPayload?.center)}` : null;

    if (locKey !== lastActiveLocationId.current) {
      lastActiveLocationId.current = locKey;

      if (activeLocation && activeLocation.locationPayload) {
        const loc = activeLocation.locationPayload;
        const transition = loc.transition || "fly";
        
        // Calculate transition duration
        // Prefer explicit transitionMS, otherwise default to 2000ms or remaining clip duration
        const clipMs = (activeLocation.durationFrames / project.fps) * 1000;
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
            // Enforce absolute bearing from payload
            map.current.easeTo(options);
            break;
          case "tilt":
            // Enforce absolute pitch from payload
            map.current.easeTo(options);
            break;
          case "zoom_in":
            map.current.flyTo({ ...options, zoom: loc.zoom + 1 });
            break;
          case "zoom_out":
            map.current.flyTo({ ...options, zoom: loc.zoom - 1 });
            break;
          case "fit_bounds":
            if (loc.geojson && loc.geojson.type === "Feature") {
               // Simple bounding box calculation if possible, or just fly to the defined zoom
               map.current.flyTo(options);
            } else {
               map.current.flyTo(options);
            }
            break;
          case "fly":
          default:
            map.current.flyTo(options);
            break;
        }

        if (map.current.isStyleLoaded()) {
          const source = map.current.getSource("city-area") as maplibregl.GeoJSONSource;
          if (source) {
            source.setData({
              type: "Feature",
              properties: { color: loc.color || "#f97316" },
              geometry: loc.geojson || { type: "Point", coordinates: loc.center },
            });
          }
        }
      } else if (!activeLocation && map.current.isStyleLoaded()) {
        const source = map.current.getSource("city-area") as maplibregl.GeoJSONSource;
        if (source) source.setData({ type: "FeatureCollection", features: [] });
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

    let startFrame = Math.floor(dropX / PIXELS_PER_FRAME);
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

      let newStart = origStart + Math.round(deltaX / PIXELS_PER_FRAME);
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
  }, [draggingElementId]);


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

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Backspace" || e.key === "Delete") {
        if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") {
            return;
        }
        deleteActiveElement();
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [deleteActiveElement]);

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
    let frame = Math.floor(x / PIXELS_PER_FRAME);
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
          <div className="absolute top-4 left-6 z-10 flex gap-4">
            <div className="bg-zinc-950/80 px-3 py-1 rounded border border-zinc-700 text-[10px] font-mono shadow-xl text-zinc-400">
              {project.width}x{project.height} @ {project.fps}FPS
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
                        <div className="text-[8px] text-zinc-500 mb-2">HIGHLIGHT COLOR</div>
                        <div className="flex gap-3 items-center">
                          <input
                            type="color"
                            value={activeElement.locationPayload.color}
                            onChange={(e) => updateActivePayload({ color: e.target.value })}
                            className="w-10 h-6 bg-transparent border-none cursor-pointer"
                          />
                          <span className="text-xs font-mono">
                            {activeElement.locationPayload.color?.toUpperCase()}
                          </span>
                        </div>
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
            <div className="text-[10px] font-mono text-zinc-500">
              [ {currentFrame} / {project.durationFrames} ]
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
            className="sticky top-0 h-6 bg-zinc-950/80 border-b border-zinc-800 z-10 cursor-col-resize"
            onMouseDown={handleTimelineHeaderMouseDown}
          >
            {/* Draw some ticks in background using inline css or just simple grid */}
            <div
              className="absolute inset-0 opacity-20 pointer-events-none"
              style={{ backgroundImage: `linear-gradient(to right, #ffffff 1px, transparent 1px)`, backgroundSize: `${project.fps * PIXELS_PER_FRAME}px 100%` }}
            />
          </div>

          {/* Tracks Container */}
          <div className="relative pt-2" style={{ width: Math.max(project.durationFrames * PIXELS_PER_FRAME, window.innerWidth), height: TRACK_COUNT * TRACK_HEIGHT }}>
            {/* Playhead Line */}
            <div
              className="absolute top-0 bottom-0 w-[1px] bg-red-500 z-20 pointer-events-none"
              style={{ left: currentFrame * PIXELS_PER_FRAME }}
            >
              <div className="absolute top-[-24px] left-[-4px] w-0 h-0 border-l-[4px] border-r-[4px] border-t-[6px] border-transparent border-t-red-500" />
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
              const left = el.startFrame * PIXELS_PER_FRAME;
              const width = el.durationFrames * PIXELS_PER_FRAME;
              const top = el.trackIndex * TRACK_HEIGHT + 4; // 4px padding

              const baseColor = el.type === "location" ? "border-orange-500/50 bg-orange-500/10" : "border-indigo-500/50 bg-indigo-500/10";
              const selColor = el.type === "location" ? "border-orange-400 bg-orange-500/30" : "border-indigo-400 bg-indigo-500/30";

              return (
                <div
                  key={el.id}
                  onMouseDown={(e) => handleBlockMouseDown(e, el.id)}
                  className={`absolute h-[52px] border rounded text-[10px] p-2 overflow-hidden cursor-grab active:cursor-grabbing hover:brightness-125 transition-colors z-10 
                          ${isSelected ? selColor : baseColor}
                       `}
                  style={{ left, width, top }}
                >
                  <div className={`font-bold truncate ${el.type === "location" ? "text-orange-400" : "text-indigo-400"}`}>
                    {el.name}
                  </div>
                  {el.type === "effect_detail" && el.effectPayload && (
                    <div className="text-[8px] text-zinc-400 mt-1">Detail: {el.effectPayload.detailLevel}%</div>
                  )}
                  {el.type === "location" && el.locationPayload && (
                    <div className="mt-1 flex w-full h-1 bg-black/40 rounded-full overflow-hidden">
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
