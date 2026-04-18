import React from "react";
import { useDraggable } from "@dnd-kit/core";
import type { LocationPayload } from "../../types";

interface Props {
  payload: LocationPayload;
}

export const DraggableSearchResult: React.FC<Props> = ({ payload }) => {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `search-res-${payload.id}`,
    data: {
      type: "new-location",
      payload,
    },
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`p-2 border rounded bg-background hover:bg-zinc-800 cursor-grab active:cursor-grabbing group transition-colors shadow-sm ${isDragging ? "opacity-30 border-primary" : "border-zinc-800"
        }`}
    >
      <div className="font-medium text-xs truncate group-hover:text-primary">
        {payload.name}
      </div>
      <div className="text-[10px] text-zinc-500 truncate">{payload.display_name}</div>
      <div className="text-[10px] text-zinc-600 mt-1 capitalize font-mono">
        {payload.type}
      </div>
    </div>
  );
};
