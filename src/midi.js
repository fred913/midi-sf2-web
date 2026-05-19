import { GS_RESET_PREFIX } from "./constants.js";
import { createDOMException } from "./utils.js";

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

export function parseMIDIMessageSequence(data, sysexEnabled) {
  if (data == null || typeof data[Symbol.iterator] !== "function") {
    throw new TypeError("MIDIOutput.send() data must be an iterable sequence of bytes.");
  }

  const bytes = Array.from(data, (value) => {
    const byte = Number(value);
    if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
      throw new TypeError("MIDIOutput.send() data bytes must be integers between 0x00 and 0xFF.");
    }
    return byte;
  });
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

    if (isRealtimeStatus(status)) {
      messages.push([status]);
      offset += 1;
      continue;
    }

    const length = midiMessageLength(status);
    if (!length) {
      offset += 1;
      continue;
    }

    const message = [status];
    offset += 1;
    while (message.length < length) {
      if (offset >= bytes.length) {
        padMIDIMessage(message, length);
        break;
      }
      const byte = bytes[offset];
      if (isRealtimeStatus(byte)) {
        messages.push([byte]);
        offset += 1;
        continue;
      }
      if (byte >= 0x80) {
        padMIDIMessage(message, length);
        break;
      }
      message.push(byte);
      offset += 1;
    }
    messages.push(message);
  }

  return messages;
}

function isRealtimeStatus(byte) {
  return byte >= 0xf8 && byte <= 0xff;
}

function padMIDIMessage(message, length) {
  while (message.length < length) {
    message.push(0);
  }
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

export function matchesSysex(bytes, pattern) {
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

export function isGsReset(bytes) {
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
