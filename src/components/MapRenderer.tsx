import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as pickPath } from "@tauri-apps/plugin-dialog";
import { open as openPath } from "@tauri-apps/plugin-shell";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { loadRenderData } from "../db";
import {
  applyDeterministicTimelineFrameToMap,
  applyTimelineFrameToMap,
  createMapPlaybackCache,
} from "../lib/mapPlayback";
import { createTimelinePreloadKey, preloadTimelineMapResources } from "../lib/mapPreload";
import {
  OPEN_FREEMAP_STYLE_URL,
  createCachedMapTransformRequest,
  installMapResourceCacheProtocol,
} from "../lib/mapResourceCache";
import type { ProjectSettings, TimelineElement } from "../types";
import { 
  Play, 
  Pause, 
  Folder, 
  Trash, 
  Monitor, 
  Clock, 
  FrameCorners, 
  Info, 
  CheckCircle,
  Queue,
  Warning,
  X
} from "@phosphor-icons/react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";
import { cn } from "../lib/utils";
import { TitleBar } from "./layout/TitleBar";

type EncoderId = "libx264" | "h264_nvenc" | "h264_qsv" | "h264_amf";
type QueueStatus = "queued" | "rendering" | "done" | "error";
type RenderPhase = "idle" | "preloading" | "capturing" | "encoding" | "complete" | "error";

interface ExportSettings {
  fileName: string;
  directory: string;
  width: number;
  height: number;
  inFrame: number;
  outFrame: number;
  encoder: EncoderId;
}

interface QueueItem extends ExportSettings {
  id: string;
  fps: number;
  createdAt: string;
  status: QueueStatus;
  progress: number;
  statusText: string;
  resultPath?: string;
  error?: string;
}

interface RenderStatus {
  phase: RenderPhase;
  title: string;
  detail: string;
  progress: number;
  renderedFrames: number;
  totalFrames: number;
}

const RENDER_MAP_OPTIONS: Partial<maplibregl.MapOptions> = {
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

const ENCODERS: Array<{ id: EncoderId; label: string; note: string }> = [
  { id: "libx264", label: "H.264 Software", note: "Most compatible" },
  { id: "h264_nvenc", label: "NVIDIA NVENC", note: "NVIDIA GPUs" },
  { id: "h264_qsv", label: "Intel Quick Sync", note: "Intel iGPUs / CPUs" },
  { id: "h264_amf", label: "AMD AMF", note: "AMD GPUs" },
];

const EMPTY_STATUS: RenderStatus = {
  phase: "idle",
  title: "Ready to export",
  detail: "Load a queued job or configure a new export.",
  progress: 0,
  renderedFrames: 0,
  totalFrames: 0,
};
const MAP_TRANSFORM_REQUEST = createCachedMapTransformRequest();

installMapResourceCacheProtocol();

const isTauriDesktop = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const waitForAnimationFrames = (count = 1) =>
  new Promise<void>((resolve) => {
    const step = (remaining: number) => {
      if (remaining <= 0) {
        resolve();
        return;
      }
      window.requestAnimationFrame(() => step(remaining - 1));
    };
    step(count);
  });

const waitForMapSettle = (map: maplibregl.Map, timeoutMs = 1200) =>
  new Promise<void>((resolve) => {
    let finished = false;
    let timer = 0;

    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      map.off("idle", handleIdle);
      resolve();
    };

    const handleIdle = () => finish();
    timer = window.setTimeout(finish, timeoutMs);

    map.once("idle", handleIdle);
    map.triggerRepaint();
  });

const waitForRenderedFrame = (map: maplibregl.Map, timeoutMs = 80) =>
  new Promise<void>((resolve) => {
    let finished = false;
    let timer = 0;

    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      map.off("render", handleRender);
      resolve();
    };

    const handleRender = () => {
      window.requestAnimationFrame(finish);
    };

    timer = window.setTimeout(() => {
      window.requestAnimationFrame(finish);
    }, timeoutMs);

    map.once("render", handleRender);
    map.triggerRepaint();
  });

const waitForExactCanvasSize = async (
  map: maplibregl.Map,
  width: number,
  height: number,
  attempts = 12
) => {
  const container = map.getContainer() as HTMLDivElement | null;
  const wrapper = container?.parentElement as HTMLDivElement | null;

  if (wrapper) {
    wrapper.style.width = `${width}px`;
    wrapper.style.height = `${height}px`;
  }

  if (container) {
    container.style.width = `${width}px`;
    container.style.height = `${height}px`;
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    map.resize();
    map.triggerRepaint();
    await waitForAnimationFrames(2);

    const canvas = map.getCanvas();
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    if (canvas.width === width && canvas.height === height) {
      return;
    }
  }

  const canvas = map.getCanvas();
  throw new Error(
    `Render surface mismatch. Expected ${width}x${height}, got ${canvas.width}x${canvas.height}.`
  );
};

const formatTimecode = (frame: number, fps: number) => {
  const totalSeconds = Math.floor(frame / fps);
  const frames = frame % fps;
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);

  return [hours, minutes, seconds, frames].map((value) => value.toString().padStart(2, "0")).join(":");
};

