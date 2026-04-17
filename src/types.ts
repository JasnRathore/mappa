import type { Geometry } from "geojson";

export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
  durationFrames: number;
  startFrame: number;
  endFrame: number;
  markers?: Marker[];
  trackStates?: TrackState[];
}

export interface TrackState {
  id: number; // correlates to trackIndex
  locked: boolean;
  hidden: boolean;
}

export interface Marker {
  id: string;
  frame: number;
  label: string;
  color: string;
}

export type TimelineElementType = "location" | "effect_detail";

export interface LocationPayload {
  id: string;
  name?: string;
  center: [number, number];
  zoom: number;
  color?: string;
  type?: string;
  display_name?: string;
  geojson?: Geometry;
  bearing?: number;
  pitch?: number;
  transition?: string; // "fly", "ease", "jump", "pan", "zoom_in", "zoom_out", "rotate", "tilt", "fit_bounds"
  transitionMS?: number;
  highlightEnabled?: boolean;
  fadeInFrames?: number;
  fadeOutFrames?: number;
}

export interface DetailEffectPayload {
  detailLevel: number; // 0-100
}

export interface Keyframe {
  id: string;
  frameOffset: number; // relative to element start
  property: string; // "center", "zoom", "bearing", "pitch", "opacity", "detailLevel"
  value: any;
  easing?: string; // "linear", "ease-in", "ease-out", "ease-in-out"
}

export interface TimelineElement {
  id: string; // unique id for the timeline instance
  name: string;
  type: TimelineElementType;
  trackIndex: number;
  startFrame: number;
  durationFrames: number;

  // Type-specific data
  locationPayload?: LocationPayload;
  effectPayload?: DetailEffectPayload;
  
  // Animation data
  keyframes?: Keyframe[];
}
