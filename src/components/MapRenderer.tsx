import React, { useEffect, useRef, useState, useCallback } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { ProjectSettings, TimelineElement } from "../types";
import { loadRenderData } from "../db";
import {
  applyDeterministicTimelineFrameToMap,
  applyTimelineFrameToMap,
  createMapPlaybackCache,
} from "../lib/mapPlayback";

const NATIVE_RENDER_SERVER = "http://127.0.0.1:3030";

const RENDER_MAP_OPTIONS: Partial<maplibregl.MapOptions> = {
  fadeDuration: 0,
  refreshExpiredTiles: false,
  canvasContextAttributes: {
    antialias: false,
    preserveDrawingBuffer: true,
    powerPreference: "high-performance",
    desynchronized: true,
  },
};

type NativeRenderStatus = {
  checked: boolean;
  available: boolean;
  encoder?: string;
  error?: string;
};

const MapRenderer: React.FC = () => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Initializing...");
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [isTabHidden, setIsTabHidden] = useState(false);
  const [nativeRenderStatus, setNativeRenderStatus] = useState<NativeRenderStatus>({
    checked: false,
    available: false,
  });
  const projectRef = useRef<ProjectSettings | null>(null);
  const timelineElementsRef = useRef<TimelineElement[]>([]);
  const playbackCacheRef = useRef(createMapPlaybackCache());
  const renderRafRef = useRef<number | null>(null);
  const bufferTimeoutRef = useRef<number | null>(null);
  const renderSessionRef = useRef(0);
  const isRenderingRef = useRef(false);

  useEffect(() => {
    const handleVisibility = () => setIsTabHidden(document.hidden);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 1500);

    fetch(`${NATIVE_RENDER_SERVER}/health`, { signal: controller.signal })
      .then(async (response) => {
        const data = (await response.json()) as {
          available?: boolean;
          preferredEncoder?: string;
          error?: string;
        };

        setNativeRenderStatus({
          checked: true,
          available: response.ok && data.available === true,
          encoder: data.preferredEncoder,
          error: response.ok ? undefined : data.error,
        });
      })
      .catch((err) => {
        setNativeRenderStatus({
          checked: true,
          available: false,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        window.clearTimeout(timeoutId);
      });

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, []);

  const updateMapState = useCallback((frameIndex: number) => {
    const currentProject = projectRef.current;
    if (!map.current || !currentProject) return;

    applyTimelineFrameToMap({
      map: map.current,
      frameIndex,
      timelineElements: timelineElementsRef.current,
      fps: currentProject.fps,
      cache: playbackCacheRef.current,
    });
  }, []);

  const playTimelinePass = useCallback(
    (sessionId: number, onFrame?: (progressValue: number) => void) => {
      const currentProject = projectRef.current;
      if (!currentProject) {
        return Promise.reject(new Error("Render project is not loaded."));
      }

      playbackCacheRef.current = createMapPlaybackCache();

      return new Promise<void>((resolve, reject) => {
        let lastTime = performance.now();
        let currentFrame = currentProject.startFrame;
        const msPerFrame = 1000 / currentProject.fps;
        const totalFrames = Math.max(1, currentProject.endFrame - currentProject.startFrame);

        updateMapState(currentFrame);
        onFrame?.(currentProject.startFrame >= currentProject.endFrame ? 100 : 0);

        const loop = (time: number) => {
          if (renderSessionRef.current !== sessionId) {
            reject(new Error("Render session was interrupted."));
            return;
          }

          const delta = time - lastTime;
          if (delta >= msPerFrame) {
            if (currentFrame >= currentProject.endFrame) {
              onFrame?.(100);
              resolve();
              return;
            }

            currentFrame++;
            updateMapState(currentFrame);
            const done = currentFrame - currentProject.startFrame;
            onFrame?.(Math.max(0, Math.min(100, (done / totalFrames) * 100)));
            lastTime = time - (delta % msPerFrame);
          }

          renderRafRef.current = requestAnimationFrame(loop);
        };

        renderRafRef.current = requestAnimationFrame(loop);
      });
    },
    [updateMapState]
  );

  const waitForMapSettled = useCallback((mapInstance: maplibregl.Map) => {
    return new Promise<void>((resolve) => {
      let finished = false;
      let rafOne = 0;
      let rafTwo = 0;
      let timeoutId = 0;

      const finish = () => {
        if (finished) return;
        finished = true;
        window.clearTimeout(timeoutId);
        cancelAnimationFrame(rafOne);
        cancelAnimationFrame(rafTwo);
        resolve();
      };

      const settleAfterPaint = () => {
        rafOne = requestAnimationFrame(() => {
          rafTwo = requestAnimationFrame(finish);
        });
      };

      timeoutId = window.setTimeout(finish, 1500);

      if (mapInstance.areTilesLoaded() && mapInstance.loaded()) {
        settleAfterPaint();
        return;
      }

      mapInstance.once("idle", settleAfterPaint);
      mapInstance.triggerRepaint();
    });
  }, []);

  const canvasToBlob = useCallback((canvas: HTMLCanvasElement) => {
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("Canvas export failed."));
          return;
        }
        resolve(blob);
      }, "image/png");
    });
  }, []);

  const uploadFramesToNativeRenderer = useCallback(
    async (sessionId: number, currentProject: ProjectSettings) => {
      if (!map.current) {
        throw new Error("Map is not ready for native rendering.");
      }

      setStatus("Preparing Native FFmpeg Render...");

      const startResponse = await fetch(`${NATIVE_RENDER_SERVER}/api/render/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fps: currentProject.fps,
          width: currentProject.width,
          height: currentProject.height,
        }),
      });

      const startData = (await startResponse.json()) as {
        jobId?: string;
        encoder?: string;
        error?: string;
      };

      if (!startResponse.ok || !startData.jobId) {
        throw new Error(startData.error || "Failed to start native render job.");
      }

      const { jobId } = startData;

      setStatus("Warmup Pass 1/2...");
      await playTimelinePass(sessionId);
      if (renderSessionRef.current !== sessionId) return;

      setStatus("Warmup Pass 2/2...");
      await playTimelinePass(sessionId);
      if (renderSessionRef.current !== sessionId) return;

      setStatus(`FFmpeg Pass 3/3 (${startData.encoder || "ffmpeg"})...`);
      setProgress(0);
      playbackCacheRef.current = createMapPlaybackCache();

      const totalFrames = currentProject.endFrame - currentProject.startFrame + 1;

      for (let index = 0; index < totalFrames; index++) {
        if (renderSessionRef.current !== sessionId) {
          throw new Error("Render session was interrupted.");
        }

        const frameNumber = currentProject.startFrame + index;
        applyDeterministicTimelineFrameToMap({
          map: map.current,
          frameIndex: frameNumber,
          timelineElements: timelineElementsRef.current,
          fps: currentProject.fps,
          cache: playbackCacheRef.current,
        });

        await waitForMapSettled(map.current);

        const frameBlob = await canvasToBlob(map.current.getCanvas());
        const frameResponse = await fetch(
          `${NATIVE_RENDER_SERVER}/api/render/frame?jobId=${encodeURIComponent(jobId)}&frame=${frameNumber}`,
          {
            method: "POST",
            headers: { "Content-Type": "image/png" },
            body: frameBlob,
          }
        );

        if (!frameResponse.ok) {
          const frameData = (await frameResponse.json()) as { error?: string };
          throw new Error(frameData.error || `Failed to upload frame ${frameNumber}.`);
        }

        setProgress(((index + 1) / totalFrames) * 100);
      }

      setStatus("Encoding Video...");
      const finishResponse = await fetch(
        `${NATIVE_RENDER_SERVER}/api/render/finish?jobId=${encodeURIComponent(jobId)}`,
        { method: "POST" }
      );
      const finishData = (await finishResponse.json()) as {
        downloadUrl?: string;
        encoder?: string;
        error?: string;
      };

      if (!finishResponse.ok || !finishData.downloadUrl) {
        throw new Error(finishData.error || "Native render encoding failed.");
      }

      setDownloadUrl(finishData.downloadUrl);
      setStatus(`Completed (${finishData.encoder || "ffmpeg"})!`);
      setProgress(100);

      const link = document.createElement("a");
      link.href = finishData.downloadUrl;
      link.download = `mappa-render-${Date.now()}.mp4`;
      link.click();
    },
    [canvasToBlob, playTimelinePass, waitForMapSettled]
  );

  const runBrowserRecorderCapture = useCallback(
    async (sessionId: number, currentProject: ProjectSettings) => {
      if (!map.current) {
        throw new Error("Map is not ready for browser capture.");
      }

      setStatus("Warmup Pass 1/2...");
      await playTimelinePass(sessionId);
      if (renderSessionRef.current !== sessionId) return;

      setStatus("Warmup Pass 2/2...");
      await playTimelinePass(sessionId);
      if (renderSessionRef.current !== sessionId) return;

      setStatus("Recording Pass 3/3...");
      setProgress(0);

      const canvas = map.current.getCanvas();
      const stream = canvas.captureStream(currentProject.fps);
      let mimeType = "video/mp4";
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = "video/webm";
      }

      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12000000 });
      const chunks: Blob[] = [];

      await new Promise<void>((resolve, reject) => {
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            chunks.push(e.data);
          }
        };

        recorder.onerror = () => {
          reject(new Error("Browser recording failed."));
        };

        recorder.onstop = () => {
          if (renderSessionRef.current !== sessionId) {
            resolve();
            return;
          }

          if (chunks.length === 0) {
            reject(
              new Error(
                "Render failed: No video data captured. Ensure the tab stays focused and the map is visible."
              )
            );
            return;
          }

          const blob = new Blob(chunks, { type: mimeType });
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = `mappa-render-${Date.now()}.${mimeType.includes("mp4") ? "mp4" : "webm"}`;
          link.click();
          setDownloadUrl(url);
          setStatus("Completed!");
          setProgress(100);
          resolve();
        };

        recorder.start();
        playTimelinePass(sessionId, (progressValue) => setProgress(progressValue))
          .then(() => {
            if (renderSessionRef.current === sessionId) {
              recorder.stop();
            } else {
              resolve();
            }
          })
          .catch(reject);
      });
    },
    [playTimelinePass]
  );

  const startRenderProcess = useCallback(() => {
    const currentProject = projectRef.current;
    if (!map.current || !currentProject || isRenderingRef.current) return;

    if (bufferTimeoutRef.current !== null) {
      window.clearTimeout(bufferTimeoutRef.current);
      bufferTimeoutRef.current = null;
    }

    isRenderingRef.current = true;
    renderSessionRef.current += 1;
    const sessionId = renderSessionRef.current;
    setError(null);
    setProgress(0);
    setDownloadUrl(null);

    const run = async () => {
      try {
        if (nativeRenderStatus.available) {
          await uploadFramesToNativeRenderer(sessionId, currentProject);
        } else {
          await runBrowserRecorderCapture(sessionId, currentProject);
        }
      } catch (err) {
        if (renderSessionRef.current !== sessionId) return;
        setError(`Renderer failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (renderSessionRef.current === sessionId) {
          isRenderingRef.current = false;
          if (renderRafRef.current !== null) {
            cancelAnimationFrame(renderRafRef.current);
            renderRafRef.current = null;
          }
        }
      }
    };

    void run();
  }, [nativeRenderStatus.available, runBrowserRecorderCapture, uploadFramesToNativeRenderer]);

  useEffect(() => {
    let cancelled = false;
    let initializedMap: maplibregl.Map | null = null;

    const initRenderer = async () => {
      let renderData: { project: ProjectSettings; timelineElements: TimelineElement[] } | null = null;

      try {
        renderData = await loadRenderData();
      } catch (err) {
        if (!cancelled) {
          setError(`Failed to load render data: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      if (cancelled) return;
      if (!renderData?.project) {
        setError("No render data found in IndexedDB. Please launch from the MapEditor.");
        return;
      }

      projectRef.current = renderData.project;
      timelineElementsRef.current = renderData.timelineElements;

      if (!mapContainer.current) return;
      const m = new maplibregl.Map({
        container: mapContainer.current,
        style: "https://tiles.openfreemap.org/styles/positron",
        center: [0, 20],
        zoom: 1.5,
        ...RENDER_MAP_OPTIONS,
        interactive: false,
        pixelRatio: 1,
      } as maplibregl.MapOptions);
      initializedMap = m;
      map.current = m;

      m.on("load", () => {
        if (cancelled) return;

        m.addSource("city-area", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        m.addLayer({
          id: "city-area-fill",
          type: "fill",
          source: "city-area",
          paint: { "fill-color": ["get", "color"], "fill-opacity": ["coalesce", ["get", "opacity"], 0.4] },
        });

        m.resize();
        setStatus("Buffering Map...");
        bufferTimeoutRef.current = window.setTimeout(() => {
          bufferTimeoutRef.current = null;
          startRenderProcess();
        }, 2000);
      });
    };

    void initRenderer();

    return () => {
      cancelled = true;
      renderSessionRef.current += 1;
      if (bufferTimeoutRef.current !== null) {
        window.clearTimeout(bufferTimeoutRef.current);
        bufferTimeoutRef.current = null;
      }
      if (renderRafRef.current !== null) {
        cancelAnimationFrame(renderRafRef.current);
        renderRafRef.current = null;
      }
      isRenderingRef.current = false;
      initializedMap?.remove();
    };
  }, [startRenderProcess]);

  if (error) {
    return (
      <div className="h-screen w-screen bg-black text-red-500 font-mono p-8 text-center flex flex-col justify-center items-center">
        <div>{error}</div>
        <button onClick={() => window.close()} className="mt-4 px-4 py-2 bg-zinc-800 text-white rounded hover:bg-zinc-700 transition-colors">Close Tab</button>
      </div>
    );
  }

  const width = projectRef.current?.width ?? 1920;
  const height = projectRef.current?.height ?? 1080;
  const renderEngineLabel = nativeRenderStatus.available
    ? `Native FFmpeg${nativeRenderStatus.encoder ? ` (${nativeRenderStatus.encoder})` : ""}`
    : "Browser Capture";

  return (
    <div className="flex flex-col h-screen w-screen bg-black text-white font-sans overflow-hidden">
      <div className="absolute inset-0 z-50 pointer-events-none flex flex-col justify-between p-8">
         <div className="flex justify-between items-start">
             <div>
                <h1 className="text-xl font-bold tracking-widest text-orange-500 mb-2 drop-shadow-md uppercase">Mappa Renderer Engine</h1>
                <div className="text-sm font-mono text-zinc-300 bg-black/50 px-3 py-1 rounded inline-block backdrop-blur-sm border border-zinc-800">
                    Resolution: {width}x{height}
                </div>
                <div className="mt-2 text-[11px] font-mono text-zinc-400 bg-black/40 px-3 py-1 rounded inline-block border border-zinc-800">
                  Engine: {renderEngineLabel}
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
                    download={`mappa-render-${Date.now()}.${downloadUrl.endsWith(".mp4") ? "mp4" : "webm"}`}
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
            {!nativeRenderStatus.available && nativeRenderStatus.checked && (
              <div className="mb-2 text-center text-[10px] text-zinc-400 bg-black/40 py-1 border border-zinc-800 rounded backdrop-blur-sm">
                Native FFmpeg server unavailable. Run <code className="font-mono">npm run render-server</code> after installing FFmpeg to enable deterministic rendering.
              </div>
            )}
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

      <div className="absolute inset-0 flex items-center justify-center opacity-80 pointer-events-none">
          <div style={{ width, height, transform: "scale(0.8)", transformOrigin: "center" }}>
             <div ref={mapContainer} style={{ width: "100%", height: "100%" }} />
          </div>
      </div>
    </div>
  );
};

export default MapRenderer;
