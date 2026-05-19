import {
  DEFAULT_LOOKAHEAD_MS,
  DEFAULT_MASTER_GAIN,
  DEFAULT_MAX_MESSAGES_PER_TICK,
  DEFAULT_MAX_VOICES,
  DEFAULT_MAX_VOICES_PER_CHANNEL,
  DEFAULT_OUTPUT_ID,
  DEFAULT_PERFORMANCE_LIMIT_ENABLED,
  DEFAULT_SCHEDULER_INTERVAL_MS,
  DEFAULT_SOUNDFONT_CACHE_KEY,
  MIN_LOOKAHEAD_MS,
  MIN_SCHEDULER_INTERVAL_MS
} from "./constants.js";
import {
  aggregatePerformanceStats,
  cleanSoundFontName,
  createCustomSoundFontKey,
  fileNameFromUrl,
  publicSoundFontDevice
} from "./devices.js";
import { parseMidiFile } from "./midi.js";
import { LookaheadScheduler } from "./scheduler.js";
import { EmbeddedSoundFontSynth } from "./synth.js";
import {
  deleteCachedSoundFont,
  loadInstalledSoundFontRecords,
  readSoundFontSettings,
  updateCachedSoundFontMetadata,
  writeCachedSoundFont,
  writeSoundFontSettings
} from "./storage.js";
import { openSoundFontSettingsPanel, registerSettingsMenu } from "./ui.js";
import {
  defineRequestMIDIAccess,
  firstMapValue,
  normalizeMasterGain,
  normalizeVoiceLimit,
  pageGlobalThis,
  performanceNow,
  positiveIntegerOrDefault,
  positiveNumberOrDefault,
  scheduleOutputMessages
} from "./utils.js";
import { VirtualMIDIAccess } from "./web-midi.js";

export { parseMidiFile } from "./midi.js";

let installedShim = null;

