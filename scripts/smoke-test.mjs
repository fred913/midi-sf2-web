import assert from "node:assert/strict"
import fs from "node:fs"
import vm from "node:vm"

class FakeAudioParam {
  constructor(value = 1) {
    this.value = value
  }

  setValueAtTime(value) {
    this.value = value
  }

  setTargetAtTime(value) {
    this.value = value
  }

  exponentialRampToValueAtTime(value) {
    this.value = value
  }

  cancelScheduledValues() {}
}

class FakeNode {
  connect(target) {
    this.target = target
    return target
  }

  disconnect() {
    this.target = null
  }
}

class FakeGain extends FakeNode {
  constructor() {
    super()
    this.gain = new FakeAudioParam(1)
  }
}

class FakePanner extends FakeNode {
  constructor() {
    super()
    this.pan = new FakeAudioParam(0)
  }
}

class FakeOscillator extends FakeNode {
  constructor() {
    super()
    this.frequency = new FakeAudioParam(0)
    this.started = false
    this.stopped = false
  }

  start() {
    this.started = true
  }

  stop() {
    this.stopped = true
  }
}

class FakeDynamicsCompressor extends FakeNode {
  constructor() {
    super()
    this.threshold = new FakeAudioParam(0)
    this.knee = new FakeAudioParam(0)
    this.ratio = new FakeAudioParam(1)
    this.attack = new FakeAudioParam(0)
    this.release = new FakeAudioParam(0)
  }
}

class FakeBufferSource extends FakeNode {
  constructor() {
    super()
    this.playbackRate = new FakeAudioParam(1)
    this.loop = false
    this.started = false
    this.stopped = false
    this.onended = null
  }

  start() {
    this.started = true
  }

  stop() {
    this.stopped = true
    this.onended?.()
  }
}

class FakeAudioBuffer {
  constructor(frameCount, sampleRate) {
    this.frameCount = frameCount
    this.sampleRate = sampleRate
    this.data = new Float32Array(frameCount)
  }

  getChannelData() {
    return this.data
  }
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 0
    this.destination = new FakeNode()
    this.state = "running"
    this.oscillatorCount = 0
  }

  createGain() {
    return new FakeGain()
  }

  createStereoPanner() {
    return new FakePanner()
  }

  createOscillator() {
    this.oscillatorCount += 1
    return new FakeOscillator()
  }

  createDynamicsCompressor() {
    return new FakeDynamicsCompressor()
  }

  createBufferSource() {
    return new FakeBufferSource()
  }

  createBuffer(_channels, frameCount, sampleRate) {
    return new FakeAudioBuffer(frameCount, sampleRate)
  }

  resume() {
    this.state = "running"
    return Promise.resolve()
  }
}

function createFakeIndexedDB() {
  const stores = new Map()

  function asyncRequest(result, apply) {
    const request = {}
    setTimeout(() => {
      try {
        if (apply) {
          apply()
        }
        request.result = result
        request.onsuccess?.({ target: request })
      } catch (error) {
        request.error = error
        request.onerror?.({ target: request })
      }
    }, 0)
    return request
  }

  function createStore(name) {
    if (!stores.has(name)) {
      stores.set(name, new Map())
    }
    const store = stores.get(name)
    return {
      get: (key) => asyncRequest(store.get(key)),
      put: (record) => asyncRequest(record.key, () => store.set(record.key, record)),
      delete: (key) => asyncRequest(undefined, () => store.delete(key)),
      getAll: () => asyncRequest(Array.from(store.values()))
    }
  }

  function createDb() {
    return {
      objectStoreNames: {
        contains: (name) => stores.has(name)
      },
      createObjectStore: (name) => createStore(name),
      transaction: (name) => ({
        objectStore: () => createStore(name)
      }),
      close() {}
    }
  }

  return {
    open() {
      const request = {}
      setTimeout(() => {
        const db = createDb()
        request.result = db
        if (!stores.has("soundfonts")) {
          request.onupgradeneeded?.({ target: request })
        }
        request.onsuccess?.({ target: request })
      }, 0)
      return request
    }
  }
}

