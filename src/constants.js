export const DEFAULT_OUTPUT_ID = "generaluser-gs-web-audio";
export const DEFAULT_SOUNDFONT_URL = "https://raw.githubusercontent.com/fred913/midi-sf2-web/main/assets/GeneralUser-GS.sf2";
export const DEFAULT_SOUNDFONT_CACHE_KEY = "GeneralUser-GS-v2.0.3";
export const SOUNDFONT_CACHE_DB = "midi-sf2-web";
export const SOUNDFONT_CACHE_STORE = "soundfonts";
export const SOUNDFONT_SETTINGS_KEY = "__settings__";
export const CUSTOM_SOUNDFONT_PREFIX = "custom-sf2-";
export const MIDI_CHANNELS = 16;
export const PERCUSSION_CHANNEL = 9;
export const DEFAULT_PITCH_BEND_RANGE = 2;
export const DEFAULT_MASTER_GAIN = 0.3;
export const DEFAULT_LOOKAHEAD_MS = 120;
export const DEFAULT_SCHEDULER_INTERVAL_MS = 25;
export const MIN_LOOKAHEAD_MS = 10;
export const MIN_SCHEDULER_INTERVAL_MS = 8;
export const DEFAULT_MAX_MESSAGES_PER_TICK = 4096;
export const DEFAULT_MAX_VOICES = 512;
export const DEFAULT_MAX_VOICES_PER_CHANNEL = 256;
export const DEFAULT_PERFORMANCE_LIMIT_ENABLED = false;
export const GM_SYSTEM_ON = [0xf0, 0x7e, null, 0x09, 0x01, 0xf7];
export const GM2_SYSTEM_ON = [0xf0, 0x7e, null, 0x09, 0x03, 0xf7];
export const GS_RESET_PREFIX = [0xf0, 0x41, null, 0x42, 0x12, 0x40, 0x00, 0x7f, 0x00];
export const UINT16_REPLACE_OPERATORS = new Set([41, 46, 47, 53, 54, 56, 57, 58]);
export const ADDITIVE_OPERATORS = new Set([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17,
  21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
  36, 37, 38, 39, 40, 45, 48, 50, 51, 52
]);

export const OPERATOR_NAMES = {
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
