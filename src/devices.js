import { CUSTOM_SOUNDFONT_PREFIX } from "./constants.js";
import { performanceNow } from "./utils.js";

export function publicSoundFontDevice(device) {
  if (!device) {
    return null;
  }
  return {
    id: device.id,
    key: device.key,
    name: device.name,
    builtIn: !!device.builtIn,
    source: device.source || ""
  };
}

export function createPerformanceStats() {
  return {
    midiEvents: 0,
    playedNotes: 0,
    droppedMidiEvents: 0,
    droppedNotes: 0
  };
}

export function incrementPerformanceStat(stats, key, count = 1) {
  const amount = Math.max(0, Math.floor(Number(count) || 0));
  if (amount) {
    stats[key] += amount;
  }
}

export function aggregatePerformanceStats(devices) {
  const totals = {
    ...createPerformanceStats(),
    activeNotes: 0,
    activeVoices: 0,
    pendingMidi: 0,
    sampleBuffers: 0
  };
  const deviceStats = devices.map((device) => {
    const stats = device.synth.getPerformanceStats();
    for (const key of Object.keys(totals)) {
      totals[key] += stats[key] || 0;
    }
    return {
      ...publicSoundFontDevice(device),
      stats
    };
  });
  return {
    updatedAt: performanceNow(),
    totals,
    devices: deviceStats
  };
}

export function createCustomSoundFontKey(name) {
  return `${CUSTOM_SOUNDFONT_PREFIX}${Date.now()}-${simpleHash(name).toString(36)}`;
}

export function simpleHash(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function cleanSoundFontName(name) {
  const text = String(name || "Custom SF2")
    .replace(/\.(sf2|sf3)$/i, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || "Custom SF2";
}

export function fileNameFromUrl(url) {
  try {
    const base = typeof location !== "undefined" ? location.href : "https://example.invalid/";
    const pathname = new URL(url, base).pathname;
    return decodeURIComponent(pathname.split("/").filter(Boolean).pop() || "");
  } catch {
    return String(url || "").split("/").filter(Boolean).pop() || "";
  }
}
