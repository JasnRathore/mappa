import { create } from 'zustand';
import type { ProjectSettings, TimelineElement, Marker } from '../types';

interface ProjectState {
  // Project Data
  project: ProjectSettings | null;
  projectName: string;
  filePath: string | null;
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
  setProject: (project: ProjectSettings | null, name?: string, path?: string | null) => void;
  setTimelineElements: (elements: TimelineElement[] | ((prev: TimelineElement[]) => TimelineElement[])) => void;
  setMarkers: (markers: Marker[] | ((prev: Marker[]) => Marker[])) => void;
  setActiveElementId: (id: string | null) => void;
  setFrame: (frame: number) => void;
  setIsPlaying: (isPlaying: boolean) => void;
  setTimelineZoom: (zoom: number) => void;
  setSnappingEnabled: (enabled: boolean) => void;
  setActiveTool: (tool: "pointer" | "blade") => void;
  toggleTrackState: (trackIndex: number, property: "locked" | "hidden") => void;
  updateProjectSettings: (updates: Partial<ProjectSettings>) => void;
  addMarker: (frame: number) => void;
  deleteMarker: (id: string) => void;
  moveMarker: (id: string, frame: number) => void;

  // Persistence Actions
  saveProject: (asNewPath?: boolean) => Promise<boolean>;
  loadProject: (path?: string) => Promise<boolean>;
  newProject: (settings: ProjectSettings, name: string) => Promise<{ success: boolean; error?: string }>;
  deleteProject: (path: string) => Promise<boolean>;


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
  projectName: "Untitled Project",
  filePath: null,
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

  setProject: (project, name, path) => set((state) => ({ 
    project, 
    projectName: name ?? state.projectName,
    filePath: path !== undefined ? path : state.filePath,
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

  updateProjectSettings: (updates) => set((state) => {
    if (!state.project) return state;
    const newProject = { ...state.project, ...updates };
    
    // Auto-grow durationFrames if the endFrame is moved beyond the current duration
    if (newProject.endFrame > newProject.durationFrames) {
      newProject.durationFrames = newProject.endFrame;
    }
    
    return { project: newProject };
  }),

  addMarker: (frame) => set((state) => {
    const newMarker: Marker = {
      id: `m-${Date.now()}`,
      frame,
      label: `Marker ${state.markers.length + 1}`,
      color: "#3b82f6"
    };
    const updated = [...state.markers, newMarker];
    return { 
      markers: updated,
      project: state.project ? { ...state.project, markers: updated } : null
    };
  }),

  deleteMarker: (id) => set((state) => {
    const updated = state.markers.filter(m => m.id !== id);
    return {
      markers: updated,
      project: state.project ? { ...state.project, markers: updated } : null
    };
  }),

  moveMarker: (id, frame) => set((state) => {
    const updated = state.markers.map(m => m.id === id ? { ...m, frame } : m);
    return {
      markers: updated,
      project: state.project ? { ...state.project, markers: updated } : null
    };
  }),

  newProject: async (settings, name) => {
    try {
      const { appLocalDataDir, join } = await import('@tauri-apps/api/path');
      const { exists, mkdir } = await import('@tauri-apps/plugin-fs');
      
      const localDir = await appLocalDataDir();
      const projectsDir = await join(localDir, 'projects');
      
      // Ensure the projects directory exists first
      if (!await exists(projectsDir)) {
        await mkdir(projectsDir, { recursive: true });
      }

      const sanitized = name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const potentialPath = await join(projectsDir, `${sanitized}.mappa`);
      
      console.log("[Mappa] New project target path:", potentialPath);

      if (await exists(potentialPath)) {
        return { success: false, error: "A project with this name already exists in your library." };
      }

      set({
        project: settings,
        projectName: name,
        filePath: potentialPath,
        timelineElements: [],
        markers: [],
        currentFrame: 0,
        activeElementId: null
      });
      
      console.log("[Mappa] Project initialized at:", potentialPath);

      // Instantly create the file on disk
      await get().saveProject();

      return { success: true };
    } catch (err: any) {
      console.error("New project error:", err);
      return { success: false, error: `System error: ${err.message || 'Failed to initialize project'}. Check permissions.` };
    }
  },

  saveProject: async (asNewPath = false) => {
    const { project, projectName, filePath, timelineElements, markers } = get();
    if (!project) return false;

    // Use current path if it exists and we're not Doing "Save As"
    let targetPath = filePath;
    
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeTextFile, mkdir, exists } = await import('@tauri-apps/plugin-fs');
    const { appLocalDataDir, join } = await import('@tauri-apps/api/path');

    // If we have no path (shouldn't happen with new logic, but safety first) 
    // or we WANT to export it somewhere else (asNewPath)
    if (asNewPath || !targetPath) {
      targetPath = await save({
        title: "Export Mappa Project",
        filters: [{ name: "Mappa Project", extensions: ["mappa", "json"] }],
        defaultPath: targetPath || `${projectName}.mappa`
      });
    }

    if (!targetPath) return false;

    try {
      // Ensure directory exists
      const localDir = await appLocalDataDir();
      const projectsDir = await join(localDir, 'projects');
      if (!await exists(projectsDir)) {
        await mkdir(projectsDir, { recursive: true });
      }

      const data = JSON.stringify({
        version: 1,
        projectName,
        project,
        timelineElements,
        markers
      }, null, 2);

      console.log("[Mappa] Writing data to:", targetPath);
      await writeTextFile(targetPath, data);
      console.log("[Mappa] Write successful.");
      
      const fileName = targetPath.split(/[\\/]/).pop() || projectName;
      const strippedName = fileName.replace(/\.mappa$|\.json$/, "");

      if (!asNewPath) {
        set({ filePath: targetPath, projectName: strippedName });
      }
      
      // Update Recent Registry
      updateRecentProjectsRegistry({
        name: strippedName,
        path: targetPath,
        lastModified: Date.now()
      });

      return true;
    } catch (err: any) {
      console.error("Failed to save project:", err);
      alert(`Save Error: ${err.message || String(err)}`);
      return false;
    }
  },

  loadProject: async (specificPath) => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { readTextFile } = await import('@tauri-apps/plugin-fs');

    let targetPath = specificPath;
    if (!targetPath) {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Mappa Project", extensions: ["mappa", "json"] }]
      });
      if (!selected || Array.isArray(selected)) return false;
      targetPath = selected;
    }

