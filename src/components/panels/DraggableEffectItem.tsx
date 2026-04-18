import React from "react";
import { useDraggable } from "@dnd-kit/core";
import { MagicWand } from "@phosphor-icons/react";

interface Props {
  id: string;
  name: string;
  type: "detail_level" | "other"; // can expand later
}

export const DraggableEffectItem: React.FC<Props> = ({ id, name, type }) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `effect-item-${id}`,
    data: {
      type: "new-effect",
      effectType: type,
      name,
    },
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`p-2 border rounded bg-background hover:bg-zinc-800 cursor-grab active:cursor-grabbing group transition-all shadow-sm flex items-center gap-2 ${
        isDragging ? "opacity-30 border-primary scale-95" : "border-zinc-800"
      }`}
    >
      <div className="w-6 h-6 rounded bg-primary/10 flex items-center justify-center text-primary group-hover:bg-primary/20 transition-colors">
        <MagicWand size={14} weight="bold" />
      </div>
      <div className="font-medium text-[11px] truncate text-zinc-200">
        {name}
      </div>
    </div>
  );
};
