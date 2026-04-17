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
import type { ProjectSettings, TimelineElement } from "../types";

type EncoderId = "libx264" | "h264_nvenc" | "h264_qsv" | "h264_amf";
type QueueStatus = "queued" | "rendering" | "done" | "error";
type RenderPhase = "idle" | "warming" | "capturing" | "encoding" | "complete" | "error";
type PresetId = "source" | "1080p" | "1440p" | "2160p" | "custom";

interface ExportSettings {
  presetId: PresetId;
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

interface ResolutionPreset {
  id: PresetId;
  label: string;
  width: number;
  height: number;
}

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

const RESOLUTION_PRESETS: ResolutionPreset[] = [
  { id: "source", label: "Source", width: 0, height: 0 },
  { id: "1080p", label: "1080p", width: 1920, height: 1080 },
  { id: "1440p", label: "1440p", width: 2560, height: 1440 },
  { id: "2160p", label: "4K UHD", width: 3840, height: 2160 },
];

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

const isTauriDesktop = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

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
  const previewShellRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const previewAnimatedCacheRef = useRef(createMapPlaybackCache());
  const previewDeterministicCacheRef = useRef(createMapPlaybackCache());
  const timelineRef = useRef<TimelineElement[]>([]);
  const queueRef = useRef<QueueItem[]>([]);

  const [project, setProject] = useState<ProjectSettings | null>(null);
  const [timelineElements, setTimelineElements] = useState<TimelineElement[]>([]);
  const [exportSettings, setExportSettings] = useState<ExportSettings | null>(null);
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [selectedQueueId, setSelectedQueueId] = useState<string | null>(null);
  const [previewFrame, setPreviewFrame] = useState(0);
  const [previewScale, setPreviewScale] = useState(1);
  const [surfaceSize, setSurfaceSize] = useState({ width: 1280, height: 720 });
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [mapReady, setMapReady] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [activeQueueId, setActiveQueueId] = useState<string | null>(null);
  const [renderStatus, setRenderStatus] = useState<RenderStatus>(EMPTY_STATUS);
  const [error, setError] = useState<string | null>(null);
  const [lastExportPath, setLastExportPath] = useState<string | null>(null);

  useEffect(() => {
    timelineRef.current = timelineElements;
  }, [timelineElements]);

