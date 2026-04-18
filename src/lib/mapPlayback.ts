import maplibregl from "maplibre-gl";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { TimelineElement } from "../types";

const HIGHLIGHT_OPACITY = 0.4;

export const DEFAULT_CAMERA_STATE = {
  center: [0, 20] as [number, number],
  zoom: 1.5,
  bearing: 0,
  pitch: 0,
};

export interface CameraState {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
}

export interface MapPlaybackCache {
  lastCameraKey: string | null;
  lastDetailLevel: number | null;
  lastGeoJson: string;
  lastCenter: [number, number] | null;
}

interface ApplyTimelineFrameParams {
  map: maplibregl.Map;
  frameIndex: number;
  timelineElements: TimelineElement[];
  trackStates: Record<number, { locked: boolean; hidden: boolean }>;
  fps: number;
  cache: MapPlaybackCache;
}

export const createMapPlaybackCache = (): MapPlaybackCache => ({
  lastCameraKey: null,
  lastDetailLevel: null,
  lastGeoJson: "",
  lastCenter: null,
});

export const applyTimelineFrameToMap = (params: ApplyTimelineFrameParams) => {
  applyAnimatedTimelineCamera(params);
  applyTimelineDecorations(params);
};

export const applyDeterministicTimelineFrameToMap = (params: ApplyTimelineFrameParams) => {
  const cameraState = resolveCameraStateAtFrame(
    params.frameIndex,
    params.timelineElements,
    params.fps,
    params.trackStates
  );

  const cameraKey = [
    cameraState.center[0].toFixed(6),
    cameraState.center[1].toFixed(6),
    cameraState.zoom.toFixed(4),
    cameraState.bearing.toFixed(2),
    cameraState.pitch.toFixed(2),
  ].join(":");

  // Detect motion velocity for adaptive detail
  let isMovingFast = false;
  if (params.cache.lastCenter) {
    const dx = cameraState.center[0] - params.cache.lastCenter[0];
    const dy = cameraState.center[1] - params.cache.lastCenter[1];
    const velocity = Math.sqrt(dx * dx + dy * dy);
    // Threshold for "fast" movement (approx. 0.5 degrees per frame)
    isMovingFast = velocity > 0.5;
  }
  params.cache.lastCenter = cameraState.center;

  if (params.cache.lastCameraKey !== cameraKey) {
    params.cache.lastCameraKey = cameraKey;
    params.map.stop();
    params.map.jumpTo(cameraState);
  }

  applyTimelineDecorations({ ...params, isMovingFast });
};

const cameraMemo = new Map<string, CameraState>();

