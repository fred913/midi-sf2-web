import {
  DEFAULT_MASTER_GAIN,
  DEFAULT_MAX_VOICES,
  DEFAULT_MAX_VOICES_PER_CHANNEL,
  DEFAULT_PERFORMANCE_LIMIT_ENABLED,
  DEFAULT_PITCH_BEND_RANGE,
  DEFAULT_SOUNDFONT_CACHE_KEY,
  DEFAULT_SOUNDFONT_URL,
  GM2_SYSTEM_ON,
  GM_SYSTEM_ON,
  MIDI_CHANNELS,
  PERCUSSION_CHANNEL
} from "./constants.js";
import { createPerformanceStats, incrementPerformanceStat } from "./devices.js";
import { isGsReset, matchesSysex } from "./midi.js";
import { parseSoundFont } from "./soundfont.js";
import { deleteCachedSoundFont, downloadSoundFont, readCachedSoundFont, writeCachedSoundFont } from "./storage.js";
import { createSoundFontProgressOverlay } from "./ui.js";
import {
  base64ToArrayBuffer,
  clamp,
  normalizeMasterGain,
  normalizeVoiceLimit,
  performanceNow,
  positiveIntegerOrDefault,
  setAudioParam,
  setCompressorParam
} from "./utils.js";

export class EmbeddedSoundFontSynth {
  constructor(options = {}) {
    this.soundFontBase64 = options.soundFontBase64 || null;
    this.soundFontUrl = options.soundFontUrl === undefined ? DEFAULT_SOUNDFONT_URL : options.soundFontUrl;
    this.soundFontCacheKey = options.soundFontCacheKey || DEFAULT_SOUNDFONT_CACHE_KEY;
    this.cacheSoundFont = options.cacheSoundFont !== false;
    this.progress = options.progress === false ? null : options.progress || null;
    this.audioContext = options.audioContext || null;
    this.masterGainValue = normalizeMasterGain(options.masterGain, DEFAULT_MASTER_GAIN);
    this.soundFont = null;
    this.soundFontPromise = null;
    this.pendingMidi = [];
    this.pendingMidiFlushAttached = false;
    this.masterGain = null;
    this.limiter = null;
    this.sampleBufferCache = new Map();
    this.performanceStats = createPerformanceStats();
    this.maxVoices = positiveIntegerOrDefault(options.maxVoices, DEFAULT_MAX_VOICES);
    this.maxVoicesPerChannel = positiveIntegerOrDefault(options.maxVoicesPerChannel, DEFAULT_MAX_VOICES_PER_CHANNEL);
    this.performanceLimitEnabled = options.performanceLimitEnabled === undefined ? DEFAULT_PERFORMANCE_LIMIT_ENABLED : !!options.performanceLimitEnabled;
    this.channels = Array.from({ length: MIDI_CHANNELS }, (_, index) => createChannelState(index));
  }

  async preload() {
    await this.loadSoundFont();
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

    if (!this.soundFont) {
      this.deferMidi(bytes, delaySeconds);
      return;
    }

    this.dispatchLoadedMidi(bytes, delaySeconds);
  }

