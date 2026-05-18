import embeddedSoundFontBase64 from "../assets/GeneralUser-GS.sf2";

const DEFAULT_OUTPUT_ID = "generaluser-gs-web-audio";
const MIDI_CHANNELS = 16;
const PERCUSSION_CHANNEL = 9;
const DEFAULT_PITCH_BEND_RANGE = 2;
const UINT16_REPLACE_OPERATORS = new Set([41, 46, 47, 53, 54, 56, 57, 58]);
const ADDITIVE_OPERATORS = new Set([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17,
  21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
  36, 37, 38, 39, 40, 45, 48, 50, 51, 52
]);

const OPERATOR_NAMES = {
  0: "startAddrsOffset",
  1: "endAddrsOffset",
  2: "startloopAddrsOffset",
  3: "endloopAddrsOffset",
  4: "startAddrsCoarseOffset",
  8: "initialFilterFc",
  17: "pan",
  26: "attackModEnv",
  27: "holdModEnv",
  28: "decayModEnv",
  29: "sustainModEnv",
  30: "releaseModEnv",
  33: "delayVolEnv",
  34: "attackVolEnv",
  35: "holdVolEnv",
  36: "decayVolEnv",
  37: "sustainVolEnv",
  38: "releaseVolEnv",
  41: "instrument",
  43: "keyRange",
  44: "velRange",
  45: "startloopAddrsCoarseOffset",
  46: "keynum",
  47: "velocity",
  48: "initialAttenuation",
  50: "endloopAddrsCoarseOffset",
  51: "coarseTune",
  52: "fineTune",
  53: "sampleID",
  54: "sampleModes",
  56: "scaleTuning",
  57: "exclusiveClass",
  58: "overridingRootKey"
};

let installedShim = null;