function loadBundle({ fakeClock = true, nativeRequestMIDIAccess = null } = {}) {
  const code = fs.readFileSync("dist/sf2.user.js", "utf8")
  const soundFontBytes = fs.readFileSync("assets/GeneralUser-GS.sf2")
  const soundFontUrl = "https://raw.githubusercontent.com/fred913/midi-sf2-web/main/assets/GeneralUser-GS.sf2"
  let now = 0
  let fetchCount = 0
  const menuCommands = []
  const context = {
    AudioContext: FakeAudioContext,
    Buffer,
    DOMException,
    console,
    clearInterval,
    clearTimeout,
    navigator: nativeRequestMIDIAccess ? { requestMIDIAccess: nativeRequestMIDIAccess } : {},
    setInterval,
    setTimeout,
    GM_registerMenuCommand: (name, callback) => {
      menuCommands.push({ name, callback })
    },
    indexedDB: createFakeIndexedDB(),
    fetch: async (url) => {
      fetchCount += 1
      assert.equal(url, soundFontUrl)
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name) => name.toLowerCase() === "content-length" ? String(soundFontBytes.byteLength) : null
        },
        arrayBuffer: async () => soundFontBytes.buffer.slice(
          soundFontBytes.byteOffset,
          soundFontBytes.byteOffset + soundFontBytes.byteLength
        )
      }
    },
    performance: fakeClock ? { now: () => now } : performance
  }
  context.advanceClock = (ms) => {
    now += ms
  }
  context.fetchCount = () => fetchCount
  context.menuCommands = menuCommands
  vm.createContext(context)
  vm.runInContext(code, context)
  context.WebMidiAudioShim.installWebMidiAudioShim({ navigator: context.navigator })
  return context
}

function outputFrom(access) {
  return access.outputs.values().next().value
}

function testUserscriptHeader() {
  const code = fs.readFileSync("dist/sf2.user.js", "utf8")
  assert.match(code, /@name\s+SF2 as MIDI out/)
  assert.match(code, /@match\s+\*:\/\/\*\/\*/)
}

function makeMidiFile() {
  const track = [
    0x00, 0xf0, 0x05, 0x7e, 0x7f, 0x09, 0x01, 0xf7,
    0x00, 0x90, 0x3c, 0x64,
    0x60, 0x80, 0x3c, 0x00,
    0x00, 0xff, 0x2f, 0x00
  ]
  return new Uint8Array([
    0x4d, 0x54, 0x68, 0x64,
    0x00, 0x00, 0x00, 0x06,
    0x00, 0x00,
    0x00, 0x01,
    0x00, 0x60,
    0x4d, 0x54, 0x72, 0x6b,
    0x00, 0x00, 0x00, track.length,
    ...track
  ]).buffer
}

async function testAccessAndPortState() {
  const context = loadBundle()
  const access = await context.navigator.requestMIDIAccess()
  const sysexAccess = await context.navigator.requestMIDIAccess({ sysex: true })
  const output = outputFrom(access)
  const events = []

  access.onstatechange = (event) => events.push(`access:${event.port.connection}`)
  output.onstatechange = (event) => events.push(`port:${event.port.connection}`)

  assert.equal(access.sysexEnabled, false)
  assert.equal(sysexAccess.sysexEnabled, true)
  assert.equal(access.inputs.size, 0)
  assert.equal(access.outputs.size, 1)
  assert.equal(output.connection, "closed")

  await output.open()
  assert.equal(output.connection, "open")
  await output.close()
  assert.equal(output.connection, "closed")
  assert.deepEqual(events, ["port:open", "access:open", "port:closed", "access:closed"])
}