export const resolveCameraStateAtFrame = (
  frameIndex: number,
  timelineElements: TimelineElement[],
  fps: number,
  trackStates?: Record<number, { locked: boolean; hidden: boolean }>
): CameraState => {
  const memoKey = `${frameIndex}-${timelineElements.length}-${timelineElements.map(e => e.id).join(",")}-${Object.values(trackStates || {}).map(s => s.hidden).join(",")}`;
  const cached = cameraMemo.get(memoKey);
  if (cached) return cached;

  const activeLocations = timelineElements
    .filter(
      (el) =>
        el.type === "location" &&
        frameIndex >= el.startFrame &&
        frameIndex < el.startFrame + el.durationFrames &&
        (!trackStates || !trackStates[el.trackIndex]?.hidden)
    )
    .sort((a, b) => b.trackIndex - a.trackIndex);


  if (activeLocations.length === 0) {
    return DEFAULT_CAMERA_STATE;
  }

  // Use the top-most clip as the primary driver
  const el = activeLocations[0];
  const loc = el.locationPayload;
  
  if (!loc) return DEFAULT_CAMERA_STATE;

  const frameOffset = frameIndex - el.startFrame;
  
  // Group keyframes by property once per frame
  const kfGroups: Record<string, Keyframe[]> = {};
  (el.keyframes || []).forEach(kf => {
    if (!kfGroups[kf.property]) kfGroups[kf.property] = [];
    kfGroups[kf.property].push(kf);
  });

  // Resolve each property using keyframes or fallback to base payload
  const resolvedZoom = resolveKeyframedValue(kfGroups["zoom"] || [], frameOffset, loc.zoom, "zoom");
  const resolvedCenter = resolveKeyframedValue(kfGroups["center"] || [], frameOffset, loc.center, "center");
  const resolvedPitch = resolveKeyframedValue(kfGroups["pitch"] || [], frameOffset, loc.pitch || 0, "pitch");
  const resolvedBearing = resolveKeyframedValue(kfGroups["bearing"] || [], frameOffset, loc.bearing || 0, "bearing");

  const targetState: CameraState = {
    center: resolvedCenter,
    zoom: resolvedZoom,
    pitch: resolvedPitch,
    bearing: resolvedBearing
  };

  // If there are NO keyframes at all, we fall back to the old transition-at-start logic
  if (!el.keyframes || el.keyframes.length === 0) {
     const transition = loc.transition || "fly";
     const transitionFrames = getTransitionFrameCount(el, fps);
     const transitionEndFrame = el.startFrame + transitionFrames - 1;

     if (transition !== "jump" && frameIndex <= transitionEndFrame) {
        const previousState = resolveCameraStateAtFrame(el.startFrame - 1, timelineElements, fps, trackStates);
        const progress = getTransitionProgress(frameIndex, el.startFrame, transitionFrames);
        const easedProgress = applyTransitionEasing(progress, transition);
        const resolvedState = interpolateCameraState(previousState, targetState, easedProgress);

        
        cameraMemo.set(memoKey, resolvedState);
        return resolvedState;
     }
  }

  cameraMemo.set(memoKey, targetState);
  
  // Keep memo size in check
  if (cameraMemo.size > 2000) {
    const firstKey = cameraMemo.keys().next().value;
    if (firstKey) cameraMemo.delete(firstKey);
  }

  return targetState;
};

const resolveKeyframedValue = (kfs: Keyframe[], offset: number, defaultValue: unknown, property: string) => {
  if (kfs.length === 0) return defaultValue;

  // Find surrounding keyframes
  const nextIndex = kfs.findIndex(k => k.frameOffset >= offset);
  
  if (nextIndex === -1) {
    // Past the last keyframe
    return kfs[kfs.length - 1].value;
  }
  
  if (nextIndex === 0) {
    if (kfs[0].frameOffset === offset) return kfs[0].value;
    // Before the first keyframe
    return kfs[0].value;
  }

  const prev = kfs[nextIndex - 1];
  const next = kfs[nextIndex];
  
  const span = next.frameOffset - prev.frameOffset;
  const progress = (offset - prev.frameOffset) / span;
  
  // Use easing from the 'next' keyframe which dictates the arrival
  const easing = next.easing || "ease-in-out";
  const eased = applyTransitionEasing(progress, easing === "ease-in-out" ? "ease" : "linear");

  if (property === "center") {
    return [
      lerp(prev.value[0], next.value[0], eased),
      lerp(prev.value[1], next.value[1], eased)
    ] as [number, number];
  }

  if (property === "bearing") {
    return prev.value + shortestAngleDelta(prev.value, next.value) * eased;
  }

  return lerp(prev.value, next.value, eased);
};