export function installWebMidiAudioShim(options = {}) {
  const targetNavigator = options.navigator || globalThis.navigator;
  if (!targetNavigator) {
    throw new Error("A navigator object is required to install the Web MIDI audio shim.");
  }

  if (installedShim && !options.force) {
    return installedShim;
  }

  if (installedShim && options.force) {
    installedShim.restore();
  }

  const previousRequestMIDIAccess = targetNavigator.requestMIDIAccess;
  let masterGainValue = normalizeMasterGain(options.masterGain, DEFAULT_MASTER_GAIN);
  let passthroughRealMidi = options.passthroughRealMidi !== false;
  let maxVoicesValue = normalizeVoiceLimit(options.maxVoices, DEFAULT_MAX_VOICES, 8, 512);
  let maxVoicesPerChannelValue = normalizeVoiceLimit(options.maxVoicesPerChannel, DEFAULT_MAX_VOICES_PER_CHANNEL, 4, 256);
  let performanceLimitEnabled = options.performanceLimitEnabled === undefined ? DEFAULT_PERFORMANCE_LIMIT_ENABLED : !!options.performanceLimitEnabled;
  maxVoicesValue = Math.max(maxVoicesValue, maxVoicesPerChannelValue);
  const defaultSynth = new EmbeddedSoundFontSynth({
    audioContext: options.audioContext,
    soundFontBase64: options.soundFontBase64,
    soundFontUrl: options.soundFontUrl,
    soundFontCacheKey: options.soundFontCacheKey,
    cacheSoundFont: options.cacheSoundFont,
    progress: options.progress,
    masterGain: masterGainValue,
    maxVoices: maxVoicesValue,
    maxVoicesPerChannel: maxVoicesPerChannelValue,
    performanceLimitEnabled
  });
  const defaultDevice = {
    id: options.outputId || DEFAULT_OUTPUT_ID,
    key: DEFAULT_SOUNDFONT_CACHE_KEY,
    name: options.outputName || "GeneralUser GS Web Audio",
    builtIn: true,
    synth: defaultSynth
  };
  const devices = new Map([[defaultDevice.id, defaultDevice]]);
  const accessBySysex = new Map();
  const accessRequestOptionsBySysex = new Map();
  const nativeAccessPromisesBySysex = new Map();
  let settingsReady = Promise.resolve();

  function orderedDevices() {
    return Array.from(devices.values());
  }

  function syncDeviceToAccesses(device) {
    for (const access of accessBySysex.values()) {
      access.addOutputDevice(device);
    }
  }

  function removeDeviceFromAccesses(deviceId) {
    for (const access of accessBySysex.values()) {
      access.removeOutputDevice(deviceId);
    }
  }

  function renameDeviceInAccesses(deviceId, name) {
    for (const access of accessBySysex.values()) {
      access.renameOutputDevice(deviceId, name);
    }
  }

  function registerCustomSoundFont(record) {
    if (!record?.key || devices.has(record.key)) {
      return null;
    }
    const device = {
      id: record.key,
      key: record.key,
      name: record.name || record.key,
      builtIn: false,
      source: record.source || "",
      synth: new EmbeddedSoundFontSynth({
        audioContext: options.audioContext,
        soundFontUrl: record.url || null,
        soundFontCacheKey: record.key,
        cacheSoundFont: true,
        progress: options.progress === false ? false : null,
        masterGain: masterGainValue,
        maxVoices: maxVoicesValue,
        maxVoicesPerChannel: maxVoicesPerChannelValue,
        performanceLimitEnabled
      })
    };
    devices.set(device.id, device);
    syncDeviceToAccesses(device);
    return device;
  }

  function getAccess(requestOptions = {}) {
    const sysexEnabled = !!requestOptions.sysex;
    accessRequestOptionsBySysex.set(sysexEnabled, requestOptions);
    if (!accessBySysex.has(sysexEnabled)) {
      accessBySysex.set(sysexEnabled, new VirtualMIDIAccess(orderedDevices(), {
        ...options,
        sysexEnabled,
        lookaheadMs: options.lookaheadMs ?? DEFAULT_LOOKAHEAD_MS,
        schedulerIntervalMs: options.schedulerIntervalMs ?? DEFAULT_SCHEDULER_INTERVAL_MS,
        maxMessagesPerTick: options.maxMessagesPerTick ?? DEFAULT_MAX_MESSAGES_PER_TICK
      }));
    }
    return accessBySysex.get(sysexEnabled);
  }

  async function requestMIDIAccess(requestOptions = {}) {
    await settingsReady;
    const access = getAccess(requestOptions);
    await syncNativeMIDIAccess(requestOptions, access);
    return access;
  }

  function applyMasterGain(value, persist = true) {
    masterGainValue = normalizeMasterGain(value, masterGainValue);
    for (const device of devices.values()) {
      device.synth.setMasterGain(masterGainValue);
    }
    if (persist) {
      writeSoundFontSettings({ masterGain: masterGainValue });
    }
    return masterGainValue;
  }

  async function applyPassthroughRealMidi(enabled, persist = true) {
    passthroughRealMidi = enabled !== false;
    if (persist) {
      writeSoundFontSettings({ passthroughRealMidi });
    }
    if (!passthroughRealMidi) {
      for (const access of accessBySysex.values()) {
        access.detachNativeAccess();
      }
      return passthroughRealMidi;
    }
    await syncAllNativeMIDIAccesses();
    return passthroughRealMidi;
  }

  function applyVoiceLimits(limits = {}, persist = true) {
    maxVoicesValue = normalizeVoiceLimit(limits.maxVoices, maxVoicesValue, 8, 512);
    maxVoicesPerChannelValue = normalizeVoiceLimit(limits.maxVoicesPerChannel, maxVoicesPerChannelValue, 4, 256);
    if (maxVoicesValue < maxVoicesPerChannelValue) {
      maxVoicesValue = maxVoicesPerChannelValue;
    }
    for (const device of devices.values()) {
      device.synth.setVoiceLimits(maxVoicesValue, maxVoicesPerChannelValue);
    }
    if (persist) {
      writeSoundFontSettings({
        maxVoices: maxVoicesValue,
        maxVoicesPerChannel: maxVoicesPerChannelValue
      });
    }
    return {
      maxVoices: maxVoicesValue,
      maxVoicesPerChannel: maxVoicesPerChannelValue
    };
  }

  function applyPerformanceLimitEnabled(enabled, persist = true) {
    performanceLimitEnabled = !!enabled;
    for (const device of devices.values()) {
      device.synth.setPerformanceLimitEnabled(performanceLimitEnabled);
    }
    if (persist) {
      writeSoundFontSettings({ performanceLimitEnabled });
    }
    return performanceLimitEnabled;
  }

  async function syncAllNativeMIDIAccesses() {
    const tasks = [];
    for (const [sysexEnabled, access] of accessBySysex) {
      tasks.push(syncNativeMIDIAccess(accessRequestOptionsBySysex.get(sysexEnabled) || { sysex: sysexEnabled }, access));
    }
    await Promise.all(tasks);
  }

  async function syncNativeMIDIAccess(requestOptions = {}, access = getAccess(requestOptions)) {
    if (!passthroughRealMidi) {
      access.detachNativeAccess();
      return access;
    }
    if (typeof previousRequestMIDIAccess !== "function") {
      return access;
    }

    const sysexEnabled = !!requestOptions.sysex;
    if (!nativeAccessPromisesBySysex.has(sysexEnabled)) {
      nativeAccessPromisesBySysex.set(sysexEnabled, Promise.resolve()
        .then(() => previousRequestMIDIAccess.call(targetNavigator, requestOptions))
        .catch(() => null));
    }
    const nativeAccess = await nativeAccessPromisesBySysex.get(sysexEnabled);
    if (nativeAccess && passthroughRealMidi) {
      access.attachNativeAccess(nativeAccess);
    }
    return access;
  }

  defineRequestMIDIAccess(targetNavigator, requestMIDIAccess);

  installedShim = {
    get access() {
      return getAccess();
    },
    getAccess,
    synth: defaultSynth,
    previousRequestMIDIAccess,
    restore() {
      for (const access of accessBySysex.values()) {
        for (const output of access.outputs.values()) {
          if (typeof output.clear === "function") {
            output.clear();
          }
        }
        access.detachNativeAccess();
      }
      if (previousRequestMIDIAccess) {
        defineRequestMIDIAccess(targetNavigator, previousRequestMIDIAccess);
      } else {
        delete targetNavigator.requestMIDIAccess;
      }
      installedShim = null;
    },
    preload() {
      return defaultSynth.preload();
    },
    clearSoundFontCache() {
      return defaultSynth.clearCache();
    },
    getMasterGain() {
      return masterGainValue;
    },
    setMasterGain(value) {
      return applyMasterGain(value);
    },
    getPassthroughRealMidi() {
      return passthroughRealMidi;
    },
    setPassthroughRealMidi(enabled) {
      return applyPassthroughRealMidi(enabled);
    },
    getVoiceLimits() {
      return {
        maxVoices: maxVoicesValue,
        maxVoicesPerChannel: maxVoicesPerChannelValue
      };
    },
    setVoiceLimits(limits) {
      return applyVoiceLimits(limits);
    },
    getPerformanceLimitEnabled() {
      return performanceLimitEnabled;
    },
    setPerformanceLimitEnabled(enabled) {
      return applyPerformanceLimitEnabled(enabled);
    },
    getPerformanceStats() {
      return aggregatePerformanceStats(orderedDevices());
    },
    listSoundFontDevices() {
      return orderedDevices().map((device) => publicSoundFontDevice(device));
    },
    async installSoundFontFromArrayBuffer(arrayBuffer, metadata = {}) {
      const key = metadata.key || createCustomSoundFontKey(metadata.name || metadata.fileName || metadata.url || "Custom SF2");
      const name = cleanSoundFontName(metadata.name || metadata.fileName || metadata.url || "Custom SF2");
      await writeCachedSoundFont(key, arrayBuffer, {
        ...metadata,
        key,
        name,
        custom: true
      });
      const device = registerCustomSoundFont({
        key,
        name,
        source: metadata.source || "file",
        url: metadata.url || ""
      });
      return publicSoundFontDevice(device);
    },
    async installSoundFontFromUrl(url, metadata = {}) {
      const progress = createSoundFontProgressOverlay();
      const arrayBuffer = await downloadSoundFont(url, progress);
      return this.installSoundFontFromArrayBuffer(arrayBuffer, {
        ...metadata,
        name: metadata.name || fileNameFromUrl(url) || "Remote SF2",
        source: "url",
        url
      });
    },
    async uninstallSoundFont(deviceId) {
      const device = devices.get(deviceId);
      if (!device || device.builtIn) {
        return false;
      }
      device.synth.clear();
      devices.delete(deviceId);
      await deleteCachedSoundFont(device.key);
      removeDeviceFromAccesses(deviceId);
      return true;
    },
    async renameSoundFontDevice(deviceId, name) {
      const device = devices.get(deviceId);
      if (!device || device.builtIn) {
        return null;
      }
      const cleanName = cleanSoundFontName(name);
      device.name = cleanName;
      await updateCachedSoundFontMetadata(device.key, { name: cleanName });
      renameDeviceInAccesses(deviceId, cleanName);
      return publicSoundFontDevice(device);
    },
    openSettings() {
      openSoundFontSettingsPanel(installedShim);
    }
  };

  const shouldReadSettings = options.masterGain === undefined ||
    options.passthroughRealMidi === undefined ||
    options.maxVoices === undefined ||
    options.maxVoicesPerChannel === undefined ||
    options.performanceLimitEnabled === undefined;

  settingsReady = Promise.all([
    loadInstalledSoundFontRecords(),
    shouldReadSettings ? readSoundFontSettings() : Promise.resolve({})
  ])
    .then(([records, settings]) => {
      for (const record of records) {
        registerCustomSoundFont(record);
      }
      if (options.masterGain === undefined && settings?.masterGain != null) {
        applyMasterGain(settings.masterGain, false);
      }
      if (options.passthroughRealMidi === undefined && settings?.passthroughRealMidi != null) {
        applyPassthroughRealMidi(settings.passthroughRealMidi, false);
      }
      if ((options.maxVoices === undefined && settings?.maxVoices != null) || (options.maxVoicesPerChannel === undefined && settings?.maxVoicesPerChannel != null)) {
        applyVoiceLimits({
          maxVoices: options.maxVoices === undefined ? settings?.maxVoices : maxVoicesValue,
          maxVoicesPerChannel: options.maxVoicesPerChannel === undefined ? settings?.maxVoicesPerChannel : maxVoicesPerChannelValue
        }, false);
      }
      if (options.performanceLimitEnabled === undefined && settings?.performanceLimitEnabled != null) {
        applyPerformanceLimitEnabled(settings.performanceLimitEnabled, false);
      }
    })
    .catch(() => {
      // Settings should never block MIDI installation.
    });

  registerSettingsMenu(installedShim);

  return installedShim;
}

