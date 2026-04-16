export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
  durationFrames: number;
}

export type TimelineElementType = "location" | "effect_detail";

export interface LocationPayload {
  id: string;
  center: [number, number];
  zoom: number;
  color: string;
  type: string;
  display_name: string;
  geojson?: Record<string, unknown>;
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