export function installWebMidiAudioShim(options = {}) {
  const targetNavigator = options.navigator || globalThis.navigator;
  if (!targetNavigator) {
    throw new Error("A navigator object is required to install the Web MIDI audio shim.");
  }

  if (installedShim && !options.force) {
    return installedShim;
  }

  const previousRequestMIDIAccess = targetNavigator.requestMIDIAccess;
  const synth = new EmbeddedSoundFontSynth({
    audioContext: options.audioContext,
    soundFontBase64: options.soundFontBase64 || embeddedSoundFontBase64,
    masterGain: options.masterGain
  });
  const access = new VirtualMIDIAccess(synth, options);

  function requestMIDIAccess() {
    return Promise.resolve(access);
  }

  defineRequestMIDIAccess(targetNavigator, requestMIDIAccess);

  installedShim = {
    access,
    synth,
    previousRequestMIDIAccess,
    restore() {
      if (previousRequestMIDIAccess) {
        defineRequestMIDIAccess(targetNavigator, previousRequestMIDIAccess);
      } else {
        delete targetNavigator.requestMIDIAccess;
      }
      installedShim = null;
    },
    preload() {
      return synth.preload();
    }
  };

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

export async function playMidiFile(arrayBuffer, options = {}) {
  const events = parseMidiFile(arrayBuffer);
  const access = options.access || installedShim?.access || await navigator.requestMIDIAccess();
  const output = options.output || firstMapValue(access.outputs);
  if (!output) {
    throw new Error("No MIDI output is available.");
  }

  const playbackRate = options.playbackRate || 1;
  const timers = [];
  const startedAt = performanceNow();
  for (const event of events) {
    const delay = Math.max(0, event.timeMs / playbackRate);
    timers.push(globalThis.setTimeout(() => output.send(event.data), delay));
  }

  return {
    durationMs: events.length ? events[events.length - 1].timeMs / playbackRate : 0,
    startedAt,
    stop() {
      for (const timer of timers) {
        globalThis.clearTimeout(timer);
      }
      if (typeof output.clear === "function") {
        output.clear();
      }
    }
  };
}

export function parseMidiFile(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  let offset = 0;

  function readString(length) {
    let result = "";
    for (let i = 0; i < length; i += 1) {
      result += String.fromCharCode(view.getUint8(offset + i));
    }
    offset += length;
    return result;
  }

  function readU16() {
    const value = view.getUint16(offset, false);
    offset += 2;
    return value;
  }

  function readU32() {
    const value = view.getUint32(offset, false);
    offset += 4;
    return value;
  }

  function readVarLen(track) {
    let value = 0;
    let byte = 0;
    do {
      byte = view.getUint8(track.offset);
      track.offset += 1;
      value = (value << 7) | (byte & 0x7f);
    } while (byte & 0x80);
    return value;
  }

  if (readString(4) !== "MThd") {
    throw new Error("The file is not a Standard MIDI file.");
  }

  const headerLength = readU32();
  const format = readU16();
  const trackCount = readU16();
  const division = readU16();
  offset += headerLength - 6;

  if (division & 0x8000) {
    throw new Error("SMPTE MIDI timing is not supported by this lightweight parser.");
  }

  const ticksPerQuarter = division;
  const rawEvents = [];

  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    if (readString(4) !== "MTrk") {
      throw new Error(`Missing MTrk header for track ${trackIndex}.`);
    }

    const trackLength = readU32();
    const track = {
      offset,
      end: offset + trackLength,
      tick: 0,
      runningStatus: 0
    };

    while (track.offset < track.end) {
      track.tick += readVarLen(track);
      let status = view.getUint8(track.offset);
      if (status & 0x80) {
        track.offset += 1;
      } else if (track.runningStatus) {
        status = track.runningStatus;
      } else {
        throw new Error("MIDI running status appeared before any status byte.");
      }

      if (status === 0xff) {
        const metaType = view.getUint8(track.offset);
        track.offset += 1;
        const length = readVarLen(track);
        if (metaType === 0x51 && length === 3) {
          const tempo =
            (view.getUint8(track.offset) << 16) |
            (view.getUint8(track.offset + 1) << 8) |
            view.getUint8(track.offset + 2);
          rawEvents.push({ tick: track.tick, tempo });
        }
        track.offset += length;
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        const length = readVarLen(track);
        track.offset += length;
        continue;
      }

      track.runningStatus = status;
      const command = status & 0xf0;
      const dataLength = command === 0xc0 || command === 0xd0 ? 1 : 2;
      const data = [status];
      for (let i = 0; i < dataLength; i += 1) {
        data.push(view.getUint8(track.offset));
        track.offset += 1;
      }
      rawEvents.push({ tick: track.tick, data });
    }

    offset = track.end;
  }

  rawEvents.sort((a, b) => a.tick - b.tick || eventSortOrder(a) - eventSortOrder(b));

  let currentTick = 0;
  let currentTimeUs = 0;
  let tempoUsPerQuarter = 500000;
  const scheduledEvents = [];

  for (const event of rawEvents) {
    const deltaTicks = event.tick - currentTick;
    currentTimeUs += (deltaTicks * tempoUsPerQuarter) / ticksPerQuarter;
    currentTick = event.tick;

    if (event.tempo) {
      tempoUsPerQuarter = event.tempo;
    } else if (event.data) {
      scheduledEvents.push({
        timeMs: currentTimeUs / 1000,
        data: event.data
      });
    }
  }

  if (format > 2) {
    throw new Error(`Unsupported MIDI file format ${format}.`);
  }

  return scheduledEvents;
}

class SimpleEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type);
    if (listeners) {
      listeners.delete(listener);
    }
  }

  dispatchEvent(event) {
    const listeners = this.listeners.get(event.type);
    if (listeners) {
      for (const listener of listeners) {
        listener.call(this, event);
      }
    }
    const handler = this[`on${event.type}`];
    if (typeof handler === "function") {
      handler.call(this, event);
    }
    return true;
  }
}

class VirtualMIDIAccess extends SimpleEventTarget {
  constructor(synth, options) {
    super();
    this.sysexEnabled = false;
    this.inputs = new Map();
    this.outputs = new Map();

    const output = new VirtualMIDIOutput(synth, {
      id: options.outputId || DEFAULT_OUTPUT_ID,
      manufacturer: options.manufacturer || "midi-sf2-web",
      name: options.outputName || "GeneralUser GS Web Audio"
    });
    this.outputs.set(output.id, output);
  }
}

class VirtualMIDIOutput extends SimpleEventTarget {
  constructor(synth, options) {
    super();
    this.synth = synth;
    this.id = options.id;
    this.manufacturer = options.manufacturer;
    this.name = options.name;
    this.type = "output";
    this.version = "0.1.0";
    this.state = "connected";
    this.connection = "closed";
  }

  open() {
    this.connection = "open";
    this.dispatchEvent({ type: "statechange", port: this });
    return Promise.resolve(this);
  }

  close() {
    this.connection = "closed";
    this.dispatchEvent({ type: "statechange", port: this });
    return Promise.resolve(this);
  }

  send(data, timestamp) {
    if (this.connection === "closed") {
      this.connection = "open";
    }
    const bytes = Array.from(data);
    const delaySeconds = timestamp ? Math.max(0, (timestamp - performanceNow()) / 1000) : 0;
    this.synth.dispatchMidi(bytes, delaySeconds);
  }