export function getInstalledWebMidiAudioShim() {
  return installedShim;
}

export async function preloadEmbeddedSoundFont() {
  const shim = installedShim || installWebMidiAudioShim();
  await shim.preload();
  return shim.synth;
}

export function clearSoundFontCache(cacheKey = DEFAULT_SOUNDFONT_CACHE_KEY) {
  return deleteCachedSoundFont(cacheKey);
}

export async function playMidiFile(arrayBuffer, options = {}) {
  const events = parseMidiFile(arrayBuffer);
  const access = options.access || installedShim?.getAccess?.({ sysex: true }) || await navigator.requestMIDIAccess({ sysex: true });
  const output = options.output || firstMapValue(access.outputs);
  if (!output) {
    throw new Error("No MIDI output is available.");
  }
  if (typeof output.preload === "function") {
    await output.preload();
  }

  const playbackRate = options.playbackRate || 1;
  const lookaheadMs = positiveNumberOrDefault(options.lookaheadMs, DEFAULT_LOOKAHEAD_MS, MIN_LOOKAHEAD_MS);
  const schedulerIntervalMs = positiveNumberOrDefault(options.schedulerIntervalMs, DEFAULT_SCHEDULER_INTERVAL_MS, MIN_SCHEDULER_INTERVAL_MS);
  const maxEventsPerTick = positiveIntegerOrDefault(options.maxEventsPerTick, DEFAULT_MAX_MESSAGES_PER_TICK);
  const startedAt = performanceNow() + (options.startDelayMs || 0);
  let cursor = 0;
  let stopped = false;
  const scheduler = new LookaheadScheduler({
    intervalMs: schedulerIntervalMs,
    onTick() {
      if (stopped) {
        return;
      }
      const horizon = performanceNow() + lookaheadMs;
      const batch = [];
      while (cursor < events.length && batch.length < maxEventsPerTick) {
        const eventTimestamp = startedAt + events[cursor].timeMs / playbackRate;
        if (eventTimestamp > horizon) {
          break;
        }
        batch.push({
          data: events[cursor].data,
          timestamp: eventTimestamp
        });
        cursor += 1;
      }
      scheduleOutputMessages(output, batch);
      if (cursor >= events.length) {
        scheduler.stop();
      }
    }
  });

  scheduler.start();
  scheduler.tick();

  return {
    durationMs: events.length ? events[events.length - 1].timeMs / playbackRate : 0,
    startedAt,
    stop() {
      stopped = true;
      scheduler.stop();
      if (typeof output.clear === "function") {
        output.clear();
      }
    }
  };
}

if (typeof window !== "undefined" && !pageGlobalThis().__WEB_MIDI_AUDIO_SHIM_NO_AUTO_INSTALL__) {
  installWebMidiAudioShim({ navigator: pageGlobalThis().navigator });
}
