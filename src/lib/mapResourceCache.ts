import maplibregl from "maplibre-gl";

const MAP_RESOURCE_CACHE_PROTOCOL = "mappa-cache";
const MAP_RESOURCE_CACHE_NAME = "mappa-map-resources-v1";

export const OPEN_FREEMAP_STYLE_URL = "https://tiles.openfreemap.org/styles/positron";

let protocolInstalled = false;

const canUseMapResourceCache = () =>
  typeof window !== "undefined" &&
  typeof fetch === "function" &&
  typeof caches !== "undefined";

const shouldCacheMapResource = (url: string) =>
  /^https?:\/\//i.test(url) && !url.startsWith(`${MAP_RESOURCE_CACHE_PROTOCOL}://`);

const encodeCachedUrl = (url: string) =>
  `${MAP_RESOURCE_CACHE_PROTOCOL}://${encodeURIComponent(url)}`;

const decodeCachedUrl = (url: string) =>
  decodeURIComponent(url.slice(`${MAP_RESOURCE_CACHE_PROTOCOL}://`.length));

const readResponsePayload = async (response: Response, type?: string) => {
  if (type === "arrayBuffer" || type === "image") {
    return response.arrayBuffer();
  }

  if (type === "json") {
    return response.json();
  }

  return response.text();
};

const createResourceResponse = async (response: Response, type?: string) => ({
  data: await readResponsePayload(response, type),
  cacheControl: response.headers.get("Cache-Control"),
  expires: response.headers.get("Expires"),
  etag: response.headers.get("ETag") ?? undefined,
});

const fetchAndCacheMapResource = async (
  originalUrl: string,
  requestParameters: { method?: "GET" | "POST" | "PUT"; body?: string; headers?: HeadersInit; credentials?: RequestCredentials; referrerPolicy?: ReferrerPolicy; type?: string },
  abortController: AbortController
) => {
  const request = new Request(originalUrl, {
    method: requestParameters.method || "GET",
    body: requestParameters.body,
    headers: requestParameters.headers,
    credentials: requestParameters.credentials,
    referrerPolicy: requestParameters.referrerPolicy,
    signal: abortController.signal,
  });

  const response = await fetch(request);
  if (!response.ok) {
    throw new Error(`Map resource request failed: ${response.status} ${response.statusText} (${originalUrl})`);
  }

  if (canUseMapResourceCache() && request.method === "GET") {
    const cache = await caches.open(MAP_RESOURCE_CACHE_NAME);
    await cache.put(originalUrl, response.clone());
  }

  return createResourceResponse(response, requestParameters.type);
};

export const installMapResourceCacheProtocol = () => {
  if (protocolInstalled || !canUseMapResourceCache()) {
    return;
  }

  protocolInstalled = true;

  maplibregl.addProtocol(
    MAP_RESOURCE_CACHE_PROTOCOL,
    async (requestParameters, abortController) => {
      const originalUrl = decodeCachedUrl(requestParameters.url);
      const cache = await caches.open(MAP_RESOURCE_CACHE_NAME);
      const cachedResponse = await cache.match(originalUrl);

      if (cachedResponse) {
        return createResourceResponse(cachedResponse, requestParameters.type);
      }

      return fetchAndCacheMapResource(originalUrl, requestParameters, abortController);
    }
  );
};

export const createCachedMapTransformRequest = () =>
  async (url: string) => {
    if (!canUseMapResourceCache() || !shouldCacheMapResource(url)) {
      return { url };
    }

    return {
      url: encodeCachedUrl(url),
    };
  };
