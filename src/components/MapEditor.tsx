import React, { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

/**
 * TYPES & INTERFACES
 */
interface MapLocation {
  id: string;
  name: string;
  center: [number, number];
  zoom: number;
  type: string;
  display_name: string;
  color: string;
  detail: number; // Controls layer visibility (0-100)
  geojson?: any;
}

const MapEditor: React.FC = () => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MapLocation[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [timelineItems, setTimelineItems] = useState<MapLocation[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  /**
   * 1. INITIALIZE VECTOR MAP
   */
  useEffect(() => {
    if (map.current || !mapContainer.current) return;

    // Using OpenFreeMap (Vector Tiles) - No API Key required for demo
    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: "https://tiles.openfreemap.org/styles/positron", // A clean vector style
      center: [0, 20],
      zoom: 1.5,
      antialias: true,
    });

    map.current.on("load", () => {
      if (!map.current) return;

      // Add our custom city-highlight source
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

  /**
   * 2. LAYER VISIBILITY LOGIC
   * We filter layers based on the 'detail' slider
   */
  const syncLayerDetail = (detail: number) => {
    if (!map.current) return;
    const style = map.current.getStyle();
    if (!style || !style.layers) return;

    style.layers.forEach((layer) => {
      // Define what constitutes "extra detail" based on common layer naming
      const isLabel = layer.id.includes("label") || layer.id.includes("place");
      const isTransit =
        layer.id.includes("rail") ||
        layer.id.includes("transit") ||
        layer.id.includes("airport");
      const isSmallRoad =
        layer.id.includes("road") && !layer.id.includes("motorway");
      const isBuilding = layer.id.includes("building");

      let visible = "visible";

      // Logic Gates for detail level
      if (detail < 30) {
        // LOW DETAIL: Hide almost everything but land/water
        if (isLabel || isTransit || isSmallRoad || isBuilding) visible = "none";
      } else if (detail < 70) {
        // MID DETAIL: Hide small streets and buildings
        if (isSmallRoad || isBuilding) visible = "none";
      }

      map.current?.setLayoutProperty(layer.id, "visibility", visible);
    });
  };

  /**
   * 3. SEARCH & SYNC
   */
  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);

    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&limit=5&polygon_geojson=1`,
      );
      const data = await response.json();

      const formatted: MapLocation[] = data.map((item: any) => ({
        id: item.place_id.toString() + Math.random(),
        name: item.display_name.split(",")[0],
        display_name: item.display_name,
        center: [parseFloat(item.lon), parseFloat(item.lat)],
        zoom: ["city", "town", "village", "suburb"].includes(item.type)
          ? 12
          : 5,
        type: item.type,
        color: "#f97316",
        detail: 100, // Default to max detail
        geojson: item.geojson,
      }));

      setSearchResults(formatted);
    } catch (err) {
      console.error("Search failed:", err);
    } finally {
      setIsSearching(false);
    }
  };

  const focusLocation = (loc: MapLocation, index: number) => {
    setActiveIndex(index);
    map.current?.flyTo({ center: loc.center, zoom: loc.zoom, duration: 2000 });

    // Update city boundary
    if (map.current?.isStyleLoaded()) {
      const source = map.current.getSource(
        "city-area",
      ) as maplibregl.GeoJSONSource;
      if (source) {
        source.setData({
          type: "Feature",
          properties: { color: loc.color },
          geometry: loc.geojson || { type: "Point", coordinates: loc.center },
        });
      }
      syncLayerDetail(loc.detail);
    }
  };

  const updateActiveClip = (updates: Partial<MapLocation>) => {
    if (activeIndex === null) return;
    const updatedItems = [...timelineItems];
    const newItem = { ...updatedItems[activeIndex], ...updates };
    updatedItems[activeIndex] = newItem;
    setTimelineItems(updatedItems);

    if (updates.detail !== undefined) syncLayerDetail(updates.detail);
    if (updates.zoom !== undefined) map.current?.setZoom(updates.zoom);
    if (updates.color) {
      const source = map.current?.getSource(
        "city-area",
      ) as maplibregl.GeoJSONSource;
      if (source)
        source.setData({
          type: "Feature",
          properties: { color: updates.color },
          geometry: newItem.geojson,
        });
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const data = e.dataTransfer.getData("application/json");
    if (data) {
      const loc = JSON.parse(data) as MapLocation;
      setTimelineItems((prev) => [...prev, loc]);
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-zinc-950 text-zinc-300 overflow-hidden font-sans">
      <div className="flex flex-1 min-h-0">
        {/* LEFT BAR */}
        <aside className="w-72 border-r border-zinc-800 bg-zinc-900 flex flex-col z-20">
          <div className="p-4 border-b border-zinc-800">
            <h2 className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-4">
              Media Pool
            </h2>
            <div className="flex gap-2">
              <input
                className="flex-1 bg-black/40 border border-zinc-700 rounded px-2 py-1.5 text-xs outline-none focus:border-orange-500"
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              />
              <button
                onClick={handleSearch}
                className="bg-zinc-800 px-3 rounded text-[10px] font-bold"
              >
                FIND
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar">
            {searchResults.map((loc) => (
              <div
                key={loc.id}
                draggable
                onDragStart={(e) =>
                  e.dataTransfer.setData(
                    "application/json",
                    JSON.stringify(loc),
                  )
                }
                className="p-3 bg-zinc-800/50 border border-zinc-700 rounded-md cursor-grab active:cursor-grabbing hover:border-orange-500/50"
              >
                <div className="flex justify-between items-center mb-1">
                  <span className="text-xs font-bold text-zinc-200 truncate">
                    {loc.name}
                  </span>
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
        <main className="flex-1 relative bg-zinc-900 overflow-hidden">
          <div ref={mapContainer} className="absolute inset-0 w-full h-full" />
          <div className="absolute top-4 left-4 z-10 bg-zinc-950/80 px-3 py-1 rounded border border-zinc-700 text-[10px] font-mono">
            {activeIndex !== null
              ? `DATA_DENSITY: ${timelineItems[activeIndex].detail}%`
              : "READY"}
          </div>
        </main>

        {/* RIGHT BAR */}
        <aside className="w-80 border-l border-zinc-800 bg-zinc-900 p-4 z-20">
          <h2 className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-6">
            Inspector
          </h2>
          {activeIndex !== null ? (
            <div className="space-y-6">
              <section>
                <label className="text-[9px] text-orange-500 font-bold block mb-2 uppercase">
                  Map Topology
                </label>
                <div className="bg-black/30 p-3 rounded border border-zinc-800 space-y-4">
                  <div>
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-[8px] text-zinc-500">
                        FEATURE_DETAIL
                      </span>
                      <span className="text-[10px] font-mono text-orange-500">
                        {timelineItems[activeIndex].detail < 33
                          ? "LOW"
                          : timelineItems[activeIndex].detail < 66
                            ? "MID"
                            : "HIGH"}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="1"
                      value={timelineItems[activeIndex].detail}
                      onChange={(e) =>
                        updateActiveClip({ detail: parseInt(e.target.value) })
                      }
                      className="w-full h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-orange-500"
                    />
                    <div className="flex justify-between mt-1 text-[7px] text-zinc-600 font-mono">
                      <span>MINIMAL</span>
                      <span>HYBRID</span>
                      <span>COMPLEX</span>
                    </div>
                  </div>

                  <div>
                    <div className="text-[8px] text-zinc-500 mb-2">
                      HIGHLIGHT_COLOR
                    </div>
                    <div className="flex gap-3 items-center">
                      <input
                        type="color"
                        value={timelineItems[activeIndex].color}
                        onChange={(e) =>
                          updateActiveClip({ color: e.target.value })
                        }
                        className="w-10 h-6 bg-transparent border-none cursor-pointer"
                      />
                      <span className="text-xs font-mono">
                        {timelineItems[activeIndex].color.toUpperCase()}
                      </span>
                    </div>
                  </div>
                </div>
              </section>

              <section>
                <label className="text-[9px] text-zinc-500 font-bold block mb-2 uppercase">
                  Camera Settings
                </label>
                <div className="bg-zinc-800 p-3 rounded">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-[8px] text-zinc-500">ZOOM_LEVEL</span>
                    <span className="text-[10px] font-mono text-orange-500">
                      {timelineItems[activeIndex].zoom.toFixed(1)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="20"
                    step="0.1"
                    value={timelineItems[activeIndex].zoom}
                    onChange={(e) =>
                      updateActiveClip({ zoom: parseFloat(e.target.value) })
                    }
                    className="w-full h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-orange-500"
                  />
                </div>
              </section>
            </div>
          ) : (
            <div className="h-40 flex items-center justify-center border border-dashed border-zinc-800 rounded text-[10px] text-zinc-600 uppercase text-center px-10">
              Drag a location to the timeline and select it to begin editing
            </div>
          )}
        </aside>
      </div>

      {/* BOTTOM: Timeline */}
      <footer
        className="h-64 border-t-2 border-zinc-800 bg-zinc-950 flex flex-col z-30"
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
      >
        <div className="h-10 bg-zinc-900 border-b border-zinc-800 flex items-center px-4">
          <div className="flex gap-2 items-center">
            <div className="w-2 h-2 rounded-full bg-orange-600 animate-pulse" />
            <span className="text-[9px] font-bold tracking-[0.2em] text-zinc-400">
              SESSION_LIVE
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-x-auto p-6 flex items-start gap-1 bg-[linear-gradient(to_right,#18181b_1px,transparent_1px)] bg-[size:100px_100%]">
          {timelineItems.map((item, idx) => (
            <div
              key={item.id}
              onClick={() => focusLocation(item, idx)}
              className={`relative flex-shrink-0 w-64 h-24 rounded-sm border-t-4 transition-all cursor-pointer group
                ${activeIndex === idx ? "bg-orange-500/10 border-orange-500 shadow-lg shadow-orange-500/5" : "bg-zinc-900/80 border-zinc-700"}`}
            >
              <div className="p-3">
                <span
                  className={`text-[9px] font-bold ${activeIndex === idx ? "text-orange-400" : "text-zinc-500"}`}
                >
                  CLIP_0{idx + 1}
                </span>
                <div className="text-sm font-medium text-zinc-200 mt-1 truncate">
                  {item.name}
                </div>
                <div className="mt-4 flex h-1.5 w-full bg-black/40 rounded-full overflow-hidden">
                  <div
                    style={{
                      backgroundColor: item.color,
                      width: `${item.detail}%`,
                    }}
                    className="h-full opacity-60 transition-all duration-500"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </footer>
    </div>
  );
};

export default MapEditor;
