import './app.css'

import { channelMix, loadConfig, saveConfig, type Config, type Mode } from './config.ts'
import { AudioEngine, type EngineStatus } from './audio/engine.ts'
import { AudioRing, type RingReader } from './audio/ring.ts'
import { initGpu, WebGpuUnavailableError, type GpuContext } from './gpu/device.ts'
import { Analyzer } from './gpu/analyzer.ts'
import { Renderer } from './gpu/renderer.ts'
import { buildGraticule } from './ui/axes.ts'
import { computePanePair } from './ui/layout.ts'
import { Overlay, type OverlayStatus } from './ui/overlay.ts'
import { dispatchKey, type KeyActions } from './ui/keymap.ts'
import { buildWindowTables } from './dsp/windows.ts'
import type { LoudnessReading } from './dsp/loudness.ts'
import type { MetersMessage, MetersReport } from './workers/meters-worker.ts'

const canvas = document.getElementById('stage') as HTMLCanvasElement
const uiRoot = document.getElementById('ui') as HTMLElement

function showBlocker(title: string, body: string[]): void {
  const blocker = document.createElement('div')
  blocker.className = 'ws-blocker'
  const inner = document.createElement('div')
  inner.className = 'ws-blocker-inner'
  const h = document.createElement('h1')
  h.textContent = title
  inner.append(h)
  for (const text of body) {
    const p = document.createElement('p')
    p.innerHTML = text
    inner.append(p)
  }
  blocker.append(inner)
  document.body.append(blocker)
}