async function testSendValidationAndQueue() {
  const context = loadBundle()
  const access = await context.navigator.requestMIDIAccess()
  const output = outputFrom(access)
  await output.preload()

  assert.throws(() => output.send([0x40, 0x7f]), /Running status/)
  assert.doesNotThrow(() => output.send([0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7]))
  assert.doesNotThrow(() => output.send([0xf0, 0x7d, 0x00, 0xf7]))
  assert.throws(() => output.send([0x90, 60, 300]), /0x00 and 0xFF/)

  output.send([0x90, 62])
  assert.equal(context.WebMidiAudioShim.getInstalledWebMidiAudioShim().synth.channels[0].activeNotes.has(62), false)
  output.send([0xf4])

  output.send([0x90, 60, 0xf8, 100])
  assert.equal(context.WebMidiAudioShim.getInstalledWebMidiAudioShim().synth.channels[0].activeNotes.get(60).length, 1)
  output.send([0x80, 60, 0xfe, 0])
  output.send([0xb0, 7, 0xc0, 5])
  assert.equal(context.WebMidiAudioShim.getInstalledWebMidiAudioShim().synth.channels[0].volume, 0)
  assert.equal(context.WebMidiAudioShim.getInstalledWebMidiAudioShim().synth.channels[0].program, 5)
  output.send([0xc0, 0])
  output.send([0xb0, 7, 100])

  output.send([0x90, 60, 100], 1000)
  assert.equal(context.WebMidiAudioShim.getInstalledWebMidiAudioShim().synth.channels[0].activeNotes.size, 0)
  context.advanceClock(800)
  output.flushQueue()
  assert.equal(context.WebMidiAudioShim.getInstalledWebMidiAudioShim().synth.channels[0].activeNotes.size, 0)
  context.advanceClock(100)
  output.flushQueue()
  assert.equal(context.WebMidiAudioShim.getInstalledWebMidiAudioShim().synth.channels[0].activeNotes.get(60).length, 1)
  output.clear()
  assert.equal(output.queue.length, 0)
}

async function testMasterGainControls() {
  const context = loadBundle()
  await new Promise((resolve) => setTimeout(resolve, 5))
  const shim = context.WebMidiAudioShim.getInstalledWebMidiAudioShim()
  const access = await context.navigator.requestMIDIAccess()
  const output = outputFrom(access)

  assert.equal(shim.getMasterGain(), 0.3)
  assert.equal(shim.setMasterGain(0.18), 0.18)
  await output.preload()
  assert.equal(output.synth.getMasterGain(), 0.18)
  assert.equal(output.synth.masterGain.gain.value, 0.18)
  assert.equal(output.synth.limiter.threshold.value, -8)

  assert.equal(shim.setMasterGain(2), 1.5)
  assert.equal(output.synth.masterGain.gain.value, 1.5)
  assert.equal(shim.setMasterGain("bad"), 1.5)
}

async function testPassthroughRealMidiDevices() {
  const realInput = {
    id: "real-input",
    name: "Real MIDI In",
    type: "input",
    state: "connected",
    connection: "open"
  }
  const realOutput = {
    id: "real-output",
    name: "Real MIDI Out",
    type: "output",
    state: "connected",
    connection: "closed",
    send() {}
  }
  const nativeAccess = {
    inputs: new Map([[realInput.id, realInput]]),
    outputs: new Map([[realOutput.id, realOutput]]),
    listeners: new Set(),
    addEventListener(type, listener) {
      if (type === "statechange") {
        this.listeners.add(listener)
      }
    },
    removeEventListener(type, listener) {
      if (type === "statechange") {
        this.listeners.delete(listener)
      }
    }
  }
  const requested = []
  const context = loadBundle({
    nativeRequestMIDIAccess: async (options) => {
      requested.push(options)
      return nativeAccess
    }
  })
  const shim = context.WebMidiAudioShim.getInstalledWebMidiAudioShim()
  const access = await context.navigator.requestMIDIAccess({ sysex: true })

  assert.equal(shim.getPassthroughRealMidi(), true)
  assert.equal(requested.length, 1)
  assert.equal(requested[0].sysex, true)
  assert.equal(access.inputs.get(realInput.id), realInput)
  assert.equal(access.outputs.get(realOutput.id), realOutput)
  assert.equal(access.outputs.has("generaluser-gs-web-audio"), true)

  await shim.setPassthroughRealMidi(false)
  assert.equal(shim.getPassthroughRealMidi(), false)
  assert.equal(access.inputs.has(realInput.id), false)
  assert.equal(access.outputs.has(realOutput.id), false)

  await shim.setPassthroughRealMidi(true)
  assert.equal(shim.getPassthroughRealMidi(), true)
  assert.equal(access.inputs.get(realInput.id), realInput)
  assert.equal(access.outputs.get(realOutput.id), realOutput)
}

