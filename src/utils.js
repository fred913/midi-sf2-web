export function scheduleOutputMessages(output, batch) {
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

export function compareQueuedMidiMessage(a, b) {
  return a.timestamp - b.timestamp || a.sequence - b.sequence;
}

export function positiveNumberOrDefault(value, defaultValue, minimum = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return Math.max(minimum, defaultValue);
  }
  return Math.max(minimum, number);
}

export function positiveIntegerOrDefault(value, defaultValue) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number <= 0) {
    return defaultValue;
  }
  return number;
}

export function createDOMException(name, message) {
  if (typeof DOMException === "function") {
    return new DOMException(message, name);
  }
  const error = new Error(message);
  error.name = name;
  return error;
}

export function setAudioParam(param, value, when) {
  if (typeof param.setTargetAtTime === "function") {
    param.setTargetAtTime(value, when, 0.01);
  } else {
    param.setValueAtTime(value, when);
  }
}

export function setCompressorParam(param, value) {
  if (param && typeof param.setValueAtTime === "function") {
    param.setValueAtTime(value, 0);
  }
}

export function normalizeMasterGain(value, fallback) {
  const gain = Number(value);
  return Number.isFinite(gain) ? clamp(gain, 0, 1.5) : fallback;
}

export function normalizeVoiceLimit(value, fallback, min, max) {
  const limit = Math.floor(Number(value));
  return Number.isFinite(limit) ? clamp(limit, min, max) : fallback;
}

export function requiredChunk(chunks, name) {
  const chunk = chunks.get(name);
  if (!chunk) {
    throw new Error(`The SF2 file is missing the ${name} chunk.`);
  }
  return chunk;
}

export function readString(view, offset, length) {
  let result = "";
  for (let i = 0; i < length; i += 1) {
    result += String.fromCharCode(view.getUint8(offset + i));
  }
  return result;
}

export function readNullTerminatedString(view, offset, length) {
  return readString(view, offset, length).replace(/\0.*$/, "").trim();
}

export function base64ToArrayBuffer(base64) {
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

export function defineRequestMIDIAccess(targetNavigator, requestMIDIAccess) {
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

export function firstMapValue(map) {
  return map.values().next().value;
}

export function midiPortValues(collection) {
  if (!collection) {
    return [];
  }
  if (typeof collection.values === "function") {
    return Array.from(collection.values());
  }
  if (typeof collection.forEach === "function") {
    const values = [];
    collection.forEach((value) => values.push(value));
    return values;
  }
  return [];
}

export function validRange(range) {
  return !range || range[0] <= range[1];
}

export function intersectRanges(a, b) {
  return [Math.max(a[0], b[0]), Math.min(a[1], b[1])];
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function performanceNow() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function pageGlobalThis() {
  return typeof unsafeWindow !== "undefined" ? unsafeWindow : globalThis;
}
