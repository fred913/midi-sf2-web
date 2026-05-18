# midi-sf2-web

Tampermonkey userscript that overrides `navigator.requestMIDIAccess()` with a virtual Web MIDI output. MIDI messages are rendered through Web Audio using `assets/GeneralUser-GS.sf2`, downloaded on first use with a bottom-center progress bar and cached in IndexedDB for later loads.

## Install

[Install the latest userscript from GitHub raw](https://raw.githubusercontent.com/fred913/midi-sf2-web/main/dist/sf2.user.js).

The compiled userscript is `dist/sf2.user.js`. The SoundFont is not embedded in the script body; the runtime downloads it from this repository's GitHub raw URL and stores it in a local IndexedDB cache.

## Build

```sh
npm install
npm run build
npm test
```

`npm run build` clears `dist/` and writes a fresh `dist/sf2.user.js`.

The userscript header version is read from `package.json`. GitHub Actions runs `npm run version:bump-userscript` before its build so each uploaded `dist/sf2.user.js` gets a monotonic patch version such as `0.1.0`, `0.1.1`, and so on.

## Local Demo

```sh
npm run serve
```

Open `http://127.0.0.1:4173/demo/index.html`, initialize the shim, then play C4 or load a local `.mid` file.

## API

```html
<script src="dist/sf2.user.js"></script>
<script>
  const access = await navigator.requestMIDIAccess({ sysex: true })
  const output = access.outputs.values().next().value

  output.send([0xc0, 0])
  output.send([0x90, 60, 100])
  setTimeout(() => output.send([0x80, 60, 0]), 700)
</script>
```

The shim implements an output-only Web MIDI surface with `MIDIAccess.sysexEnabled`, `onstatechange`, `MIDIPort.open()`, `MIDIPort.close()`, queued `MIDIOutput.send(data, timestamp)`, and `MIDIOutput.clear()`. The bundle also exposes `WebMidiAudioShim.playMidiFile(arrayBuffer)`, which uses a lookahead scheduler for Standard MIDI files and recognizes common GM/GS reset messages.

Playback is capped to avoid runaway CPU on dense files: defaults are `maxVoices: 96`, `maxVoicesPerChannel: 32`, and `maxMessagesPerTick: 4096`. `playMidiFile()` also accepts `lookaheadMs`, `schedulerIntervalMs`, and `maxEventsPerTick` overrides for tuning.

The SoundFont cache can be cleared with `WebMidiAudioShim.clearSoundFontCache()` or `WebMidiAudioShim.getInstalledWebMidiAudioShim().clearSoundFontCache()`.

Tampermonkey's menu exposes `SF2 Settings`. The settings panel can install a new `.sf2` by drag and drop, file picker, or URL; each installed SoundFont appears as a separate virtual MIDI output. Custom devices can be selected as the default output order, renamed, or uninstalled.

## License

This repository is not GPL-3-only. See [LICENSE](LICENSE) for the project code notice and the bundled GeneralUser GS v2.0.3 license. GeneralUser GS is by S. Christian Collins; the SoundFont metadata includes the copyright notice "1997-2025 by S. Christian Collins".
