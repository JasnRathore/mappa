import maplibregl from "maplibre-gl";
import {
  applyDeterministicTimelineFrameToMap,
  createMapPlaybackCache,
  resolveCameraStateAtFrame,
} from "./mapPlayback";
import type { TimelineElement } from "../types";

interface PreloadTimelineMapParams {
  map: maplibregl.Map;
  timelineElements: TimelineElement[];
  fps: number;
  startFrame: number;
  endFrame: number;
  onProgress?: (completed: number, total: number, frame: number) => void;
}

const MAX_PRELOAD_SAMPLES = 72;

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

const waitForMapIdle = (map: maplibregl.Map, timeoutMs = 1200) =>
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

const clampFrame = (frame: number, startFrame: number, endFrame: number) =>
  Math.min(endFrame, Math.max(startFrame, frame));

const sampleTimelineFrames = (
  timelineElements: TimelineElement[],
  fps: number,
  startFrame: number,
  endFrame: number
) => {
  const frames = new Set<number>([startFrame, endFrame]);
  const totalFrames = endFrame - startFrame + 1;
  const adaptiveStep = Math.max(
    Math.max(1, Math.floor(fps / 4)),
    Math.ceil(totalFrames / MAX_PRELOAD_SAMPLES)
  );

  for (let frame = startFrame; frame <= endFrame; frame += adaptiveStep) {
    frames.add(frame);
  }

  timelineElements
    .filter((element) => element.type === "location")
    .forEach((element) => {
      const clipStart = clampFrame(element.startFrame, startFrame, endFrame);
      const clipEnd = clampFrame(
        element.startFrame + element.durationFrames - 1,
        startFrame,
        endFrame
      );
      const transitionFrames = Math.max(
        1,
        Math.min(
          element.durationFrames,
          Math.round(((element.locationPayload?.transitionMS ?? 1000) / 1000) * fps)
        )
      );

      frames.add(clipStart);
      frames.add(clipEnd);
      frames.add(clampFrame(clipStart + Math.floor(transitionFrames / 2), startFrame, endFrame));
      frames.add(clampFrame(clipStart + transitionFrames - 1, startFrame, endFrame));
    });

  const sorted = Array.from(frames).sort((a, b) => a - b);
  if (sorted.length <= MAX_PRELOAD_SAMPLES) {
    return sorted;
  }

  const condensed: number[] = [];
  const stride = Math.ceil(sorted.length / MAX_PRELOAD_SAMPLES);
  for (let index = 0; index < sorted.length; index += stride) {
    condensed.push(sorted[index]);
  }

  if (!condensed.includes(startFrame)) {
    condensed.unshift(startFrame);
  }
  if (!condensed.includes(endFrame)) {
    condensed.push(endFrame);
  }

  return condensed.sort((a, b) => a - b);
};

export const preloadTimelineMapResources = async ({
  map,
  timelineElements,
  fps,
  startFrame,
  endFrame,
  onProgress,
}: PreloadTimelineMapParams) => {
  const frames = sampleTimelineFrames(timelineElements, fps, startFrame, endFrame);
  const cache = createMapPlaybackCache();

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    applyDeterministicTimelineFrameToMap({
      map,
      frameIndex: frame,
      timelineElements,
      fps,
      cache,
    });
    await waitForAnimationFrames(2);
    await waitForMapIdle(map, 1500);
    onProgress?.(index + 1, frames.length, frame);
  }

  applyDeterministicTimelineFrameToMap({
    map,
    frameIndex: startFrame,
    timelineElements,
    fps,
    cache: createMapPlaybackCache(),
  });
  await waitForAnimationFrames(1);
};

export const createTimelinePreloadKey = ({
  timelineElements,
  fps,
  startFrame,
  endFrame,
}: {
  timelineElements: TimelineElement[];
  fps: number;
  startFrame: number;
  endFrame: number;
}) => {
  const signature = timelineElements
    .map((element) => {
      if (element.type !== "location" || !element.locationPayload) {
        return `${element.id}:${element.startFrame}:${element.durationFrames}:${element.trackIndex}`;
      }

      const state = resolveCameraStateAtFrame(element.startFrame, timelineElements, fps);
      return [
        element.id,
        element.startFrame,
        element.durationFrames,
        element.trackIndex,
        state.center[0].toFixed(4),
        state.center[1].toFixed(4),
        state.zoom.toFixed(2),
        state.bearing.toFixed(1),
        state.pitch.toFixed(1),
      ].join(":");
    })
    .join("|");

  return `${fps}:${startFrame}:${endFrame}:${signature}`;
};
