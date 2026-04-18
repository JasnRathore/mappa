import React, { useState, useEffect } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ProjectSettings } from "../types";
import {
  Folder,
  Gear,
  Monitor,
  Trash,
  Plus,
  ClockClockwise,
  MagnifyingGlass,
  File as FileIcon
} from "@phosphor-icons/react";
import { useProjectStore, syncLibraryWithDisk, type RecentProject } from "../store/useProjectStore";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./ui/dialog";
import { cn } from "../lib/utils";
import { TitleBar } from "./layout/TitleBar";

interface Props {
  onComplete: (settings: ProjectSettings) => void;
  onImport: (file: File) => void;
}

const PRESETS = [
  { label: "1080p HD", width: 1920, height: 1080 },
  { label: "720p HD", width: 1280, height: 720 },
  { label: "Social", width: 1080, height: 1920 },
  { label: "Square", width: 1080, height: 1080 },
];

const FPS_OPTIONS = [24, 30, 60];

const ProjectManager: React.FC<Props> = () => {
  const { newProject, loadProject, deleteProject } = useProjectStore();
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(true);
  const [showNewModal, setShowNewModal] = useState(false);
  const [activeTab, setActiveTab] = useState("all");

  // New Project Form State
  const [name, setName] = useState("Untitled Project");
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  const [fps, setFps] = useState(30);
  const [durationSecs, setDurationSecs] = useState(30);

  useEffect(() => {
    const init = async () => {
      setIsRefreshing(true);
      const synced = await syncLibraryWithDisk();
      setRecentProjects(synced);
      setIsRefreshing(false);
    };
    init();
  }, []);

  const openEditor = async (path: string) => {
    const editorId = `editor-${Date.now()}`;
    const webview = new WebviewWindow(editorId, {
      url: `?mode=editor&projectPath=${encodeURIComponent(path)}`,
      title: "Mappa Editor",
      width: 1280,
      height: 800,
      resizable: true,
      decorations: false,
    });

    webview.once("tauri://created", () => {
      console.log("[Mappa] Editor window created, closing manager.");
      getCurrentWindow().close();
    });

    webview.once("tauri://error", (e) => {
      console.error("Failed to create editor window", e);
      alert("Failed to launch editor window.");
    });
  };

  const handleCreateNew = async (e: React.FormEvent) => {
    e.preventDefault();
    const durationFrames = fps * durationSecs;
    const result = await newProject({
      width,
      height,
      fps,
      durationFrames,
      startFrame: 0,
      endFrame: durationFrames - 1
    }, name);

    if (result.success) {
      const path = useProjectStore.getState().filePath;
      if (path) openEditor(path);
    } else {
      alert(result.error);
    }
  };

  const handleOpenLocal = async () => {
    const success = await loadProject();
    if (success) {
      const path = useProjectStore.getState().filePath;
      if (path) openEditor(path);
    }
  };

  const handleOpenRecent = async (path: string) => {
    const success = await loadProject(path);
    if (success) {
      openEditor(path);
    }
  };

  const handleDeleteProject = async (e: React.MouseEvent, path: string, name: string) => {
    e.stopPropagation();
    if (confirm(`Are you sure you want to permanently delete "${name}" from your library? This will delete the file from your computer.`)) {
      const success = await deleteProject(path);
      if (success) {
        setRecentProjects(prev => prev.filter(p => p.path !== path));
      } else {
        alert("Failed to delete project file. It might be in use or you may not have permissions.");
      }
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-background overflow-hidden">
      <TitleBar
        hideDeliver={true}
        onNew={() => setShowNewModal(true)}
      />
      <div className="flex flex-1 min-h-0 text-foreground font-sans overflow-hidden">

        {/* Main Content */}
        <main className="flex-1 flex flex-col min-w-0">
          <header className="h-16 border-b border-border flex items-center justify-between px-8 bg-background">
            <div className="flex items-center gap-4 flex-1 max-w-md">
              <div className="relative w-full">
                <MagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="text"
                  placeholder="Search projects..."
                  className="w-full pl-10"
                />
              </div>
            </div>

            <div className="flex gap-3">
              {isRefreshing && <span className="text-[10px] text-muted-foreground animate-pulse mt-3 mr-2">SCANNING LIBRARY...</span>}
              <Button
                variant="secondary"
                onClick={handleOpenLocal}
              >
                Open Existing...
              </Button>
              <Button
                onClick={() => setShowNewModal(true)}
                className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20"
              >
                <Plus size={16} weight="bold" />
                New Project
              </Button>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto p-8">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-6">
              {/* Recent Project Cards */}
              {recentProjects.map((p) => (
                <div
                  key={p.path}
                  onDoubleClick={() => handleOpenRecent(p.path)}
                  className="group flex flex-col bg-card border border-border/50 rounded-xl overflow-hidden hover:border-primary/50 hover:bg-accent/20 transition-all cursor-pointer shadow-sm hover:shadow-xl"
                >
                  <div className="aspect-video bg-background flex items-center justify-center relative overflow-hidden">
                    <FileIcon size={48} weight="duotone" className="text-muted-foreground/20 group-hover:text-primary/40 transition-colors" />
                    {/* We could add generic thumbnails here later */}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-4">
                      <Button
                        size="sm"
                        onClick={(e) => { e.stopPropagation(); handleOpenRecent(p.path); }}
                      >
                        OPEN PROJECT
                      </Button>
                    </div>
                  </div>
                  <div className="p-4 flex flex-col gap-1">
                    <h3 className="text-sm font-semibold text-foreground truncate">{p.name}</h3>
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                      <span>{new Date(p.lastModified).toLocaleDateString()}</span>
                      <button
                        onClick={(e) => handleDeleteProject(e, p.path, p.name)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-destructive"
                      >
                        <Trash size={14} />
                      </button>
                    </div>
                    <div className="mt-2 text-[9px] text-muted-foreground font-mono truncate bg-background/50 px-2 py-1 rounded">
                      {p.path}
                    </div>
                  </div>
                </div>
              ))}

              {/* Empty State */}
              {recentProjects.length === 0 && (
                <div className="col-span-full py-24 flex flex-col items-center justify-center text-center">
                  <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mb-4 text-muted-foreground">
                    <Folder size={32} />
                  </div>
                  <h2 className="text-lg font-medium text-foreground">No projects found</h2>
                  <p className="text-sm text-muted-foreground max-w-xs mt-2">
                    Start by creating a new project or importing an existing .mappa file from your disk.
                  </p>
                  <button
                    onClick={() => setShowNewModal(true)}
                    className="mt-6 text-primary hover:text-primary/80 text-sm font-bold uppercase tracking-widest"
                  >
                    Create your first project
                  </button>
                </div>
              )}
            </div>
          </div>
        </main>

        {/* New Project Modal */}
        <Dialog open={showNewModal} onOpenChange={setShowNewModal}>
          <DialogContent className="sm:max-w-lg bg-card border-border p-8">
            <DialogHeader className="mb-8">
              <DialogTitle className="text-2xl font-bold text-foreground tracking-tight">Project Settings</DialogTitle>
              <DialogDescription className="text-muted-foreground text-xs mt-1">
                Configure your new mapping workspace.
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={handleCreateNew} className="space-y-6">
              <div>
                <Label className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest block mb-2">Project Name</Label>
                <Input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest block mb-2">Width</Label>
                  <Input
                    type="number"
                    value={width}
                    onChange={(e) => setWidth(parseInt(e.target.value) || 0)}
                  />
                </div>
                <div>
                  <Label className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest block mb-2">Height</Label>
                  <Input
                    type="number"
                    value={height}
                    onChange={(e) => setHeight(parseInt(e.target.value) || 0)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-4 gap-2">
                {PRESETS.map(p => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => { setWidth(p.width); setHeight(p.height); }}
                    className={cn(
                      "text-[9px] font-bold py-2 rounded-md border transition-all",
                      width === p.width && height === p.height
                        ? 'bg-primary/10 border-primary text-primary'
                        : 'bg-muted border-border text-muted-foreground'
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-4 pt-2">
                <div>
                  <Label className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest block mb-2">Frame Rate</Label>
                  <div className="flex gap-2">
                    {FPS_OPTIONS.map(f => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setFps(f)}
                        className={cn(
                          "flex-1 py-1.5 rounded-md text-[10px] font-bold border transition-all",
                          fps === f
                            ? 'bg-primary border-primary text-primary-foreground'
                            : 'bg-muted border-border text-muted-foreground'
                        )}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <Label className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest block mb-2">Duration (s)</Label>
                  <Input
                    type="number"
                    value={durationSecs}
                    onChange={(e) => setDurationSecs(parseInt(e.target.value) || 0)}
                  />
                </div>
              </div>

              <DialogFooter className="gap-3 pt-6">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowNewModal(false)}
                  className="flex-1 rounded-xl text-sm font-bold"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  className="flex-[2] rounded-xl text-sm font-bold shadow-lg shadow-primary/20"
                >
                  Create Workspace
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};

export default ProjectManager;