  clear() {
    this.synth.allSoundOff();
  }

  preload() {
    return this.synth.preload();
  }
}

class EmbeddedSoundFontSynth {
  constructor(options = {}) {
    this.soundFontBase64 = options.soundFontBase64 || embeddedSoundFontBase64;
    this.audioContext = options.audioContext || null;
    this.masterGainValue = options.masterGain ?? 0.85;
    this.soundFont = null;
    this.masterGain = null;
    this.sampleBufferCache = new Map();
    this.channels = Array.from({ length: MIDI_CHANNELS }, (_, index) => createChannelState(index));
  }

  async preload() {
    this.ensureSoundFont();
    this.ensureAudioContext();
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
    return this;
  }

  dispatchMidi(bytes, delaySeconds = 0) {
    if (!bytes.length) {
      return;
    }

    const status = bytes[0];
    if (status >= 0xf0) {
      return;
    }

    const command = status & 0xf0;
    const channelIndex = status & 0x0f;
    const data1 = bytes[1] || 0;
    const data2 = bytes[2] || 0;

    switch (command) {
      case 0x80:
        this.noteOff(channelIndex, data1, delaySeconds);
        break;
      case 0x90:
        if (data2 === 0) {
          this.noteOff(channelIndex, data1, delaySeconds);
        } else {
          this.noteOn(channelIndex, data1, data2, delaySeconds);
        }
        break;
      case 0xb0:
        this.controlChange(channelIndex, data1, data2, delaySeconds);
        break;
      case 0xc0:
        this.channels[channelIndex].program = data1 & 0x7f;
        break;
      case 0xe0:
        this.channels[channelIndex].pitchBend = ((data2 << 7) | data1) - 8192;
        this.updatePitchBend(channelIndex, delaySeconds);
        break;
      default:
        break;
    }
  }

  noteOn(channelIndex, note, velocity, delaySeconds = 0) {
    const soundFont = this.ensureSoundFont();
    const context = this.ensureAudioContext();
    const channel = this.channels[channelIndex];
    const bank = channelIndex === PERCUSSION_CHANNEL ? 128 : channel.bankMsb;
    const preset = soundFont.getPreset(bank, channel.program) || soundFont.getPreset(0, channel.program) || soundFont.getPreset(0, 0);
    if (!preset) {
      return;
    }

    const regions = soundFont.getPresetRegions(preset).filter((region) => regionMatches(region, note, velocity));
    if (!regions.length) {
      return;
    }

    const startTime = context.currentTime + delaySeconds;
    const voices = [];
    for (const region of regions) {
      const voice = this.createVoice(context, channel, channelIndex, note, velocity, region, startTime);
      if (voice) {
        voices.push(voice);
      }
    }

    if (!voices.length) {
      return;
    }

    const activeForNote = channel.activeNotes.get(note) || [];
    activeForNote.push(...voices);
    channel.activeNotes.set(note, activeForNote);
  }

  noteOff(channelIndex, note, delaySeconds = 0) {
    const context = this.ensureAudioContext();
    const channel = this.channels[channelIndex];
    const voices = channel.activeNotes.get(note);
    if (!voices) {
      return;
    }

    const releaseTime = context.currentTime + delaySeconds;
    if (channel.sustain) {
      for (const voice of voices) {
        voice.sustained = true;
      }
      return;
    }

    for (const voice of voices) {
      voice.release(releaseTime);
    }
    channel.activeNotes.delete(note);
  }

  controlChange(channelIndex, controller, value, delaySeconds = 0) {
    const channel = this.channels[channelIndex];
    switch (controller) {
      case 0:
        channel.bankMsb = value & 0x7f;
        break;
      case 6:
        if (channel.rpnMsb === 0 && channel.rpnLsb === 0) {
          channel.pitchBendRange = clamp(value, 0, 24);
        }
        break;
      case 7:
        channel.volume = value & 0x7f;
        break;
      case 10:
        channel.pan = value & 0x7f;
        break;
      case 11:
        channel.expression = value & 0x7f;
        break;
      case 32:
        channel.bankLsb = value & 0x7f;
        break;
      case 64:
        channel.sustain = value >= 64;
        if (!channel.sustain) {
          this.releaseSustained(channelIndex, delaySeconds);
        }
        break;
      case 100:
        channel.rpnLsb = value & 0x7f;
        break;
      case 101:
        channel.rpnMsb = value & 0x7f;
        break;
      case 120:
      case 123:
        this.allNotesOff(channelIndex, delaySeconds);
        break;
      case 121:
        resetChannelControllers(channel);
        break;
      default:
        break;
    }
  }

