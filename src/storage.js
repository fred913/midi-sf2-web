import { SOUNDFONT_CACHE_DB, SOUNDFONT_CACHE_STORE, SOUNDFONT_SETTINGS_KEY } from "./constants.js";
import { pageGlobalThis } from "./utils.js";

export async function downloadSoundFont(url, progress) {
  const fetchFn = typeof fetch === "function" ? fetch : pageGlobalThis()?.fetch?.bind(pageGlobalThis());
  if (typeof fetchFn !== "function") {
    throw new Error("fetch() is required to download the SoundFont.");
  }

  progress.show();
  const response = await fetchFn(url, { cache: "no-store" });
  if (!response.ok && response.status !== 0) {
    throw new Error(`Failed to download SoundFont: HTTP ${response.status}`);
  }

  const total = Number(response.headers?.get?.("content-length")) || 0;
  if (!response.body || typeof response.body.getReader !== "function") {
    const arrayBuffer = await response.arrayBuffer();
    progress.update(arrayBuffer.byteLength, total || arrayBuffer.byteLength);
    return arrayBuffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    chunks.push(result.value);
    received += result.value.byteLength;
    progress.update(received, total);
  }

  progress.update(received, total || received);
  return concatenateUint8Arrays(chunks, received).buffer;
}

function concatenateUint8Arrays(chunks, byteLength) {
  const combined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

export async function readCachedSoundFont(key) {
  const db = await openSoundFontCache();
  if (!db) {
    return null;
  }
  try {
    const record = await idbRequestToPromise(db.transaction(SOUNDFONT_CACHE_STORE, "readonly").objectStore(SOUNDFONT_CACHE_STORE).get(key));
    return isArrayBuffer(record?.data) ? record.data : null;
  } catch {
    return null;
  } finally {
    db.close?.();
  }
}

export async function loadInstalledSoundFontRecords() {
  const db = await openSoundFontCache();
  if (!db) {
    return [];
  }
  try {
    const records = await idbRequestToPromise(db.transaction(SOUNDFONT_CACHE_STORE, "readonly").objectStore(SOUNDFONT_CACHE_STORE).getAll());
    return records.filter((record) => record?.custom && isArrayBuffer(record.data));
  } catch {
    return [];
  } finally {
    db.close?.();
  }
}

export async function readSoundFontSettings() {
  const db = await openSoundFontCache();
  if (!db) {
    return {};
  }
  try {
    const record = await idbRequestToPromise(db.transaction(SOUNDFONT_CACHE_STORE, "readonly").objectStore(SOUNDFONT_CACHE_STORE).get(SOUNDFONT_SETTINGS_KEY));
    return record?.settings || {};
  } catch {
    return {};
  } finally {
    db.close?.();
  }
}

export async function writeSoundFontSettings(settings) {
  const db = await openSoundFontCache();
  if (!db) {
    return;
  }
  try {
    const existing = await idbRequestToPromise(db.transaction(SOUNDFONT_CACHE_STORE, "readonly").objectStore(SOUNDFONT_CACHE_STORE).get(SOUNDFONT_SETTINGS_KEY));
    await idbRequestToPromise(db.transaction(SOUNDFONT_CACHE_STORE, "readwrite").objectStore(SOUNDFONT_CACHE_STORE).put({
      key: SOUNDFONT_SETTINGS_KEY,
      settings: {
        ...(existing?.settings || {}),
        ...settings
      },
      updatedAt: Date.now()
    }));
  } catch {
    // User settings are a convenience; MIDI output still works without them.
  } finally {
    db.close?.();
  }
}

export async function writeCachedSoundFont(key, arrayBuffer, metadata = {}) {
  const db = await openSoundFontCache();
  if (!db) {
    return;
  }
  try {
    await idbRequestToPromise(db.transaction(SOUNDFONT_CACHE_STORE, "readwrite").objectStore(SOUNDFONT_CACHE_STORE).put({
      key,
      data: arrayBuffer,
      byteLength: arrayBuffer.byteLength,
      name: metadata.name || key,
      custom: !!metadata.custom,
      source: metadata.source || "",
      url: metadata.url || "",
      updatedAt: Date.now()
    }));
  } catch {
    // Playback still works without a persistent cache.
  } finally {
    db.close?.();
  }
}

export async function updateCachedSoundFontMetadata(key, metadata = {}) {
  const db = await openSoundFontCache();
  if (!db) {
    return;
  }
  try {
    const record = await idbRequestToPromise(db.transaction(SOUNDFONT_CACHE_STORE, "readonly").objectStore(SOUNDFONT_CACHE_STORE).get(key));
    if (!record) {
      return;
    }
    await idbRequestToPromise(db.transaction(SOUNDFONT_CACHE_STORE, "readwrite").objectStore(SOUNDFONT_CACHE_STORE).put({
      ...record,
      ...metadata,
      key,
      updatedAt: Date.now()
    }));
  } catch {
    // Runtime device names remain usable even if metadata persistence fails.
  } finally {
    db.close?.();
  }
}

export async function deleteCachedSoundFont(key) {
  const db = await openSoundFontCache();
  if (!db) {
    return;
  }
  try {
    await idbRequestToPromise(db.transaction(SOUNDFONT_CACHE_STORE, "readwrite").objectStore(SOUNDFONT_CACHE_STORE).delete(key));
  } catch {
    // Nothing useful to report for cache cleanup failures.
  } finally {
    db.close?.();
  }
}

function openSoundFontCache() {
  if (typeof indexedDB === "undefined" || !indexedDB?.open) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const request = indexedDB.open(SOUNDFONT_CACHE_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SOUNDFONT_CACHE_STORE)) {
        db.createObjectStore(SOUNDFONT_CACHE_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function idbRequestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
  });
}

function isArrayBuffer(value) {
  return Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}
