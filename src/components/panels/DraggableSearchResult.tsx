import React from "react";
import { useDraggable } from "@dnd-kit/core";
import type { LocationPayload } from "../../types";

interface Props {
  payload: LocationPayload;
}

export const DraggableSearchResult: React.FC<Props> = ({ payload }) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
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
      className={`p-2 px-3 border w-full min-w-0 rounded bg-background hover:bg-zinc-800 cursor-grab active:cursor-grabbing group transition-colors shadow-sm ${isDragging ? "opacity-30 border-primary" : "border-zinc-800"
        }`}
    >
      <div className="font-medium text-xs truncate group-hover:text-primary mb-0.5">
        {payload.name}
      </div>
      <div className="text-[10px] text-zinc-500 leading-tight break-words line-clamp-2">{payload.display_name}</div>
      <div className="text-[10px] text-zinc-600 mt-1 capitalize font-mono">
        {payload.type}
      </div>
    </div>
  );
};