  updatePitchBend(channelIndex, delaySeconds = 0) {
    const context = this.ensureAudioContext();
    const channel = this.channels[channelIndex];
    const when = context.currentTime + delaySeconds;
    for (const voices of channel.activeNotes.values()) {
      for (const voice of voices) {
        voice.updatePitch(when);
      }
    }
  }

  releaseSustained(channelIndex, delaySeconds = 0) {
    const context = this.ensureAudioContext();
    const channel = this.channels[channelIndex];
    const when = context.currentTime + delaySeconds;
    for (const [note, voices] of channel.activeNotes) {
      const remaining = [];
      for (const voice of voices) {
        if (voice.sustained) {
          voice.release(when);
        } else {
          remaining.push(voice);
        }
      }
      if (remaining.length) {
        channel.activeNotes.set(note, remaining);
      } else {
        channel.activeNotes.delete(note);
      }
    }
  }

  allNotesOff(channelIndex, delaySeconds = 0) {
    const context = this.ensureAudioContext();
    const channel = this.channels[channelIndex];
    const when = context.currentTime + delaySeconds;
    for (const voices of channel.activeNotes.values()) {
      for (const voice of voices) {
        voice.release(when);
      }
    }
    channel.activeNotes.clear();
  }

  allSoundOff() {
    for (let i = 0; i < this.channels.length; i += 1) {
      this.allNotesOff(i);
    }
  }

  createVoice(context, channel, channelIndex, note, velocity, region, startTime) {
    const sample = this.soundFont.samples[region.sampleID];
    if (!sample || sample.sampleRate <= 0 || sample.end <= sample.start) {
      return null;
    }

    const sampleWindow = resolveSampleWindow(region, sample, this.soundFont.sampleData.length);
    if (sampleWindow.end <= sampleWindow.start) {
      return null;
    }

    const buffer = this.getSampleBuffer(context, sample, sampleWindow.start, sampleWindow.end);
    const source = context.createBufferSource();
    const gain = context.createGain();
    const panner = typeof context.createStereoPanner === "function" ? context.createStereoPanner() : null;
    const releaseSeconds = timecentsToSeconds(region.releaseVolEnv ?? -12000);
    const voice = {
      channel,
      source,
      gain,
      note,
      region,
      released: false,
      sustained: false,
      updatePitch: (when) => {
        const ratio = pitchRatio(channel, note, region, sample);
        source.playbackRate.cancelScheduledValues(when);
        source.playbackRate.setValueAtTime(ratio, when);
      },
      release: (when) => {
        if (voice.released) {
          return;
        }
        voice.released = true;
        gain.gain.cancelScheduledValues(when);
        gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), when);
        gain.gain.exponentialRampToValueAtTime(0.0001, when + Math.max(0.015, releaseSeconds));
        try {
          source.stop(when + Math.max(0.03, releaseSeconds) + 0.05);
        } catch {
          // The source may have already ended for one-shot samples.
        }
      }
    };

    source.buffer = buffer;
    source.playbackRate.setValueAtTime(pitchRatio(channel, note, region, sample), startTime);

    const loopStart = sampleWindow.loopStart - sampleWindow.start;
    const loopEnd = sampleWindow.loopEnd - sampleWindow.start;
    if ((region.sampleModes & 1) && loopEnd > loopStart + 8) {
      source.loop = true;
      source.loopStart = loopStart / sample.sampleRate;
      source.loopEnd = loopEnd / sample.sampleRate;
    }

    const amplitude = amplitudeFor(channel, velocity, region);
    applyEnvelope(gain.gain, startTime, amplitude, region);

    source.connect(gain);
    if (panner) {
      panner.pan.setValueAtTime(panFor(channel, region), startTime);
      gain.connect(panner);
      panner.connect(this.masterGain);
    } else {
      gain.connect(this.masterGain);
    }

    source.onended = () => {
      const activeForNote = channel.activeNotes.get(note);
      if (!activeForNote) {
        return;
      }
      const remaining = activeForNote.filter((activeVoice) => activeVoice !== voice);
      if (remaining.length) {
        channel.activeNotes.set(note, remaining);
      } else {
        channel.activeNotes.delete(note);
      }
    };

    source.start(startTime);
    return voice;
  }

  getSampleBuffer(context, sample, start, end) {
    const cacheKey = `${sample.index}:${start}:${end}`;
    const cached = this.sampleBufferCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const frameCount = end - start;
    const buffer = context.createBuffer(1, frameCount, sample.sampleRate);
    const channelData = buffer.getChannelData(0);
    const sampleData = this.soundFont.sampleData;
    for (let i = 0; i < frameCount; i += 1) {
      channelData[i] = sampleData[start + i] / 32768;
    }
    this.sampleBufferCache.set(cacheKey, buffer);
    return buffer;
  }

  ensureAudioContext() {
    if (!this.audioContext) {
      const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextCtor) {
        throw new Error("Web Audio is not available in this browser.");
      }
      this.audioContext = new AudioContextCtor();
    }

    if (!this.masterGain) {
      this.masterGain = this.audioContext.createGain();
      this.masterGain.gain.value = this.masterGainValue;
      this.masterGain.connect(this.audioContext.destination);
    }

    if (this.audioContext.state === "suspended") {
      this.audioContext.resume();
    }

    return this.audioContext;
  }

  ensureSoundFont() {
    if (!this.soundFont) {
      const arrayBuffer = base64ToArrayBuffer(this.soundFontBase64);
      this.soundFont = parseSoundFont(arrayBuffer);
    }
    return this.soundFont;
  }
}