const sanitizeFileName = (fileName: string) => {
  const trimmed = fileName.trim();
  const withoutControlChars = [...trimmed]
    .filter((character) => character.charCodeAt(0) >= 32)
    .join("");
  const clean = withoutControlChars.replace(/[<>:"/\\|?*]/g, "-").replace(/\.+$/, "");
  return clean || "mappa-export";
};

const getPathSeparator = (directory: string) => {
  if (directory.includes("\\") && !directory.includes("/")) {
    return "\\";
  }
  return "/";
};

const buildOutputPath = (directory: string, fileName: string) => {
  const separator = getPathSeparator(directory);
  const normalizedDirectory = directory.endsWith("/") || directory.endsWith("\\")
    ? directory.slice(0, -1)
    : directory;
  const baseName = sanitizeFileName(fileName).replace(/\.mp4$/i, "");
  return `${normalizedDirectory}${separator}${baseName}.mp4`;
};

const matchesPreset = (
  width: number,
  height: number,
  project: ProjectSettings | null
): PresetId => {
  if (project && width === project.width && height === project.height) {
    return "source";
  }

  const matched = RESOLUTION_PRESETS.find(
    (preset) => preset.id !== "source" && preset.width === width && preset.height === height
  );

  return matched?.id ?? "custom";
};

const createDefaultSettings = (project: ProjectSettings): ExportSettings => ({
  presetId: "source",
  fileName: `mappa-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`,
  directory: "",
  width: project.width,
  height: project.height,
  inFrame: project.startFrame,
  outFrame: project.endFrame,
  encoder: "libx264",
});

const summarizeQueueItem = (item: QueueItem) =>
  `${item.width}x${item.height} - ${item.fps} fps - ${item.encoder}`;

const queueItemFromSettings = (settings: ExportSettings, fps: number): QueueItem => ({
  ...settings,
  id: crypto.randomUUID(),
  fps,
  createdAt: new Date().toLocaleTimeString(),
  status: "queued",
  progress: 0,
  statusText: "Queued",
});

const syncQueuePatch = (
  items: QueueItem[],
  id: string,
  patch: Partial<QueueItem>
) => items.map((item) => (item.id === id ? { ...item, ...patch } : item));

const MapRenderer: React.FC = () => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const previewShellRef = useRef<HTMLDivElement>(null);
  
  const [project, setProject] = useState<ProjectSettings | null>(null);
  const [timelineElements, setTimelineElements] = useState<TimelineElement[]>([]);
  const [exportSettings, setExportSettings] = useState<ExportSettings | null>(null);
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [trackStates, setTrackStates] = useState<Record<number, { locked: boolean; hidden: boolean }>>({});
  const [selectedQueueId, setSelectedQueueId] = useState<string | null>(null);
  const [activeQueueId, setActiveQueueId] = useState<string | null>(null);

  const [previewFrame, setPreviewFrame] = useState(0);
  const [previewScale, setPreviewScale] = useState(1);
  const [surfaceSize, setSurfaceSize] = useState({ width: 1280, height: 720 });

  const [renderStatus, setRenderStatus] = useState<RenderStatus>(EMPTY_STATUS);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [isPreloadingPreview, setIsPreloadingPreview] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastExportPath, setLastExportPath] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);

  const queueRef = useRef<QueueItem[]>([]);
  const timelineRef = useRef<TimelineElement[]>([]);
  const previewAnimatedCacheRef = useRef(createMapPlaybackCache());
  const previewDeterministicCacheRef = useRef(createMapPlaybackCache());
  const renderPreloadKeyRef = useRef<string | null>(null);
  const previewPreloadKeyRef = useRef<string | null>(null);

  useEffect(() => {
    queueRef.current = queueItems;
  }, [queueItems]);

  useEffect(() => {
    timelineRef.current = timelineElements;
  }, [timelineElements]);

  useEffect(() => {
    const init = async () => {
      try {
        const data = await loadRenderData();
        if (!data) {
          setError("No render payload found. Export from the main editor first.");
          setIsLoading(false);
          return;
        }

        setProject(data.project);
        setTimelineElements(data.timelineElements);
        setTrackStates(data.trackStates || {});

        const initialSettings = createDefaultSettings(data.project);
        setExportSettings(initialSettings);
        setPreviewFrame(data.project.startFrame);
        setSurfaceSize({ width: data.project.width, height: data.project.height });
        setIsLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load render data.");
        setIsLoading(false);
      }
    };
    void init();
  }, []);

  useEffect(() => {
    if (!project || mapRef.current || !mapContainerRef.current) {
      return;
    }

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: OPEN_FREEMAP_STYLE_URL,
      center: [0, 20],
      zoom: 1.5,
      pixelRatio: 1,
      transformRequest: MAP_TRANSFORM_REQUEST,
      ...RENDER_MAP_OPTIONS,
    } as maplibregl.MapOptions);

    const handleLoad = () => {
      if (!map.getSource("city-area")) {
        map.addSource("city-area", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      }

      if (!map.getLayer("city-area-fill")) {
        map.addLayer({
          id: "city-area-fill",
          type: "fill",
          source: "city-area",
          paint: {
            "fill-color": ["get", "color"],
            "fill-opacity": ["coalesce", ["get", "opacity"], 0.4],
          },
        });
      }

      setMapReady(true);
      map.resize();
    };

    map.on("load", handleLoad);
    mapRef.current = map;

    return () => {
      map.off("load", handleLoad);
      map.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, [project]);

  useEffect(() => {
    if (isRendering || !exportSettings) {
      return;
    }
    setSurfaceSize({ width: exportSettings.width, height: exportSettings.height });
  }, [exportSettings, isRendering]);

  useEffect(() => {
    if (!previewShellRef.current || !surfaceSize.width || !surfaceSize.height) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;

      const paddedWidth = Math.max(1, entry.contentRect.width - 64);
      const paddedHeight = Math.max(1, entry.contentRect.height - 64);
      const scaleX = paddedWidth / surfaceSize.width;
      const scaleY = paddedHeight / surfaceSize.height;
      setPreviewScale(Math.min(scaleX, scaleY, 1));
    });

    observer.observe(previewShellRef.current);
    return () => observer.disconnect();
  }, [surfaceSize.height, surfaceSize.width]);

  useEffect(() => {
    if (!mapReady || !mapRef.current || !project) {
      return;
    }

    if (isPreviewPlaying) {
      applyTimelineFrameToMap({
        map: mapRef.current,
        frameIndex: previewFrame,
        timelineElements,
        fps: project.fps,
        cache: previewAnimatedCacheRef.current,
      });
      return;
    }

    applyDeterministicTimelineFrameToMap({
      map: mapRef.current,
      frameIndex: previewFrame,
      timelineElements,
      trackStates,
      fps: project.fps,
      cache: previewDeterministicCacheRef.current,
    });
  }, [isPreviewPlaying, mapReady, previewFrame, project, timelineElements, trackStates]);

  useEffect(() => {
    if (!mapRef.current) {
      return;
    }

    void waitForAnimationFrames(2).then(() => {
      mapRef.current?.resize();
    });
  }, [surfaceSize.height, surfaceSize.width]);

  useEffect(() => {
    if (!exportSettings || isRendering) {
      return;
    }

    setPreviewFrame((current) => clamp(current, exportSettings.inFrame, exportSettings.outFrame));
  }, [exportSettings, isRendering]);

  useEffect(() => {
    if (!isPreviewPlaying || !project || !exportSettings || isRendering) {
      return;
    }

    let frameHandle = 0;
    let lastTime = performance.now();
    const msPerFrame = 1000 / project.fps;

    const step = (time: number) => {
      const delta = time - lastTime;
      if (delta >= msPerFrame) {
        setPreviewFrame((current) => {
          if (current >= exportSettings.outFrame) {
            setIsPreviewPlaying(false);
            return exportSettings.inFrame;
          }
          return current + 1;
        });
        lastTime = time - (delta % msPerFrame);
      }
      frameHandle = window.requestAnimationFrame(step);
    };

    frameHandle = window.requestAnimationFrame(step);

    return () => window.cancelAnimationFrame(frameHandle);
  }, [exportSettings, isPreviewPlaying, isRendering, project]);

  const updateSettings = useCallback(
    (patch: Partial<ExportSettings>) => {
      setExportSettings((current) => {
        if (!current || !project) return current;
        const next = { ...current, ...patch };
        next.width = clamp(Math.round(next.width), 320, 7680);
        next.height = clamp(Math.round(next.height), 180, 4320);
        next.inFrame = clamp(Math.round(next.inFrame), project.startFrame, project.endFrame);
        next.outFrame = clamp(Math.round(next.outFrame), next.inFrame, project.endFrame);
        next.presetId = matchesPreset(next.width, next.height, project);
        return next;
      });
    },
    [project]
  );

  const updateQueueItem = useCallback((id: string, patch: Partial<QueueItem>) => {
    setQueueItems((current) => syncQueuePatch(current, id, patch));
  }, []);

  const handlePresetSelect = useCallback(
    (presetId: PresetId) => {
      if (!project || !exportSettings) return;

      const preset = RESOLUTION_PRESETS.find((item) => item.id === presetId);
      if (!preset) return;

      if (preset.id === "source") {
        updateSettings({ width: project.width, height: project.height, presetId: "source" });
        return;
      }

      updateSettings({
        width: preset.width,
        height: preset.height,
        presetId: preset.id,
      });
    },
    [exportSettings, project, updateSettings]
  );

  const handlePickDirectory = useCallback(async () => {
    if (!exportSettings) return;

    const result = await pickPath({
      directory: true,
      multiple: false,
      title: "Choose export folder",
    });

    if (typeof result === "string") {
      updateSettings({ directory: result });
    }
  }, [exportSettings, updateSettings]);

  const ensureOutputDirectory = useCallback(
    async (job: QueueItem) => {
      if (job.directory) {
        return job.directory;
      }

      const result = await pickPath({
        directory: true,
        multiple: false,
        title: `Choose export folder for ${job.fileName}`,
      });

      if (typeof result !== "string") {
        throw new Error("Render cancelled before an export folder was chosen.");
      }

      updateQueueItem(job.id, { directory: result });
      if (selectedQueueId === job.id) {
        updateSettings({ directory: result });
      }
      return result;
    },
    [selectedQueueId, updateQueueItem, updateSettings]
  );

  const handleAddToQueue = useCallback(() => {
    if (!project || !exportSettings) return;

    const queuedJob = queueItemFromSettings(
      {
        ...exportSettings,
        fileName: sanitizeFileName(exportSettings.fileName),
      },
      project.fps
    );

    setQueueItems((current) => [...current, queuedJob]);
    setSelectedQueueId(queuedJob.id);
  }, [exportSettings, project]);

  const handleQueueSelect = useCallback((item: QueueItem) => {
    setSelectedQueueId(item.id);
    setExportSettings({
      presetId: item.presetId,
      fileName: item.fileName,
      directory: item.directory,
      width: item.width,
      height: item.height,
      inFrame: item.inFrame,
      outFrame: item.outFrame,
      encoder: item.encoder,
    });
    setPreviewFrame(item.inFrame);
  }, []);

  const handleRemoveQueueItem = useCallback((id: string) => {
    setQueueItems((current) => current.filter((item) => item.id !== id));
    setSelectedQueueId((current) => (current === id ? null : current));
  }, []);

  const syncSurfaceForRender = useCallback(async (width: number, height: number) => {
    setSurfaceSize((current) =>
      current.width === width && current.height === height ? current : { width, height }
    );
    await waitForAnimationFrames(2);
    if (mapRef.current) {
      await waitForExactCanvasSize(mapRef.current, width, height);
    }
  }, []);

  const ensureMapPreloaded = useCallback(
    async ({
      startFrame,
      endFrame,
      cacheRef,
      queueItem,
      previewState,
    }: {
      startFrame: number;
      endFrame: number;
      cacheRef: React.MutableRefObject<string | null>;
      queueItem?: QueueItem;
      previewState?: boolean;
    }) => {
      if (!mapRef.current || !project) {
        return;
      }

      const preloadKey = createTimelinePreloadKey({
        timelineElements: timelineRef.current,
        fps: project.fps,
        startFrame,
        endFrame,
      });

      if (cacheRef.current === preloadKey) {
        return;
      }

      const restoreFrame = previewFrame;
      if (previewState) {
        setIsPreloadingPreview(true);
      }

      try {
        await preloadTimelineMapResources({
          map: mapRef.current,
          timelineElements: timelineRef.current,
          fps: project.fps,
          startFrame,
          endFrame,
          onProgress: (completed, total, frame) => {
            setPreviewFrame(frame);
            const progress = Math.round((completed / total) * 100);
            setRenderStatus({
              phase: "preloading",
              title: "Caching Map Tiles",
              detail: `Preloading camera ${completed} of ${total}`,
              progress,
              renderedFrames: completed,
              totalFrames: total,
            });
            if (queueItem) {
              updateQueueItem(queueItem.id, {
                status: "rendering",
                statusText: `Caching map - ${completed}/${total}`,
                progress: Math.min(progress, 95),
                error: undefined,
              });
            }
          },
        });
        cacheRef.current = preloadKey;
      } finally {
        setPreviewFrame(restoreFrame);
        if (previewState) {
          setIsPreloadingPreview(false);
        }
      }
    },
    [previewFrame, project, updateQueueItem]
  );

  const captureThirdPass = useCallback(
    async (job: QueueItem, jobId: string, outputPath: string) => {
      if (!mapRef.current || !project) {
        throw new Error("Map is not ready for capture.");
      }

      previewDeterministicCacheRef.current = createMapPlaybackCache();
      const totalFrames = job.outFrame - job.inFrame + 1;
      await waitForExactCanvasSize(mapRef.current, job.width, job.height);
      setRenderStatus({
        phase: "capturing",
        title: "Recording Pass",
        detail: "Capturing frames directly from the cached map surface.",
        progress: 0,
        renderedFrames: 0,
        totalFrames,
      });
      updateQueueItem(job.id, {
        status: "rendering",
        statusText: "Capture pass",
        progress: 0,
        error: undefined,
      });

      for (let offset = 0; offset < totalFrames; offset += 1) {
        const frame = job.inFrame + offset;
        applyDeterministicTimelineFrameToMap({
          map: mapRef.current,
          frameIndex: frame,
          timelineElements: timelineRef.current,
          trackStates,
          fps: project.fps,
          cache: previewDeterministicCacheRef.current,
        });

        await waitForRenderedFrame(mapRef.current);

        const canvas = mapRef.current.getCanvas();
        const pngData = canvas.toDataURL("image/png");

        await invoke("save_frame", {
          jobId,
          frameIndex: offset + 1,
          base64Data: pngData,
        });

        if (offset === 0 || offset === totalFrames - 1 || offset % Math.max(1, Math.floor(project.fps / 2)) === 0) {
          const progress = Math.round(((offset + 1) / totalFrames) * 100);
          setPreviewFrame(frame);
          setRenderStatus({
            phase: "capturing",
            title: "Recording Pass",
            detail: `Captured frame ${offset + 1} of ${totalFrames}`,
            progress,
            renderedFrames: offset + 1,
            totalFrames,
          });
          updateQueueItem(job.id, {
            progress,
            statusText: `Capture - ${offset + 1}/${totalFrames}`,
          });
        }
      }

      setRenderStatus({
        phase: "encoding",
        title: "Encoding MP4",
        detail: "FFmpeg is packaging the captured frames.",
        progress: 100,
        renderedFrames: totalFrames,
        totalFrames,
      });
      updateQueueItem(job.id, {
        progress: 100,
        statusText: "Encoding MP4",
      });

      return invoke<string>("finish_render_job", {
        jobId,
        outputPath,
        encoder: job.encoder,
      });
    },
    [project, updateQueueItem]
  );

  const renderSingleJob = useCallback(
    async (job: QueueItem) => {
      if (!project || !mapRef.current || !mapReady) {
        throw new Error("Renderer is not ready yet.");
      }

      setIsPreviewPlaying(false);
      setIsRendering(true);
      setActiveQueueId(job.id);
      setError(null);
      setLastExportPath(null);

      let activeJobId: string | null = null;

      try {
        const directory = await ensureOutputDirectory(job);
        const resolvedJob = { ...job, directory };
        const outputPath = buildOutputPath(directory, resolvedJob.fileName);

        await syncSurfaceForRender(resolvedJob.width, resolvedJob.height);
        setPreviewFrame(resolvedJob.inFrame);
        await waitForMapSettle(mapRef.current, 1500);
        await ensureMapPreloaded({
          startFrame: resolvedJob.inFrame,
          endFrame: resolvedJob.outFrame,
          cacheRef: renderPreloadKeyRef,
          queueItem: resolvedJob,
        });

        activeJobId = await invoke<string>("start_render_job", {
          fps: project.fps,
          width: resolvedJob.width,
          height: resolvedJob.height,
        });

        const resultPath = await captureThirdPass(resolvedJob, activeJobId, outputPath);

        updateQueueItem(resolvedJob.id, {
          status: "done",
          progress: 100,
          statusText: "Complete",
          resultPath,
          error: undefined,
        });
        setLastExportPath(resultPath);
        setRenderStatus({
          phase: "complete",
          title: "Render complete",
          detail: resultPath,
          progress: 100,
          renderedFrames: resolvedJob.outFrame - resolvedJob.inFrame + 1,
          totalFrames: resolvedJob.outFrame - resolvedJob.inFrame + 1,
        });
      } catch (renderError) {
        if (activeJobId) {
          try {
            await invoke("cleanup_render_job", { jobId: activeJobId });
          } catch {
            // Ignore cleanup failure after a render error.
          }
        }

        const message = renderError instanceof Error ? renderError.message : String(renderError);
        updateQueueItem(job.id, {
          status: "error",
          statusText: "Failed",
          error: message,
        });
        setRenderStatus({
          phase: "error",
          title: "Render failed",
          detail: message,
          progress: 0,
          renderedFrames: 0,
          totalFrames: job.outFrame - job.inFrame + 1,
        });
        setError(message);
        throw renderError;
      } finally {
        setIsRendering(false);
        setActiveQueueId(null);
      }
    },
    [captureThirdPass, ensureMapPreloaded, ensureOutputDirectory, mapReady, project, syncSurfaceForRender, updateQueueItem]
  );

  const runQueuedJobs = useCallback(
    async (jobIds?: string[]) => {
      const currentQueue = queueRef.current;
      const jobs =
        jobIds && jobIds.length > 0
          ? currentQueue.filter((item) => jobIds.includes(item.id))
          : currentQueue.filter((item) => item.status === "queued" || item.status === "error");

      if (jobs.length === 0) {
        setError("There are no queued jobs ready to render.");
        return;
      }

      for (const job of jobs) {
        await renderSingleJob(job);
      }
    },
    [renderSingleJob]
  );

  const handleRenderCurrent = useCallback(async () => {
    if (!project || !exportSettings) return;

    const job = queueItemFromSettings(
      {
        ...exportSettings,
        fileName: sanitizeFileName(exportSettings.fileName),
      },
      project.fps
    );

    setQueueItems((current) => [...current, job]);
    setSelectedQueueId(job.id);
    await runQueuedJobs([job.id]);
  }, [exportSettings, project, runQueuedJobs]);

  const handleRenderSelected = useCallback(async () => {
    if (!selectedQueueId) {
      setError("Select a queued export before rendering it.");
      return;
    }

    await runQueuedJobs([selectedQueueId]);
  }, [runQueuedJobs, selectedQueueId]);

  const handleOpenLastExport = useCallback(async () => {
    const selectedItem = queueItems.find((item) => item.id === selectedQueueId);
    const target = selectedItem?.resultPath ?? lastExportPath ?? selectedItem?.directory ?? exportSettings?.directory;

    if (!target) {
      setError("There is no exported file or folder to open yet.");
      return;
    }

    await openPath(target);
  }, [exportSettings?.directory, lastExportPath, queueItems, selectedQueueId]);

  const handlePreviewPlaybackToggle = useCallback(async () => {
    if (!exportSettings || !project) {
      return;
    }

    if (isPreviewPlaying) {
      setIsPreviewPlaying(false);
      return;
    }

    await ensureMapPreloaded({
      startFrame: exportSettings.inFrame,
      endFrame: exportSettings.outFrame,
      cacheRef: previewPreloadKeyRef,
      previewState: true,
    });

    previewAnimatedCacheRef.current = createMapPlaybackCache();
    previewDeterministicCacheRef.current = createMapPlaybackCache();
    setRenderStatus({
      phase: "idle",
      title: "Preview Ready",
      detail: "Cached tiles loaded for the current range.",
      progress: 0,
      renderedFrames: 0,
      totalFrames: 0,
    });
    setIsPreviewPlaying(true);
  }, [ensureMapPreloaded, exportSettings, isPreviewPlaying, project]);

  if (isLoading) {
    return (
      <div className="h-full bg-[#111315] text-zinc-200 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
          <div className="text-[10px] tracking-[0.3em] uppercase text-zinc-500">Initializing Deliver Engine</div>
        </div>
      </div>
    );
  }

  if (error && !project) {
    return (
      <div className="h-full bg-[#111315] text-zinc-100 p-10 flex items-center justify-center">
        <div className="max-w-md w-full border border-zinc-800 bg-[#17191c] rounded-lg p-8 space-y-4 shadow-2xl">
          <div className="flex items-center gap-3 text-amber-500">
            <Warning size={20} weight="fill" />
            <div className="text-[11px] tracking-[0.3em] uppercase">Session Error</div>
          </div>
          <h1 className="text-xl font-semibold">Missing Render Data</h1>
          <p className="text-xs text-zinc-400 leading-relaxed">{error}</p>
        </div>
      </div>
    );
  }

  if (!project || !exportSettings) return null;

  const totalFrames = exportSettings.outFrame - exportSettings.inFrame + 1;
  const timeLabel = formatTimecode(previewFrame, project.fps);
  const previewWidth = Math.max(1, Math.round(surfaceSize.width * previewScale));
  const previewHeight = Math.max(1, Math.round(surfaceSize.height * previewScale));

  return (
    <div className="flex flex-col h-screen w-screen bg-background text-foreground overflow-hidden font-sans select-none">
      <TitleBar onDeliver={handleRenderCurrent} deliverLabel="Quick Export" />

      {/* Main Content Grid */}
      <div className="flex-1 min-h-0 grid grid-cols-[300px_minmax(0,1fr)_320px] overflow-hidden">
        
        {/* Render Settings Panel (Left) */}
        <aside className="min-h-0 border-r border-border bg-card overflow-hidden flex flex-col">
          <div className="p-4 border-b border-border bg-card/50">
            <span className="text-[10px] font-bold tracking-[.25em] text-muted-foreground uppercase">Render Settings</span>
          </div>
          
          <ScrollArea className="flex-1">
            <div className="p-4 space-y-6">
              {/* File Section */}
              <section className="space-y-3">
                <div className="space-y-2">
                  <Label className="text-[9px] font-bold text-muted-foreground uppercase tracking-widest block">Filename</Label>
                  <Input
                    value={exportSettings.fileName}
                    onChange={(e) => updateSettings({ fileName: e.target.value })}
                    className="h-8 text-xs"
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-[9px] font-bold text-muted-foreground uppercase tracking-widest block">Location</Label>
                  <Button
                    variant="outline"
                    onClick={handlePickDirectory}
                    className="w-full h-8 px-2 justify-between font-normal text-xs text-muted-foreground hover:text-foreground border-border bg-muted/30"
                  >
                    <span className="truncate mr-2 font-mono text-[10px]">
                      {exportSettings.directory || "Select Path..."}
                    </span>
                    <Folder size={12} weight="bold" className="shrink-0" />
                  </Button>
                </div>
              </section>

              <Separator className="bg-border/50" />

              {/* Video Section */}
              <section className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label className="text-[9px] font-bold text-muted-foreground uppercase tracking-widest block">Width</Label>
                    <Input
                      type="number"
                      value={exportSettings.width}
                      onChange={(e) => updateSettings({ width: Number(e.target.value) || project.width })}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-[9px] font-bold text-muted-foreground uppercase tracking-widest block">Height</Label>
                    <Input
                      type="number"
                      value={exportSettings.height}
                      onChange={(e) => updateSettings({ height: Number(e.target.value) || project.height })}
                      className="h-8 text-xs"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-[9px] font-bold text-muted-foreground uppercase tracking-widest block mb-2">Video Encoder</Label>
                  <select
                    value={exportSettings.encoder}
                    onChange={(e) => updateSettings({ encoder: e.target.value as EncoderId })}
                    className="w-full h-8 bg-muted border border-border rounded px-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-primary/50"
                  >
                    {ENCODERS.map((enc) => (
                      <option key={enc.id} value={enc.id}>{enc.label}</option>
                    ))}
                  </select>
                </div>
              </section>

              <Separator className="bg-border/50" />

              {/* Range Section */}
              <section className="space-y-3">
                <Label className="text-[9px] font-bold text-muted-foreground uppercase tracking-widest block">Render Range</Label>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-muted/50 border border-border rounded p-2 flex flex-col gap-1">
                    <span className="text-[8px] font-bold text-muted-foreground uppercase tracking-tighter">In Frame</span>
                    <input
                      type="number"
                      value={exportSettings.inFrame}
                      onChange={(e) => updateSettings({ inFrame: Number(e.target.value) || 0 })}
                      className="bg-transparent border-none text-xs text-foreground outline-none font-mono"
                    />
                  </div>
                  <div className="bg-muted/50 border border-border rounded p-2 flex flex-col gap-1">
                    <span className="text-[8px] font-bold text-muted-foreground uppercase tracking-tighter">Out Frame</span>
                    <input
                      type="number"
                      value={exportSettings.outFrame}
                      onChange={(e) => updateSettings({ outFrame: Number(e.target.value) || 0 })}
                      className="bg-transparent border-none text-xs text-foreground outline-none font-mono"
                    />
                  </div>
                </div>
              </section>

              <Button
                 onClick={handleAddToQueue}
                 disabled={isRendering}
                 variant="outline"
                 className="w-full h-9 text-[10px] font-bold uppercase tracking-widest mt-4"
              >
                ADD TO RENDER QUEUE
              </Button>
            </div>
          </ScrollArea>
        </aside>

        {/* Center Viewer Area */}
        <main className="min-w-0 bg-background flex flex-col overflow-hidden relative">
          {/* Header Sub-bar */}
          <div className="h-10 border-b border-border bg-card/30 px-4 flex items-center justify-between shrink-0 font-mono">
             <div className="flex items-center gap-6">
                <div className="flex items-center gap-1.5">
                   <Monitor size={14} className="text-muted-foreground" />
                   <span className="text-[10px] font-bold text-muted-foreground">{surfaceSize.width}x{surfaceSize.height}</span>
                </div>
                <div className="flex items-center gap-1.5">
                   <Clock size={14} className="text-muted-foreground" />
                   <span className="text-[10px] font-bold text-muted-foreground tracking-wider">{timeLabel}</span>
                </div>
             </div>

             <div className="flex items-center gap-4">
                <div className="flex items-center gap-1.5">
                   <FrameCorners size={14} className="text-muted-foreground" />
                   <span className="text-[10px] font-bold text-muted-foreground tracking-wider uppercase">Preview: {previewWidth}x{previewHeight}</span>
                </div>
             </div>
          </div>

          <div className="flex-1 flex flex-col min-h-0 p-8">
            <div
              ref={previewShellRef}
              className="flex-1 rounded-sm border border-border bg-black shadow-[0_40px_100px_rgba(0,0,0,0.8)] flex items-center justify-center overflow-hidden relative group"
            >
              <div
                className="relative bg-black shadow-2xl"
                style={{
                  width: surfaceSize.width,
                  height: surfaceSize.height,
                  transform: `scale(${previewScale})`,
                }}
              >
                <div ref={mapContainerRef} className="w-full h-full" />
              </div>

              {/* Status HUD (Top Left) */}
              <div className="absolute top-4 left-4 flex flex-col gap-2">
                <div className="px-3 py-1.5 bg-black/80 backdrop-blur-md rounded border border-border flex items-center gap-3">
                   <div className={`w-1.5 h-1.5 rounded-full ${isRendering ? 'bg-destructive animate-pulse' : 'bg-emerald-500'} `} />
                   <span className="text-[9px] font-bold tracking-[.2em] text-foreground uppercase">{renderStatus.title}</span>
                </div>
                {renderStatus.detail && (
                  <div className="px-3 py-1 text-[8px] bg-black/40 text-muted-foreground font-mono truncate max-w-[400px]">
                    {renderStatus.detail}
                  </div>
                )}
              </div>

              {/* Transport Controls Overlay */}
              <div className="absolute inset-x-0 bottom-0 p-6 bg-gradient-to-t from-black/90 to-transparent flex flex-col gap-4 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                <div className="flex items-center justify-center gap-6">
                   <button 
                     onClick={() => void handlePreviewPlaybackToggle()}
                     className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-all"
                   >
                     {isPreviewPlaying ? <Pause size={20} weight="fill" /> : <Play size={20} weight="fill" />}
                   </button>
                </div>
                
                <div className="space-y-2">
                    <div className="flex items-center justify-between text-[8px] font-bold text-muted-foreground uppercase tracking-widest">
                       <span>{renderStatus.phase === "idle" ? "Timeline Position" : "Rendering Progress"}</span>
                       <span>{Math.round(renderStatus.progress)}%</span>
                    </div>
                    <div className="h-1.5 bg-muted/30 rounded-full overflow-hidden">
                       <div 
                         className="h-full bg-primary transition-all duration-300 shadow-[0_0_8px_rgba(var(--primary),0.5)]" 
                         style={{ width: `${renderStatus.progress}%` }} 
                       />
                    </div>
                 </div>
                   <input
                     type="range"
                     min={exportSettings.inFrame}
                     max={exportSettings.outFrame}
                     value={previewFrame}
                     onChange={(e) => {
                       setIsPreviewPlaying(false);
                       setPreviewFrame(Number(e.target.value));
                     }}
                     className="w-full h-1 accent-primary bg-zinc-700/50 rounded-full appearance-none cursor-pointer"
                   />
                </div>
              </div>
            </div>
        </main>

        {/* Render Queue (Right Sidebar) */}
        <aside className="min-h-0 border-l border-border bg-card overflow-hidden flex flex-col">
          <div className="p-4 border-b border-border bg-card/50 flex items-center justify-between">
            <span className="text-[10px] font-bold tracking-[.25em] text-muted-foreground uppercase">Render Queue</span>
            <span className="text-[10px] font-mono text-muted-foreground/50">{queueItems.length} JOBS</span>
          </div>

          <ScrollArea className="flex-1">
            <div className="p-3 space-y-3">
              {queueItems.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-48 opacity-20 gap-3">
                   <Queue size={32} />
                   <span className="text-[9px] font-bold tracking-widest uppercase text-muted-foreground">Queue is Empty</span>
                </div>
              ) : (
                queueItems.map((item) => {
                  const isSelected = item.id === selectedQueueId;
                  const isActive = item.id === activeQueueId;
                  const isDone = item.status === "done";
                  const isError = item.status === "error";

                  return (
                    <div
                      key={item.id}
                      onClick={() => setSelectedQueueId(item.id)}
                      className={cn(
                        "group relative rounded border p-3 transition-all cursor-pointer",
                        isSelected ? 'bg-primary/5 border-primary/50' : 'bg-muted/30 border-border hover:border-muted-foreground/30'
                      )}
                    >
                      <div className="flex items-start justify-between gap-3 mb-2">
                         <div className="min-w-0">
                            <div className={cn("text-[10px] font-bold truncate mb-0.5", isDone ? 'text-muted-foreground' : 'text-foreground')}>
                              {item.fileName}.mp4
                            </div>
                            <div className="text-[8px] text-muted-foreground/60 font-mono">{item.createdAt}</div>
                         </div>
                         
                         <div className="shrink-0">
                            {isDone ? (
                              <CheckCircle size={14} className="text-emerald-500" weight="fill" />
                            ) : isError ? (
                              <Warning size={14} className="text-destructive" weight="fill" />
                            ) : isActive ? (
                              <div className="w-2.5 h-2.5 bg-primary rounded-full animate-pulse" />
                            ) : (
                              <div className="w-1.5 h-1.5 bg-muted rounded-full" />
                            )}
                         </div>
                      </div>

                      <div className="flex items-center justify-between text-[8px] font-bold text-muted-foreground uppercase tracking-tighter mb-2">
                         <span>{item.width}x{item.height} • {item.encoder}</span>
                         <span className={isActive ? 'text-primary' : ''}>{item.statusText}</span>
                      </div>

                      <div className="h-1 bg-muted rounded-full overflow-hidden mb-2">
                         <div 
                           className={cn("h-full transition-all duration-300", isError ? 'bg-destructive' : isDone ? 'bg-muted-foreground/30' : 'bg-primary')}
                           style={{ width: `${item.progress}%` }} 
                         />
                      </div>

                      <div className="flex gap-2">
                         <Button
                           variant="secondary"
                           size="sm"
                           onClick={(e) => { e.stopPropagation(); void runQueuedJobs([item.id]); }}
                           disabled={isRendering || isDone}
                           className="flex-1 h-6 text-[8px] font-bold uppercase rounded"
                         >
                           {isError ? "Retry" : "Render"}
                         </Button>
                         <Button
                           variant="ghost"
                           size="icon"
                           onClick={(e) => { e.stopPropagation(); handleRemoveQueueItem(item.id); }}
                           disabled={isActive}
                           className="w-6 h-6 text-muted-foreground hover:text-destructive transition-colors shrink-0"
                         >
                           <Trash size={12} />
                         </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </ScrollArea>

          {queueItems.length > 0 && (
            <div className="p-3 border-t border-border bg-card/50">
               <Button
                 variant="outline"
                 onClick={() => void runQueuedJobs()}
                 disabled={isRendering}
                 className="w-full text-[10px] font-bold tracking-widest uppercase gap-2"
               >
                 <Play size={14} weight="fill" />
                 Render All
               </Button>
            </div>
          )}
        </aside>
      </div>

      {/* Footer Info-bar */}
      <footer className="h-8 shrink-0 bg-card border-t border-border px-4 flex items-center justify-between overflow-hidden">
        <div className="flex items-center gap-4 text-[9px] font-bold text-muted-foreground uppercase tracking-widest">
           <div className="flex items-center gap-1.5">
              <Info size={12} />
              <span>GPU Rendering Active</span>
           </div>
           {isRendering && <span className="text-primary">Encoding Video {Math.round(renderStatus.progress)}%</span>}
        </div>
        <div className="text-[9px] font-mono text-muted-foreground/50 truncate max-w-[50%]">
           {lastExportPath ? `Last saved to: ${lastExportPath}` : "Waiting for render job..."}
        </div>
      </footer>
    </div>
  );
};

export default MapRenderer;