    try {
      const dataStr = await readTextFile(targetPath);
      const data = JSON.parse(dataStr);
      
      if (data.project && Array.isArray(data.timelineElements)) {
        const fileName = targetPath.split(/[\\/]/).pop() || data.projectName || "Untitled";
        const strippedName = fileName.replace(/\.mappa$|\.json$/, "");

        set({
          project: data.project,
          projectName: strippedName,
          filePath: targetPath,
          timelineElements: data.timelineElements,
          markers: data.markers || []
        });

        updateRecentProjectsRegistry({
          name: strippedName,
          path: targetPath,
          lastModified: Date.now()
        });

        return true;
      }
    } catch (err) {
      console.error("Failed to load project:", err);
    }
    return false;
  },

  deleteProject: async (path) => {
    const { remove } = await import('@tauri-apps/plugin-fs');
    try {
      await remove(path);
      // Update Registry
      const recent = getRecentProjects();
      const updated = recent.filter(p => p.path !== path);
      localStorage.setItem("mappa_recent_projects", JSON.stringify(updated));
      return true;
    } catch (err) {
      console.error("Failed to delete project:", err);
      return false;
    }
  }
}));

// --- Library Scanning & Registry Helpers ---
export interface RecentProject {
  name: string;
  path: string;
  lastModified: number;
}

const REGISTRY_KEY = "mappa_recent_projects";

// Scans the disk and merges with localStorage to return the definitive list
export const syncLibraryWithDisk = async (): Promise<RecentProject[]> => {
  try {
    const { appLocalDataDir, join } = await import('@tauri-apps/api/path');
    const { readDir, stat, exists, mkdir } = await import('@tauri-apps/plugin-fs');
    
    const localDir = await appLocalDataDir();
    const projectsDir = await join(localDir, 'projects');

    if (!await exists(projectsDir)) {
      await mkdir(projectsDir, { recursive: true });
      return [];
    }

    const entries = await readDir(projectsDir);
    const diskProjects: RecentProject[] = [];

    for (const entry of entries) {
      if (entry.isFile && (entry.name.endsWith('.mappa') || entry.name.endsWith('.json'))) {
        const fullPath = await join(projectsDir, entry.name);
        const fileStat = await stat(fullPath);
        
        diskProjects.push({
          name: entry.name.replace(/\.mappa$|\.json$/, ""),
          path: fullPath,
          lastModified: fileStat.mtime ? new Date(fileStat.mtime).getTime() : Date.now()
        });
      }
    }

    // Merge with histori (localStorage might have projects on other drives/paths we want to keep)
    const history = getRecentProjects();
    const combined = [...diskProjects];

    // Add history items if they aren't already included from the disk scan
    for (const hItem of history) {
      if (!combined.some(p => p.path === hItem.path)) {
        // Optional: Check if history item still exists on disk before adding
        if (await exists(hItem.path)) {
          combined.push(hItem);
        }
      }
    }

    // Sort by most recently modified
    const sorted = combined.sort((a, b) => b.lastModified - a.lastModified);
    
    // Persist the synced list back to registry
    localStorage.setItem(REGISTRY_KEY, JSON.stringify(sorted.slice(0, 50)));

    return sorted;
  } catch (err) {
    console.error("Library sync failed:", err);
    return getRecentProjects();
  }
};

export const getRecentProjects = (): RecentProject[] => {
  const data = localStorage.getItem(REGISTRY_KEY);
  if (!data) return [];
  try {
    return JSON.parse(data);
  } catch {
    return [];
  }
};

const updateRecentProjectsRegistry = (project: RecentProject) => {
  const recent = getRecentProjects();
  const filtered = recent.filter(p => p.path !== project.path);
  const updated = [project, ...filtered].slice(0, 10); // Keep top 10
  localStorage.setItem(REGISTRY_KEY, JSON.stringify(updated));
};
