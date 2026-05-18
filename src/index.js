import embeddedSoundFontBase64 from "../assets/GeneralUser-GS.sf2";

const DEFAULT_OUTPUT_ID = "generaluser-gs-web-audio";
const MIDI_CHANNELS = 16;
const PERCUSSION_CHANNEL = 9;
const DEFAULT_PITCH_BEND_RANGE = 2;
const DEFAULT_LOOKAHEAD_MS = 120;
const DEFAULT_SCHEDULER_INTERVAL_MS = 25;
const MIN_LOOKAHEAD_MS = 10;
const MIN_SCHEDULER_INTERVAL_MS = 8;
const DEFAULT_MAX_MESSAGES_PER_TICK = 4096;
const DEFAULT_MAX_VOICES = 96;
const DEFAULT_MAX_VOICES_PER_CHANNEL = 32;
const GM_SYSTEM_ON = [0xf0, 0x7e, null, 0x09, 0x01, 0xf7];
const GM2_SYSTEM_ON = [0xf0, 0x7e, null, 0x09, 0x03, 0xf7];
const GS_RESET_PREFIX = [0xf0, 0x41, null, 0x42, 0x12, 0x40, 0x00, 0x7f, 0x00];
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

  if (installedShim && options.force) {
    installedShim.restore();
  }

  const previousRequestMIDIAccess = targetNavigator.requestMIDIAccess;
  const synth = new EmbeddedSoundFontSynth({
    audioContext: options.audioContext,
    soundFontBase64: options.soundFontBase64 || embeddedSoundFontBase64,
    masterGain: options.masterGain
  });
  const accessBySysex = new Map();

  function getAccess(requestOptions = {}) {
    const sysexEnabled = !!requestOptions.sysex;
    if (!accessBySysex.has(sysexEnabled)) {
      accessBySysex.set(sysexEnabled, new VirtualMIDIAccess(synth, {
        ...options,
        sysexEnabled,
        lookaheadMs: options.lookaheadMs ?? DEFAULT_LOOKAHEAD_MS,
        schedulerIntervalMs: options.schedulerIntervalMs ?? DEFAULT_SCHEDULER_INTERVAL_MS,
        maxMessagesPerTick: options.maxMessagesPerTick ?? DEFAULT_MAX_MESSAGES_PER_TICK
      }));
    }
    return accessBySysex.get(sysexEnabled);
  }

  function requestMIDIAccess(requestOptions = {}) {
    return Promise.resolve(getAccess(requestOptions));
  }

  defineRequestMIDIAccess(targetNavigator, requestMIDIAccess);

  installedShim = {
    get access() {
      return getAccess();
    },
    getAccess,
    synth,
    previousRequestMIDIAccess,
    restore() {
      for (const access of accessBySysex.values()) {
        for (const output of access.outputs.values()) {
          output.clear();
        }
      }
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
  const access = options.access || installedShim?.getAccess?.({ sysex: true }) || await navigator.requestMIDIAccess({ sysex: true });
  const output = options.output || firstMapValue(access.outputs);
  if (!output) {
    throw new Error("No MIDI output is available.");
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
        const data = [status];
        for (let i = 0; i < length; i += 1) {
          data.push(view.getUint8(track.offset));
          track.offset += 1;
        }
        rawEvents.push({ tick: track.tick, data });
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
    if (!event || !event.type) {
      throw new TypeError("Event object requires a type.");
    }
    if (event.timeStamp == null) {
      event.timeStamp = performanceNow();
    }
    event.target = this;
    event.currentTarget = this;
    const listeners = this.listeners.get(event.type);
    if (listeners) {
      for (const listener of listeners) {
        if (typeof listener === "function") {
          listener.call(this, event);
        } else if (listener && typeof listener.handleEvent === "function") {
          listener.handleEvent(event);
        }
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
    this.sysexEnabled = !!options.sysexEnabled;
    this.inputs = new Map();
    this.outputs = new Map();

    const output = new VirtualMIDIOutput(synth, {
      access: this,
      id: options.outputId || DEFAULT_OUTPUT_ID,
      manufacturer: options.manufacturer || "midi-sf2-web",
      name: options.outputName || "GeneralUser GS Web Audio",
      sysexEnabled: this.sysexEnabled,
      lookaheadMs: options.lookaheadMs ?? DEFAULT_LOOKAHEAD_MS,
      schedulerIntervalMs: options.schedulerIntervalMs ?? DEFAULT_SCHEDULER_INTERVAL_MS,
      maxMessagesPerTick: options.maxMessagesPerTick ?? DEFAULT_MAX_MESSAGES_PER_TICK
    });
    this.outputs.set(output.id, output);
  }

  emitPortStateChange(port) {
    this.dispatchEvent(createMIDIConnectionEvent(port));
  }
}

class VirtualMIDIOutput extends SimpleEventTarget {
  constructor(synth, options) {
    super();
    this.synth = synth;
    this.access = options.access;
    this.id = options.id;
    this.manufacturer = options.manufacturer;
    this.name = options.name;
    this.type = "output";
    this.version = "0.1.0";
    this.state = "connected";
    this.connection = "closed";
    this.sysexEnabled = !!options.sysexEnabled;
    this.lookaheadMs = positiveNumberOrDefault(options.lookaheadMs, DEFAULT_LOOKAHEAD_MS, MIN_LOOKAHEAD_MS);
    this.maxMessagesPerTick = positiveIntegerOrDefault(options.maxMessagesPerTick, DEFAULT_MAX_MESSAGES_PER_TICK);
    this.queue = [];
    this.queueSequence = 0;
    this.scheduler = new LookaheadScheduler({
      intervalMs: options.schedulerIntervalMs ?? DEFAULT_SCHEDULER_INTERVAL_MS,
      onTick: () => this.flushQueue()
    });
  }

  open() {
    if (this.state === "disconnected") {
      this.connection = "pending";
      this.emitStateChange();
      return Promise.resolve(this);
    }
    if (this.connection !== "open") {
      this.connection = "open";
      this.emitStateChange();
    }
    return Promise.resolve(this);
  }

  close() {
    if (this.connection !== "closed") {
      this.queue.length = 0;
      this.scheduler.stop();
      this.connection = "closed";
      this.emitStateChange();
    }
    return Promise.resolve(this);
  }

  send(data, timestamp = 0) {
    this.scheduleMessages([{ data, timestamp }]);
  }

  scheduleMessages(items) {
    if (this.state === "disconnected") {
      throw createDOMException("InvalidStateError", "Cannot send to a disconnected MIDI output.");
    }

    if (this.connection === "closed") {
      this.open();
    }

    const now = performanceNow();
    for (const item of items) {
      const messages = parseMIDIMessageSequence(item.data, this.sysexEnabled);
      const timestampNumber = Number(item.timestamp || 0);
      if (!Number.isFinite(timestampNumber) || timestampNumber < 0) {
        throw new TypeError("MIDIOutput.send() timestamp must be a finite non-negative number.");
      }

      const sendTimestamp = timestampNumber > now ? timestampNumber : now;
      for (const message of messages) {
        this.enqueueMessage(message, sendTimestamp);
      }
    }
    this.flushQueue();
  }

  enqueueMessage(bytes, timestamp) {
    const item = {
      bytes,
      timestamp,
      sequence: this.queueSequence
    };
    this.queueSequence += 1;

    const last = this.queue[this.queue.length - 1];
    if (!last || compareQueuedMidiMessage(last, item) <= 0) {
      this.queue.push(item);
      return;
    }

    let low = 0;
    let high = this.queue.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (compareQueuedMidiMessage(this.queue[middle], item) <= 0) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    this.queue.splice(low, 0, item);
  }

  clear() {
    this.queue.length = 0;
    this.scheduler.stop();
    this.synth.allSoundOff();
  }

  preload() {
    return this.synth.preload();
  }

  flushQueue() {
    if (!this.queue.length) {
      this.scheduler.stop();
      return;
    }

    const now = performanceNow();
    const horizon = now + this.lookaheadMs;
    let sent = 0;
    while (this.queue.length && this.queue[0].timestamp <= horizon && sent < this.maxMessagesPerTick) {
      const item = this.queue.shift();
      const delaySeconds = Math.max(0, (item.timestamp - now) / 1000);
      this.synth.dispatchMidi(item.bytes, delaySeconds);
      sent += 1;
    }

    if (this.queue.length) {
      this.scheduler.start();
    } else {
      this.scheduler.stop();
    }
  }

  emitStateChange() {
    this.dispatchEvent(createMIDIConnectionEvent(this));
    if (this.access) {
      this.access.emitPortStateChange(this);
    }
  }
}

class LookaheadScheduler {
  constructor(options) {
    this.intervalMs = positiveNumberOrDefault(options.intervalMs, DEFAULT_SCHEDULER_INTERVAL_MS, MIN_SCHEDULER_INTERVAL_MS);
    this.onTick = options.onTick;
    this.timer = null;
  }

  start() {
    if (this.timer != null) {
      return;
    }
    this.timer = globalThis.setInterval(() => this.tick(), this.intervalMs);
  }

  stop() {
    if (this.timer == null) {
      return;
    }
    globalThis.clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    this.onTick();
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
    this.maxVoices = positiveIntegerOrDefault(options.maxVoices, DEFAULT_MAX_VOICES);
    this.maxVoicesPerChannel = positiveIntegerOrDefault(options.maxVoicesPerChannel, DEFAULT_MAX_VOICES_PER_CHANNEL);
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
      this.dispatchSystemMessage(bytes, delaySeconds);
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
      case 0xa0:
        this.polyAftertouch(channelIndex, data1, data2, delaySeconds);
        break;
      case 0xb0:
        this.controlChange(channelIndex, data1, data2, delaySeconds);
        break;
      case 0xc0:
        this.channels[channelIndex].program = data1 & 0x7f;
        break;
      case 0xd0:
        this.channelAftertouch(channelIndex, data1, delaySeconds);
        break;
      case 0xe0:
        this.channels[channelIndex].pitchBend = ((data2 << 7) | data1) - 8192;
        this.updatePitchBend(channelIndex, delaySeconds);
        break;
      default:
        break;
    }
  }

  dispatchSystemMessage(bytes, delaySeconds = 0) {
    const status = bytes[0];
    if (status === 0xf0) {
      if (matchesSysex(bytes, GM_SYSTEM_ON) || matchesSysex(bytes, GM2_SYSTEM_ON) || isGsReset(bytes)) {
        this.resetSystem(delaySeconds);
      }
      return;
    }

    if (status === 0xff) {
      this.resetSystem(delaySeconds);
    }
  }

  resetSystem(delaySeconds = 0) {
    this.allSoundOff();
    for (let i = 0; i < this.channels.length; i += 1) {
      const existingNotes = this.channels[i].activeNotes;
      const existingVoices = this.channels[i].activeVoices;
      this.disposeChannelLfo(this.channels[i]);
      this.channels[i] = createChannelState(i);
      existingNotes.clear();
      existingVoices.clear();
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
    const exclusiveClasses = new Set(regions.map((region) => region.exclusiveClass || 0).filter(Boolean));
    for (const exclusiveClass of exclusiveClasses) {
      this.releaseExclusiveClass(channel, exclusiveClass, startTime);
    }

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
    for (const voice of voices) {
      channel.activeVoices.add(voice);
    }
    this.enforceVoiceLimits(channel, startTime);
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

  polyAftertouch(channelIndex, note, value, delaySeconds = 0) {
    const channel = this.channels[channelIndex];
    channel.polyPressure.set(note, value & 0x7f);
    this.updateChannelGain(channelIndex, delaySeconds);
  }

  channelAftertouch(channelIndex, value, delaySeconds = 0) {
    const channel = this.channels[channelIndex];
    channel.channelPressure = value & 0x7f;
    this.updateChannelGain(channelIndex, delaySeconds);
  }

  controlChange(channelIndex, controller, value, delaySeconds = 0) {
    const channel = this.channels[channelIndex];
    const ccValue = value & 0x7f;
    switch (controller) {
      case 0:
        channel.bankMsb = ccValue;
        break;
      case 1:
        channel.modulation = ccValue;
        this.updateModulation(channelIndex, delaySeconds);
        break;
      case 5:
        channel.portamentoTime = ccValue;
        break;
      case 6:
        channel.dataEntryMsb = ccValue;
        this.applyDataEntry(channelIndex, delaySeconds);
        break;
      case 7:
        channel.volume = ccValue;
        this.updateChannelGain(channelIndex, delaySeconds);
        break;
      case 10:
        channel.pan = ccValue;
        this.updatePan(channelIndex, delaySeconds);
        break;
      case 11:
        channel.expression = ccValue;
        this.updateChannelGain(channelIndex, delaySeconds);
        break;
      case 32:
        channel.bankLsb = ccValue;
        break;
      case 38:
        channel.dataEntryLsb = ccValue;
        this.applyDataEntry(channelIndex, delaySeconds);
        break;
      case 64:
        channel.sustain = ccValue >= 64;
        if (!channel.sustain) {
          this.releaseSustained(channelIndex, delaySeconds);
        }
        break;
      case 65:
        channel.portamento = ccValue >= 64;
        break;
      case 66:
        channel.sostenuto = ccValue >= 64;
        break;
      case 67:
        channel.softPedal = ccValue >= 64;
        this.updateChannelGain(channelIndex, delaySeconds);
        break;
      case 71:
        channel.resonance = ccValue;
        break;
      case 72:
        channel.releaseTime = ccValue;
        break;
      case 73:
        channel.attackTime = ccValue;
        break;
      case 74:
        channel.brightness = ccValue;
        break;
      case 91:
        channel.reverbSend = ccValue;
        break;
      case 93:
        channel.chorusSend = ccValue;
        break;
      case 96:
        this.incrementSelectedParameter(channelIndex, 1, delaySeconds);
        break;
      case 97:
        this.incrementSelectedParameter(channelIndex, -1, delaySeconds);
        break;
      case 98:
        channel.nrpnLsb = ccValue;
        channel.selectedParameter = "nrpn";
        break;
      case 99:
        channel.nrpnMsb = ccValue;
        channel.selectedParameter = "nrpn";
        break;
      case 100:
        channel.rpnLsb = ccValue;
        channel.selectedParameter = "rpn";
        break;
      case 101:
        channel.rpnMsb = ccValue;
        channel.selectedParameter = "rpn";
        break;
      case 120:
        this.allSoundOff(channelIndex);
        break;
      case 123:
        this.allNotesOff(channelIndex, delaySeconds);
        break;
      case 121:
        resetChannelControllers(channel);
        this.updatePitchBend(channelIndex, delaySeconds);
        this.updateChannelGain(channelIndex, delaySeconds);
        this.updatePan(channelIndex, delaySeconds);
        this.updateModulation(channelIndex, delaySeconds);
        break;
      case 124:
      case 125:
      case 126:
      case 127:
        this.allNotesOff(channelIndex, delaySeconds);
        break;
      default:
        break;
    }
  }

  applyDataEntry(channelIndex, delaySeconds = 0) {
    const channel = this.channels[channelIndex];
    if (channel.selectedParameter === "rpn") {
      this.applyRpn(channelIndex, delaySeconds);
      return;
    }

    if (channel.selectedParameter === "nrpn") {
      const key = `${channel.nrpnMsb}:${channel.nrpnLsb}`;
      channel.nrpnValues.set(key, (channel.dataEntryMsb << 7) | channel.dataEntryLsb);
    }
  }

  applyRpn(channelIndex, delaySeconds = 0) {
    const channel = this.channels[channelIndex];
    if (channel.rpnMsb === 127 && channel.rpnLsb === 127) {
      return;
    }

    if (channel.rpnMsb === 0 && channel.rpnLsb === 0) {
      channel.pitchBendRange = clamp(channel.dataEntryMsb, 0, 24);
      channel.pitchBendRangeCents = clamp(channel.dataEntryLsb, 0, 99);
      this.updatePitchBend(channelIndex, delaySeconds);
    } else if (channel.rpnMsb === 0 && channel.rpnLsb === 1) {
      const value14 = (channel.dataEntryMsb << 7) | channel.dataEntryLsb;
      channel.fineTuningCents = ((value14 - 8192) / 8192) * 100;
      this.updatePitchBend(channelIndex, delaySeconds);
    } else if (channel.rpnMsb === 0 && channel.rpnLsb === 2) {
      channel.coarseTuningSemitones = channel.dataEntryMsb - 64;
      this.updatePitchBend(channelIndex, delaySeconds);
    }
  }

  incrementSelectedParameter(channelIndex, delta, delaySeconds = 0) {
    const channel = this.channels[channelIndex];
    const value = clamp(((channel.dataEntryMsb << 7) | channel.dataEntryLsb) + delta, 0, 16383);
    channel.dataEntryMsb = (value >> 7) & 0x7f;
    channel.dataEntryLsb = value & 0x7f;
    this.applyDataEntry(channelIndex, delaySeconds);
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

  updateChannelGain(channelIndex, delaySeconds = 0) {
    const context = this.ensureAudioContext();
    const channel = this.channels[channelIndex];
    const when = context.currentTime + delaySeconds;
    for (const voices of channel.activeNotes.values()) {
      for (const voice of voices) {
        voice.updateGain(when);
      }
    }
  }

  updatePan(channelIndex, delaySeconds = 0) {
    const context = this.ensureAudioContext();
    const channel = this.channels[channelIndex];
    const when = context.currentTime + delaySeconds;
    for (const voices of channel.activeNotes.values()) {
      for (const voice of voices) {
        voice.updatePan(when);
      }
    }
  }

  updateModulation(channelIndex, delaySeconds = 0) {
    const context = this.ensureAudioContext();
    const channel = this.channels[channelIndex];
    const when = context.currentTime + delaySeconds;
    for (const voice of channel.activeVoices) {
      voice.updateModulation(when);
    }
  }

  releaseExclusiveClass(channel, exclusiveClass, when) {
    for (const voice of channel.activeVoices) {
      if (voice.exclusiveClass === exclusiveClass && !voice.released) {
        voice.release(when);
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

  allSoundOff(channelIndex = null) {
    if (channelIndex != null) {
      this.stopChannelSound(this.channels[channelIndex]);
      return;
    }
    for (let i = 0; i < this.channels.length; i += 1) {
      this.stopChannelSound(this.channels[i]);
    }
  }

  stopChannelSound(channel, delaySeconds = 0) {
    const context = this.ensureAudioContext();
    const when = context.currentTime + delaySeconds;
    for (const voice of channel.activeVoices) {
      voice.release(when, true);
    }
    channel.activeNotes.clear();
  }

  enforceVoiceLimits(channel, when) {
    while (countManagedVoices(channel.activeVoices) > this.maxVoicesPerChannel) {
      const voice = selectVoiceToStop(channel.activeVoices);
      if (!voice) {
        break;
      }
      voice.release(when, true);
    }

    while (this.countManagedVoices() > this.maxVoices) {
      const voice = this.selectGlobalVoiceToStop();
      if (!voice) {
        break;
      }
      voice.release(when, true);
    }
  }

  countManagedVoices() {
    let count = 0;
    for (const channel of this.channels) {
      count += countManagedVoices(channel.activeVoices);
    }
    return count;
  }

  selectGlobalVoiceToStop() {
    let selected = null;
    for (const channel of this.channels) {
      selected = chooseOlderVoice(selected, selectVoiceToStop(channel.activeVoices));
    }
    return selected;
  }

  ensureChannelLfo(channel, context, when) {
    if (channel.lfo || typeof context.createOscillator !== "function") {
      return channel.lfo;
    }

    const lfo = context.createOscillator();
    lfo.frequency.setValueAtTime(5.5, when);
    lfo.start(when);
    channel.lfo = lfo;
    return lfo;
  }

  updateVoiceModulation(voice, when) {
    const channel = voice.channel;
    if (!channel.modulation) {
      if (voice.lfoGain) {
        setAudioParam(voice.lfoGain.gain, 0, when);
      }
      return;
    }

    const context = this.ensureAudioContext();
    const lfo = this.ensureChannelLfo(channel, context, when);
    if (!lfo || typeof context.createGain !== "function") {
      return;
    }

    if (!voice.lfoGain) {
      voice.lfoGain = context.createGain();
      voice.lfoGain.gain.setValueAtTime(0, when);
      lfo.connect(voice.lfoGain);
      voice.lfoGain.connect(voice.source.playbackRate);
    }
    setAudioParam(voice.lfoGain.gain, modulationPlaybackRateDepth(channel, voice.source.playbackRate.value || 1), when);
  }

  disposeChannelLfo(channel) {
    if (!channel.lfo) {
      return;
    }
    try {
      channel.lfo.stop();
    } catch {
      // The LFO may already have been stopped.
    }
    if (typeof channel.lfo.disconnect === "function") {
      channel.lfo.disconnect();
    }
    channel.lfo = null;
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
    const outputGain = context.createGain();
    const panner = typeof context.createStereoPanner === "function" ? context.createStereoPanner() : null;
    const releaseSeconds = timecentsToSeconds(region.releaseVolEnv ?? -12000);
    const voice = {
      channel,
      source,
      gain,
      outputGain,
      panner,
      lfoGain: null,
      note,
      velocity,
      region,
      sample,
      exclusiveClass: region.exclusiveClass || 0,
      released: false,
      stopping: false,
      sustained: false,
      startedAt: startTime,
      updatePitch: (when) => {
        const ratio = pitchRatio(channel, note, region, sample);
        source.playbackRate.cancelScheduledValues(when);
        source.playbackRate.setValueAtTime(ratio, when);
        voice.updateModulation(when);
      },
      updateGain: (when) => {
        const value = channelGainFor(channel, note);
        setAudioParam(outputGain.gain, value, when);
      },
      updatePan: (when) => {
        if (panner) {
          setAudioParam(panner.pan, panFor(channel, region), when);
        }
      },
      updateModulation: (when) => {
        this.updateVoiceModulation(voice, when);
      },
      release: (when, fast = false) => {
        if (voice.stopping || (voice.released && !fast)) {
          return;
        }
        voice.released = true;
        if (fast) {
          voice.stopping = true;
        }
        const releaseDuration = fast ? 0.015 : Math.max(0.015, releaseSeconds);
        gain.gain.cancelScheduledValues(when);
        gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), when);
        gain.gain.exponentialRampToValueAtTime(0.0001, when + releaseDuration);
        try {
          source.stop(when + Math.max(0.03, releaseDuration) + 0.05);
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

    const amplitude = amplitudeFor(velocity, region);
    applyEnvelope(gain.gain, startTime, amplitude, region);
    outputGain.gain.setValueAtTime(channelGainFor(channel, note), startTime);
    voice.updateModulation(startTime);

    source.connect(gain);
    gain.connect(outputGain);
    if (panner) {
      panner.pan.setValueAtTime(panFor(channel, region), startTime);
      outputGain.connect(panner);
      panner.connect(this.masterGain);
    } else {
      outputGain.connect(this.masterGain);
    }

    source.onended = () => {
      channel.activeVoices.delete(voice);
      if (voice.lfoGain && typeof voice.lfoGain.disconnect === "function") {
        voice.lfoGain.disconnect();
        voice.lfoGain = null;
      }
      if (!channel.activeVoices.size) {
        this.disposeChannelLfo(channel);
      }
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
  const bendSemitones = (channel.pitchBend / 8192) * (channel.pitchBendRange + channel.pitchBendRangeCents / 100);
  const semitones =
    ((playedKey - rootKey) * scaleTuning) / 100 +
    (region.coarseTune || 0) +
    (region.fineTune || 0) / 100 +
    (sample.pitchCorrection || 0) / 100 +
    channel.coarseTuningSemitones +
    channel.fineTuningCents / 100 +
    bendSemitones;
  return Math.pow(2, semitones / 12);
}

function amplitudeFor(velocity, region) {
  const velocityGain = Math.pow((region.velocity != null ? region.velocity : velocity) / 127, 1.35);
  const attenuation = Math.pow(10, -(region.initialAttenuation || 0) / 200);
  return clamp(velocityGain * attenuation, 0.0001, 1);
}

function channelGainFor(channel, note) {
  const pressure = channel.polyPressure.get(note) ?? channel.channelPressure;
  const pressureGain = 0.75 + (pressure / 127) * 0.25;
  const softPedalGain = channel.softPedal ? 0.72 : 1;
  return clamp((channel.volume / 127) * (channel.expression / 127) * pressureGain * softPedalGain, 0.0001, 1);
}

function panFor(channel, region) {
  const channelPan = (channel.pan - 64) / 64;
  const regionPan = (region.pan || 0) / 500;
  return clamp(channelPan + regionPan, -1, 1);
}

function modulationPlaybackRateDepth(channel, playbackRate) {
  if (!channel.modulation) {
    return 0;
  }
  const depthCents = (channel.modulation / 127) * 35;
  return playbackRate * (Math.pow(2, depthCents / 1200) - 1);
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
    modulation: 0,
    volume: 100,
    expression: 127,
    pan: 64,
    sustain: false,
    sostenuto: false,
    softPedal: false,
    portamento: false,
    portamentoTime: 0,
    resonance: 64,
    brightness: 64,
    attackTime: 64,
    releaseTime: 64,
    reverbSend: 40,
    chorusSend: 0,
    pitchBend: 0,
    pitchBendRange: DEFAULT_PITCH_BEND_RANGE,
    pitchBendRangeCents: 0,
    fineTuningCents: 0,
    coarseTuningSemitones: 0,
    channelPressure: 0,
    polyPressure: new Map(),
    rpnMsb: 127,
    rpnLsb: 127,
    nrpnMsb: 127,
    nrpnLsb: 127,
    selectedParameter: "rpn",
    dataEntryMsb: 0,
    dataEntryLsb: 0,
    nrpnValues: new Map(),
    activeNotes: new Map(),
    activeVoices: new Set(),
    lfo: null
  };
}

function resetChannelControllers(channel) {
  channel.modulation = 0;
  channel.volume = 100;
  channel.expression = 127;
  channel.pan = 64;
  channel.sustain = false;
  channel.sostenuto = false;
  channel.softPedal = false;
  channel.portamento = false;
  channel.portamentoTime = 0;
  channel.resonance = 64;
  channel.brightness = 64;
  channel.attackTime = 64;
  channel.releaseTime = 64;
  channel.reverbSend = 40;
  channel.chorusSend = 0;
  channel.pitchBend = 0;
  channel.pitchBendRange = DEFAULT_PITCH_BEND_RANGE;
  channel.pitchBendRangeCents = 0;
  channel.fineTuningCents = 0;
  channel.coarseTuningSemitones = 0;
  channel.channelPressure = 0;
  channel.polyPressure.clear();
  channel.rpnMsb = 127;
  channel.rpnLsb = 127;
  channel.nrpnMsb = 127;
  channel.nrpnLsb = 127;
  channel.selectedParameter = "rpn";
  channel.dataEntryMsb = 0;
  channel.dataEntryLsb = 0;
}

function scheduleOutputMessages(output, batch) {
  if (!batch.length) {
    return;
  }
  if (typeof output.scheduleMessages === "function") {
    output.scheduleMessages(batch);
    return;
  }
  for (const item of batch) {
    output.send(item.data, item.timestamp);
  }
}

function compareQueuedMidiMessage(a, b) {
  return a.timestamp - b.timestamp || a.sequence - b.sequence;
}

function positiveNumberOrDefault(value, defaultValue, minimum = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return Math.max(minimum, defaultValue);
  }
  return Math.max(minimum, number);
}

function positiveIntegerOrDefault(value, defaultValue) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number <= 0) {
    return defaultValue;
  }
  return number;
}

function countManagedVoices(voices) {
  let count = 0;
  for (const voice of voices) {
    if (!voice.stopping) {
      count += 1;
    }
  }
  return count;
}

function selectVoiceToStop(voices) {
  let selected = null;
  for (const voice of voices) {
    if (voice.stopping) {
      continue;
    }
    if (!selected) {
      selected = voice;
      continue;
    }
    if (voice.released && !selected.released) {
      selected = voice;
      continue;
    }
    if (voice.released === selected.released && voice.startedAt < selected.startedAt) {
      selected = voice;
    }
  }
  return selected;
}

function chooseOlderVoice(a, b) {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  if (b.released && !a.released) {
    return b;
  }
  if (a.released && !b.released) {
    return a;
  }
  return b.startedAt < a.startedAt ? b : a;
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

function createMIDIConnectionEvent(port) {
  return {
    type: "statechange",
    port,
    timeStamp: performanceNow()
  };
}

function parseMIDIMessageSequence(data, sysexEnabled) {
  if (data == null || typeof data[Symbol.iterator] !== "function") {
    throw new TypeError("MIDIOutput.send() data must be an iterable sequence of bytes.");
  }

  const bytes = Array.from(data, (value) => Number(value) & 0xff);
  if (!bytes.length) {
    throw new TypeError("MIDIOutput.send() data must contain at least one MIDI message.");
  }

  const messages = [];
  let offset = 0;
  while (offset < bytes.length) {
    const status = bytes[offset];
    if (status < 0x80) {
      throw new TypeError("Running status is not allowed in MIDIOutput.send() data.");
    }

    if (status === 0xf0) {
      const end = bytes.indexOf(0xf7, offset + 1);
      if (end === -1) {
        throw new TypeError("System Exclusive messages must terminate with 0xF7.");
      }
      if (!sysexEnabled) {
        throw createDOMException("InvalidAccessError", "System Exclusive access was not enabled.");
      }
      messages.push(bytes.slice(offset, end + 1));
      offset = end + 1;
      continue;
    }

    if (status === 0xf7) {
      throw new TypeError("Unexpected System Exclusive terminator.");
    }

    const length = midiMessageLength(status);
    if (!length || offset + length > bytes.length) {
      throw new TypeError("MIDIOutput.send() data contains an incomplete or invalid MIDI message.");
    }

    const message = bytes.slice(offset, offset + length);
    for (let i = 1; i < message.length; i += 1) {
      if (message[i] >= 0x80) {
        throw new TypeError("MIDI data bytes must be less than 0x80.");
      }
    }
    messages.push(message);
    offset += length;
  }

  return messages;
}

function midiMessageLength(status) {
  if (status >= 0x80 && status <= 0xef) {
    const command = status & 0xf0;
    return command === 0xc0 || command === 0xd0 ? 2 : 3;
  }

  switch (status) {
    case 0xf1:
    case 0xf3:
      return 2;
    case 0xf2:
      return 3;
    case 0xf6:
    case 0xf8:
    case 0xf9:
    case 0xfa:
    case 0xfb:
    case 0xfc:
    case 0xfd:
    case 0xfe:
    case 0xff:
      return 1;
    default:
      return 0;
  }
}

function createDOMException(name, message) {
  if (typeof DOMException === "function") {
    return new DOMException(message, name);
  }
  const error = new Error(message);
  error.name = name;
  return error;
}

function matchesSysex(bytes, pattern) {
  if (bytes.length !== pattern.length) {
    return false;
  }
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] != null && bytes[i] !== pattern[i]) {
      return false;
    }
  }
  return true;
}

function isGsReset(bytes) {
  if (bytes.length !== 11 || bytes[10] !== 0xf7) {
    return false;
  }
  for (let i = 0; i < GS_RESET_PREFIX.length; i += 1) {
    if (GS_RESET_PREFIX[i] != null && bytes[i] !== GS_RESET_PREFIX[i]) {
      return false;
    }
  }
  return bytes[9] === rolandChecksum(bytes.slice(5, 9));
}

function rolandChecksum(addressAndData) {
  const sum = addressAndData.reduce((total, value) => total + value, 0);
  return (128 - (sum % 128)) & 0x7f;
}

function setAudioParam(param, value, when) {
  if (typeof param.setTargetAtTime === "function") {
    param.setTargetAtTime(value, when, 0.01);
  } else {
    param.setValueAtTime(value, when);
  }
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