const applyAnimatedTimelineCamera = ({
  map,
  frameIndex,
  timelineElements,
  trackStates,
  fps,
  cache,
}: ApplyTimelineFrameParams) => {
  const activeElements = timelineElements.filter(
    (el) => 
      frameIndex >= el.startFrame && 
      frameIndex < el.startFrame + el.durationFrames &&
      (!trackStates || !trackStates[el.trackIndex]?.hidden)
  );

  const activeLocations = activeElements.filter((el) => el.type === "location");
  const startingLocations = activeLocations
    .filter((el) => el.startFrame === frameIndex)
    .sort((a, b) => b.trackIndex - a.trackIndex);
  const topActiveLocation = [...activeLocations].sort((a, b) => b.trackIndex - a.trackIndex)[0];
  const cameraElement = startingLocations.length > 0 ? startingLocations[0] : topActiveLocation;

  const locKey = cameraElement
    ? `${cameraElement.id}-${cameraElement.locationPayload?.zoom}-${cameraElement.locationPayload?.bearing}-${cameraElement.locationPayload?.pitch}-${cameraElement.locationPayload?.transition}-${cameraElement.locationPayload?.color}-${JSON.stringify(cameraElement.locationPayload?.center)}`
    : null;

  if (locKey === cache.lastCameraKey || !cameraElement?.locationPayload) {
    return;
  }

  cache.lastCameraKey = locKey;

  const loc = cameraElement.locationPayload;
  const transition = loc.transition || "fly";
  const clipMs = (cameraElement.durationFrames / fps) * 1000;
  const duration = loc.transitionMS || Math.min(2000, clipMs);
  const options = {
    center: loc.center,
    zoom: loc.zoom,
    bearing: loc.bearing || 0,
    pitch: loc.pitch || 0,
    duration,
    essential: true,
  };

  map.stop();

  switch (transition) {
    case "jump":
      map.jumpTo({
        center: loc.center,
        zoom: loc.zoom,
        bearing: loc.bearing || 0,
        pitch: loc.pitch || 0,
      });
      break;
    case "ease":
      map.easeTo(options);
      break;
    case "pan":
      map.panTo(loc.center, { duration, essential: true });
      break;
    case "rotate":
      map.easeTo(options);
      break;
    case "tilt":
      map.easeTo(options);
      break;
    case "zoom_in":
      map.flyTo({ ...options, zoom: loc.zoom + 1 });
      break;
    case "zoom_out":
      map.flyTo({ ...options, zoom: loc.zoom - 1 });
      break;
    case "fit_bounds":
      map.flyTo(options);
      break;
    case "fly":
    default:
      map.flyTo(options);
      break;
  }
};

interface ApplyTimelineDecorationsParams extends ApplyTimelineFrameParams {
  isMovingFast?: boolean;
}