async function testVoiceLimitControls() {
  const context = loadBundle()
  const shim = context.WebMidiAudioShim.getInstalledWebMidiAudioShim()
  const access = await context.navigator.requestMIDIAccess()
  const output = outputFrom(access)

  let limits = shim.getVoiceLimits()
  assert.equal(limits.maxVoices, 512)
  assert.equal(limits.maxVoicesPerChannel, 256)
  assert.equal(shim.getPerformanceLimitEnabled(), false)
  assert.equal(output.synth.getPerformanceLimitEnabled(), false)

  limits = shim.setVoiceLimits({ maxVoices: 16, maxVoicesPerChannel: 9 })
  assert.equal(limits.maxVoices, 16)
  assert.equal(limits.maxVoicesPerChannel, 9)
  assert.equal(output.synth.maxVoices, 16)
  assert.equal(output.synth.maxVoicesPerChannel, 9)

  limits = shim.setVoiceLimits({ maxVoices: 2, maxVoicesPerChannel: 999 })
  assert.equal(limits.maxVoices, 256)
  assert.equal(limits.maxVoicesPerChannel, 256)

  assert.equal(shim.setPerformanceLimitEnabled(true), true)
  assert.equal(shim.getPerformanceLimitEnabled(), true)
  assert.equal(output.synth.getPerformanceLimitEnabled(), true)
  assert.equal(shim.setPerformanceLimitEnabled(false), false)
}

async function testPerformanceStats() {
  const context = loadBundle()
  const access = await context.navigator.requestMIDIAccess()
  const output = outputFrom(access)
  const shim = context.WebMidiAudioShim.getInstalledWebMidiAudioShim()
  await output.preload()

  let stats = shim.getPerformanceStats()
  assert.equal(stats.totals.midiEvents, 0)
  assert.equal(stats.totals.playedNotes, 0)
  assert.equal(stats.totals.droppedMidiEvents, 0)
  assert.equal(stats.totals.droppedNotes, 0)
  assert.equal(stats.devices.length, 1)

  output.send([0x90, 60, 100])
  output.send([0xb0, 7, 90])
  assert.throws(() => output.send([0x90, 60, 300]), /0x00 and 0xFF/)

  stats = shim.getPerformanceStats()
  assert.equal(stats.totals.midiEvents, 2)
  assert.equal(stats.totals.playedNotes, 1)
  assert.equal(stats.totals.droppedMidiEvents, 1)
  assert.equal(stats.devices[0].stats.activeVoices, 1)

  shim.setPerformanceLimitEnabled(true)
  shim.setVoiceLimits({ maxVoices: 4, maxVoicesPerChannel: 4 })
  for (let i = 0; i < 7; i += 1) {
    output.send([0x90, 62 + i, 100])
  }

  stats = shim.getPerformanceStats()
  assert.equal(stats.totals.playedNotes, 8)
  assert.ok(stats.totals.droppedNotes >= 4)
  assert.ok(stats.totals.activeVoices <= 4)
}

async function testDefaultLimitsAllowDenseNoteBursts() {
  const context = loadBundle()
  const access = await context.navigator.requestMIDIAccess()
  const output = outputFrom(access)
  const shim = context.WebMidiAudioShim.getInstalledWebMidiAudioShim()
  await output.preload()

  for (let i = 0; i < 200; i += 1) {
    output.send([0x90, 60 + (i % 12), 100], i * 5)
  }
  for (let elapsed = 0; elapsed < 1000; elapsed += 25) {
    context.advanceClock(25)
    output.flushQueue()
  }

  const stats = shim.getPerformanceStats()
  assert.equal(stats.totals.playedNotes, 200)
  assert.equal(stats.totals.droppedNotes, 0)
  assert.ok(stats.totals.activeVoices >= 200)
}

