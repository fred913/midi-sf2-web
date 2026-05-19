import { DEFAULT_LOOKAHEAD_MS, DEFAULT_MAX_MESSAGES_PER_TICK, DEFAULT_SCHEDULER_INTERVAL_MS, MIN_LOOKAHEAD_MS } from "./constants.js";
import { createMIDIConnectionEvent, SimpleEventTarget } from "./events.js";
import { parseMIDIMessageSequence } from "./midi.js";
import { LookaheadScheduler } from "./scheduler.js";
import { compareQueuedMidiMessage, createDOMException, midiPortValues, performanceNow, positiveIntegerOrDefault, positiveNumberOrDefault } from "./utils.js";

export class VirtualMIDIAccess extends SimpleEventTarget {
  constructor(devices, options) {
    super();
    this.sysexEnabled = !!options.sysexEnabled;
    this.inputs = new Map();
    this.outputs = new Map();
    this.outputOptions = options;
    this.nativeAccess = null;
    this.nativeInputIds = new Set();
    this.nativeOutputIds = new Set();
    this.nativeStateListener = null;

    for (const device of devices) {
      this.addOutputDevice(device, false);
    }
  }

  addOutputDevice(device, notify = true) {
    if (!device || this.outputs.has(device.id)) {
      return;
    }

    const output = new VirtualMIDIOutput(device.synth, {
      access: this,
      id: device.id,
      manufacturer: this.outputOptions.manufacturer || "midi-sf2-web",
      name: device.name,
      sysexEnabled: this.sysexEnabled,
      lookaheadMs: this.outputOptions.lookaheadMs ?? DEFAULT_LOOKAHEAD_MS,
      schedulerIntervalMs: this.outputOptions.schedulerIntervalMs ?? DEFAULT_SCHEDULER_INTERVAL_MS,
      maxMessagesPerTick: this.outputOptions.maxMessagesPerTick ?? DEFAULT_MAX_MESSAGES_PER_TICK
    });
    output.builtIn = !!device.builtIn;
    output.soundFontKey = device.key;
    this.outputs.set(output.id, output);
    if (notify) {
      this.emitPortStateChange(output);
    }
  }

  attachNativeAccess(nativeAccess) {
    if (!nativeAccess) {
      return;
    }
    if (this.nativeAccess && this.nativeAccess !== nativeAccess) {
      this.detachNativeAccess();
    }
    this.nativeAccess = nativeAccess;
    if (!this.nativeStateListener) {
      this.nativeStateListener = (event) => {
        this.syncNativePorts(true);
        if (event?.port) {
          this.emitPortStateChange(event.port);
        }
      };
      if (typeof nativeAccess.addEventListener === "function") {
        nativeAccess.addEventListener("statechange", this.nativeStateListener);
      }
    }
    this.syncNativePorts(true);
  }

  detachNativeAccess() {
    if (!this.nativeAccess && !this.nativeInputIds.size && !this.nativeOutputIds.size) {
      return;
    }
    if (this.nativeAccess && this.nativeStateListener && typeof this.nativeAccess.removeEventListener === "function") {
      this.nativeAccess.removeEventListener("statechange", this.nativeStateListener);
    }
    for (const id of this.nativeInputIds) {
      const port = this.inputs.get(id);
      this.inputs.delete(id);
      if (port) {
        this.emitPortStateChange(port);
      }
    }
    for (const id of this.nativeOutputIds) {
      const port = this.outputs.get(id);
      this.outputs.delete(id);
      if (port) {
        this.emitPortStateChange(port);
      }
    }
    this.nativeAccess = null;
    this.nativeStateListener = null;
    this.nativeInputIds.clear();
    this.nativeOutputIds.clear();
  }

  syncNativePorts(notify = true) {
    if (!this.nativeAccess) {
      return;
    }
    this.syncNativePortMap("inputs", this.nativeAccess.inputs, this.nativeInputIds, notify);
    this.syncNativePortMap("outputs", this.nativeAccess.outputs, this.nativeOutputIds, notify);
  }

  syncNativePortMap(kind, source, trackedIds, notify) {
    const target = this[kind];
    const seen = new Set();
    for (const port of midiPortValues(source)) {
      if (!port?.id) {
        continue;
      }
      seen.add(port.id);
      if (target.has(port.id) && !trackedIds.has(port.id)) {
        continue;
      }
      const previous = target.get(port.id);
      target.set(port.id, port);
      trackedIds.add(port.id);
      if (notify && previous !== port) {
        this.emitPortStateChange(port);
      }
    }
    for (const id of Array.from(trackedIds)) {
      if (seen.has(id)) {
        continue;
      }
      const port = target.get(id);
      target.delete(id);
      trackedIds.delete(id);
      if (notify && port) {
        this.emitPortStateChange(port);
      }
    }
  }

  removeOutputDevice(deviceId) {
    const output = this.outputs.get(deviceId);
    if (!output) {
      return;
    }
    output.clear();
    output.state = "disconnected";
    output.connection = "closed";
    this.outputs.delete(deviceId);
    this.emitPortStateChange(output);
  }

  renameOutputDevice(deviceId, name) {
    const output = this.outputs.get(deviceId);
    if (!output) {
      return;
    }
    output.name = name;
    output.emitStateChange();
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
      this.recordDroppedQueuedEvents();
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
      let messages;
      try {
        messages = parseMIDIMessageSequence(item.data, this.sysexEnabled);
      } catch (error) {
        this.synth.recordDroppedMidiEvents(1);
        throw error;
      }
      const timestampNumber = Number(item.timestamp || 0);
      if (!Number.isFinite(timestampNumber) || timestampNumber < 0) {
        this.synth.recordDroppedMidiEvents(messages.length || 1);
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
    this.recordDroppedQueuedEvents();
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

  recordDroppedQueuedEvents() {
    if (this.queue.length) {
      this.synth.recordDroppedMidiEvents(this.queue.length);
    }
  }
}