  useEffect(() => {
    queueRef.current = queueItems;
  }, [queueItems]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const data = await loadRenderData();
        if (cancelled) return;

        if (!data) {
          setError("No render payload found. Open the editor and send a render job again.");
          return;
        }

        setProject(data.project);
        setTimelineElements(data.timelineElements);

        const initialSettings = createDefaultSettings(data.project);
        setExportSettings(initialSettings);
        setPreviewFrame(initialSettings.inFrame);
        setSurfaceSize({ width: initialSettings.width, height: initialSettings.height });
      } catch (loadError) {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!project || mapRef.current || !mapContainerRef.current) {
      return;
    }

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: "https://tiles.openfreemap.org/styles/positron",
      center: [0, 20],
      zoom: 1.5,
      pixelRatio: 1,
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
      fps: project.fps,
      cache: previewDeterministicCacheRef.current,
    });
  }, [isPreviewPlaying, mapReady, previewFrame, project, timelineElements]);

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

  const playWarmupPass = useCallback(
    async (job: QueueItem, passNumber: number) => {
      if (!mapRef.current || !project) return;

      previewAnimatedCacheRef.current = createMapPlaybackCache();
      const totalFrames = job.outFrame - job.inFrame + 1;
      setRenderStatus({
        phase: "warming",
        title: `Warmup Pass ${passNumber}/2`,
        detail: "Priming map tiles and transition state before capture.",
        progress: 0,
        renderedFrames: 0,
        totalFrames,
      });
      updateQueueItem(job.id, {
        status: "rendering",
        statusText: `Warmup pass ${passNumber}/2`,
        progress: 0,
        error: undefined,
      });

      for (let offset = 0; offset < totalFrames; offset += 1) {
        const frame = job.inFrame + offset;
        applyTimelineFrameToMap({
          map: mapRef.current,
          frameIndex: frame,
          timelineElements: timelineRef.current,
          fps: project.fps,
          cache: previewAnimatedCacheRef.current,
        });

        if (offset === 0 || offset === totalFrames - 1 || offset % Math.max(1, Math.floor(project.fps / 2)) === 0) {
          const progress = Math.round(((offset + 1) / totalFrames) * 100);
          setPreviewFrame(frame);
          setRenderStatus({
            phase: "warming",
            title: `Warmup Pass ${passNumber}/2`,
            detail: `Frame ${offset + 1} of ${totalFrames}`,
            progress,
            renderedFrames: offset + 1,
            totalFrames,
          });
          updateQueueItem(job.id, {
            progress,
            statusText: `Warmup ${passNumber}/2 - ${offset + 1}/${totalFrames}`,
          });
        }

        await wait(1000 / project.fps);
      }

      await waitForMapSettle(mapRef.current, 600);
    },
    [project, updateQueueItem]
  );

  const captureThirdPass = useCallback(
    async (job: QueueItem, jobId: string, outputPath: string) => {
      if (!mapRef.current || !project) {
        throw new Error("Map is not ready for capture.");
      }

      previewDeterministicCacheRef.current = createMapPlaybackCache();
      const totalFrames = job.outFrame - job.inFrame + 1;
      await waitForExactCanvasSize(mapRef.current, job.width, job.height);

      for (let offset = 0; offset < totalFrames; offset += 1) {
        const frame = job.inFrame + offset;
        applyDeterministicTimelineFrameToMap({
          map: mapRef.current,
          frameIndex: frame,
          timelineElements: timelineRef.current,
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
            title: "Recording Pass 3/3",
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

        activeJobId = await invoke<string>("start_render_job", {
          fps: project.fps,
          width: resolvedJob.width,
          height: resolvedJob.height,
        });

        await playWarmupPass(resolvedJob, 1);
        await playWarmupPass(resolvedJob, 2);
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
    [captureThirdPass, ensureOutputDirectory, mapReady, playWarmupPass, project, syncSurfaceForRender, updateQueueItem]
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

  if (isLoading) {
    return (
      <div className="h-full bg-[#111315] text-zinc-200 flex items-center justify-center">
        <div className="text-sm tracking-[0.2em] uppercase text-zinc-500">Loading Render Session</div>
      </div>
    );
  }

  if (error && !project) {
    return (
      <div className="h-full bg-[#111315] text-zinc-100 p-10 flex items-center justify-center">
        <div className="max-w-lg border border-zinc-800 bg-[#17191c] rounded-2xl p-8 space-y-3 shadow-2xl shadow-black/30">
          <div className="text-[11px] tracking-[0.3em] uppercase text-amber-500">Renderer</div>
          <h1 className="text-2xl font-semibold">No render payload available</h1>
          <p className="text-sm text-zinc-400 leading-6">{error}</p>
        </div>
      </div>
    );
  }

  if (!project || !exportSettings) {
    return null;
  }

  const selectedQueueItem = queueItems.find((item) => item.id === selectedQueueId) ?? null;
  const totalFrames = exportSettings.outFrame - exportSettings.inFrame + 1;
  const timeLabel = formatTimecode(previewFrame, project.fps);
  const previewWidth = Math.max(1, Math.round(surfaceSize.width * previewScale));
  const previewHeight = Math.max(1, Math.round(surfaceSize.height * previewScale));

  return (
    <div className="h-screen w-screen overflow-hidden bg-[#0d0f11] text-zinc-100 flex flex-col">
      <header className="h-14 shrink-0 border-b border-zinc-800 bg-[#121418] px-4 flex items-center justify-between">
        <div>
          <div className="text-[10px] tracking-[0.35em] uppercase text-zinc-500">Deliver</div>
          <div className="text-base font-semibold text-zinc-100">Map Export</div>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleOpenLastExport}
            className="px-3 py-2 text-xs font-medium rounded-lg border border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-white transition-colors"
          >
            Open Output
          </button>
          <button
            type="button"
            onClick={handleRenderCurrent}
            disabled={isRendering || !isTauriDesktop()}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-amber-500 text-black disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Render Current
          </button>
        </div>
      </header>

      <div className="h-11 shrink-0 border-b border-zinc-800 bg-[#15181d] px-3 flex items-center justify-center gap-2">
        {RESOLUTION_PRESETS.map((preset) => {
          const active = exportSettings.presetId === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => handlePresetSelect(preset.id)}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-medium border transition-colors ${
                  active
                    ? "border-amber-500 bg-amber-500/10 text-amber-300"
                    : "border-zinc-800 bg-[#101216] text-zinc-400 hover:text-white hover:border-zinc-600"
              }`}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-[280px_minmax(0,1fr)_300px] overflow-hidden">
        <aside className="min-h-0 border-r border-zinc-800 bg-[#111317] overflow-hidden">
          <div className="h-full p-3 space-y-3">
            <section className="space-y-2">
              <div className="text-[10px] tracking-[0.3em] uppercase text-zinc-500">Render Settings</div>
              <div className="space-y-2 rounded-2xl border border-zinc-800 bg-[#171a1f] p-3">
                <label className="block space-y-2">
                  <span className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">File Name</span>
                  <input
                    value={exportSettings.fileName}
                    onChange={(event) => updateSettings({ fileName: event.target.value })}
                    className="w-full rounded-lg border border-zinc-700 bg-[#0f1115] px-3 py-2 text-sm outline-none focus:border-amber-500"
                  />
                </label>

                <div className="space-y-2">
                  <span className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Location</span>
                  <button
                    type="button"
                    onClick={handlePickDirectory}
                    className="w-full rounded-lg border border-zinc-700 bg-[#0f1115] px-3 py-2 text-left text-sm text-zinc-300 hover:border-zinc-500 transition-colors"
                  >
                    {exportSettings.directory || "Choose export folder"}
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <label className="space-y-2">
                    <span className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Width</span>
                    <input
                      type="number"
                      min={320}
                      max={7680}
                      value={exportSettings.width}
                      onChange={(event) => updateSettings({ width: Number(event.target.value) || project.width })}
                      className="w-full rounded-lg border border-zinc-700 bg-[#0f1115] px-3 py-2 text-sm outline-none focus:border-amber-500"
                    />
                  </label>
                  <label className="space-y-2">
                    <span className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Height</span>
                    <input
                      type="number"
                      min={180}
                      max={4320}
                      value={exportSettings.height}
                      onChange={(event) => updateSettings({ height: Number(event.target.value) || project.height })}
                      className="w-full rounded-lg border border-zinc-700 bg-[#0f1115] px-3 py-2 text-sm outline-none focus:border-amber-500"
                    />
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <label className="space-y-2">
                    <span className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">In</span>
                    <input
                      type="number"
                      min={project.startFrame}
                      max={project.endFrame}
                      value={exportSettings.inFrame}
                      onChange={(event) => updateSettings({ inFrame: Number(event.target.value) || project.startFrame })}
                      className="w-full rounded-lg border border-zinc-700 bg-[#0f1115] px-3 py-2 text-sm outline-none focus:border-amber-500"
                    />
                  </label>
                  <label className="space-y-2">
                    <span className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Out</span>
                    <input
                      type="number"
                      min={exportSettings.inFrame}
                      max={project.endFrame}
                      value={exportSettings.outFrame}
                      onChange={(event) => updateSettings({ outFrame: Number(event.target.value) || project.endFrame })}
                      className="w-full rounded-lg border border-zinc-700 bg-[#0f1115] px-3 py-2 text-sm outline-none focus:border-amber-500"
                    />
                  </label>
                </div>

                <div className="space-y-2">
                  <span className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Encoder</span>
                  <select
                    value={exportSettings.encoder}
                    onChange={(event) => updateSettings({ encoder: event.target.value as EncoderId })}
                    className="w-full rounded-lg border border-zinc-700 bg-[#0f1115] px-3 py-2 text-sm outline-none focus:border-amber-500"
                  >
                    {ENCODERS.map((encoder) => (
                      <option key={encoder.id} value={encoder.id}>
                        {encoder.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </section>

            <section className="space-y-2">
              <div className="text-[10px] tracking-[0.3em] uppercase text-zinc-500">Output Summary</div>
              <div className="rounded-2xl border border-zinc-800 bg-[#171a1f] p-3 space-y-2 text-sm">
                <div className="flex justify-between text-zinc-400">
                  <span>Codec</span>
                  <span className="text-zinc-100">{ENCODERS.find((item) => item.id === exportSettings.encoder)?.label}</span>
                </div>
                <div className="flex justify-between text-zinc-400">
                  <span>Format</span>
                  <span className="text-zinc-100">MP4</span>
                </div>
                <div className="flex justify-between text-zinc-400">
                  <span>Frame Rate</span>
                  <span className="text-zinc-100">{project.fps} fps</span>
                </div>
                <div className="flex justify-between text-zinc-400">
                  <span>Range</span>
                  <span className="text-zinc-100">{totalFrames} frames</span>
                </div>
                <div className="rounded-xl bg-[#0f1115] border border-zinc-800 px-3 py-2 text-[11px] text-zinc-400 break-all">
                  {exportSettings.directory
                    ? buildOutputPath(exportSettings.directory, exportSettings.fileName)
                    : "Output path will be resolved when you queue or render."}
                </div>
              </div>
            </section>

            <section className="space-y-2">
              <div className="text-[10px] tracking-[0.3em] uppercase text-zinc-500">Actions</div>
              <div className="rounded-2xl border border-zinc-800 bg-[#171a1f] p-3 space-y-2">
                <button
                  type="button"
                  onClick={handleAddToQueue}
                  disabled={isRendering}
                  className="w-full rounded-lg border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-200 hover:border-zinc-500 disabled:opacity-40"
                >
                  Add To Queue
                </button>
                <button
                  type="button"
                  onClick={handleRenderSelected}
                  disabled={isRendering || !selectedQueueItem}
                  className="w-full rounded-lg bg-amber-500 px-3 py-2 text-xs font-semibold text-black disabled:opacity-40"
                >
                  Render Selected
                </button>
                <button
                  type="button"
                  onClick={() => void runQueuedJobs()}
                  disabled={isRendering || queueItems.length === 0}
                  className="w-full rounded-lg border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-200 hover:border-zinc-500 disabled:opacity-40"
                >
                  Render Queue
                </button>
              </div>
            </section>
          </div>
        </aside>

        <main className="min-w-0 bg-[#0e1013] flex flex-col overflow-hidden">
          <div className="h-12 shrink-0 border-b border-zinc-800 bg-[#13161b] px-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  previewAnimatedCacheRef.current = createMapPlaybackCache();
                  previewDeterministicCacheRef.current = createMapPlaybackCache();
                  setIsPreviewPlaying((playing) => !playing);
                }}
                disabled={isRendering}
                className="w-9 h-9 rounded-full bg-zinc-800 text-zinc-100 flex items-center justify-center disabled:opacity-40"
              >
                {isPreviewPlaying ? "Pause" : "Play"}
              </button>
              <div>
                <div className="text-sm font-medium">{timeLabel}</div>
                <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
                  Frame {previewFrame}
                </div>
              </div>
            </div>

            <div className="text-right">
              <div className="text-sm font-medium text-zinc-200">
                {surfaceSize.width} x {surfaceSize.height}
              </div>
              <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
                Viewer {previewWidth} x {previewHeight}
              </div>
            </div>
          </div>

          <div className="flex-1 min-h-0 p-3">
            <div
              ref={previewShellRef}
              className="w-full h-full rounded-[24px] border border-zinc-800 bg-[#15181d] shadow-[0_35px_100px_rgba(0,0,0,0.35)] flex items-center justify-center overflow-hidden relative"
            >
              <div
                className="relative border border-zinc-900 bg-black shadow-2xl shadow-black/50"
                style={{
                  width: surfaceSize.width,
                  height: surfaceSize.height,
                  transform: `scale(${previewScale})`,
                  transformOrigin: "center center",
                }}
              >
                <div ref={mapContainerRef} className="w-full h-full" />
              </div>

              <div className="absolute top-3 left-3 rounded-2xl border border-zinc-800/80 bg-black/65 px-3 py-2 backdrop-blur max-w-[70%]">
                <div className="text-[10px] uppercase tracking-[0.28em] text-zinc-500">{renderStatus.title}</div>
                <div className="mt-1 text-xs text-zinc-200 break-all">{renderStatus.detail}</div>
              </div>

              <div className="absolute bottom-3 left-3 right-3 rounded-2xl border border-zinc-800/80 bg-black/65 px-3 py-2 backdrop-blur">
                <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.18em] text-zinc-500">
                  <span>{renderStatus.phase === "idle" ? "Preview" : "Render Status"}</span>
                  <span>{renderStatus.totalFrames > 0 ? `${renderStatus.renderedFrames}/${renderStatus.totalFrames}` : "Ready"}</span>
                </div>
                <div className="mt-3 h-2 rounded-full bg-zinc-800 overflow-hidden">
                  <div
                    className="h-full bg-amber-500 transition-[width] duration-200"
                    style={{ width: `${renderStatus.progress}%` }}
                  />
                </div>
                <input
                  type="range"
                  min={exportSettings.inFrame}
                  max={exportSettings.outFrame}
                  step={1}
                  value={previewFrame}
                  onChange={(event) => {
                    setIsPreviewPlaying(false);
                    setPreviewFrame(Number(event.target.value));
                  }}
                  className="mt-4 w-full accent-amber-500"
                />
              </div>
            </div>
          </div>
        </main>

        <aside className="min-h-0 border-l border-zinc-800 bg-[#111317] overflow-hidden">
          <div className="h-full p-3 space-y-3 flex flex-col">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[10px] tracking-[0.3em] uppercase text-zinc-500">Render Queue</div>
                <div className="text-base font-semibold">Jobs</div>
              </div>
              <div className="text-sm text-zinc-500">{queueItems.length}</div>
            </div>

            <div className="flex-1 min-h-0 space-y-2 overflow-hidden">
              {queueItems.length === 0 && (
                <div className="rounded-2xl border border-dashed border-zinc-800 bg-[#171a1f] p-4 text-sm text-zinc-500">
                  Queue an export from the left panel to render it here.
                </div>
              )}

              {queueItems.map((item) => {
                const selected = item.id === selectedQueueId;
                const active = item.id === activeQueueId;

                return (
                  <div
                    key={item.id}
                    className={`rounded-2xl border p-3 transition-colors ${
                      selected
                        ? "border-amber-500/70 bg-amber-500/10"
                        : "border-zinc-800 bg-[#171a1f] hover:border-zinc-700"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => handleQueueSelect(item)}
                      className="w-full text-left space-y-2"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-xs font-medium text-zinc-100">{item.fileName}.mp4</div>
                          <div className="text-xs text-zinc-500">{item.createdAt}</div>
                        </div>
                        <div
                          className={`px-2 py-1 rounded-full text-[10px] uppercase tracking-[0.18em] ${
                            item.status === "done"
                              ? "bg-emerald-500/10 text-emerald-300"
                              : item.status === "error"
                                ? "bg-red-500/10 text-red-300"
                                : active
                                  ? "bg-amber-500/10 text-amber-300"
                                  : "bg-zinc-800 text-zinc-400"
                          }`}
                        >
                          {active ? "Rendering" : item.status}
                        </div>
                      </div>
                      <div className="text-xs text-zinc-400">{summarizeQueueItem(item)}</div>
                      <div className="text-xs text-zinc-500">
                        Frames {item.inFrame} - {item.outFrame}
                      </div>
                      <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                        <div className="h-full bg-amber-500" style={{ width: `${item.progress}%` }} />
                      </div>
                      <div className="text-xs text-zinc-400">{item.statusText}</div>
                      {item.error && <div className="text-xs text-red-300">{item.error}</div>}
                      {item.resultPath && <div className="text-xs text-zinc-500 break-all">{item.resultPath}</div>}
                    </button>

                      <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void runQueuedJobs([item.id])}
                        disabled={isRendering}
                        className="flex-1 rounded-lg border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-200 hover:border-zinc-500 disabled:opacity-40"
                      >
                        Render
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveQueueItem(item.id)}
                        disabled={active}
                        className="rounded-lg border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-400 hover:text-white hover:border-zinc-500 disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {!isTauriDesktop() && (
              <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
                This window is configured for the Tauri desktop build. Native FFmpeg export will fail in a plain browser tab.
              </div>
            )}

            {error && project && (
              <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
                {error}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
};

export default MapRenderer;
