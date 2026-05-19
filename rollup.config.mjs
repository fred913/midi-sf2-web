import fs from "node:fs"

const packageJson = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"))

const userscriptHeader = `// ==UserScript==
// @name         SF2 as MIDI out
// @namespace    http://tampermonkey.net/
// @version      ${packageJson.version}
// @description  try to take over the world!
// @author       Sheng Fan
// @match        *://*/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=midishow.com
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// ==/UserScript==

(function() {
  'use strict';
`

export default {
  input: "src/index.js",
  output: {
    file: "dist/sf2.user.js",
    format: "iife",
    name: "WebMidiAudioShim",
    banner: userscriptHeader,
    footer: `
  const pageGlobal = typeof unsafeWindow !== "undefined" ? unsafeWindow : globalThis
  if (typeof globalThis !== "undefined") {
    globalThis.WebMidiAudioShim = WebMidiAudioShim
  }
  if (pageGlobal && pageGlobal !== globalThis) {
    pageGlobal.WebMidiAudioShim = WebMidiAudioShim
  }
})();`,
    sourcemap: false,
    generatedCode: "es2015",
  },
  plugins: [],
  treeshake: false
}
