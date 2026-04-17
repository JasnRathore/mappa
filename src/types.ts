export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
  durationFrames: number;
  startFrame: number;
  endFrame: number;
  markers?: Marker[];
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
  center: [number, number];
  zoom: number;
  color?: string;
  type?: string;
  display_name?: string;
  geojson?: Record<string, unknown>;
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
}