async function testPerformanceLimitsDefaultOff() {
  const context = loadBundle()
  const access = await context.navigator.requestMIDIAccess()
  const output = outputFrom(access)
  const shim = context.WebMidiAudioShim.getInstalledWebMidiAudioShim()
  await output.preload()

  shim.setVoiceLimits({ maxVoices: 8, maxVoicesPerChannel: 4 })
  for (let i = 0; i < 12; i += 1) {
    output.send([0x90, 48 + i, 100])
  }

  const stats = shim.getPerformanceStats()
  assert.equal(shim.getPerformanceLimitEnabled(), false)
  assert.equal(stats.totals.playedNotes, 12)
  assert.equal(stats.totals.droppedNotes, 0)
  assert.ok(stats.totals.activeVoices > 8)
}

async function testDeferredSendWhileSoundFontDownloads() {
  const context = loadBundle()
  const access = await context.navigator.requestMIDIAccess()
  const output = outputFrom(access)
  const shim = context.WebMidiAudioShim.getInstalledWebMidiAudioShim()

  output.send([0x90, 60, 100])
  assert.equal(shim.synth.channels[0].activeNotes.size, 0)
  await output.preload()
  assert.equal(shim.synth.channels[0].activeNotes.get(60).length, 1)
  output.clear()
}

async function testIndexedDbSoundFontCache() {
  const context = loadBundle()
  let shim = context.WebMidiAudioShim.getInstalledWebMidiAudioShim()

  await shim.preload()
  assert.equal(context.fetchCount(), 1)

  shim = context.WebMidiAudioShim.installWebMidiAudioShim({ navigator: context.navigator, force: true })
  await shim.preload()
  assert.equal(context.fetchCount(), 1)

  await shim.clearSoundFontCache()
  shim = context.WebMidiAudioShim.installWebMidiAudioShim({ navigator: context.navigator, force: true })
  await shim.preload()
  assert.equal(context.fetchCount(), 2)
}

async function testCustomSoundFontDevices() {
  const context = loadBundle()
  const shim = context.WebMidiAudioShim.getInstalledWebMidiAudioShim()
  const sourceBytes = fs.readFileSync("assets/GeneralUser-GS.sf2")
  const sourceBuffer = sourceBytes.buffer.slice(sourceBytes.byteOffset, sourceBytes.byteOffset + sourceBytes.byteLength)

  assert.equal(context.menuCommands.some((command) => command.name === "SF2 Settings"), true)
  assert.equal(shim.listSoundFontDevices().length, 1)

  const installed = await shim.installSoundFontFromArrayBuffer(sourceBuffer, {
    name: "Second Piano.sf2",
    source: "file"
  })
  assert.equal(installed.name, "Second Piano")
  assert.equal(shim.listSoundFontDevices().length, 2)

  const access = await context.navigator.requestMIDIAccess()
  assert.equal(access.outputs.size, 2)
  const outputs = Array.from(access.outputs.values())
  assert.equal(outputs[0].id, "generaluser-gs-web-audio")
  assert.equal(outputs[1].id, installed.id)

  await outputs[1].preload()
  assert.equal(outputs[1].synth.ensureSoundFont().getPreset(0, 0).name, "Grand Piano")

  const renamed = await shim.renameSoundFontDevice(installed.id, "Renamed Piano")
  assert.equal(renamed.name, "Renamed Piano")
  assert.equal(access.outputs.get(installed.id).name, "Renamed Piano")

  assert.equal(await shim.uninstallSoundFont(installed.id), true)
  assert.equal(shim.listSoundFontDevices().length, 1)
  assert.equal(access.outputs.has(installed.id), false)
}