  dispatchLoadedMidi(bytes, delaySeconds = 0) {
    this.recordMidiEvents(1);
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

  deferMidi(bytes, delaySeconds = 0) {
    this.pendingMidi.push({
      bytes: Array.from(bytes),
      dueTimeMs: performanceNow() + Math.max(0, delaySeconds) * 1000
    });
    if (this.pendingMidiFlushAttached) {
      return;
    }
    this.pendingMidiFlushAttached = true;
    this.loadSoundFont()
      .then(() => {
        this.pendingMidiFlushAttached = false;
        this.flushPendingMidi();
      })
      .catch((error) => {
        this.pendingMidiFlushAttached = false;
        this.pendingMidi.length = 0;
        setTimeout(() => {
          throw error;
        }, 0);
      });
  }

  flushPendingMidi() {
    if (!this.soundFont || !this.pendingMidi.length) {
      return;
    }

    const pending = this.pendingMidi.splice(0);
    const now = performanceNow();
    for (const item of pending) {
      this.dispatchLoadedMidi(item.bytes, Math.max(0, (item.dueTimeMs - now) / 1000));
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

  recordMidiEvents(count = 1) {
    incrementPerformanceStat(this.performanceStats, "midiEvents", count);
  }

  recordDroppedMidiEvents(count = 1) {
    incrementPerformanceStat(this.performanceStats, "droppedMidiEvents", count);
  }

  recordPlayedNotes(count = 1) {
    incrementPerformanceStat(this.performanceStats, "playedNotes", count);
  }

  recordDroppedNotes(count = 1) {
    incrementPerformanceStat(this.performanceStats, "droppedNotes", count);
  }

  getPerformanceStats() {
    return {
      ...this.performanceStats,
      activeNotes: this.countActiveNotes(),
      activeVoices: this.countManagedVoices(),
      pendingMidi: this.pendingMidi.length,
      sampleBuffers: this.sampleBufferCache.size
    };
  }

  countActiveNotes() {
    let count = 0;
    for (const channel of this.channels) {
      count += channel.activeNotes.size;
    }
    return count;
  }

  noteOn(channelIndex, note, velocity, delaySeconds = 0) {
    const soundFont = this.ensureSoundFont();
    const context = this.ensureAudioContext();
    const channel = this.channels[channelIndex];
    const bank = channelIndex === PERCUSSION_CHANNEL ? 128 : channel.bankMsb;
    const preset = soundFont.getPreset(bank, channel.program) || soundFont.getPreset(0, channel.program) || soundFont.getPreset(0, 0);
    if (!preset) {
      this.recordDroppedNotes(1);
      return;
    }

    const regions = soundFont.getPresetRegions(preset).filter((region) => regionMatches(region, note, velocity));
    if (!regions.length) {
      this.recordDroppedNotes(1);
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
      this.recordDroppedNotes(1);
      return;
    }

    const activeForNote = channel.activeNotes.get(note) || [];
    activeForNote.push(...voices);
    channel.activeNotes.set(note, activeForNote);
    for (const voice of voices) {
      channel.activeVoices.add(voice);
    }
    this.recordPlayedNotes(1);
    if (this.performanceLimitEnabled) {
      this.recordDroppedNotes(this.enforceVoiceLimits(channel, startTime));
    }
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
    let dropped = this.enforceChannelVoiceLimit(channel, when);
    dropped += this.enforceGlobalVoiceLimit(when);
    return dropped;
  }

  enforceCurrentVoiceLimits(when) {
    let dropped = 0;
    for (const channel of this.channels) {
      dropped += this.enforceChannelVoiceLimit(channel, when);
    }
    dropped += this.enforceGlobalVoiceLimit(when);
    return dropped;
  }

  enforceChannelVoiceLimit(channel, when) {
    let dropped = 0;
    while (countManagedVoices(channel.activeVoices) > this.maxVoicesPerChannel) {
      const voice = selectVoiceToStop(channel.activeVoices);
      if (!voice) {
        break;
      }
      voice.release(when, true);
      dropped += 1;
    }
    return dropped;
  }

  enforceGlobalVoiceLimit(when) {
    let dropped = 0;
    while (this.countManagedVoices() > this.maxVoices) {
      const voice = this.selectGlobalVoiceToStop();
      if (!voice) {
        break;
      }
      voice.release(when, true);
      dropped += 1;
    }
    return dropped;
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
      if (typeof this.audioContext.createDynamicsCompressor === "function") {
        this.limiter = this.audioContext.createDynamicsCompressor();
        setCompressorParam(this.limiter.threshold, -8);
        setCompressorParam(this.limiter.knee, 18);
        setCompressorParam(this.limiter.ratio, 10);
        setCompressorParam(this.limiter.attack, 0.003);
        setCompressorParam(this.limiter.release, 0.12);
        this.masterGain.connect(this.limiter);
        this.limiter.connect(this.audioContext.destination);
      } else {
        this.masterGain.connect(this.audioContext.destination);
      }
    }

    if (this.audioContext.state === "suspended") {
      this.audioContext.resume();
    }

    return this.audioContext;
  }

  getMasterGain() {
    return this.masterGainValue;
  }

  setMasterGain(value) {
    this.masterGainValue = normalizeMasterGain(value, this.masterGainValue);
    if (this.masterGain?.gain && this.audioContext) {
      setAudioParam(this.masterGain.gain, this.masterGainValue, this.audioContext.currentTime || 0);
    }
    return this.masterGainValue;
  }

  getVoiceLimits() {
    return {
      maxVoices: this.maxVoices,
      maxVoicesPerChannel: this.maxVoicesPerChannel
    };
  }

  setVoiceLimits(maxVoices, maxVoicesPerChannel) {
    this.maxVoices = normalizeVoiceLimit(maxVoices, this.maxVoices, 8, 512);
    this.maxVoicesPerChannel = normalizeVoiceLimit(maxVoicesPerChannel, this.maxVoicesPerChannel, 4, 256);
    if (this.maxVoices < this.maxVoicesPerChannel) {
      this.maxVoices = this.maxVoicesPerChannel;
    }
    return this.getVoiceLimits();
  }

  getPerformanceLimitEnabled() {
    return this.performanceLimitEnabled;
  }

  setPerformanceLimitEnabled(enabled) {
    this.performanceLimitEnabled = !!enabled;
    if (this.performanceLimitEnabled && this.audioContext) {
      this.recordDroppedNotes(this.enforceCurrentVoiceLimits(this.audioContext.currentTime || 0));
    }
    return this.performanceLimitEnabled;
  }

  ensureSoundFont() {
    if (!this.soundFont) {
      if (!this.soundFontBase64) {
        throw new Error("The SoundFont is not loaded yet. Call preload() before reading it synchronously.");
      }
      this.soundFont = parseSoundFont(base64ToArrayBuffer(this.soundFontBase64));
    }
    return this.soundFont;
  }

  loadSoundFont() {
    if (this.soundFont) {
      return Promise.resolve(this.soundFont);
    }
    if (this.soundFontPromise) {
      return this.soundFontPromise;
    }

    this.soundFontPromise = this.loadSoundFontArrayBuffer()
      .then((arrayBuffer) => {
        this.soundFont = parseSoundFont(arrayBuffer);
        return this.soundFont;
      })
      .finally(() => {
        this.soundFontPromise = null;
      });
    return this.soundFontPromise;
  }

  async loadSoundFontArrayBuffer() {
    if (this.soundFontBase64) {
      return base64ToArrayBuffer(this.soundFontBase64);
    }

    if (this.cacheSoundFont) {
      const cached = await readCachedSoundFont(this.soundFontCacheKey);
      if (cached) {
        return cached;
      }
    }

    const url = this.resolveSoundFontUrl();
    if (!url) {
      throw new Error("No cached SoundFont data is available for this MIDI output.");
    }

    const progress = this.progress || createSoundFontProgressOverlay();
    this.progress = progress;
    let arrayBuffer;
    try {
      arrayBuffer = await downloadSoundFont(url, progress);
      if (this.cacheSoundFont) {
        await writeCachedSoundFont(this.soundFontCacheKey, arrayBuffer, { url });
      }
      progress.finish();
    } catch (error) {
      progress.fail(error);
      throw error;
    }
    return arrayBuffer;
  }

  resolveSoundFontUrl() {
    if (typeof this.soundFontUrl === "function") {
      return this.soundFontUrl();
    }
    if (this.soundFontUrl) {
      return this.soundFontUrl;
    }
    return null;
  }

  clearCache() {
    this.clear();
    return deleteCachedSoundFont(this.soundFontCacheKey);
  }

  clear() {
    if (this.audioContext) {
      this.allSoundOff();
    }
    this.soundFont = null;
    this.soundFontPromise = null;
    this.pendingMidi.length = 0;
    this.sampleBufferCache.clear();
  }
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
