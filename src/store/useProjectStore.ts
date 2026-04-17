import { create } from 'zustand';
import type { ProjectSettings, TimelineElement, Marker } from '../types';

interface ProjectState {
  // Project Data
  project: ProjectSettings | null;
  timelineElements: TimelineElement[];
  markers: Marker[];
  
  // Editor View State
  activeElementId: string | null;
  currentFrame: number;
  isPlaying: boolean;
  timelineZoom: number; // pixels per frame
  snappingEnabled: boolean;
  activeTool: "pointer" | "blade";
  trackStates: Record<number, { locked: boolean; hidden: boolean }>;


  // Actions
  setProject: (project: ProjectSettings | null) => void;
  setTimelineElements: (elements: TimelineElement[] | ((prev: TimelineElement[]) => TimelineElement[])) => void;
  setMarkers: (markers: Marker[] | ((prev: Marker[]) => Marker[])) => void;
  setActiveElementId: (id: string | null) => void;
  setFrame: (frame: number) => void;
  setIsPlaying: (isPlaying: boolean) => void;
  setTimelineZoom: (zoom: number) => void;
  setSnappingEnabled: (enabled: boolean) => void;
  setActiveTool: (tool: "pointer" | "blade") => void;
  toggleTrackState: (trackIndex: number, property: "locked" | "hidden") => void;


  // Timeline Utilities
  addTimelineElement: (element: TimelineElement, isInsert?: boolean) => void;
  moveTimelineElement: (id: string, newStart: number, newTrack: number, isInsert: boolean) => void;
  updateTimelineElement: (id: string, updates: Partial<TimelineElement>) => void;
  deleteTimelineElement: (id: string) => void;
  rippleDeleteTimelineElement: (id: string) => void;
  splitTimelineElement: (id: string, frame: number) => void;
  trimTimelineElement: (id: string, side: "start" | "end", newFrame: number, ripple: boolean) => void;
  snapFrame: (frame: number) => number;

  // Keyframe Actions
  addKeyframe: (elementId: string, property: string, frameOffset: number, value: any) => void;
  removeKeyframe: (elementId: string, keyframeId: string) => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: null,
  timelineElements: [],
  markers: [],
  
  activeElementId: null,
  currentFrame: 0,
  isPlaying: false,
  timelineZoom: 2,
  snappingEnabled: true,
  activeTool: "pointer",
  trackStates: {
    0: { locked: false, hidden: false },
    1: { locked: false, hidden: false },
    2: { locked: false, hidden: false },
    3: { locked: false, hidden: false },
  },

  setProject: (project) => set((state) => ({ 
    project, 
    currentFrame: project ? project.startFrame : 0,
    // Initialize trackStates from project if available
    trackStates: project?.trackStates 
      ? Object.fromEntries(project.trackStates.map(ts => [ts.id, { locked: ts.locked, hidden: ts.hidden }]))
      : state.trackStates
  })),

  
  setTimelineElements: (param) => set((state) => ({
    timelineElements: typeof param === 'function' ? param(state.timelineElements) : param
  })),

  setMarkers: (param) => set((state) => {
    const newMarkers = typeof param === 'function' ? param(state.markers) : param;
    return {
      markers: newMarkers,
      project: state.project ? { ...state.project, markers: newMarkers } : null
    };
  }),

  setActiveElementId: (id) => set({ activeElementId: id }),
  
  setFrame: (frame) => set({ currentFrame: frame }),
  
  setIsPlaying: (isPlaying) => set({ isPlaying }),
  
  setTimelineZoom: (zoom) => set({ timelineZoom: zoom }),
  
  setSnappingEnabled: (snappingEnabled) => set({ snappingEnabled }),
  
  setActiveTool: (activeTool) => set({ activeTool }),

  addTimelineElement: (element, isInsert) => set((state) => {
    let updated = [...state.timelineElements];
    if (isInsert) {
      updated = updated.map(e => {
        if (e.trackIndex === element.trackIndex && e.startFrame >= element.startFrame) {
          return { ...e, startFrame: e.startFrame + element.durationFrames };
        }
        return e;
      });
    }
    return { timelineElements: [...updated, element] };
  }),

  moveTimelineElement: (id, newStart, newTrack, isInsert) => set((state) => {
    const el = state.timelineElements.find(e => e.id === id);
    if (!el) return state;

    // Guard: Prevent moving if current or target track is locked
    if (state.trackStates[el.trackIndex]?.locked || state.trackStates[newTrack]?.locked) {
      return state;
    }

    let updated = state.timelineElements.filter(e => e.id !== id);
    
    if (isInsert) {
      updated = updated.map(e => {
        if (e.trackIndex === newTrack && e.startFrame >= newStart) {
          return { ...e, startFrame: e.startFrame + el.durationFrames };
        }
        return e;
      });
    }
    
    updated.push({ ...el, startFrame: newStart, trackIndex: newTrack });
    return { timelineElements: updated };
  }),

