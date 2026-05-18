# midi-sf2-web

Tampermonkey userscript that overrides `navigator.requestMIDIAccess()` with a virtual Web MIDI output. MIDI messages are rendered through Web Audio using the embedded `assets/GeneralUser-GS.sf2` SoundFont, so playback works on browsers that do not expose compatible native MIDI output.

## Install

[Install the latest userscript from GitHub raw](https://raw.githubusercontent.com/fred913/midi-sf2-web/main/dist/sf2.user.js).

The compiled userscript is `dist/sf2.user.js`. It includes the userscript header and the SoundFont data inline as base64.

## Build

```sh
npm install
npm run build
npm test
```

`npm run build` clears `dist/` and writes a fresh `dist/sf2.user.js`.

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

## License

This repository is not GPL-3-only. See [LICENSE](LICENSE) for the project code notice and the embedded GeneralUser GS v2.0.3 license. GeneralUser GS is by S. Christian Collins; the SoundFont metadata includes the copyright notice "1997-2025 by S. Christian Collins".
