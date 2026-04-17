import React, { useEffect, useRef, useState, useCallback } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { ProjectSettings, TimelineElement } from "../types";

const MapRenderer: React.FC = () => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Initializing...");
  const lastActiveLocationId = useRef<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [isTabHidden, setIsTabHidden] = useState(false);

  const [project, setProject] = useState<ProjectSettings | null>(null);
  const [timelineElements, setTimelineElements] = useState<TimelineElement[]>([]);

  useEffect(() => {
    const handleVisibility = () => setIsTabHidden(document.hidden);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  const updateMapState = useCallback((frameIndex: number) => {
    if (!map.current || !project) return;
    
    const activeElements = timelineElements.filter(
      (el) => frameIndex >= el.startFrame && frameIndex < el.startFrame + el.durationFrames
    );

    const activeLocations = activeElements.filter((el) => el.type === "location");
    const activeEffect = activeElements
      .filter((el) => el.type === "effect_detail")
      .sort((a, b) => b.trackIndex - a.trackIndex)[0];
    
    const startingLocations = activeLocations
      .filter(el => el.startFrame === frameIndex)
      .sort((a, b) => b.trackIndex - a.trackIndex);
    
    const topActiveLocation = activeLocations
      .sort((a, b) => b.trackIndex - a.trackIndex)[0];

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
          case "jump": map.current.jumpTo({ center: loc.center, zoom: loc.zoom, bearing: loc.bearing || 0, pitch: loc.pitch || 0 }); break;
          case "pan": map.current.panTo(loc.center as any, { duration, essential: true }); break;
          case "zoom_in": map.current.flyTo({ ...options, zoom: loc.zoom + 1 }); break;
          case "zoom_out": map.current.flyTo({ ...options, zoom: loc.zoom - 1 }); break;
          case "ease": map.current.easeTo(options); break;
          case "rotate": map.current.easeTo(options); break;
          case "tilt": map.current.easeTo(options); break;
          case "fit_bounds": map.current.flyTo(options); break;
          case "fly":
          default: map.current.flyTo(options); break;
        }
      }
    }

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
             const frameIn = frameIndex - el.startFrame;
             const frameOut = (el.startFrame + el.durationFrames) - frameIndex;
             
             if (fi > 0 && frameIn < fi) alpha = 0.4 * (frameIn / fi);
             else if (fo > 0 && frameOut <= fo) alpha = 0.4 * (frameOut / fo);
          }
          
          return {
            type: "Feature",
            properties: { color: loc?.color || "#f97316", opacity: alpha },
            geometry: loc?.geojson || { type: "Point", coordinates: loc?.center },
          };
        });
        
        source.setData({ type: "FeatureCollection", features: features as any });
      }

      // Layer visibility
      const detailLevel = activeEffect?.effectPayload?.detailLevel ?? 100;
      const style = map.current.getStyle();
      if (style && style.layers) {
        style.layers.forEach((layer) => {
          const isLabel = layer.id.includes("label") || layer.id.includes("place");
          const isTransit = layer.id.includes("rail") || layer.id.includes("transit") || layer.id.includes("airport");
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
  }, [project, timelineElements]);

  const startRenderProcess = useCallback(() => {
    if (!map.current || !project) return;
    setStatus("Recording...");

    try {
      const canvas = map.current.getCanvas();
      const stream = (canvas as any).captureStream(project.fps);
      let mimeType = "video/mp4";
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = "video/webm";
        console.log("Renderer: MP4 not supported, falling back to WebM");
      }

      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12000000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => { 
        if (e.data.size > 0) chunks.push(e.data); 
      };
      
      recorder.onstop = () => {
        console.log("Renderer: Recording stopped, final chunks count:", chunks.length);
        if (chunks.length === 0) {
          setError("Render failed: No video data captured. Ensure the tab stays focused and the map is visible.");
          return;
        }
        setStatus("Encoding Video...");
        const blob = new Blob(chunks, { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `mappa-render-${Date.now()}.${mimeType.includes("mp4") ? "mp4" : "webm"}`;
        a.click();
        setDownloadUrl(url); 
        setStatus("Completed!");
        setProgress(100);
        console.log("Renderer: Render complete, download triggered");
      };

      console.log("Renderer: Starting recorder...");
      recorder.start();

      // Playback loop
      let lastTime = performance.now();
      let currentFrame = project.startFrame;
      const msPerFrame = 1000 / project.fps;

      // Immediately push first frame state
      updateMapState(currentFrame);

      const loop = (time: number) => {
        const delta = time - lastTime;
        if (delta >= msPerFrame) {
          currentFrame++;
          updateMapState(currentFrame);
          
          const total = project.endFrame - project.startFrame + 1;
          const done = currentFrame - project.startFrame;
          setProgress(Math.max(0, Math.min(100, (done / total) * 100)));

          if (currentFrame > project.endFrame) {
            recorder.stop();
            return;
          }
          lastTime = time - (delta % msPerFrame);
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    } catch (err) {
      console.error("Renderer: Failed to start recording", err);
      setError(`Renderer failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [project, updateMapState]);

  useEffect(() => {
    // 1. Load Data
    const rawData = localStorage.getItem("mappa-render-data");
    if (!rawData) {
      setError("No render data found in localStorage. Please launch from the MapEditor.");
      return;
    }

    let parsedData: { project: ProjectSettings; timelineElements: TimelineElement[] } | null = null;
    try {
      parsedData = JSON.parse(rawData);
    } catch (e) {
      setError("Failed to parse render data.");
      return;
    }

    if (!parsedData || !parsedData.project) {
      setError("Parsed data is invalid.");
      return;
    }
    
    const p = parsedData.project;
    const t = parsedData.timelineElements;
    setProject(p);
    setTimelineElements(t);

    // 2. Init barebones MAP
    if (!mapContainer.current) return;
    const m = new maplibregl.Map({
      container: mapContainer.current,
      style: "https://tiles.openfreemap.org/styles/positron",
      center: [0, 20],
      zoom: 1.5,
      preserveDrawingBuffer: true,
      pixelRatio: 1, // exact 1:1 render
      interactive: false, 
    });
    map.current = m;

    m.on("load", () => {
      m.addSource("city-area", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({
        id: "city-area-fill",
        type: "fill",
        source: "city-area",
        paint: { "fill-color": ["get", "color"], "fill-opacity": ["coalesce", ["get", "opacity"], 0.4] },
      });

      m.resize();
      
      console.log("Renderer: Map loaded, starting buffer timer...");
      setStatus("Buffering Map...");
      setTimeout(() => {
        console.log("Renderer: Buffer finished, starting render process");
        // We use a small timeout to ensure state has propagated
        startRenderProcess();
      }, 2000);
    });

    return () => {
      m.remove();
    };
  }, [startRenderProcess]); // Depend on startRenderProcess which depends on project

  if (error) {
    return (
      <div className="h-screen w-screen bg-black text-red-500 font-mono p-8 text-center flex flex-col justify-center items-center">
        <div>{error}</div>
        <button onClick={() => window.close()} className="mt-4 px-4 py-2 bg-zinc-800 text-white rounded hover:bg-zinc-700 transition-colors">Close Tab</button>
      </div>
    );
  }

  // Use local storage values for width/height directly in the HUD if project state hasn't updated yet
  let width = 1920;
  let height = 1080;
  try {
    const rawData = localStorage.getItem("mappa-render-data");
    if (rawData) {
      const p = JSON.parse(rawData).project;
      if (p) { width = p.width; height = p.height; }
    }
  } catch(e) {}

  return (
    <div className="flex flex-col h-screen w-screen bg-black text-white font-sans overflow-hidden">
      {/* HUD OVERLAY */}
      <div className="absolute inset-0 z-50 pointer-events-none flex flex-col justify-between p-8">
         <div className="flex justify-between items-start">
             <div>
                <h1 className="text-xl font-bold tracking-widest text-orange-500 mb-2 drop-shadow-md uppercase">Mappa Renderer Engine</h1>
                <div className="text-sm font-mono text-zinc-300 bg-black/50 px-3 py-1 rounded inline-block backdrop-blur-sm border border-zinc-800">
                    Resolution: {width}x{height}
                </div>
             </div>
             <div className="text-right">
                <div className="text-2xl font-mono tracking-wider drop-shadow-md">
                   {Math.round(progress)}%
                </div>
                <div className="text-xs text-orange-400 font-bold uppercase tracking-widest animate-pulse mt-1 drop-shadow-md">
                   {status}
                </div>
                {downloadUrl && (
                  <a 
                    href={downloadUrl} 
                    download={`mappa-render-${Date.now()}.webm`}
                    className="mt-2 inline-block px-4 py-1 bg-orange-500 text-black text-[10px] font-bold rounded hover:bg-white pointer-events-auto"
                  >
                    DOWNLOAD MANUALLY
                  </a>
                )}
                {!downloadUrl && status.includes("Buffering") && (
                   <button 
                     onClick={startRenderProcess}
                     className="mt-2 block px-3 py-1 bg-zinc-800 text-[9px] font-bold border border-zinc-700 rounded hover:bg-zinc-700 pointer-events-auto shadow-lg"
                   >
                     SKIP BUFFER & START
                   </button>
                )}
             </div>
         </div>
         
         <div className="w-full">
            {isTabHidden && progress < 100 && (
               <div className="mb-2 text-center text-xs font-bold text-red-500 bg-red-500/10 py-1 border border-red-500/50 rounded animate-bounce shadow-lg backdrop-blur-sm">
                  WARNING: TAB IS HIDDEN. RENDERING MAY BE PAUSED BY BROWSER.
               </div>
            )}
            <div className="h-1 lg:h-2 w-full bg-zinc-900 rounded-full overflow-hidden border border-zinc-800 shadow-xl">
               <div className="h-full bg-orange-500 transition-all duration-300" style={{ width: `${progress}%` }} />
            </div>
         </div>
      </div>

      {/* MAP CANVAS SCALED TO FIT VIEWPORT WHILE HOLDING NATIVE RESOLUTION */}
      <div className="absolute inset-0 flex items-center justify-center opacity-80 pointer-events-none">
          <div style={{ width, height, transform: 'scale(0.8)', transformOrigin: 'center' }}>
             <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
          </div>
      </div>
    </div>
  );
};

export default MapRenderer;