class ParsedSoundFont {
  constructor(data) {
    this.presets = data.presets;
    this.presetBags = data.presetBags;
    this.presetGenerators = data.presetGenerators;
    this.instruments = data.instruments;
    this.instrumentBags = data.instrumentBags;
    this.instrumentGenerators = data.instrumentGenerators;
    this.samples = data.samples;
    this.sampleData = data.sampleData;
    this.regionCache = new Map();
    this.presetMap = new Map();

    for (const preset of this.presets) {
      if (!preset.terminal) {
        this.presetMap.set(`${preset.bank}:${preset.preset}`, preset);
      }
    }
  }

  getPreset(bank, program) {
    return this.presetMap.get(`${bank}:${program}`) || null;
  }

  getPresetRegions(preset) {
    if (this.regionCache.has(preset.index)) {
      return this.regionCache.get(preset.index);
    }

    const presetZones = this.getPresetZones(preset.index);
    const presetGlobal = mergeZoneList(presetZones.filter((zone) => zone.instrument == null).map((zone) => zone.generators));
    const regions = [];

    for (const presetZone of presetZones) {
      if (presetZone.instrument == null) {
        continue;
      }

      const presetGenerators = mergeGenerators(presetGlobal, presetZone.generators);
      const instrument = this.instruments[presetZone.instrument];
      if (!instrument) {
        continue;
      }

      const instrumentZones = this.getInstrumentZones(instrument.index);
      const instrumentGlobal = mergeZoneList(instrumentZones.filter((zone) => zone.sampleID == null).map((zone) => zone.generators));
      for (const instrumentZone of instrumentZones) {
        if (instrumentZone.sampleID == null) {
          continue;
        }

        const region = mergeGenerators(
          mergeGenerators(presetGenerators, instrumentGlobal),
          instrumentZone.generators
        );
        if (region.sampleID != null && region.sampleID >= 0 && region.sampleID < this.samples.length && validRange(region.keyRange) && validRange(region.velRange)) {
          regions.push(region);
        }
      }
    }

    this.regionCache.set(preset.index, regions);
    return regions;
  }

  getPresetZones(presetIndex) {
    const preset = this.presets[presetIndex];
    const nextPreset = this.presets[presetIndex + 1];
    return buildZones(this.presetBags, this.presetGenerators, preset.presetBagIndex, nextPreset.presetBagIndex, "instrument");
  }

  getInstrumentZones(instrumentIndex) {
    const instrument = this.instruments[instrumentIndex];
    const nextInstrument = this.instruments[instrumentIndex + 1];
    return buildZones(this.instrumentBags, this.instrumentGenerators, instrument.instrumentBagIndex, nextInstrument.instrumentBagIndex, "sampleID");
  }
}

