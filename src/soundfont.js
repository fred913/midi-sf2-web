import { ADDITIVE_OPERATORS, OPERATOR_NAMES, UINT16_REPLACE_OPERATORS } from "./constants.js";
import { intersectRanges, readNullTerminatedString, readString, requiredChunk, validRange } from "./utils.js";

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

export function parseSoundFont(arrayBuffer) {
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
