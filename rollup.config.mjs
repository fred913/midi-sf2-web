const userscriptHeader = `// ==UserScript==
// @name         SF2 Support for MidiShow
// @namespace    http://tampermonkey.net/
// @version      2026-05-18
// @description  try to take over the world!
// @author       Sheng Fan
// @match        https://www.midishow.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=midishow.com
// @resource     GENERAL_USER_GS_SF2 https://raw.githubusercontent.com/fred913/midi-sf2-web/main/assets/GeneralUser-GS.sf2
// @grant        GM_getResourceURL
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