const applyTimelineDecorations = ({
  map,
  frameIndex,
  timelineElements,
  cache,
  isMovingFast,
}: ApplyTimelineDecorationsParams) => {
  if (!map.isStyleLoaded()) {
    return;
  }

  const activeElements = timelineElements.filter(
    (el) => frameIndex >= el.startFrame && frameIndex < el.startFrame + el.durationFrames
  );

  const activeLocations = activeElements.filter((el) => el.type === "location");
  const activeEffect = activeElements
    .filter((el) => el.type === "effect_detail")
    .sort((a, b) => b.trackIndex - a.trackIndex)[0];

  const source = map.getSource("city-area") as maplibregl.GeoJSONSource | undefined;
  if (source) {
    const signature = activeLocations
      .map(el => `${el.id}:${el.locationPayload?.opacity ?? 1}`)
      .join("|");

    if (signature !== cache.lastGeoJson) {
      cache.lastGeoJson = signature;
      const features: Feature<Geometry, { color: string; opacity: number }>[] = activeLocations.map(
        (el) => {
          let alpha = HIGHLIGHT_OPACITY;
          const loc = el.locationPayload;
          const fallbackCenter: [number, number] = loc?.center ?? [0, 0];

          if (loc?.highlightEnabled === false) {
            alpha = 0;
          } else if (loc) {
            const fadeInFrames = loc.fadeInFrames || 0;
            const fadeOutFrames = loc.fadeOutFrames || 0;
            const frameIn = frameIndex - el.startFrame;
            const frameOut = el.startFrame + el.durationFrames - frameIndex;

            if (fadeInFrames > 0 && frameIn < fadeInFrames) {
              alpha = HIGHLIGHT_OPACITY * (frameIn / fadeInFrames);
            } else if (fadeOutFrames > 0 && frameOut <= fadeOutFrames) {
              alpha = HIGHLIGHT_OPACITY * (frameOut / fadeOutFrames);
            }
          }

          return {
            type: "Feature",
            properties: {
              color: loc?.color || "#f97316",
              opacity: alpha,
            },
            geometry: loc?.geojson || { type: "Point", coordinates: fallbackCenter },
          };
        }
      );

      const featureCollection: FeatureCollection<Geometry, { color: string; opacity: number }> = {
        type: "FeatureCollection",
        features,
      };
      source.setData(featureCollection);
    }
  }

  const detailLevel = activeEffect?.effectPayload?.detailLevel ?? 100;
  if (detailLevel === cache.lastDetailLevel) {
    return;
  }

  cache.lastDetailLevel = detailLevel;

  const style = map.getStyle();
  if (!style?.layers) {
    return;
  }

  style.layers.forEach((layer) => {
    const isLabel = layer.id.includes("label") || layer.id.includes("place");
    const isTransit =
      layer.id.includes("rail") ||
      layer.id.includes("transit") ||
      layer.id.includes("airport");
    const isSmallRoad = layer.id.includes("road") && !layer.id.includes("motorway");
    const isBuilding = layer.id.includes("building");

    let visible = "visible";
    if (isMovingFast || detailLevel < 30) {
      if (isLabel || isTransit || isSmallRoad || isBuilding) {
        visible = "none";
      }
    } else if (detailLevel < 70) {
      if (isSmallRoad || isBuilding) {
        visible = "none";
      }
    }

    map.setLayoutProperty(layer.id, "visibility", visible);
  });
};



const getTransitionFrameCount = (element: TimelineElement, fps: number) => {
  const loc = element.locationPayload;
  if (!loc) {
    return 1;
  }

  if (loc.transition === "jump") {
    return 1;
  }

  const clipMs = (element.durationFrames / fps) * 1000;
  const durationMs = loc.transitionMS || Math.min(2000, clipMs);
  return Math.max(1, Math.min(element.durationFrames, Math.round((durationMs / 1000) * fps)));
};

const getTransitionProgress = (frame: number, startFrame: number, durationFrames: number) => {
  if (durationFrames <= 1) {
    return 1;
  }

  const rawProgress = (frame - startFrame) / Math.max(1, durationFrames - 1);
  return clamp(rawProgress, 0, 1);
};

const applyTransitionEasing = (progress: number, transition: string) => {
  switch (transition) {
    case "ease":
    case "rotate":
    case "tilt":
      return easeInOutCubic(progress);
    case "fly":
    case "fit_bounds":
    case "zoom_in":
    case "zoom_out":
      return easeOutCubic(progress);
    case "pan":
      return easeInOutSine(progress);
    default:
      return progress;
  }
};

const interpolateCameraState = (
  fromState: CameraState,
  toState: CameraState,
  progress: number
): CameraState => ({
  center: [
    lerp(fromState.center[0], toState.center[0], progress),
    lerp(fromState.center[1], toState.center[1], progress),
  ],
  zoom: lerp(fromState.zoom, toState.zoom, progress),
  bearing: fromState.bearing + shortestAngleDelta(fromState.bearing, toState.bearing) * progress,
  pitch: lerp(fromState.pitch, toState.pitch, progress),
});

const lerp = (from: number, to: number, progress: number) => from + (to - from) * progress;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const easeInOutCubic = (value: number) =>
  value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;

const easeOutCubic = (value: number) => 1 - Math.pow(1 - value, 3);

const easeInOutSine = (value: number) => -(Math.cos(Math.PI * value) - 1) / 2;

const shortestAngleDelta = (from: number, to: number) => {
  const delta = ((to - from + 540) % 360) - 180;
  return delta === -180 ? 180 : delta;
};
