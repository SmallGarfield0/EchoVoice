export const contentCacheName = "echovoice-content-v1";
export const defaultContentCacheLimitBytes = 512 * 1024 * 1024;

const cacheIndexStorageKey = "ev.contentCache.index.v1";

export type ContentCacheEntry = {
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  lastAccessedAtMS: number;
};

type ContentCacheIndex = Record<string, ContentCacheEntry>;

export function normalizeSHA256(value: string): string {
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : "";
}

export async function sha256Hex(input: Blob | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = input instanceof Blob
    ? await input.arrayBuffer()
    : input instanceof Uint8Array
      ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
      : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function readCachedContentAsset(sha256: string): Promise<Response | null> {
  const normalized = normalizeSHA256(sha256);
  if (!normalized || !("caches" in globalThis)) return null;
  const cache = await caches.open(contentCacheName);
  const response = await cache.match(contentCacheRequest(normalized));
  if (!response) return null;
  touchContentCacheIndex(normalized, response);
  return response;
}

export async function cacheContentAsset(sha256: string, response: Response): Promise<Response> {
  const expected = normalizeSHA256(sha256);
  if (!expected) throw new Error("invalid content asset sha256");
  const blob = await response.blob();
  const actual = await sha256Hex(blob);
  if (actual !== expected) {
    throw new Error(`content asset sha256 mismatch: expected ${expected}, got ${actual}`);
  }
  const cachedResponse = new Response(blob, {
    status: 200,
    headers: {
      "Content-Type": blob.type || response.headers.get("Content-Type") || "application/octet-stream",
      "Content-Length": String(blob.size),
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-EchoVoice-SHA256": expected
    }
  });
  if ("caches" in globalThis) {
    const cache = await caches.open(contentCacheName);
    await cache.put(contentCacheRequest(expected), cachedResponse.clone());
  }
  writeContentCacheEntry({
    sha256: expected,
    sizeBytes: blob.size,
    mimeType: cachedResponse.headers.get("Content-Type") || "application/octet-stream",
    lastAccessedAtMS: Date.now()
  });
  return cachedResponse;
}

export async function getOrFetchContentAsset(
  sha256: string,
  fetcher: () => Promise<Response>
): Promise<Response> {
  const cached = await readCachedContentAsset(sha256);
  if (cached) return cached;
  return cacheContentAsset(sha256, await fetcher());
}

export async function pruneContentCache(maxBytes = defaultContentCacheLimitBytes): Promise<number> {
  if (!("caches" in globalThis)) return 0;
  const index = readContentCacheIndex();
  const entries = Object.values(index).sort((left, right) => left.lastAccessedAtMS - right.lastAccessedAtMS);
  let total = entries.reduce((sum, entry) => sum + Math.max(0, entry.sizeBytes), 0);
  if (total <= maxBytes) return 0;
  const cache = await caches.open(contentCacheName);
  let removed = 0;
  for (const entry of entries) {
    if (total <= maxBytes) break;
    await cache.delete(contentCacheRequest(entry.sha256));
    total -= Math.max(0, entry.sizeBytes);
    delete index[entry.sha256];
    removed += 1;
  }
  writeContentCacheIndex(index);
  return removed;
}

export function readContentCacheIndex(): ContentCacheIndex {
  if (!("localStorage" in globalThis)) return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(cacheIndexStorageKey) ?? "{}") as ContentCacheIndex;
    return Object.fromEntries(
      Object.entries(parsed).filter(([sha256, entry]) => normalizeSHA256(sha256) && entry?.sha256 === sha256)
    );
  } catch {
    return {};
  }
}

function contentCacheRequest(sha256: string): Request {
  const origin = "location" in globalThis ? location.origin : "https://echovoice.invalid";
  return new Request(`${origin}/__echovoice_content_cache__/${sha256}`);
}

function touchContentCacheIndex(sha256: string, response: Response) {
  writeContentCacheEntry({
    sha256,
    sizeBytes: Number(response.headers.get("Content-Length")) || 0,
    mimeType: response.headers.get("Content-Type") || "application/octet-stream",
    lastAccessedAtMS: Date.now()
  });
}

function writeContentCacheEntry(entry: ContentCacheEntry) {
  const index = readContentCacheIndex();
  index[entry.sha256] = entry;
  writeContentCacheIndex(index);
}

function writeContentCacheIndex(index: ContentCacheIndex) {
  if (!("localStorage" in globalThis)) return;
  localStorage.setItem(cacheIndexStorageKey, JSON.stringify(index));
}
