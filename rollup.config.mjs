import fs from "node:fs"

const userscriptHeader = `// ==UserScript==
// @name         SF2 Support for MidiShow
// @namespace    http://tampermonkey.net/
// @version      2026-05-18
// @description  try to take over the world!
// @author       Sheng Fan
// @match        https://www.midishow.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=midishow.com
// @grant        none
// ==/UserScript==

(function() {
  'use strict';
`

function inlineSf2Plugin() {
  return {
    name: "inline-sf2",
    load(id) {
      if (!id.endsWith(".sf2")) {
        return null
      }

      const base64 = fs.readFileSync(id).toString("base64")
      return `export default ${JSON.stringify(base64)};`
    }
  }
}

export default {
  input: "src/index.js",
  output: {
    file: "dist/sf2.user.js",
    format: "iife",
    name: "WebMidiAudioShim",
    banner: userscriptHeader,
    footer: `
  if (typeof globalThis !== "undefined") {
    globalThis.WebMidiAudioShim = WebMidiAudioShim
  }
})();`,
    sourcemap: false,
    generatedCode: "es2015",
  },
  plugins: [inlineSf2Plugin()],
  treeshake: false
}