  updateTimelineElement: (id, updates) => set((state) => ({
    timelineElements: state.timelineElements.map(el => 
      el.id === id ? { ...el, ...updates } : el
    )
  })),

  deleteTimelineElement: (id) => set((state) => ({
    timelineElements: state.timelineElements.filter(el => el.id !== id),
    activeElementId: state.activeElementId === id ? null : state.activeElementId
  })),

  rippleDeleteTimelineElement: (id) => set((state) => {
    const elToDelete = state.timelineElements.find(e => e.id === id);
    if (!elToDelete) return state;

    const remaining = state.timelineElements.filter(e => e.id !== id);
    const updated = remaining.map(e => {
      // Shift elements on the same track that start after this one
      if (e.trackIndex === elToDelete.trackIndex && e.startFrame >= elToDelete.startFrame) {
        return { ...e, startFrame: Math.max(0, e.startFrame - elToDelete.durationFrames) };
      }
      return e;
    });

    return {
      timelineElements: updated,
      activeElementId: state.activeElementId === id ? null : state.activeElementId
    };
  }),

  splitTimelineElement: (id, frame) => set((state) => {
    const el = state.timelineElements.find(e => e.id === id);
    if (!el || frame <= el.startFrame || frame >= el.startFrame + el.durationFrames) return state;

    const dur1 = frame - el.startFrame;
    const dur2 = el.durationFrames - dur1;

    const newEl: TimelineElement = {
      ...el,
      id: `clip-${Date.now()}`,
      startFrame: frame,
      durationFrames: dur2
    };

    return {
      timelineElements: [
        ...state.timelineElements.map(p => p.id === id ? { ...p, durationFrames: dur1 } : p),
        newEl
      ]
    };
  }),

  trimTimelineElement: (id, side, newFrame, ripple) => set((state) => {
    const el = state.timelineElements.find(e => e.id === id);
    if (!el) return state;

    // Guard: Prevent trimming if track is locked
    if (state.trackStates[el.trackIndex]?.locked) {
      return state;
    }

    let delta = 0;

    let newStart = el.startFrame;
    let newDuration = el.durationFrames;

    if (side === "start") {
      const maxStart = el.startFrame + el.durationFrames - 1;
      newStart = Math.min(newFrame, maxStart);
      newStart = Math.max(0, newStart);
      delta = newStart - el.startFrame;
      newDuration = el.durationFrames - delta;
    } else {
      const minEnd = el.startFrame + 1;
      const endFrame = Math.max(newFrame, minEnd);
      newDuration = endFrame - el.startFrame;
      delta = newDuration - el.durationFrames;
    }

    const updated = state.timelineElements.map(e => {
      if (e.id === id) {
        return { ...e, startFrame: newStart, durationFrames: newDuration };
      }
      if (ripple && e.trackIndex === el.trackIndex && e.startFrame >= el.startFrame) {
         // shift any subsequent clips by the delta
         return { ...e, startFrame: Math.max(0, e.startFrame + delta) };
      }
      return e;
    });

    return { timelineElements: updated };
  }),

  snapFrame: (frame) => {
    const state = get();
    if (!state.snappingEnabled || !state.project) return frame;
    
    const targets = new Set<number>();
    targets.add(0);
    targets.add(state.project.durationFrames);
    state.timelineElements.forEach(el => {
      targets.add(el.startFrame);
      targets.add(el.startFrame + el.durationFrames);
    });
    state.project.markers?.forEach(m => targets.add(m.frame));
    
    const threshold = Math.max(1, Math.round(10 / state.timelineZoom));
    let closest = frame;
    let minDiff = threshold + 1;
    
    targets.forEach(t => {
      const diff = Math.abs(t - frame);
      if (diff < minDiff) {
        minDiff = diff;
        closest = t;
      }
    });
    
    return closest;
  },

  addKeyframe: (elementId, property, frameOffset, value) => set((state) => {
    const el = state.timelineElements.find(e => e.id === elementId);
    if (!el) return state;

    const newKeyframe: any = {
      id: `kf-${Date.now()}`,
      frameOffset,
      property,
      value,
      easing: "ease-in-out"
    };

    const keyframes = el.keyframes || [];
    // Remove existing keyframe at same offset and property if exists
    const filtered = keyframes.filter(kf => kf.property !== property || kf.frameOffset !== frameOffset);
    
    return {
      timelineElements: state.timelineElements.map(e => 
        e.id === elementId ? { ...e, keyframes: [...filtered, newKeyframe].sort((a, b) => a.frameOffset - b.frameOffset) } : e
      )
    };
  }),

  removeKeyframe: (elementId, keyframeId) => set((state) => ({
    timelineElements: state.timelineElements.map(e => 
      e.id === elementId ? { ...e, keyframes: (e.keyframes || []).filter(kf => kf.id !== keyframeId) } : e
    )
  })),

  toggleTrackState: (trackIndex, property) => set((state) => ({
    trackStates: {
      ...state.trackStates,
      [trackIndex]: {
        ...state.trackStates[trackIndex],
        [property]: !state.trackStates[trackIndex][property]
      }
    }
  })),
}));
