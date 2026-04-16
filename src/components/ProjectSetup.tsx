import React, { useState } from "react";
import type { ProjectSettings } from "../types";

interface Props {
  onComplete: (settings: ProjectSettings) => void;
}

const PRESETS = [
  { label: "1080p HD", width: 1920, height: 1080 },
  { label: "720p HD", width: 1280, height: 720 },
  { label: "Social Vertical", width: 1080, height: 1920 },
  { label: "Square", width: 1080, height: 1080 },
];

const FPS_OPTIONS = [24, 30, 60];

const ProjectSetup: React.FC<Props> = ({ onComplete }) => {
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  const [fps, setFps] = useState(30);
  const [durationSecs, setDurationSecs] = useState(30);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onComplete({
      width,
      height,
      fps,
      durationFrames: fps * durationSecs,
    });
  };

  const setPreset = (w: number, h: number) => {
    setWidth(w);
    setHeight(h);
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-zinc-950 text-zinc-300 font-sans p-6">
      <div className="max-w-md w-full bg-zinc-900 border border-zinc-800 rounded-xl p-8 shadow-2xl">
        <h1 className="text-2xl font-bold text-zinc-100 mb-2">New Map Project</h1>
        <p className="text-zinc-500 text-sm mb-8">
          Configure your timeline and video output settings.
        </p>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-3">
            <label className="text-xs font-bold text-zinc-500 uppercase tracking-widest">
              Resolution Presets
            </label>
            <div className="grid grid-cols-2 gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setPreset(p.width, p.height)}
                  className={`py-2 px-3 text-xs rounded border transition-colors ${width === p.width && height === p.height
                    ? "bg-orange-500/10 border-orange-500 text-orange-400"
                    : "bg-zinc-800/50 border-zinc-700 hover:border-zinc-500"
                    }`}
                >
                  {p.label} ({p.width}x{p.height})
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-bold text-zinc-500 uppercase tracking-widest block mb-1">
                Width (px)
              </label>
              <input
                type="number"
                value={width}
                onChange={(e) => setWidth(parseInt(e.target.value) || 0)}
                className="w-full bg-black/40 border border-zinc-700 rounded px-3 py-2 text-sm outline-none focus:border-orange-500"
              />
            </div>
            <div>
              <label className="text-xs font-bold text-zinc-500 uppercase tracking-widest block mb-1">
                Height (px)
              </label>
              <input
                type="number"
                value={height}
                onChange={(e) => setHeight(parseInt(e.target.value) || 0)}
                className="w-full bg-black/40 border border-zinc-700 rounded px-3 py-2 text-sm outline-none focus:border-orange-500"
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-bold text-zinc-500 uppercase tracking-widest block mb-2">
              Framerate (FPS)
            </label>
            <div className="flex gap-2">
              {FPS_OPTIONS.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFps(f)}
                  className={`flex-1 py-2 rounded border text-sm font-bold ${fps === f
                    ? "bg-orange-500 text-zinc-950 border-orange-500"
                    : "bg-zinc-800 border-zinc-700 hover:border-zinc-500"
                    }`}
                >
                  {f} fps
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-bold text-zinc-500 uppercase tracking-widest block mb-1">
              Length (Seconds)
            </label>
            <input
              type="number"
              value={durationSecs}
              onChange={(e) => setDurationSecs(parseInt(e.target.value) || 0)}
              className="w-full bg-black/40 border border-zinc-700 rounded px-3 py-2 text-sm outline-none focus:border-orange-500"
            />
            <div className="text-[10px] text-zinc-500 mt-1">
              Total frames: {fps * durationSecs}
            </div>
          </div>

          <button
            type="submit"
            className="w-full py-3 bg-zinc-100 hover:bg-white text-zinc-950 font-bold rounded mt-4 transition-colors"
          >
            Create Project
          </button>
        </form>
      </div>
    </div>
  );
};

export default ProjectSetup;