async function main(): Promise<void> {
  const config = loadConfig()

  let gpu: GpuContext
  try {
    gpu = await initGpu(canvas)
  } catch (error) {
    if (error instanceof WebGpuUnavailableError) {
      showBlocker('WebGPU required', [
        error.message,
        'Waveshape runs its FFT, its envelope reduction and its pitch tracker as compute shaders. WebGL has no compute stage, so there is no fallback that would be the same instrument.',
        'Chrome or Edge 113+, Safari 26+, or Firefox 141+ on a machine with a working GPU driver.',
      ])
      return
    }
    throw error
  }

  const { device } = gpu
  device.lost.then((info) => {
    showBlocker('GPU device lost', [
      `The WebGPU device was lost: ${info.message || info.reason}.`,
      'Reload the page to recover.',
    ])
  })

  const analyzer = new Analyzer(device)
  let renderer = new Renderer(device, gpu.context, gpu.format, analyzer, config.perf.msaa ? 4 : 1)
  const engine = new AudioEngine()

  // ------------------------------------------------------------------ metering
  const meters = new Worker(new URL('./workers/meters-worker.ts', import.meta.url), {
    type: 'module',
  })
  let loudness: LoudnessReading | null = null
  meters.onmessage = (event: MessageEvent<MetersReport>) => {
    if (event.data.type === 'reading') loudness = event.data.reading
  }
  const postMeters = (msg: MetersMessage, transfer?: Transferable[]) =>
    meters.postMessage(msg, transfer ?? [])

  // Fallback transport for documents that are not cross-origin isolated.
  let meterReader: RingReader | null = null
  let meterPlanes: Float32Array[] = []
  const METER_CHUNK = 8192

  function pumpMetersFallback(): void {
    const ring = engine.ring
    if (!ring || !meterReader) return
    let available = meterReader.available()
    while (available > 0) {
      const take = Math.min(available, METER_CHUNK)
      for (let c = 0; c < ring.channels; c++) {
        meterReader.readWindow(
          c,
          (meterReader.position + take) & 0x3fffffff,
          take,
          meterPlanes[c],
        )
      }
      postMeters({
        type: 'audio',
        planes: meterPlanes.map((p) => p.slice()),
        frames: take,
      })
      meterReader.advance(take)
      available -= take
    }
  }

  function attachMeters(ring: AudioRing | null): void {
    meterReader = null
    if (!ring) {
      postMeters({ type: 'stop' })
      return
    }
    if (ring.shared) {
      postMeters({ type: 'init', layout: ring.layout })
    } else {
      postMeters({ type: 'init', sampleRate: ring.sampleRate, channels: ring.channels })
      meterReader = ring.reader()
      meterPlanes = Array.from({ length: ring.channels }, () => new Float32Array(METER_CHUNK))
    }
  }

  // ------------------------------------------------------------------ source control
  const filePicker = document.createElement('input')
  filePicker.type = 'file'
  filePicker.accept = 'audio/*'
  filePicker.style.display = 'none'
  document.body.append(filePicker)
  let pendingFile: File | null = null

  let engineStatus: EngineStatus = engine.status
  engine.onStatus = (status) => {
    engineStatus = status
  }

  let sourceError = ''

  async function startSource(): Promise<void> {
    sourceError = ''
    try {
      await engine.start({
        kind: config.source.kind,
        deviceId: config.source.deviceId || undefined,
        sampleRate: config.source.sampleRate,
        channels: config.source.channels,
        file: pendingFile ?? undefined,
        generator: config.source.generator,
      })
      engine.setMonitorGain(config.source.monitorGain)
      analyzer.attach(engine.ring)
      renderer.invalidate()
      attachMeters(engine.ring)
      overlay.setDevices(await engine.listInputs())
      armResumeOnGesture()
    } catch (error) {
      // Surface the failure in three places: the console for the stack, the System tab for the
      // message, and the readout so it is visible without opening anything.
      console.error('[waveshape] could not start the source', error)
      sourceError = error instanceof Error ? error.message : String(error)
      engineStatus = {
        ...engine.status,
        running: false,
        sourceLabel: `failed: ${sourceError}`,
        message: sourceError,
      }
    }
  }

  async function stopSource(): Promise<void> {
    await engine.stop()
    analyzer.attach(null)
    renderer.invalidate()
    attachMeters(null)
  }

  filePicker.addEventListener('change', () => {
    const file = filePicker.files?.[0]
    if (!file) return
    pendingFile = file
    config.source.kind = 'file'
    void startSource()
  })

  // ------------------------------------------------------------------ automatic capture
  //
  // An analyzer that shows a flat line until you find the start button is a broken analyzer.
  // Capture therefore opens by itself whenever it can do so without putting something on
  // screen the user did not ask for: on load, when a device appears, and when the capture
  // settings change. "Can" is the whole question — a permission prompt, a screen-share picker
  // and a file dialog are all things that must follow a deliberate click, so those sources
  // wait to be started by hand.

  /** Sources that can be opened unattended, given the right conditions. */
  function sourceIsSelfStarting(): boolean {
    const kind = config.source.kind
    return kind === 'microphone' || kind === 'generator'
  }

  async function canAutoStart(): Promise<boolean> {
    if (engineStatus.running || !sourceIsSelfStarting()) return false
    // The generator is synthesis: no device, no permission, nothing to prompt for.
    if (config.source.kind === 'generator') return true
    return engine.isInputBound(config.source.deviceId || undefined)
  }

  let autoStarting = false
  async function autoStartIfBound(): Promise<void> {
    if (autoStarting) return
    autoStarting = true
    try {
      if (await canAutoStart()) await startSource()
    } finally {
      autoStarting = false
    }
  }

  /**
   * A context created without a user gesture can be parked in `suspended` by autoplay policy,
   * where it pulls no audio at all. Nothing can be done about that from script — so the next
   * click or keystroke anywhere on the page is borrowed to release it.
   */
  let resumeArmed = false
  function armResumeOnGesture(): void {
    if (resumeArmed || !engineStatus.suspended) return
    resumeArmed = true
    const release = () => {
      window.removeEventListener('pointerdown', release, true)
      window.removeEventListener('keydown', release, true)
      resumeArmed = false
      // Not every event grants activation. If the context is still parked, wait for one that
      // does rather than giving up after the first try.
      void engine.resume().then((running) => {
        if (!running) armResumeOnGesture()
      })
    }
    window.addEventListener('pointerdown', release, true)
    window.addEventListener('keydown', release, true)
    overlay.notify('Audio is held by the browser until you click or press a key')
  }

  engine.onSourceEnded = () => {
    analyzer.attach(null)
    renderer.invalidate()
    attachMeters(null)
    overlay.notify(engine.status.message || 'Capture device disconnected')
    void engine.listInputs().then((devices) => overlay.setDevices(devices))
  }

  // Hardware arriving or leaving. The same event covers both, and `canAutoStart` decides:
  // if the configured device is the one that just appeared, capture picks up on its own.
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    void (async () => {
      overlay.setDevices(await engine.listInputs())
      await autoStartIfBound()
    })()
  })

  // Re-open when the capture settings themselves change — a different device, rate or channel
  // count is a different capture, and the old one is no longer what the panel is describing.
  function sourceSettingsSignature(): string {
    const s = config.source
    // Only the discrete choices. The generator's frequency and amplitude are sliders, and
    // re-opening the AudioContext on every tick of a drag would be a very expensive way to
    // change a number; those take effect on the next start, like they always have.
    return `${s.kind}|${s.deviceId}|${s.sampleRate}|${s.channels}|${s.generator.kind}`
  }

  let sourceSignature = sourceSettingsSignature()
  let sourceEditTimer = 0

  function reactToSourceEdit(): void {
    const signature = sourceSettingsSignature()
    if (signature === sourceSignature) return
    sourceSignature = signature
    if (config.source.kind === 'file' && !pendingFile) return
    // Coalesce: switching device and rate in quick succession should open the device once.
    window.clearTimeout(sourceEditTimer)
    sourceEditTimer = window.setTimeout(() => {
      void (async () => {
        if (engineStatus.running) await startSource()
        else await autoStartIfBound()
      })()
    }, 150)
  }

  // ------------------------------------------------------------------ overlay
  let fps = 60
  let analysisFps = 0
  let lastStats = {
    frames: 0,
    dropped: 0,
    lapped: 0,
    head: 0,
    sampleRate: 48000,
    binCount: 0,
    hopHz: 0,
    pointCount: 0,
  }

  function currentStatus(): OverlayStatus {
    const tables = windowTablesFor(config)
    return {
      fps,
      analysisFps,
      frames: lastStats.frames,
      dropped: lastStats.dropped,
      lapped: lastStats.lapped,
      pitchHz: analyzer.timebase[3],
      clarity: analyzer.timebase[2],
      loudness,
      engine: { ...engineStatus, message: sourceError || engineStatus.message },
      crossOriginIsolated: Boolean(globalThis.crossOriginIsolated),
      binHz: (engineStatus.sampleRate || 48000) / config.analysis.fftSize,
      enbwHz: (tables.nenbw * (engineStatus.sampleRate || 48000)) / config.analysis.fftSize,
      latencyMs: (engineStatus.baseLatencySec + engineStatus.outputLatencySec) * 1000,
    }
  }

  // The overlay quotes the window's measured ENBW; caching keeps that off the per-frame path.
  let cachedTablesKey = ''
  let cachedTables = buildWindowTables('hann', 1024, 0)
  function windowTablesFor(cfg: Config) {
    const key = `${cfg.analysis.window}|${cfg.analysis.fftSize}|${cfg.analysis.windowParam}`
    if (key !== cachedTablesKey) {
      cachedTables = buildWindowTables(
        cfg.analysis.window,
        cfg.analysis.fftSize,
        cfg.analysis.windowParam,
      )
      cachedTablesKey = key
    }
    return cachedTables
  }

  let saveTimer = 0
  const scheduleSave = () => {
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => saveConfig(config), 400)
  }

  const overlay = new Overlay(uiRoot, {
    config,
    gpuInfo: gpu.info,
    onChange: () => {
      engine.setMonitorGain(config.source.monitorGain)
      reactToSourceEdit()
      scheduleSave()
    },
    onRestartSource: () => void startSource(),
    onStopSource: () => void stopSource(),
    onResetMeters: () => postMeters({ type: 'reset' }),
    onPickFile: () => filePicker.click(),
    onSelfTest: async () => {
      overlay.setSelfTestResult('running…')
      try {
        const result = await analyzer.selfTest(4096)
        const text = `max ${(result.maxError * 100).toFixed(6)}% · rms ${(result.rmsError * 100).toFixed(6)}% of peak`
        overlay.setSelfTestResult(text)
        return text
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        overlay.setSelfTestResult(`failed: ${text}`)
        return text
      }
    },
    status: currentStatus,
  })

  void engine.listInputs().then((devices) => overlay.setDevices(devices))
  // Open the input straight away if the browser already trusts us with one.
  void autoStartIfBound()

  // ------------------------------------------------------------------ input
  const keyActions: KeyActions = {
    togglePanel: () => overlay.toggle(),
    toggleFullscreen: () => void overlay.toggleFullscreen(),
    toggleHelp: () => overlay.toggleHelp(),
    cycleTab: (dir) => overlay.cycleTab(dir),
    cycleTheme: (dir) => overlay.cycleTheme(dir),
    restartSource: () => void startSource(),
    stopSource: () => void stopSource(),
    resetMeters: () => postMeters({ type: 'reset' }),
    notify: (text) => overlay.notify(text),
    changed: (structural) => {
      scheduleSave()
      // Non-structural changes are picked up by the panel's per-frame refresh; a structural one
      // can add or remove controls, so the tab has to be rebuilt.
      if (structural && overlay.isVisible) overlay.rebuild()
    },
  }

  window.addEventListener('keydown', (event) => {
    // The modal reference owns the keyboard while it is up, including Escape, which the dialog
    // element handles itself.
    if (overlay.isHelpOpen) return

    const target = event.target as HTMLElement | null
    if (target) {
      const tag = target.tagName
      // A focused field owns its keys — a slider must keep the arrows, a text box its letters.
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag) || target.isContentEditable) {
        if (event.key === 'Escape') target.blur()
        return
      }
      // Space and Enter activate a focused button; anything else is fair game.
      if (tag === 'BUTTON' && (event.key === ' ' || event.key === 'Enter')) return
    }

    if (dispatchKey(event, { config, actions: keyActions })) event.preventDefault()
  })

  // ------------------------------------------------------------------ sizing
  let cssWidth = 1
  let cssHeight = 1
  let pixelWidth = 1
  let pixelHeight = 1

  function resize(): void {
    const rect = canvas.getBoundingClientRect()
    cssWidth = Math.max(1, rect.width)
    cssHeight = Math.max(1, rect.height)
    const scale = Math.max(0.25, Math.min(2, config.perf.resolutionScale))
    const dpr = Math.min(window.devicePixelRatio || 1, 3) * scale
    const maxDim = device.limits.maxTextureDimension2D
    pixelWidth = Math.max(1, Math.min(maxDim, Math.round(cssWidth * dpr)))
    pixelHeight = Math.max(1, Math.min(maxDim, Math.round(cssHeight * dpr)))
    canvas.width = pixelWidth
    canvas.height = pixelHeight
  }

  new ResizeObserver(resize).observe(canvas)
  window.addEventListener('resize', resize)
  resize()

  // ------------------------------------------------------------------ frame loop
  let lastFrameTime = performance.now()
  let lastMeterPump = 0

  let msaaSetting = config.perf.msaa
  let scaleSetting = config.perf.resolutionScale
  let analysisFrameAccum = 0
  let analysisWindowStart = performance.now()

  function frame(now: number): void {
    requestAnimationFrame(frame)
    draw(now)
  }

  /** One frame's work, with no scheduling in it, so it can also be stepped by hand. */
  function draw(now: number): void {
    const dt = now - lastFrameTime
    lastFrameTime = now
    if (dt > 0) fps += (1000 / dt - fps) * 0.08

    if (config.perf.msaa !== msaaSetting) {
      msaaSetting = config.perf.msaa
      renderer = new Renderer(device, gpu.context, gpu.format, analyzer, msaaSetting ? 4 : 1)
    }
    if (config.perf.resolutionScale !== scaleSetting) {
      scaleSetting = config.perf.resolutionScale
      resize()
    }

    if (meterReader && now - lastMeterPump > 60) {
      lastMeterPump = now
      pumpMetersFallback()
    }
    // Request every frame rather than on a timer: it is a 16-byte async copy that self-limits
    // to one in flight, and throttling it makes the axis labels visibly lag the trace for a
    // moment after the timebase changes.
    analyzer.requestTimebaseReadback()

    const sampleRate = engineStatus.sampleRate || analyzer.sampleRate || 48000
    const nyquist = sampleRate / 2
    // Stereo analysis of a mono capture is two identical lanes. Collapse to one so a mono
    // source draws a single centred trace — and costs half the transforms while it is at it.
    const requested = channelMix(config.analysis.channelMode)
    const mix = requested.mix
    const count = analyzer.ringChannels === 1 ? 1 : requested.count

    // All four panes are on screen, so what the analyzer computes is decided by which of them
    // still has room to be drawn in rather than by a mode. Collapsing a pane to nothing is what
    // switches its part of the pipeline off — the FFT chain stops running when neither spectral
    // pane is open, and the envelope reduction stops when the oscilloscope is closed.
    const panes = computePanePair(config.split, cssWidth, cssHeight, pixelWidth, pixelHeight)
    const open = (mode: Mode) => panes.some((p) => p.visible && p.css.mode === mode)
    const wavePane = panes.find((p) => p.css.mode === 'wave')
    const spectrumPane = panes.find((p) => p.css.mode === 'spectrum')
    const spectral = open('spectrum') || open('spectrogram')

    // The fixed span is what the trigger falls back to; when pitch-locked and confident, the
    // GPU replaces it with an exact number of detected periods.
    const spanSamples = (config.wave.timebaseMs / 1000) * sampleRate

    const encoder = device.createCommandEncoder({ label: 'frame' })
    const stats = analyzer.record(encoder, {
      settings: {
        fftSize: config.analysis.fftSize,
        window: config.analysis.window,
        windowParam: config.analysis.windowParam,
        hop: config.analysis.hop,
        mix,
        channelCount: count,
        reassign: config.analysis.reassign,
        maxTimeShift: config.analysis.maxTimeShift,
        maxFreqShiftBins: config.analysis.maxFreqShiftBins,
        averaging: config.analysis.averaging,
        peakDecayDbPerSecond: config.analysis.peakDecayDbPerSecond,
        floorDb: config.analysis.floorDb,
        scale: config.analysis.scale,
        displayChannel: 0,
      },
      trigger: {
        mode: config.wave.trigger,
        level: config.wave.triggerLevel,
        edge: config.wave.triggerEdge,
        cycles: config.wave.cycles,
        clarityThreshold: config.wave.clarityThreshold,
        pitchMinHz: config.wave.pitchMinHz,
        pitchMaxHz: config.wave.pitchMaxHz,
        spanSamples,
      },
      axis: {
        columns: open('spectrum') ? Math.min(4096, spectrumPane!.device.width) : 0,
        logFrequency: config.spectrum.logFrequency,
        freqMin: config.spectrum.freqMin,
        freqMax: Math.min(config.spectrum.freqMax, nyquist),
        source: config.spectrum.source,
      },
      waveColumns: open('wave') ? Math.min(4096, wavePane!.device.width) : 0,
      maxFramesPerRender: config.perf.maxFramesPerRender,
      spectral,
    })
    lastStats = stats

    analysisFrameAccum += stats.frames
    const window = now - analysisWindowStart
    if (window > 500) {
      // A gap far longer than the averaging window means the page was not being painted at
      // all (a background tab throttles rAF). Reporting frames-per-second across that gap
      // would show a number that says nothing about the pipeline, so restart the average.
      analysisFps = window > 2000 ? analysisFps : (analysisFrameAccum * 1000) / window
      analysisFrameAccum = 0
      analysisWindowStart = now
    }

    // The waveform's displayed span comes from the GPU-resolved timebase, so its graticule
    // agrees with the trace even when the pitch lock has changed the window under it.
    const waveSeconds = analyzer.timebase[1] / sampleRate || config.wave.timebaseMs / 1000
    const visible = panes.filter((p) => p.visible)
    const graticules = visible.map((pane) => {
      const seconds = pane.css.mode === 'wave' ? waveSeconds : config.wave.timebaseMs / 1000
      return { pane, seconds, graticule: buildGraticule(pane.css.mode, config, seconds, nyquist) }
    })

    renderer.render(encoder, {
      config,
      stats,
      panes: graticules.map(({ pane, seconds, graticule }) => ({
        mode: pane.device.mode,
        slot: pane.device.index,
        rect: pane.device,
        graticule: graticule.lines,
        shownSeconds: seconds,
      })),
      width: pixelWidth,
      height: pixelHeight,
      nyquist,
      channelCount: count,
    })
    device.queue.submit([encoder.finish()])

    overlay.setPanes(
      panes.map((p) => p.css),
      graticules.map(({ pane, graticule }) => ({ pane: pane.css, ticks: graticule.ticks })),
    )
    overlay.update()
  }

  if (import.meta.env.DEV) {
    // Dev-only inspection handle. Everything the render loop touches is reachable from here,
    // which makes it possible to check GPU-resolved state from the console without adding
    // logging to the hot path.
    Object.assign(globalThis as Record<string, unknown>, {
      waveshape: {
        config,
        engine,
        analyzer,
        gpu,
        overlay,
        // Draws one frame on demand. The loop is driven by requestAnimationFrame, which a
        // hidden tab never fires, so this is the only way to inspect a rendered frame from a
        // window that is not on screen.
        step: () => draw(performance.now()),
        get renderer() { return renderer },
        get stats() { return lastStats },
      },
    })
  }

  requestAnimationFrame(frame)
}

void main().catch((error) => {
  console.error(error)
  showBlocker('Startup failed', [
    error instanceof Error ? error.message : String(error),
    'Check the browser console for the full stack.',
  ])
})
