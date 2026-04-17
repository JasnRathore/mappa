import React, { useState, useEffect } from "react";
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
import { useProjectStore, getRecentProjects, type RecentProject } from "../store/useProjectStore";

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
  const { newProject, loadProject } = useProjectStore();
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [showNewModal, setShowNewModal] = useState(false);
  const [activeTab, setActiveTab] = useState("all");
  
  // New Project Form State
  const [name, setName] = useState("Untitled Project");
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  const [fps, setFps] = useState(30);
  const [durationSecs, setDurationSecs] = useState(30);

  useEffect(() => {
    setRecentProjects(getRecentProjects());
  }, []);

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

    if (!result.success) {
      alert(result.error);
    }
  };

  const handleOpenLocal = async () => {
    await loadProject();
  };

  const handleOpenRecent = async (path: string) => {
    await loadProject(path);
  };

  return (
    <div className="flex h-screen w-screen bg-[#0d0d0d] text-zinc-300 font-sans overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 bg-[#141414] border-r border-zinc-800 flex flex-col pt-12">
        <div className="px-6 mb-8 flex items-center gap-3">
          <div className="w-8 h-8 bg-orange-500 rounded flex items-center justify-center font-bold text-black text-xl">
             M
          </div>
          <span className="text-xl font-bold tracking-tighter text-white">MAPPA</span>
        </div>

        <nav className="flex-1 px-3 space-y-1">
          <button 
            onClick={() => setActiveTab("all")}
            className={`w-full flex items-center gap-3 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'all' ? 'bg-zinc-800 text-white' : 'hover:bg-zinc-900 text-zinc-500'}`}
          >
            <Folder size={18} weight={activeTab === 'all' ? 'fill' : 'regular'} />
            Projects
          </button>
          <button 
             disabled
             className="w-full flex items-center gap-3 px-4 py-2 rounded-lg text-sm font-medium text-zinc-700 cursor-not-allowed"
          >
            <Monitor size={18} />
            Network (Pro)
          </button>
          <div className="pt-4 pb-2 px-4">
            <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Library</span>
          </div>
          <button className="w-full flex items-center gap-3 px-4 py-2 rounded-lg text-sm font-medium text-zinc-500 hover:bg-zinc-900">
            <ClockClockwise size={18} />
            Recently Viewed
          </button>
        </nav>

        <div className="p-4 border-t border-zinc-800">
          <button className="w-full flex items-center gap-3 px-4 py-2 rounded-lg text-sm font-medium text-zinc-500 hover:bg-zinc-900">
            <Gear size={18} />
            Tauri Settings
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0">
        <header className="h-16 border-b border-zinc-800 flex items-center justify-between px-8 bg-[#0d0d0d]">
          <div className="flex items-center gap-4 flex-1 max-w-md">
            <div className="relative w-full">
              <MagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
              <input 
                type="text" 
                placeholder="Search projects..." 
                className="w-full bg-zinc-900/50 border border-zinc-800 rounded-md pl-10 pr-4 py-1.5 text-sm focus:outline-none focus:border-zinc-700"
              />
            </div>
          </div>
          
          <div className="flex gap-3">
             <button 
               onClick={handleOpenLocal}
               className="flex items-center gap-2 px-4 py-2 rounded-md bg-zinc-800 hover:bg-zinc-700 text-white text-sm font-medium transition-all"
             >
               Open Existing...
             </button>
             <button 
               onClick={() => setShowNewModal(true)}
               className="flex items-center gap-2 px-4 py-2 rounded-md bg-orange-600 hover:bg-orange-500 text-white text-sm font-medium shadow-lg shadow-orange-900/20 transition-all border border-orange-400/20"
             >
               <Plus size={16} weight="bold" />
               New Project
             </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-8">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-6">
            {/* Recent Project Cards */}
            {recentProjects.map((p) => (
              <div 
                key={p.path}
                onDoubleClick={() => handleOpenRecent(p.path)}
                className="group flex flex-col bg-[#1a1a1a] border border-zinc-800/50 rounded-xl overflow-hidden hover:border-orange-500/50 hover:bg-[#222] transition-all cursor-pointer shadow-sm hover:shadow-xl"
              >
                <div className="aspect-video bg-[#0d0d0d] flex items-center justify-center relative overflow-hidden">
                  <FileIcon size={48} weight="duotone" className="text-zinc-800 group-hover:text-orange-900/40 transition-colors" />
                   {/* We could add generic thumbnails here later */}
                   <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-4">
                      <button 
                        onClick={(e) => { e.stopPropagation(); handleOpenRecent(p.path); }}
                        className="bg-orange-500 text-black font-bold text-xs py-1.5 px-4 rounded shadow-lg"
                      >
                        OPEN PROJECT
                      </button>
                   </div>
                </div>
                <div className="p-4 flex flex-col gap-1">
                   <h3 className="text-sm font-semibold text-zinc-100 truncate">{p.name}</h3>
                   <div className="flex items-center justify-between text-[10px] text-zinc-500">
                      <span>{new Date(p.lastModified).toLocaleDateString()}</span>
                      <button className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-red-400">
                         <Trash size={14} />
                      </button>
                   </div>
                   <div className="mt-2 text-[9px] text-zinc-600 font-mono truncate bg-black/30 px-2 py-1 rounded">
                      {p.path}
                   </div>
                </div>
              </div>
            ))}

            {/* Empty State */}
            {recentProjects.length === 0 && (
              <div className="col-span-full py-24 flex flex-col items-center justify-center text-center">
                 <div className="w-16 h-16 bg-zinc-900 rounded-full flex items-center justify-center mb-4 text-zinc-700">
                    <Folder size={32} />
                 </div>
                 <h2 className="text-lg font-medium text-zinc-400">No projects found</h2>
                 <p className="text-sm text-zinc-600 max-w-xs mt-2">
                    Start by creating a new project or importing an existing .mappa file from your disk.
                 </p>
                 <button 
                   onClick={() => setShowNewModal(true)}
                   className="mt-6 text-orange-500 hover:text-orange-400 text-sm font-bold uppercase tracking-widest"
                 >
                   Create your first project
                 </button>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* New Project Modal */}
      {showNewModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-6">
          <div 
            className="w-full max-w-lg bg-[#1a1a1a] border border-zinc-800 rounded-2xl shadow-2xl p-8"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-start mb-8">
              <div>
                <h2 className="text-2xl font-bold text-white tracking-tight">Project Settings</h2>
                <p className="text-zinc-500 text-xs mt-1">Configure your new mapping workspace.</p>
              </div>
              <button onClick={() => setShowNewModal(false)} className="p-2 hover:bg-zinc-800 rounded-full">
                 <Trash size={20} className="rotate-45" />
              </button>
            </div>

            <form onSubmit={handleCreateNew} className="space-y-6">
              <div>
                  <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest block mb-2">Project Name</label>
                  <input 
                    type="text" 
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full bg-black/40 border border-zinc-800 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-orange-500 transition-colors"
                  />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                    <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest block mb-2">Width</label>
                    <input 
                      type="number" 
                      value={width}
                      onChange={(e) => setWidth(parseInt(e.target.value) || 0)}
                      className="w-full bg-black/40 border border-zinc-800 rounded-lg px-4 py-2.5 text-sm focus:outline-none"
                    />
                </div>
                <div>
                    <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest block mb-2">Height</label>
                    <input 
                      type="number" 
                      value={height}
                      onChange={(e) => setHeight(parseInt(e.target.value) || 0)}
                      className="w-full bg-black/40 border border-zinc-800 rounded-lg px-4 py-2.5 text-sm focus:outline-none"
                    />
                </div>
              </div>

              <div className="grid grid-cols-4 gap-2">
                {PRESETS.map(p => (
                  <button 
                    key={p.label}
                    type="button"
                    onClick={() => { setWidth(p.width); setHeight(p.height); }}
                    className={`text-[9px] font-bold py-2 rounded-md border transition-all ${width === p.width && height === p.height ? 'bg-orange-500/10 border-orange-500 text-orange-400' : 'bg-zinc-900 border-zinc-800 text-zinc-500'}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-4 pt-2">
                <div>
                  <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest block mb-2">Frame Rate</label>
                  <div className="flex gap-2">
                    {FPS_OPTIONS.map(f => (
                      <button 
                        key={f}
                        type="button"
                        onClick={() => setFps(f)}
                        className={`flex-1 py-1.5 rounded-md text-[10px] font-bold border transition-all ${fps === f ? 'bg-orange-500 border-orange-500 text-black' : 'bg-zinc-900 border-zinc-800 text-zinc-500'}`}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest block mb-2">Duration (s)</label>
                  <input 
                    type="number" 
                    value={durationSecs}
                    onChange={(e) => setDurationSecs(parseInt(e.target.value) || 0)}
                    className="w-full bg-black/40 border border-zinc-800 rounded-lg px-4 py-2 text-sm focus:outline-none"
                  />
                </div>
              </div>

              <div className="flex gap-3 pt-6">
                <button 
                  type="button"
                  onClick={() => setShowNewModal(false)}
                  className="flex-1 py-3 px-4 rounded-xl text-sm font-bold text-zinc-400 border border-zinc-800 hover:bg-zinc-800 transition-all"
                >
                  Cancel
                </button>
                <button 
                   type="submit"
                   className="flex-[2] py-3 px-4 rounded-xl text-sm font-bold text-black bg-orange-500 hover:bg-orange-400 transition-all shadow-lg shadow-orange-900/20"
                >
                  Create Workspace
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProjectManager;
