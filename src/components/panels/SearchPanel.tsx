import React, { useState } from "react";
import { MagnifyingGlass, CircleNotch } from "@phosphor-icons/react";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import type { LocationPayload } from "../../types";

import { DraggableSearchResult } from "./DraggableSearchResult";

export const SearchPanel: React.FC = () => {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<LocationPayload[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    setSearchResults([]);
    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&limit=10&polygon_geojson=1`
      );
      const data = await response.json();
      const formatted: LocationPayload[] = data.map((item: any) => ({
        id: (item.place_id as number).toString() + Math.random(),
        name: (item.display_name as string).split(",")[0],
        display_name: item.display_name as string,
        center: [parseFloat(item.lon as string), parseFloat(item.lat as string)],
        zoom: ["city", "town", "village", "suburb"].includes(item.type as string) ? 12 : 5,
        bearing: 0,
        pitch: 0,
        transition: "fly",
        transitionMS: 2000,
        type: item.type as string,
        color: "#f97316",
        geojson: item.geojson as any,
      }));
      setSearchResults(formatted);
    } catch (err) {
      console.error(err);
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-card">
      <div className="p-3 border-b border-border flex-shrink-0">
        <form onSubmit={handleSearch} className="flex gap-2">
          <Input 
            autoFocus 
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search location..." 
            className="flex-1 h-8 text-xs bg-muted/50 border-border"
          />
          <Button type="submit" size="sm" variant="secondary" className="h-8 shadow-sm" disabled={isSearching}>
            <MagnifyingGlass weight="bold" />
          </Button>
        </form>
      </div>
      
      <ScrollArea className="flex-1 p-2">
        {searchResults.length === 0 && !isSearching && (
          <div className="text-center text-xs text-muted-foreground mt-8">
            Search for locations to add to timeline.
          </div>
        )}
        {isSearching && (
          <div className="flex flex-col items-center justify-center text-xs text-muted-foreground mt-8 text-primary/70 gap-2">
            <CircleNotch size={24} className="animate-spin" />
            <span>Searching...</span>
          </div>
        )}
        <div className="space-y-2 w-full min-w-0">
          {searchResults.map((res) => (
            <DraggableSearchResult key={res.id} payload={res} />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
};
