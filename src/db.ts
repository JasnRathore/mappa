import type { ProjectSettings, TimelineElement } from "./types";

const DB_NAME = "MappaDB";
const STORE_NAME = "RenderStore";
const DB_VERSION = 1;

export interface RenderData {
  project: ProjectSettings;
  timelineElements: TimelineElement[];
  trackStates: Record<number, { locked: boolean; hidden: boolean }>;
}

export const openDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

export const saveRenderData = async (data: RenderData): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(data, "current-render");

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

export const loadRenderData = async (): Promise<RenderData | null> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get("current-render");

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
};
