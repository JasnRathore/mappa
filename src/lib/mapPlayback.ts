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
}

interface ApplyTimelineFrameParams {
  map: maplibregl.Map;
  frameIndex: number;
  timelineElements: TimelineElement[];
  fps: number;
  cache: MapPlaybackCache;
}

export const createMapPlaybackCache = (): MapPlaybackCache => ({
  lastCameraKey: null,
  lastDetailLevel: null,
  lastGeoJson: "",
});

export const applyTimelineFrameToMap = (params: ApplyTimelineFrameParams) => {
  applyAnimatedTimelineCamera(params);
  applyTimelineDecorations(params);
};

export const applyDeterministicTimelineFrameToMap = (params: ApplyTimelineFrameParams) => {
  const cameraState = resolveCameraStateAtFrame(
    params.frameIndex,
    params.timelineElements,
    params.fps
  );
  const cameraKey = [
    cameraState.center[0].toFixed(6),
    cameraState.center[1].toFixed(6),
    cameraState.zoom.toFixed(4),
    cameraState.bearing.toFixed(2),
    cameraState.pitch.toFixed(2),
  ].join(":");

  if (params.cache.lastCameraKey !== cameraKey) {
    params.cache.lastCameraKey = cameraKey;
    params.map.stop();
    params.map.jumpTo(cameraState);
  }

  applyTimelineDecorations(params);
};

export const resolveCameraStateAtFrame = (
  frameIndex: number,
  timelineElements: TimelineElement[],
  fps: number
): CameraState => {
  const memo = new Map<number, CameraState>();

  const resolve = (targetFrame: number): CameraState => {
    if (targetFrame < 0) {
      return DEFAULT_CAMERA_STATE;
    }

    const cached = memo.get(targetFrame);
    if (cached) {
      return cached;
    }

    const activeLocations = timelineElements
      .filter(
        (el) =>
          el.type === "location" &&
          targetFrame >= el.startFrame &&
          targetFrame < el.startFrame + el.durationFrames
      )
      .sort((a, b) => b.trackIndex - a.trackIndex);

    if (activeLocations.length === 0) {
      memo.set(targetFrame, DEFAULT_CAMERA_STATE);
      return DEFAULT_CAMERA_STATE;
    }

    const controllingLocation =
      activeLocations.find((el) => el.startFrame === targetFrame) ?? activeLocations[0];

    if (!controllingLocation.locationPayload) {
      memo.set(targetFrame, DEFAULT_CAMERA_STATE);
      return DEFAULT_CAMERA_STATE;
    }

    const previousState =
      targetFrame <= controllingLocation.startFrame
        ? resolve(controllingLocation.startFrame - 1)
        : resolve(targetFrame - 1);

    const transition = controllingLocation.locationPayload.transition || "fly";
    const targetState = getTargetCameraState(controllingLocation, previousState);
    const transitionFrames = getTransitionFrameCount(controllingLocation, fps);
    const transitionEndFrame = controllingLocation.startFrame + transitionFrames - 1;

    let resolvedState = targetState;
    if (transition !== "jump" && targetFrame <= transitionEndFrame) {
      const progress = getTransitionProgress(
        targetFrame,
        controllingLocation.startFrame,
        transitionFrames
      );
      const easedProgress = applyTransitionEasing(progress, transition);
      resolvedState = interpolateCameraState(previousState, targetState, easedProgress);
    }

    memo.set(targetFrame, resolvedState);
    return resolvedState;
  };

  return resolve(frameIndex);
};

const applyAnimatedTimelineCamera = ({
  map,
  frameIndex,
  timelineElements,
  fps,
  cache,
}: ApplyTimelineFrameParams) => {
  const activeElements = timelineElements.filter(
    (el) => frameIndex >= el.startFrame && frameIndex < el.startFrame + el.durationFrames
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

const applyTimelineDecorations = ({
  map,
  frameIndex,
  timelineElements,
  cache,
}: ApplyTimelineFrameParams) => {
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

    const serialized = JSON.stringify(features);
    if (serialized !== cache.lastGeoJson) {
      cache.lastGeoJson = serialized;
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
    if (detailLevel < 30) {
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

const getTargetCameraState = (
  element: TimelineElement,
  previousState: CameraState
): CameraState => {
  const loc = element.locationPayload;
  if (!loc) {
    return previousState;
  }

  switch (loc.transition) {
    case "pan":
      return {
        ...previousState,
        center: loc.center,
      };
    case "zoom_in":
      return {
        center: loc.center,
        zoom: loc.zoom + 1,
        bearing: loc.bearing || 0,
        pitch: loc.pitch || 0,
      };
    case "zoom_out":
      return {
        center: loc.center,
        zoom: loc.zoom - 1,
        bearing: loc.bearing || 0,
        pitch: loc.pitch || 0,
      };
    default:
      return {
        center: loc.center,
        zoom: loc.zoom,
        bearing: loc.bearing || 0,
        pitch: loc.pitch || 0,
      };
  }
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