async function testMidiAndResetMessages() {
  const context = loadBundle()
  const access = await context.navigator.requestMIDIAccess({ sysex: true })
  const output = outputFrom(access)
  const shim = context.WebMidiAudioShim.getInstalledWebMidiAudioShim()
  await output.preload()

  output.send([0xc0, 10])
  output.send([0xb0, 7, 20])
  output.send([0xb0, 1, 100])
  output.send([0xd0, 80])
  output.send([0xa0, 60, 70])
  output.send([0xe0, 0, 64])
  output.send([0xb0, 101, 0, 0xb0, 100, 0, 0xb0, 6, 12, 0xb0, 38, 50])
  output.send([0xb0, 99, 1, 0xb0, 98, 2, 0xb0, 6, 3, 0xb0, 38, 4])

  const channel = shim.synth.channels[0]
  assert.equal(channel.program, 10)
  assert.equal(channel.volume, 20)
  assert.equal(channel.modulation, 100)
  assert.equal(channel.channelPressure, 80)
  assert.equal(channel.polyPressure.get(60), 70)
  assert.equal(channel.pitchBend, 0)
  assert.equal(channel.pitchBendRange, 12)
  assert.equal(channel.pitchBendRangeCents, 50)
  assert.equal(channel.nrpnValues.get("1:2"), 388)

  output.send([0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7])
  assert.equal(shim.synth.channels[0].program, 0)
  assert.equal(shim.synth.channels[0].volume, 100)

  output.send([0xc0, 5])
  output.send([0xf0, 0x41, 0x10, 0x42, 0x12, 0x40, 0x00, 0x7f, 0x00, 0x41, 0xf7])
  assert.equal(shim.synth.channels[0].program, 0)
}

async function testLazySharedModulationLfo() {
  const context = loadBundle()
  const access = await context.navigator.requestMIDIAccess()
  const output = outputFrom(access)
  const shim = context.WebMidiAudioShim.getInstalledWebMidiAudioShim()
  await output.preload()

  output.send([0x90, 60, 100])
  output.send([0x90, 64, 100])
  assert.equal(shim.synth.audioContext.oscillatorCount, 0)

  output.send([0xb0, 1, 100])
  assert.equal(shim.synth.audioContext.oscillatorCount, 1)

  output.send([0x90, 67, 100])
  assert.equal(shim.synth.audioContext.oscillatorCount, 1)
  output.clear()
}

async function testMidiParserAndPlayback() {
  const context = loadBundle({ fakeClock: false })
  const shim = context.WebMidiAudioShim.installWebMidiAudioShim({ navigator: context.navigator, force: true })
  const midi = makeMidiFile()
  const events = context.WebMidiAudioShim.parseMidiFile(midi)

  assert.deepEqual(Array.from(events[0].data), [0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7])
  assert.deepEqual(Array.from(events[1].data), [0x90, 0x3c, 0x64])
  assert.deepEqual(Array.from(events[2].data), [0x80, 0x3c, 0x00])

  const playback = await context.WebMidiAudioShim.playMidiFile(midi, {
    access: shim.getAccess({ sysex: true }),
    playbackRate: 100,
    lookaheadMs: 30,
    schedulerIntervalMs: 5
  })
  assert.ok(playback.durationMs > 0)
  await new Promise((resolve) => setTimeout(resolve, 50))
  playback.stop()
}

async function testEmbeddedSoundFontStillLoads() {
  const context = loadBundle()
  const shim = context.WebMidiAudioShim.installWebMidiAudioShim({ navigator: context.navigator, force: true })
  await shim.preload()
  const soundFont = shim.synth.ensureSoundFont()
  const preset = soundFont.getPreset(0, 0)
  assert.equal(preset.name, "Grand Piano")
}

testUserscriptHeader()
await testAccessAndPortState()
await testSendValidationAndQueue()
await testMasterGainControls()
await testPassthroughRealMidiDevices()
await testVoiceLimitControls()
await testPerformanceStats()
await testDefaultLimitsAllowDenseNoteBursts()
await testPerformanceLimitsDefaultOff()
await testDeferredSendWhileSoundFontDownloads()
await testIndexedDbSoundFontCache()
await testCustomSoundFontDevices()
await testMidiAndResetMessages()
await testLazySharedModulationLfo()
await testMidiParserAndPlayback()
await testEmbeddedSoundFontStillLoads()

console.log("smoke tests passed")