function parseSoundFont(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (readString(view, 0, 4) !== "RIFF" || readString(view, 8, 4) !== "sfbk") {
    throw new Error("The embedded file is not an SF2 SoundFont bank.");
  }

  const riffEnd = 8 + view.getUint32(4, true);
  const chunks = { pdta: new Map(), sdta: new Map() };
  let offset = 12;

  while (offset < riffEnd) {
    const id = readString(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (id === "LIST") {
      const listType = readString(view, offset + 8, 4);
      if (listType === "pdta" || listType === "sdta") {
        readListChunks(view, offset + 12, offset + 8 + size, chunks[listType]);
      }
    }
    offset += 8 + size + (size % 2);
  }

  const smpl = chunks.sdta.get("smpl");
  if (!smpl) {
    throw new Error("The SF2 file has no sample data chunk.");
  }

  const sampleBytes = arrayBuffer.slice(smpl.offset, smpl.offset + smpl.size);
  const sampleData = new Int16Array(sampleBytes);
  const data = {
    presets: parsePresetHeaders(view, requiredChunk(chunks.pdta, "phdr")),
    presetBags: parseBags(view, requiredChunk(chunks.pdta, "pbag"), "presetBagIndex"),
    presetGenerators: parseGenerators(view, requiredChunk(chunks.pdta, "pgen")),
    instruments: parseInstruments(view, requiredChunk(chunks.pdta, "inst")),
    instrumentBags: parseBags(view, requiredChunk(chunks.pdta, "ibag"), "instrumentBagIndex"),
    instrumentGenerators: parseGenerators(view, requiredChunk(chunks.pdta, "igen")),
    samples: parseSampleHeaders(view, requiredChunk(chunks.pdta, "shdr")),
    sampleData
  };

  return new ParsedSoundFont(data);
}

function readListChunks(view, start, end, target) {
  let offset = start;
  while (offset < end) {
    const id = readString(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    target.set(id, { offset: offset + 8, size });
    offset += 8 + size + (size % 2);
  }
}

function parsePresetHeaders(view, chunk) {
  const recordSize = 38;
  const count = chunk.size / recordSize;
  const presets = [];
  for (let i = 0; i < count - 1; i += 1) {
    const offset = chunk.offset + i * recordSize;
    presets.push({
      index: i,
      name: readNullTerminatedString(view, offset, 20),
      preset: view.getUint16(offset + 20, true),
      bank: view.getUint16(offset + 22, true),
      presetBagIndex: view.getUint16(offset + 24, true)
    });
  }

  const terminalOffset = chunk.offset + (count - 1) * recordSize;
  presets.push({
    index: count - 1,
    name: readNullTerminatedString(view, terminalOffset, 20),
    preset: view.getUint16(terminalOffset + 20, true),
    bank: view.getUint16(terminalOffset + 22, true),
    presetBagIndex: view.getUint16(terminalOffset + 24, true),
    terminal: true
  });
  return presets;
}

function parseInstruments(view, chunk) {
  const recordSize = 22;
  const count = chunk.size / recordSize;
  const instruments = [];
  for (let i = 0; i < count; i += 1) {
    const offset = chunk.offset + i * recordSize;
    instruments.push({
      index: i,
      name: readNullTerminatedString(view, offset, 20),
      instrumentBagIndex: view.getUint16(offset + 20, true),
      terminal: i === count - 1
    });
  }
  return instruments;
}

function parseBags(view, chunk, indexName) {
  const recordSize = 4;
  const count = chunk.size / recordSize;
  const bags = [];
  for (let i = 0; i < count; i += 1) {
    const offset = chunk.offset + i * recordSize;
    bags.push({
      [indexName]: i,
      generatorIndex: view.getUint16(offset, true),
      modulatorIndex: view.getUint16(offset + 2, true)
    });
  }
  return bags;
}

function parseGenerators(view, chunk) {
  const recordSize = 4;
  const count = chunk.size / recordSize;
  const generators = [];
  for (let i = 0; i < count; i += 1) {
    const offset = chunk.offset + i * recordSize;
    const operator = view.getUint16(offset, true);
    const raw = view.getUint16(offset + 2, true);
    generators.push({
      operator,
      name: OPERATOR_NAMES[operator] || `operator${operator}`,
      value: decodeGeneratorAmount(operator, raw)
    });
  }
  return generators;
}

function parseSampleHeaders(view, chunk) {
  const recordSize = 46;
  const count = chunk.size / recordSize;
  const samples = [];
  for (let i = 0; i < count - 1; i += 1) {
    const offset = chunk.offset + i * recordSize;
    samples.push({
      index: i,
      name: readNullTerminatedString(view, offset, 20),
      start: view.getUint32(offset + 20, true),
      end: view.getUint32(offset + 24, true),
      startLoop: view.getUint32(offset + 28, true),
      endLoop: view.getUint32(offset + 32, true),
      sampleRate: view.getUint32(offset + 36, true),
      originalPitch: view.getUint8(offset + 40),
      pitchCorrection: view.getInt8(offset + 41),
      sampleLink: view.getUint16(offset + 42, true),
      sampleType: view.getUint16(offset + 44, true)
    });
  }
  return samples;
}

function buildZones(bags, generators, startBagIndex, endBagIndex, terminalName) {
  const zones = [];
  for (let bagIndex = startBagIndex; bagIndex < endBagIndex; bagIndex += 1) {
    const bag = bags[bagIndex];
    const nextBag = bags[bagIndex + 1];
    const zoneGenerators = {};
    for (let genIndex = bag.generatorIndex; genIndex < nextBag.generatorIndex; genIndex += 1) {
      const generator = generators[genIndex];
      if (!generator || generator.operator === 60) {
        continue;
      }
      applyGenerator(zoneGenerators, generator);
    }

    zones.push({
      generators: zoneGenerators,
      [terminalName]: zoneGenerators[terminalName]
    });
  }
  return zones;
}

function applyGenerator(target, generator) {
  const name = generator.name;
  if (name === "keyRange" || name === "velRange") {
    target[name] = generator.value;
    return;
  }

  if (UINT16_REPLACE_OPERATORS.has(generator.operator)) {
    target[name] = generator.value;
    return;
  }

  if (ADDITIVE_OPERATORS.has(generator.operator)) {
    target[name] = (target[name] || 0) + generator.value;
    return;
  }

  target[name] = generator.value;
}

function mergeZoneList(zones) {
  return zones.reduce((merged, zone) => mergeGenerators(merged, zone), {});
}

function mergeGenerators(base, next) {
  const result = { ...base };
  if (base.keyRange) {
    result.keyRange = [...base.keyRange];
  }
  if (base.velRange) {
    result.velRange = [...base.velRange];
  }

  for (const [name, value] of Object.entries(next)) {
    if (name === "keyRange" || name === "velRange") {
      result[name] = intersectRanges(result[name] || [0, 127], value);
    } else if (name === "instrument" || name === "sampleID" || name === "keynum" || name === "velocity" || name === "sampleModes" || name === "exclusiveClass" || name === "overridingRootKey" || name === "scaleTuning") {
      result[name] = value;
    } else {
      result[name] = (result[name] || 0) + value;
    }
  }

  return result;
}

function decodeGeneratorAmount(operator, raw) {
  if (operator === 43 || operator === 44) {
    return [raw & 0xff, (raw >> 8) & 0xff];
  }

  if (UINT16_REPLACE_OPERATORS.has(operator)) {
    return raw;
  }

  return raw & 0x8000 ? raw - 0x10000 : raw;
}

function resolveSampleWindow(region, sample, sampleDataLength) {
  const start =
    sample.start +
    (region.startAddrsOffset || 0) +
    (region.startAddrsCoarseOffset || 0) * 32768;
  const end =
    sample.end +
    (region.endAddrsOffset || 0) +
    (region.endAddrsCoarseOffset || 0) * 32768;
  const loopStart =
    sample.startLoop +
    (region.startloopAddrsOffset || 0) +
    (region.startloopAddrsCoarseOffset || 0) * 32768;
  const loopEnd =
    sample.endLoop +
    (region.endloopAddrsOffset || 0) +
    (region.endloopAddrsCoarseOffset || 0) * 32768;

  return {
    start: clamp(Math.trunc(start), 0, sampleDataLength),
    end: clamp(Math.trunc(end), 0, sampleDataLength),
    loopStart: clamp(Math.trunc(loopStart), 0, sampleDataLength),
    loopEnd: clamp(Math.trunc(loopEnd), 0, sampleDataLength)
  };
}

function applyEnvelope(param, startTime, peakAmplitude, region) {
  const delay = timecentsToSeconds(region.delayVolEnv ?? -12000);
  const attack = timecentsToSeconds(region.attackVolEnv ?? -12000);
  const hold = timecentsToSeconds(region.holdVolEnv ?? -12000);
  const decay = timecentsToSeconds(region.decayVolEnv ?? -12000);
  const sustain = Math.pow(10, -(region.sustainVolEnv || 0) / 200);
  const envelopeStart = startTime + delay;
  const peakTime = envelopeStart + Math.max(0.001, attack);
  const holdEnd = peakTime + hold;
  const decayEnd = holdEnd + decay;

  param.cancelScheduledValues(startTime);
  param.setValueAtTime(0.0001, startTime);
  param.setValueAtTime(0.0001, envelopeStart);
  param.exponentialRampToValueAtTime(Math.max(0.0001, peakAmplitude), peakTime);
  param.setValueAtTime(Math.max(0.0001, peakAmplitude), holdEnd);
  param.exponentialRampToValueAtTime(Math.max(0.0001, peakAmplitude * sustain), decayEnd);
}

function pitchRatio(channel, note, region, sample) {
  const rootKey = region.overridingRootKey != null && region.overridingRootKey !== 255
    ? region.overridingRootKey
    : sample.originalPitch;
  const playedKey = region.keynum != null ? region.keynum : note;
  const scaleTuning = region.scaleTuning ?? 100;
  const bendSemitones = (channel.pitchBend / 8192) * channel.pitchBendRange;
  const semitones =
    ((playedKey - rootKey) * scaleTuning) / 100 +
    (region.coarseTune || 0) +
    (region.fineTune || 0) / 100 +
    (sample.pitchCorrection || 0) / 100 +
    bendSemitones;
  return Math.pow(2, semitones / 12);
}

function amplitudeFor(channel, velocity, region) {
  const velocityGain = Math.pow((region.velocity != null ? region.velocity : velocity) / 127, 1.35);
  const channelGain = (channel.volume / 127) * (channel.expression / 127);
  const attenuation = Math.pow(10, -(region.initialAttenuation || 0) / 200);
  return clamp(velocityGain * channelGain * attenuation, 0.0001, 1);
}

function panFor(channel, region) {
  const channelPan = (channel.pan - 64) / 64;
  const regionPan = (region.pan || 0) / 500;
  return clamp(channelPan + regionPan, -1, 1);
}

function regionMatches(region, note, velocity) {
  const keyRange = region.keyRange || [0, 127];
  const velRange = region.velRange || [0, 127];
  return note >= keyRange[0] && note <= keyRange[1] && velocity >= velRange[0] && velocity <= velRange[1];
}

function timecentsToSeconds(value) {
  if (value == null || value <= -12000) {
    return 0.001;
  }
  return Math.min(30, Math.pow(2, value / 1200));
}

function createChannelState(index) {
  return {
    index,
    program: 0,
    bankMsb: 0,
    bankLsb: 0,
    volume: 100,
    expression: 127,
    pan: 64,
    sustain: false,
    pitchBend: 0,
    pitchBendRange: DEFAULT_PITCH_BEND_RANGE,
    rpnMsb: 127,
    rpnLsb: 127,
    activeNotes: new Map()
  };
}

function resetChannelControllers(channel) {
  channel.volume = 100;
  channel.expression = 127;
  channel.pan = 64;
  channel.sustain = false;
  channel.pitchBend = 0;
  channel.pitchBendRange = DEFAULT_PITCH_BEND_RANGE;
  channel.rpnMsb = 127;
  channel.rpnLsb = 127;
}

function eventSortOrder(event) {
  if (event.tempo) {
    return 0;
  }
  if (!event.data) {
    return 1;
  }
  const command = event.data[0] & 0xf0;
  return command === 0x80 || (command === 0x90 && event.data[2] === 0) ? 1 : 2;
}

function requiredChunk(chunks, name) {
  const chunk = chunks.get(name);
  if (!chunk) {
    throw new Error(`The SF2 file is missing the ${name} chunk.`);
  }
  return chunk;
}

function readString(view, offset, length) {
  let result = "";
  for (let i = 0; i < length; i += 1) {
    result += String.fromCharCode(view.getUint8(offset + i));
  }
  return result;
}

function readNullTerminatedString(view, offset, length) {
  return readString(view, offset, length).replace(/\0.*$/, "").trim();
}

function base64ToArrayBuffer(base64) {
  if (typeof atob === "function") {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  if (typeof Buffer !== "undefined") {
    const buffer = Buffer.from(base64, "base64");
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  throw new Error("No base64 decoder is available.");
}

function defineRequestMIDIAccess(targetNavigator, requestMIDIAccess) {
  try {
    Object.defineProperty(targetNavigator, "requestMIDIAccess", {
      value: requestMIDIAccess,
      configurable: true,
      writable: true
    });
  } catch {
    targetNavigator.requestMIDIAccess = requestMIDIAccess;
  }
}

function firstMapValue(map) {
  return map.values().next().value;
}

function validRange(range) {
  return !range || range[0] <= range[1];
}

function intersectRanges(a, b) {
  return [Math.max(a[0], b[0]), Math.min(a[1], b[1])];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function performanceNow() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

if (typeof window !== "undefined" && !window.__WEB_MIDI_AUDIO_SHIM_NO_AUTO_INSTALL__) {
  installWebMidiAudioShim({ navigator: window.navigator });
}
