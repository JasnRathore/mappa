import React, { useCallback } from "react";
import { useProjectStore } from "../../store/useProjectStore";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Slider } from "../ui/slider";
import { Separator } from "../ui/separator";
import { Camera, Drop } from "@phosphor-icons/react";
import { Button } from "../ui/button";

export const InspectorPanel: React.FC = () => {
  const activeElementId = useProjectStore(state => state.activeElementId);
  const timelineElements = useProjectStore(state => state.timelineElements);
  const updateTimelineElement = useProjectStore(state => state.updateTimelineElement);
  
  const element = timelineElements.find(el => el.id === activeElementId);
  const currentFrame = useProjectStore(state => state.currentFrame);
  const addKeyframe = useProjectStore(state => state.addKeyframe);
  const removeKeyframe = useProjectStore(state => state.removeKeyframe);

  const updateLocationPayload = useCallback((updates: Record<string, any>) => {
    if (!element || !element.locationPayload) return;
    updateTimelineElement(element.id, {
      locationPayload: { ...element.locationPayload, ...updates }
    });
  }, [element, updateTimelineElement]);

  const toggleKeyframe = useCallback((property: string, value: any) => {
    if (!element) return;
    const offset = currentFrame - element.startFrame;
    const existing = (element.keyframes || []).find(k => k.property === property && k.frameOffset === offset);
    
    if (existing) {
      removeKeyframe(element.id, existing.id);
    } else {
      addKeyframe(element.id, property, offset, value);
    }
  }, [element, currentFrame, addKeyframe, removeKeyframe]);

  const hasKeyframe = useCallback((property: string) => {
    if (!element) return false;
    const offset = currentFrame - element.startFrame;
    return (element.keyframes || []).some(k => k.property === property && k.frameOffset === offset);
  }, [element, currentFrame]);

  const KeyframeIcon = ({ property, value }: { property: string, value: any }) => {
    const active = hasKeyframe(property);
    return (
      <button 
        onClick={() => toggleKeyframe(property, value)}
        className={`hover:text-primary transition-colors ${active ? 'text-primary' : 'text-muted-foreground/40'}`}
      >
        <div className={`w-3 h-3 rotate-45 border-2 ${active ? 'bg-primary border-primary' : 'border-current'}`} />
      </button>
    );
  };

  if (!element) {
    return (
      <div className="flex items-center justify-center flex-1 text-muted-foreground text-xs p-4 text-center">
        Select a clip in the timeline to view properties.
      </div>
    );
  }

  if (element.type === "location" && element.locationPayload) {
    const p = element.locationPayload;
    
    return (
      <div className="flex-1 flex flex-col overflow-y-auto">
        <div className="p-3 border-b shrink-0 flex items-center justify-between bg-muted/30">
          <span className="font-medium text-sm truncate pr-4">{element.name}</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground border px-1 rounded bg-background">Video</span>
        </div>
        
        <div className="p-4 space-y-6">
          {/* Transform constraints */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Transform</h3>
            
            <div className="grid grid-cols-4 items-center gap-2">
              <div className="col-span-1 flex items-center justify-end pr-2 gap-2">
                <KeyframeIcon property="zoom" value={p.zoom} />
                <Label className="text-xs">Zoom</Label>
              </div>
              <div className="col-span-3 flex items-center gap-3">
                <Slider 
                  min={1} max={22} step={0.1}
                  value={[p.zoom]} 
                  onValueChange={(val) => updateLocationPayload({ zoom: val[0] })}
                  className="flex-1"
                />
                <Input 
                  type="number"
                  value={p.zoom.toFixed(2)}
                  className="w-14 h-6 text-xs px-1 text-center font-mono bg-background"
                  onChange={(e) => updateLocationPayload({ zoom: parseFloat(e.target.value) || p.zoom })}
                />
              </div>
            </div>

            {/* Manual Capture Button */}
            <div className="grid grid-cols-4 items-center gap-2 pt-1">
              <div className="col-start-2 col-span-3">
                <Button 
                  variant="outline" 
                  size="sm" 
                  className="w-full h-8 text-[10px] gap-2 font-semibold tracking-wide"
                  onClick={() => {
                    // Dispatch a custom event that ViewerPanel listens to
                    window.dispatchEvent(new CustomEvent("mappa:capture-map-state"));
                  }}
                >
                  <Camera weight="bold" size={14} />
                  CAPTURE MAP REFERENCE
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-4 items-center gap-2">
              <div className="col-span-1 flex items-center justify-end pr-2 gap-2">
                <KeyframeIcon property="pitch" value={p.pitch || 0} />
                <Label className="text-xs">Pitch</Label>
              </div>
              <div className="col-span-3 flex items-center gap-3">
                <Slider 
                  min={0} max={85} step={1}
                  value={[p.pitch || 0]} 
                  onValueChange={(val) => updateLocationPayload({ pitch: val[0] })}
                  className="flex-1"
                />
                <Input 
                  type="number"
                  value={(p.pitch || 0).toString()}
                  className="w-14 h-6 text-xs px-1 text-center font-mono bg-background"
                  onChange={(e) => updateLocationPayload({ pitch: parseFloat(e.target.value) || 0 })}
                />
              </div>
            </div>

            <div className="grid grid-cols-4 items-center gap-2">
              <div className="col-span-1 flex items-center justify-end pr-2 gap-2">
                <KeyframeIcon property="bearing" value={p.bearing || 0} />
                <Label className="text-xs">Bearing</Label>
              </div>
              <div className="col-span-3 flex items-center gap-3">
                <Slider 
                  min={-180} max={180} step={1}
                  value={[p.bearing || 0]} 
                  onValueChange={(val) => updateLocationPayload({ bearing: val[0] })}
                  className="flex-1"
                />
                <Input 
                  type="number"
                  value={(p.bearing || 0).toString()}
                  className="w-14 h-6 text-xs px-1 text-center font-mono bg-background"
                  onChange={(e) => updateLocationPayload({ bearing: parseFloat(e.target.value) || 0 })}
                />
              </div>
            </div>
          </div>
          
          <Separator />

          {/* Transitions */}
          <div className="space-y-3">
             <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Camera Transition</h3>
             <div className="grid grid-cols-4 items-center gap-2">
              <Label className="text-xs col-span-1 text-right pr-2">Animation</Label>
              <select 
                  value={p.transition || "fly"}
                  className="col-span-3 h-7 text-xs px-2 bg-background border border-input rounded-md flex h-9 w-full bg-transparent px-3 py-1 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  onChange={(e) => updateLocationPayload({ transition: e.target.value as any })}
                >
                  <option value="jump">Jump (Instant)</option>
                  <option value="fly">Fly To</option>
                  <option value="ease">Ease To</option>
                  <option value="pan">Pan To</option>
                  <option value="zoom_in">Zoom In</option>
                  <option value="zoom_out">Zoom Out</option>
                </select>
             </div>
             {p.transition !== "jump" && (
               <div className="grid grid-cols-4 items-center gap-2">
                <Label className="text-xs col-span-1 text-right pr-2">Duration</Label>
                <div className="col-span-3 flex items-center gap-2">
                  <Input 
                      type="number" step="100"
                      value={p.transitionMS || 2000}
                      className="flex-1 h-7 text-xs px-2 font-mono bg-background"
                      onChange={(e) => updateLocationPayload({ transitionMS: parseInt(e.target.value) || 2000 })}
                    />
                    <span className="text-xs text-muted-foreground">ms</span>
                </div>
               </div>
             )}
          </div>

          <Separator />

          {/* Coordinates (Advanced) */}
          <div className="space-y-3">
             <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Coordinates</h3>
             <div className="grid grid-cols-4 items-center gap-2">
              <div className="col-span-1 flex items-center justify-end pr-2 gap-2">
                <KeyframeIcon property="center" value={p.center} />
                <Label className="text-xs">Long</Label>
              </div>
              <Input 
                  type="number" step="0.0001"
                  value={p.center[0].toFixed(5)}
                  className="col-span-3 h-7 text-xs px-2 font-mono bg-background"
                  onChange={(e) => updateLocationPayload({ center: [parseFloat(e.target.value) || p.center[0], p.center[1]] })}
                />
             </div>
             <div className="grid grid-cols-4 items-center gap-2">
              <Label className="text-xs col-span-1 text-right pr-2">Lat</Label>
              <Input 
                  type="number" step="0.0001"
                  value={p.center[1].toFixed(5)}
                  className="col-span-3 h-7 text-xs px-2 font-mono bg-background"
                  onChange={(e) => updateLocationPayload({ center: [p.center[0], parseFloat(e.target.value) || p.center[1]] })}
                />
             </div>
          </div>

          <Separator />


          {/* Highlight (City Area) */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Area Highlight</h3>
            
            <div className="grid grid-cols-4 items-center gap-2">
              <Label className="text-xs col-span-1 text-right pr-2">Enabled</Label>
              <div className="col-span-3">
                <input 
                  type="checkbox"
                  checked={p.highlightEnabled !== false}
                  onChange={(e) => updateLocationPayload({ highlightEnabled: e.target.checked })}
                  className="rounded border-zinc-700 bg-zinc-900 accent-primary"
                />
              </div>
            </div>

            <div className="grid grid-cols-4 items-center gap-2">
              <Label className="text-xs col-span-1 text-right pr-2">Color</Label>
              <div className="col-span-3 flex items-center gap-2">
                <Input 
                  type="color"
                  value={p.color || "#f97316"}
                  className="w-8 h-8 p-1 bg-background border-none cursor-pointer"
                  onChange={(e) => updateLocationPayload({ color: e.target.value })}
                />
                <Input 
                  type="text"
                  value={p.color || "#f97316"}
                  className="flex-1 h-7 text-[10px] uppercase font-mono bg-background"
                  onChange={(e) => updateLocationPayload({ color: e.target.value })}
                />
              </div>
            </div>

            <div className="grid grid-cols-4 items-center gap-2">
              <Label className="text-xs col-span-1 text-right pr-2">Fade In</Label>
              <div className="col-span-3 flex items-center gap-2 text-xs">
                <Input 
                  type="number"
                  value={p.fadeInFrames || 0}
                  className="w-16 h-7 text-xs bg-background"
                  onChange={(e) => updateLocationPayload({ fadeInFrames: parseInt(e.target.value) || 0 })}
                />
                <span className="text-[10px] text-muted-foreground">frames</span>
              </div>
            </div>

            <div className="grid grid-cols-4 items-center gap-2">
              <Label className="text-xs col-span-1 text-right pr-2">Fade Out</Label>
              <div className="col-span-3 flex items-center gap-2 text-xs">
                <Input 
                  type="number"
                  value={p.fadeOutFrames || 0}
                  className="w-16 h-7 text-xs bg-background"
                  onChange={(e) => updateLocationPayload({ fadeOutFrames: parseInt(e.target.value) || 0 })}
                />
                <span className="text-[10px] text-muted-foreground">frames</span>
              </div>
            </div>
          </div>
          
        </div>
      </div>
    );
  }

  if (element.type === "effect_detail" && element.effectPayload) {
    const p = element.effectPayload;
    return (
      <div className="flex-1 flex flex-col overflow-y-auto">
        <div className="p-3 border-b shrink-0 flex items-center justify-between bg-muted/30">
          <span className="font-medium text-sm truncate pr-4">{element.name}</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground border px-1 rounded bg-background">Effect</span>
        </div>
        
        <div className="p-4 space-y-6">
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Detail Settings</h3>
            
            <div className="grid grid-cols-4 items-center gap-2">
              <Label className="text-xs col-span-1 text-right pr-2 font-medium">Density</Label>
              <div className="col-span-3 flex items-center gap-3">
                <Slider 
                  min={0} max={100} step={1}
                  value={[p.detailLevel]} 
                  onValueChange={(val) => updateTimelineElement(element.id, { effectPayload: { ...p, detailLevel: val[0] } })}
                  className="flex-1"
                />
                <Input 
                  type="number"
                  value={p.detailLevel.toString()}
                  className="w-14 h-6 text-xs px-1 text-center font-mono bg-background"
                  onChange={(e) => updateTimelineElement(element.id, { effectPayload: { ...p, detailLevel: parseInt(e.target.value) || 0 } })}
                />
              </div>
            </div>
            <p className="text-[10px] text-zinc-500 italic pl-10 pr-2 leading-relaxed">
              Controls the visibility of labels, buildings, and small roads on the map canvas.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return null;
};
