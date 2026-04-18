import React, { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  X,
  Minus,
  Square,
  Copy,
  FolderOpen,
  FilePlus,
  FloppyDisk,
  Monitor,
  Gear,
  Info,
  SignOut,
  CaretDown,
  Export,
  CardsThreeIcon
} from "@phosphor-icons/react";
import { useProjectStore } from "../../store/useProjectStore";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuShortcut
} from "../ui/dropdown-menu";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";

const appWindow = getCurrentWindow();

interface TitleBarProps {
  onNew?: () => void;
  onDeliver?: () => void;
  deliverLabel?: string;
  hideDeliver?: boolean;
  hideAllMenus?: boolean;
}

export const TitleBar: React.FC<TitleBarProps> = ({
  onNew,
  onDeliver,
  deliverLabel = "Deliver",
  hideDeliver = false,
  hideAllMenus = false
}) => {
  const {
    project,
    projectName,
    saveProject,
    loadProject,
    setProject
  } = useProjectStore();

  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const updateMaximized = async () => {
      const maximized = await appWindow.isMaximized();
      setIsMaximized(maximized);
    };

    updateMaximized();
    const unlisten = appWindow.onResized(() => {
      updateMaximized();
    });

    return () => {
      void unlisten.then(fn => fn());
    };
  }, []);

  const handleNew = () => {
    if (onNew) {
      onNew();
    } else {
      setProject(null);
    }
  };

  const handleOpen = async () => {
    await loadProject();
  };

  const handleSave = async () => {
    await saveProject();
  };

  const handleExit = async () => {
    await appWindow.close();
  };

  return (
    <div
      data-tauri-drag-region
      className="h-10 bg-card border-b border-border flex items-center justify-between select-none px-0.5 shrink-0 z-50"
    >
      {/* Left: App Icon & Menu */}
      <div className="flex items-center h-full">
        <div className="px-3 flex items-center justify-center pointer-events-none border-r border-border/20 mr-1 h-6 self-center">
          <div className="w-5 h-5 bg-primary rounded flex items-center justify-center font-bold text-primary-foreground text-[10px]">
            M
          </div>
        </div>

        {!hideAllMenus && (
          <div className="flex items-center h-full text-[11px] font-medium text-muted-foreground">
            {/* File Menu */}
            <DropdownMenu>
              <DropdownMenuTrigger className="px-3 h-6 hover:bg-accent hover:text-accent-foreground rounded outline-none flex items-center gap-1 transition-colors">
                File
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56 mt-1">
                <DropdownMenuItem onClick={handleNew} className="text-xs">
                  <FilePlus className="mr-2 h-3.5 w-3.5" />
                  New Project
                  <DropdownMenuShortcut>Ctrl+N</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleOpen} className="text-xs">
                  <FolderOpen className="mr-2 h-3.5 w-3.5" />
                  Open Project...
                  <DropdownMenuShortcut>Ctrl+O</DropdownMenuShortcut>
                </DropdownMenuItem>
                {project && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={handleSave} className="text-xs">
                      <FloppyDisk className="mr-2 h-3.5 w-3.5" />
                      Save Project
                      <DropdownMenuShortcut>Ctrl+S</DropdownMenuShortcut>
                    </DropdownMenuItem>
                  </>
                )}
                {project && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setProject(null)} className="text-xs">
                      <CardsThreeIcon className="mr-2 h-3.5 w-3.5" />
                      Project Manager
                      {/* <DropdownMenuShortcut>Ctrl+S</DropdownMenuShortcut> */}
                    </DropdownMenuItem>
                  </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleExit} className="text-xs text-destructive focus:text-destructive">
                  <SignOut className="mr-2 h-3.5 w-3.5" />
                  Exit Mappa
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* View Menu */}
            {project && (
              <DropdownMenu>
                <DropdownMenuTrigger className="px-3 h-6 hover:bg-accent hover:text-accent-foreground rounded outline-none flex items-center gap-1 transition-colors">
                  View
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56 mt-1">
                  <DropdownMenuItem className="text-xs">
                    <Monitor className="mr-2 h-3.5 w-3.5" />
                    Show / Hide Sidebar
                    <DropdownMenuShortcut>Ctrl+B</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem className="text-xs">
                    <List className="mr-2 h-3.5 w-3.5" />
                    Timeline Focus
                    <DropdownMenuShortcut>Ctrl+T</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-xs">
                    <Gear className="mr-2 h-3.5 w-3.5" />
                    Editor Settings
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* Help Menu */}
            <DropdownMenu>
              <DropdownMenuTrigger className="px-3 h-6 hover:bg-accent hover:text-accent-foreground rounded outline-none flex items-center gap-1 transition-colors">
                Help
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48 mt-1">
                <DropdownMenuItem className="text-xs">
                  <Info className="mr-2 h-3.5 w-3.5" />
                  About Mappa
                </DropdownMenuItem>
                <DropdownMenuItem className="text-xs">
                  Documentation
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {!hideDeliver && (
              <button
                onClick={onDeliver}
                disabled={!onDeliver}
                className="px-3 h-6 hover:bg-accent hover:text-accent-foreground rounded outline-none flex items-center gap-1 transition-colors">
                Render
              </button>
            )}
          </div>
        )}
      </div>


      {/* Center: Project Name */}
      {project && (
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">
            {projectName || "Untitled Project"}
          </span>

          <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground/70 font-mono">
            {project.width}x{project.height}
          </span>

        </div>
      )}
      {/* Right: Actions & Window Controls */}
      <div className="flex items-center h-full">


        <div className="flex items-center h-full group">
          <button
            onClick={() => appWindow.minimize()}
            className="w-12 h-10 flex items-center justify-center hover:bg-accent text-foreground/60 transition-colors"
          >
            <Minus size={14} />
          </button>
          <button
            onClick={() => appWindow.toggleMaximize()}
            className="w-12 h-10 flex items-center justify-center hover:bg-accent text-foreground/60 transition-colors"
          >
            {isMaximized ? <Copy size={13} /> : <Square size={13} />}
          </button>
          <button
            onClick={() => appWindow.close()}
            className="w-12 h-10 flex items-center justify-center hover:bg-destructive hover:text-destructive-foreground text-foreground/60 transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
};

const List: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} width="16" height="16" viewBox="0 0 256 256"><path fill="currentColor" d="M224 128a8 8 0 0 1-8 8H40a8 8 0 0 1 0-16h176a8 8 0 0 1 8 8ZM40 72h176a8 8 0 0 0 0-16H40a8 8 0 0 0 0 16Zm176 112H40a8 8 0 0 0 0 16h176a8 8 0 0 0 0-16Z" /></svg>
);
