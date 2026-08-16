/**
 * The control overlay: a tabbed panel that floats over the canvas, plus the always-on readout
 * and the axis labels.
 *
 * The canvas is never resized or inset to make room for chrome — the waveform owns the whole
 * viewport and the panel sits on top of it, dismissable with a single key. Text lives in the
 * DOM rather than in the render pipeline so it stays crisp at any scale factor, is selectable,
 * and is reachable by assistive technology.
 */

import {
  DEFAULT_CONFIG,
  FFT_SIZES,
  SAMPLE_RATES,
  STYLE_PRESETS,
  type Config,
  type Mode,
} from '../config.ts'
import { WINDOWS, windowSpec } from '../dsp/windows.ts'
import { PALETTES } from '../gpu/colormap.ts'
import type { AudioDeviceInfo, EngineStatus } from '../audio/engine.ts'
import type { GpuInfo } from '../gpu/device.ts'
import type { LoudnessReading } from '../dsp/loudness.ts'
import type { AxisTick } from './axes.ts'
import { fmt, renderControls, type Control } from './widgets.ts'

const MODES: { id: Mode; label: string; key: string }[] = [
  { id: 'wave', label: 'Waveform', key: '1' },
  { id: 'spectrum', label: 'Spectrum', key: '2' },
  { id: 'spectrogram', label: 'Spectrogram', key: '3' },
  { id: 'vector', label: 'Vectorscope', key: '4' },
]

const TABS = [
  'Source',
  'Analysis',
  'Waveform',
  'Spectrum',
  'Spectrogram',
  'Meters',
  'Appearance',
  'System',
] as const
type Tab = (typeof TABS)[number]

export interface OverlayStatus {
  fps: number
  analysisFps: number
  frames: number
  dropped: number
  lapped: number
  pitchHz: number
  clarity: number
  loudness: LoudnessReading | null
  engine: EngineStatus
  crossOriginIsolated: boolean
  binHz: number
  enbwHz: number
  latencyMs: number
}

export interface OverlayDeps {
  config: Config
  gpuInfo: GpuInfo
  onChange: () => void
  onRestartSource: () => void
  onStopSource: () => void
  onResetMeters: () => void
  onSelfTest: () => Promise<string>
  onPickFile: () => void
  status: () => OverlayStatus
}

export class Overlay {
  private readonly root: HTMLElement
  private readonly deps: OverlayDeps
  private readonly panel: HTMLElement
  private readonly body: HTMLElement
  private readonly tabBar: HTMLElement
  private readonly modeBar: HTMLElement
  private readonly readout: HTMLElement
  private readonly labelLayer: HTMLElement
  private readonly toast: HTMLElement

  private tab: Tab = 'Source'
  private refreshControls: () => void = () => {}
  private devices: AudioDeviceInfo[] = []
  private visible = true
  private selfTestResult = ''
  private labelPool: HTMLElement[] = []

  constructor(root: HTMLElement, deps: OverlayDeps) {
    this.root = root
    this.deps = deps

    this.labelLayer = document.createElement('div')
    this.labelLayer.className = 'ws-labels'

    this.modeBar = document.createElement('div')
    this.modeBar.className = 'ws-modes'

    this.tabBar = document.createElement('div')
    this.tabBar.className = 'ws-tabs'
    this.tabBar.setAttribute('role', 'tablist')

    this.body = document.createElement('div')
    this.body.className = 'ws-body'

    this.panel = document.createElement('section')
    this.panel.className = 'ws-panel'
    this.panel.setAttribute('aria-label', 'Analyzer controls')

    const header = document.createElement('header')
    header.className = 'ws-header'
    const title = document.createElement('div')
    title.className = 'ws-title'
    title.innerHTML = '<strong>Waveshape</strong><span>WebGPU spectral analyzer</span>'
    const hide = document.createElement('button')
    hide.type = 'button'
    hide.className = 'ws-close'
    hide.textContent = 'Hide  ·  esc'
    hide.addEventListener('click', () => this.setVisible(false))
    header.append(title, hide)

    this.panel.append(header, this.modeBar, this.tabBar, this.body)

    this.readout = document.createElement('div')
    this.readout.className = 'ws-readout'

    this.toast = document.createElement('div')
    this.toast.className = 'ws-toast'
    this.toast.textContent = 'press space, esc or h for controls'

    this.root.append(this.labelLayer, this.panel, this.readout, this.toast)

    this.buildModeBar()
    this.buildTabBar()
    this.rebuild()
  }

  get isVisible(): boolean {
    return this.visible
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.panel.classList.toggle('ws-hidden', !visible)
    if (!visible) {
      this.toast.classList.add('ws-toast-show')
      window.setTimeout(() => this.toast.classList.remove('ws-toast-show'), 1600)
    }
  }

  toggle(): void {
    this.setVisible(!this.visible)
  }

  setDevices(devices: AudioDeviceInfo[]): void {
    this.devices = devices
    if (this.tab === 'Source') this.rebuild()
  }

  setSelfTestResult(text: string): void {
    this.selfTestResult = text
    if (this.tab === 'System') this.rebuild()
  }

  private buildModeBar(): void {
    this.modeBar.replaceChildren()
    for (const mode of MODES) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'ws-mode'
      button.dataset.mode = mode.id
      button.innerHTML = `${mode.label}<kbd>${mode.key}</kbd>`
      button.addEventListener('click', () => {
        this.deps.config.mode = mode.id
        this.deps.onChange()
        this.syncModeBar()
        this.rebuild()
      })
      this.modeBar.append(button)
    }
    this.syncModeBar()
  }

  private syncModeBar(): void {
    for (const child of Array.from(this.modeBar.children)) {
      const button = child as HTMLElement
      button.classList.toggle('ws-active', button.dataset.mode === this.deps.config.mode)
    }
  }

  private buildTabBar(): void {
    this.tabBar.replaceChildren()
    for (const tab of TABS) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'ws-tab'
      button.textContent = tab
      button.setAttribute('role', 'tab')
      button.addEventListener('click', () => {
        this.tab = tab
        this.syncTabBar()
        this.rebuild()
      })
      this.tabBar.append(button)
    }
    this.syncTabBar()
  }

  private syncTabBar(): void {
    const buttons = Array.from(this.tabBar.children) as HTMLElement[]
    for (const button of buttons) {
      const active = button.textContent === this.tab
      button.classList.toggle('ws-active', active)
      button.setAttribute('aria-selected', String(active))
    }
  }

  /** Rebuilds the active tab's controls. Called on tab change and on structural config change. */
  rebuild(): void {
    this.syncModeBar()
    const scroll = this.body.scrollTop
    this.refreshControls = renderControls(this.body, this.controlsFor(this.tab), (structural) => {
      this.deps.onChange()
      this.syncModeBar()
      if (structural) {
        // A discrete choice can change which controls exist — switching the source from a
        // device to the generator adds a whole block of settings — so the panel is rebuilt
        // rather than merely refreshed.
        this.rebuild()
      } else {
        this.refreshControls()
      }
    })
    this.body.scrollTop = scroll
  }

  /** Cheap per-frame update of live values without rebuilding DOM. */
  update(): void {
    const s = this.deps.status()
    if (this.deps.config.style.showReadout) {
      this.readout.classList.remove('ws-hidden')
      this.readout.replaceChildren(...this.readoutItems(s))
    } else {
      this.readout.classList.add('ws-hidden')
    }
    if (this.visible) this.refreshControls()
  }

  private readoutItems(s: OverlayStatus): HTMLElement[] {
    const items: [string, string][] = []
    const e = s.engine
    items.push(['src', e.running ? e.sourceLabel.slice(0, 28) : 'stopped'])
    items.push(['rate', e.sampleRate ? `${(e.sampleRate / 1000).toFixed(1)} kHz` : '—'])
    items.push(['fft', `${this.deps.config.analysis.fftSize}`])
    items.push(['Δf', `${s.binHz.toFixed(2)} Hz`])
    items.push(['enbw', `${s.enbwHz.toFixed(2)} Hz`])
    items.push(['rate/s', `${s.analysisFps.toFixed(0)}`])
    if (this.deps.config.mode === 'wave' && s.pitchHz > 0) {
      items.push(['pitch', `${s.pitchHz.toFixed(2)} Hz`])
      items.push(['clarity', s.clarity.toFixed(2)])
    }
    const l = s.loudness
    if (l) {
      const num = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '−∞')
      items.push(['M', num(l.momentary)])
      items.push(['S', num(l.shortTerm)])
      items.push(['I', num(l.integrated)])
      items.push(['LRA', l.range.toFixed(1)])
      items.push(['dBTP', num(l.truePeakDb)])
      items.push(['corr', l.correlation.toFixed(2)])
    }
    items.push(['fps', s.fps.toFixed(0)])
    if (s.dropped > 0) items.push(['dropped', String(s.dropped)])

    return items.map(([k, v]) => {
      const node = document.createElement('span')
      node.className = 'ws-stat'
      node.innerHTML = `<em>${k}</em>${v}`
      return node
    })
  }

  /** Positions the axis tick labels over the canvas. */
  setTicks(ticks: AxisTick[], width: number, height: number): void {
    while (this.labelPool.length < ticks.length) {
      const node = document.createElement('span')
      node.className = 'ws-tick'
      this.labelLayer.append(node)
      this.labelPool.push(node)
    }
    for (let i = 0; i < this.labelPool.length; i++) {
      const node = this.labelPool[i]
      const tick = ticks[i]
      if (!tick || !this.deps.config.style.showLabels) {
        node.style.display = 'none'
        continue
      }
      node.style.display = ''
      node.textContent = tick.label
      // Labels are nudged away from the edges so the outermost tick is not half-clipped, and
      // the time axis sits clear of the readout bar along the bottom.
      const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
      if (tick.horizontal) {
        node.style.left = '6px'
        node.style.top = `${clamp(tick.pos * height, 9, height - 46)}px`
        node.dataset.axis = 'y'
      } else {
        node.style.left = `${clamp(tick.pos * width, 18, width - 18)}px`
        node.style.top = `${height - 44}px`
        node.dataset.axis = 'x'
      }
    }
  }

  // -------------------------------------------------------------------------------------
  // Tab contents
  // -------------------------------------------------------------------------------------

  private controlsFor(tab: Tab): Control[] {
    const c = this.deps.config
    switch (tab) {
      case 'Source':
        return this.sourceControls(c)
      case 'Analysis':
        return this.analysisControls(c)
      case 'Waveform':
        return this.waveControls(c)
      case 'Spectrum':
        return this.spectrumControls(c)
      case 'Spectrogram':
        return this.spectrogramControls(c)
      case 'Meters':
        return this.meterControls(c)
      case 'Appearance':
        return this.appearanceControls(c)
      case 'System':
        return this.systemControls(c)
    }
  }

  private sourceControls(c: Config): Control[] {
    const s = c.source
    const list: Control[] = [
      { kind: 'heading', text: 'Input' },
      {
        kind: 'select',
        label: 'Source',
        options: [
          { value: 'microphone', label: 'Audio input device' },
          { value: 'display', label: 'Tab / system audio' },
          { value: 'file', label: 'Audio file' },
          { value: 'generator', label: 'Test signal generator' },
        ],
        get: () => s.kind,
        set: (v) => {
          s.kind = v as Config['source']['kind']
        },
      },
    ]

    if (s.kind === 'microphone') {
      list.push({
        kind: 'select',
        label: 'Device',
        options: [
          { value: '', label: 'System default' },
          ...this.devices.map((d) => ({ value: d.deviceId, label: d.label })),
        ],
        get: () => s.deviceId,
        set: (v) => {
          s.deviceId = v
        },
        hint: this.devices.length
          ? undefined
          : 'Device names appear once microphone permission has been granted.',
      })
    }

    if (s.kind === 'file') {
      list.push({
        kind: 'button',
        label: 'Choose file…',
        action: 'pick-file',
        onClick: () => this.deps.onPickFile(),
        hint: 'Decoded audio plays looped at the current AudioContext rate.',
      })
    }

    if (s.kind === 'generator') {
      const g = s.generator
      list.push(
        {
          kind: 'select',
          label: 'Signal',
          options: [
            { value: 'sine', label: 'Sine' },
            { value: 'square', label: 'Square' },
            { value: 'sawtooth', label: 'Sawtooth' },
            { value: 'sweep', label: 'Log sweep' },
            { value: 'white', label: 'White noise' },
            { value: 'pink', label: 'Pink noise' },
            { value: 'impulse', label: 'Impulse train' },
          ],
          get: () => g.kind,
          set: (v) => {
            g.kind = v as typeof g.kind
          },
        },
        {
          kind: 'slider',
          label: 'Frequency',
          min: 10,
          max: 20000,
          step: 0.01,
          curve: 'log',
          get: () => g.frequency,
          set: (v) => {
            g.frequency = v
          },
          format: fmt.hz,
        },
        {
          kind: 'slider',
          label: 'Amplitude',
          min: 0,
          max: 1,
          step: 0.001,
          get: () => g.amplitude,
          set: (v) => {
            g.amplitude = v
          },
          format: fmt.pct,
        },
      )
      if (g.kind === 'sweep') {
        list.push(
          {
            kind: 'slider',
            label: 'Sweep start',
            min: 5,
            max: 2000,
            step: 1,
            curve: 'log',
            get: () => g.sweepStart,
            set: (v) => {
              g.sweepStart = v
            },
            format: fmt.hz,
          },
          {
            kind: 'slider',
            label: 'Sweep end',
            min: 1000,
            max: 96000,
            step: 1,
            curve: 'log',
            get: () => g.sweepEnd,
            set: (v) => {
              g.sweepEnd = v
            },
            format: fmt.hz,
          },
          {
            kind: 'slider',
            label: 'Sweep time',
            min: 1,
            max: 60,
            step: 0.5,
            get: () => g.sweepSeconds,
            set: (v) => {
              g.sweepSeconds = v
            },
            format: (v) => `${v.toFixed(1)} s`,
          },
        )
      }
    }

    list.push(
      { kind: 'heading', text: 'Capture' },
      {
        kind: 'select',
        label: 'Sample rate',
        options: SAMPLE_RATES.map((r) => ({
          value: String(r),
          label: r === 'native' ? 'Device native' : `${(r / 1000).toFixed(1)} kHz`,
        })),
        get: () => String(s.sampleRate),
        set: (v) => {
          s.sampleRate = v === 'native' ? 'native' : Number(v)
        },
        hint: 'The AudioContext is opened at the rate the device reports, so nothing is resampled behind your back. Requesting a rate the hardware cannot do will fall back.',
      },
      {
        kind: 'select',
        label: 'Channels',
        options: [
          { value: '1', label: 'Mono' },
          { value: '2', label: 'Stereo' },
        ],
        get: () => String(s.channels),
        set: (v) => {
          s.channels = Number(v)
        },
      },
      {
        kind: 'note',
        text: 'Echo cancellation, noise suppression and automatic gain control are all disabled on the captured track. Chrome enables all three by default and AGC alone makes level measurement meaningless.',
      },
      {
        kind: 'row',
        children: [
          {
            kind: 'button',
            label: 'Start / restart capture',
            action: 'restart',
            onClick: () => this.deps.onRestartSource(),
          },
          {
            kind: 'button',
            label: 'Stop',
            action: 'stop',
            onClick: () => this.deps.onStopSource(),
          },
        ],
      },
      {
        kind: 'slider',
        label: 'Monitor to output',
        min: 0,
        max: 1,
        step: 0.01,
        get: () => s.monitorGain,
        set: (v) => {
          s.monitorGain = v
        },
        format: fmt.pct,
        hint: 'Off by default. A live microphone routed to the speakers is a feedback loop.',
      },
    )
    return list
  }

  private analysisControls(c: Config): Control[] {
    const a = c.analysis
    const spec = windowSpec(a.window)
    const status = this.deps.status()
    return [
      { kind: 'heading', text: 'Transform' },
      {
        kind: 'select',
        label: 'FFT size',
        options: FFT_SIZES.map((n) => ({ value: String(n), label: String(n) })),
        get: () => String(a.fftSize),
        set: (v) => {
          a.fftSize = Number(v)
        },
        hint: `Bin spacing ${status.binHz.toFixed(3)} Hz. Larger transforms resolve closer partials but smear transients over a longer window.`,
      },
      {
        kind: 'select',
        label: 'Window',
        options: WINDOWS.map((w) => ({ value: w.id, label: w.label })),
        get: () => a.window,
        set: (v) => {
          a.window = v as typeof a.window
        },
        hint: `${spec.note} Sidelobes ${spec.sidelobeDb} dB, rolloff ${spec.rolloffDbPerOctave} dB/oct, ENBW ${status.enbwHz.toFixed(2)} Hz.`,
      },
      ...(spec.parametric
        ? [
            {
              kind: 'slider' as const,
              label: spec.paramLabel ?? 'Shape',
              min: spec.paramMin ?? 0,
              max: spec.paramMax ?? 1,
              step: 0.1,
              get: () => a.windowParam,
              set: (v: number) => {
                a.windowParam = v
              },
              format: fmt.fixed(2),
            },
          ]
        : []),
      {
        kind: 'slider',
        label: 'Hop size',
        min: 32,
        max: 8192,
        step: 1,
        curve: 'log',
        get: () => a.hop,
        set: (v) => {
          a.hop = Math.max(32, 1 << Math.round(Math.log2(v)))
        },
        format: (v) => `${v} smp  ·  ${(status.engine.sampleRate / v || 0).toFixed(0)} fps`,
        hint: `Samples between analysis windows — this sets the true analysis rate, independent of the display refresh. Recommended overlap for this window is ${spec.optimalOverlapPct}%.`,
      },
      {
        kind: 'select',
        label: 'Channels analysed',
        options: [
          { value: 'stereo', label: 'Stereo (L and R)' },
          { value: 'left', label: 'Left only' },
          { value: 'right', label: 'Right only' },
          { value: 'mid', label: 'Mid (L+R)' },
          { value: 'side', label: 'Side (L−R)' },
          { value: 'mono', label: 'Mono downmix' },
        ],
        get: () => a.channelMode,
        set: (v) => {
          a.channelMode = v as typeof a.channelMode
        },
      },
      {
        kind: 'select',
        label: 'Magnitude scale',
        options: [
          { value: 'amplitude', label: 'Amplitude (dBFS peak)' },
          { value: 'density', label: 'Power spectral density (dBFS/√Hz)' },
        ],
        get: () => a.scale,
        set: (v) => {
          a.scale = v as typeof a.scale
        },
        hint: 'Amplitude reads a sine correctly regardless of FFT size; density reads noise correctly regardless of FFT size. They cannot both be right at once.',
      },
      { kind: 'heading', text: 'Reassignment' },
      {
        kind: 'toggle',
        label: 'Time-frequency reassignment',
        get: () => a.reassign,
        set: (v) => {
          a.reassign = v
        },
        hint: 'Relocates each bin to the centre of gravity of the energy it represents, computed from the phase derivative. Sharpens the spectrogram far beyond the window’s nominal resolution. Costs two extra transforms per frame.',
      },
      {
        kind: 'slider',
        label: 'Max time correction',
        min: 0.05,
        max: 0.5,
        step: 0.01,
        get: () => a.maxTimeShift,
        set: (v) => {
          a.maxTimeShift = v
        },
        format: (v) => `${(v * 100).toFixed(0)}% of window`,
        disabled: () => !a.reassign,
        hint: 'Corrections larger than this are discarded. A large displacement means the bin sat in a spectral null where the phase derivative is noise.',
      },
      {
        kind: 'slider',
        label: 'Max frequency correction',
        min: 0.5,
        max: 16,
        step: 0.5,
        get: () => a.maxFreqShiftBins,
        set: (v) => {
          a.maxFreqShiftBins = v
        },
        format: (v) => `${v} bins`,
        disabled: () => !a.reassign,
      },
      { kind: 'heading', text: 'Integration' },
      {
        kind: 'slider',
        label: 'Averaging',
        min: 0,
        max: 5,
        step: 0.05,
        get: () => a.averaging,
        set: (v) => {
          a.averaging = v
        },
        format: (v) => (v <= 0 ? 'off' : `${v.toFixed(2)} s`),
        hint: 'Exponential power averaging across analysis frames (Welch). Trades time resolution for a lower-variance estimate — essential when reading a noise floor.',
      },
      {
        kind: 'slider',
        label: 'Peak hold fall',
        min: 0,
        max: 60,
        step: 0.5,
        get: () => a.peakDecayDbPerSecond,
        set: (v) => {
          a.peakDecayDbPerSecond = v
        },
        format: (v) => (v <= 0 ? 'infinite hold' : `${v.toFixed(1)} dB/s`),
      },
      {
        kind: 'slider',
        label: 'Noise floor clamp',
        min: -200,
        max: -60,
        step: 1,
        get: () => a.floorDb,
        set: (v) => {
          a.floorDb = v
        },
        format: fmt.db,
      },
    ]
  }

  private waveControls(c: Config): Control[] {
    const w = c.wave
    return [
      { kind: 'heading', text: 'Timebase' },
      {
        kind: 'slider',
        label: 'Time span',
        min: 0.05,
        max: 5000,
        step: 0.01,
        curve: 'log',
        get: () => w.timebaseMs,
        set: (v) => {
          w.timebaseMs = v
        },
        format: fmt.ms,
        disabled: () => w.trigger === 'pitch',
        hint: 'Ignored while pitch-locked, where the span is derived from the detected period.',
      },
      {
        kind: 'select',
        label: 'Trigger',
        options: [
          { value: 'pitch', label: 'Pitch-locked (NSDF)' },
          { value: 'level', label: 'Level' },
          { value: 'free', label: 'Free run' },
        ],
        get: () => w.trigger,
        set: (v) => {
          w.trigger = v as typeof w.trigger
        },
        hint: 'Pitch lock estimates the period with the McLeod Pitch Method and locks the sweep to it, so a harmonically rich waveform stands still where a level trigger would jitter between crossings.',
      },
      {
        kind: 'slider',
        label: 'Cycles shown',
        min: 0.25,
        max: 32,
        step: 0.25,
        get: () => w.cycles,
        set: (v) => {
          w.cycles = v
        },
        format: (v) => `${v} periods`,
        disabled: () => w.trigger !== 'pitch',
      },
      {
        kind: 'slider',
        label: 'Clarity threshold',
        min: 0,
        max: 1,
        step: 0.01,
        get: () => w.clarityThreshold,
        set: (v) => {
          w.clarityThreshold = v
        },
        format: fmt.fixed(2),
        disabled: () => w.trigger !== 'pitch',
        hint: 'How periodic the signal must be before the pitch lock is trusted. Below this the display falls back to the fixed time span.',
      },
      {
        kind: 'row',
        children: [
          {
            kind: 'slider',
            label: 'Pitch range low',
            min: 10,
            max: 500,
            step: 1,
            curve: 'log',
            get: () => w.pitchMinHz,
            set: (v) => {
              w.pitchMinHz = v
            },
            format: fmt.hz,
            disabled: () => w.trigger !== 'pitch',
          },
          {
            kind: 'slider',
            label: 'Pitch range high',
            min: 200,
            max: 8000,
            step: 1,
            curve: 'log',
            get: () => w.pitchMaxHz,
            set: (v) => {
              w.pitchMaxHz = v
            },
            format: fmt.hz,
            disabled: () => w.trigger !== 'pitch',
          },
        ],
      },
      {
        kind: 'slider',
        label: 'Trigger level',
        min: -1,
        max: 1,
        step: 0.001,
        get: () => w.triggerLevel,
        set: (v) => {
          w.triggerLevel = v
        },
        format: fmt.fixed(3),
        disabled: () => w.trigger === 'free',
      },
      {
        kind: 'select',
        label: 'Trigger edge',
        options: [
          { value: '1', label: 'Rising' },
          { value: '-1', label: 'Falling' },
        ],
        get: () => String(w.triggerEdge),
        set: (v) => {
          w.triggerEdge = Number(v) as 1 | -1
        },
        disabled: () => w.trigger === 'free',
      },
      { kind: 'heading', text: 'Trace' },
      {
        kind: 'select',
        label: 'Reconstruction',
        options: [
          { value: 'auto', label: 'Automatic' },
          { value: 'envelope', label: 'Min/max envelope' },
          { value: 'bandlimited', label: 'Band-limited (sinc)' },
        ],
        get: () => w.trace,
        set: (v) => {
          w.trace = v as typeof w.trace
        },
        hint: 'Zoomed out, each pixel column shows the true min/max of every sample it covers. Zoomed in, the trace is the Whittaker-Shannon interpolant — the actual band-limited waveform, complete with inter-sample overshoot.',
      },
      {
        kind: 'slider',
        label: 'Vertical gain',
        min: 0.05,
        max: 64,
        step: 0.01,
        curve: 'log',
        get: () => w.gain,
        set: (v) => {
          w.gain = v
        },
        format: (v) => `${v.toFixed(2)}×  (${(20 * Math.log10(v)).toFixed(1)} dB)`,
      },
      {
        kind: 'toggle',
        label: 'Show RMS band',
        get: () => w.showRms,
        set: (v) => {
          w.showRms = v
        },
      },
      {
        kind: 'toggle',
        label: 'Split channels into lanes',
        get: () => w.splitChannels,
        set: (v) => {
          w.splitChannels = v
        },
      },
    ]
  }

  private spectrumControls(c: Config): Control[] {
    const s = c.spectrum
    return [
      { kind: 'heading', text: 'Frequency axis' },
      {
        kind: 'toggle',
        label: 'Logarithmic frequency',
        get: () => s.logFrequency,
        set: (v) => {
          s.logFrequency = v
        },
      },
      {
        kind: 'row',
        children: [
          {
            kind: 'slider',
            label: 'Low',
            min: 1,
            max: 2000,
            step: 1,
            curve: 'log',
            get: () => s.freqMin,
            set: (v) => {
              s.freqMin = v
            },
            format: fmt.hz,
          },
          {
            kind: 'slider',
            label: 'High',
            min: 1000,
            max: 96000,
            step: 10,
            curve: 'log',
            get: () => s.freqMax,
            set: (v) => {
              s.freqMax = v
            },
            format: fmt.hz,
          },
        ],
      },
      { kind: 'heading', text: 'Level axis' },
      {
        kind: 'row',
        children: [
          {
            kind: 'slider',
            label: 'Floor',
            min: -200,
            max: -20,
            step: 1,
            get: () => s.dbMin,
            set: (v) => {
              s.dbMin = v
            },
            format: fmt.db,
          },
          {
            kind: 'slider',
            label: 'Ceiling',
            min: -60,
            max: 40,
            step: 1,
            get: () => s.dbMax,
            set: (v) => {
              s.dbMax = v
            },
            format: fmt.db,
          },
        ],
      },
      { kind: 'heading', text: 'Display' },
      {
        kind: 'select',
        label: 'Curve source',
        options: [
          { value: 'live', label: 'Instantaneous' },
          { value: 'average', label: 'Averaged' },
        ],
        get: () => s.source,
        set: (v) => {
          s.source = v as typeof s.source
        },
        hint: 'Averaging is configured on the Analysis tab.',
      },
      {
        kind: 'toggle',
        label: 'Peak hold trace',
        get: () => s.showPeak,
        set: (v) => {
          s.showPeak = v
        },
      },
      {
        kind: 'slider',
        label: 'Fill opacity',
        min: 0,
        max: 1,
        step: 0.01,
        get: () => s.fill,
        set: (v) => {
          s.fill = v
        },
        format: fmt.pct,
      },
      {
        kind: 'toggle',
        label: 'Split channels into lanes',
        get: () => s.splitChannels,
        set: (v) => {
          s.splitChannels = v
        },
      },
      {
        kind: 'note',
        text: 'Each pixel column shows the min, mean and max of every bin that falls inside it. A narrow peak can never be lost between columns, and where there is less than one bin per pixel the curve is interpolated rather than stepped.',
      },
    ]
  }

  private spectrogramControls(c: Config): Control[] {
    const s = c.spectrogram
    return [
      { kind: 'heading', text: 'History' },
      {
        kind: 'slider',
        label: 'Time span',
        min: 1,
        max: 120,
        step: 0.5,
        curve: 'log',
        get: () => s.historySeconds,
        set: (v) => {
          s.historySeconds = v
        },
        format: (v) => `${v.toFixed(1)} s`,
        hint: 'Stored as a ring in GPU memory: scrolling is a texture coordinate offset, not a copy.',
      },
      { kind: 'heading', text: 'Frequency axis' },
      {
        kind: 'toggle',
        label: 'Logarithmic frequency',
        get: () => s.logFrequency,
        set: (v) => {
          s.logFrequency = v
        },
      },
      {
        kind: 'row',
        children: [
          {
            kind: 'slider',
            label: 'Low',
            min: 1,
            max: 2000,
            step: 1,
            curve: 'log',
            get: () => s.freqMin,
            set: (v) => {
              s.freqMin = v
            },
            format: fmt.hz,
          },
          {
            kind: 'slider',
            label: 'High',
            min: 1000,
            max: 96000,
            step: 10,
            curve: 'log',
            get: () => s.freqMax,
            set: (v) => {
              s.freqMax = v
            },
            format: fmt.hz,
          },
        ],
      },
      { kind: 'heading', text: 'Intensity' },
      {
        kind: 'row',
        children: [
          {
            kind: 'slider',
            label: 'Floor',
            min: -160,
            max: -20,
            step: 1,
            get: () => s.dbFloor,
            set: (v) => {
              s.dbFloor = v
            },
            format: fmt.db,
          },
          {
            kind: 'slider',
            label: 'Ceiling',
            min: -80,
            max: 20,
            step: 1,
            get: () => s.dbCeil,
            set: (v) => {
              s.dbCeil = v
            },
            format: fmt.db,
          },
        ],
      },
      {
        kind: 'slider',
        label: 'Gain',
        min: 0.01,
        max: 100,
        step: 0.01,
        curve: 'log',
        get: () => s.gain,
        set: (v) => {
          s.gain = v
        },
        format: (v) => `${v.toFixed(2)}×`,
      },
      {
        kind: 'slider',
        label: 'Splat radius',
        min: 0.5,
        max: 4,
        step: 0.05,
        get: () => s.splatRadius,
        set: (v) => {
          s.splatRadius = v
        },
        format: (v) => `${v.toFixed(2)} px`,
        hint: 'Reassigned points land at fractional coordinates. A larger kernel fills gaps in sparse material; a smaller one keeps partials needle-thin.',
      },
      {
        kind: 'toggle',
        label: 'Normalise by coverage',
        get: () => s.normalise,
        set: (v) => {
          s.normalise = v
        },
        hint: 'Divides accumulated energy by accumulated kernel weight. Evens out density variation at the cost of absolute level accuracy.',
      },
      {
        kind: 'select',
        label: 'Palette',
        options: PALETTES.map((p) => ({ value: p.id, label: p.label })),
        get: () => s.palette,
        set: (v) => {
          s.palette = v
        },
        hint: 'All of these rise monotonically in lightness. A rainbow map would invent a bright band in the middle of a smooth ramp and you would read it as a peak.',
      },
    ]
  }

  private meterControls(c: Config): Control[] {
    const status = this.deps.status()
    const l = status.loudness
    const num = (v: number | undefined) =>
      v === undefined || !Number.isFinite(v) ? '−∞' : v.toFixed(2)
    return [
      { kind: 'heading', text: 'ITU-R BS.1770-4 / EBU R 128' },
      { kind: 'readout', label: 'Momentary (400 ms)', get: () => `${num(l?.momentary)} LUFS` },
      { kind: 'readout', label: 'Short term (3 s)', get: () => `${num(l?.shortTerm)} LUFS` },
      { kind: 'readout', label: 'Integrated (gated)', get: () => `${num(l?.integrated)} LUFS` },
      { kind: 'readout', label: 'Loudness range', get: () => `${(l?.range ?? 0).toFixed(2)} LU` },
      { kind: 'readout', label: 'True peak', get: () => `${num(l?.truePeakDb)} dBTP` },
      { kind: 'readout', label: 'Sample peak', get: () => `${num(l?.samplePeakDb)} dBFS` },
      { kind: 'readout', label: 'Correlation', get: () => (l?.correlation ?? 0).toFixed(3) },
      {
        kind: 'readout',
        label: 'Integration time',
        get: () => `${(l?.seconds ?? 0).toFixed(1)} s`,
      },
      {
        kind: 'readout',
        label: 'Delivery check',
        get: () => {
          if (!l || !Number.isFinite(l.integrated)) return 'measuring…'
          const dl = l.integrated - c.meters.targetLufs
          const tp = l.truePeakDb - c.meters.truePeakCeilingDb
          const loud = `${dl >= 0 ? '+' : ''}${dl.toFixed(1)} LU vs target`
          return tp > 0 ? `${loud}, true peak over by ${tp.toFixed(1)} dB` : loud
        },
      },
      { kind: 'heading', text: 'Targets' },
      {
        kind: 'slider',
        label: 'Loudness target',
        min: -31,
        max: -9,
        step: 0.5,
        get: () => c.meters.targetLufs,
        set: (v) => {
          c.meters.targetLufs = v
        },
        format: (v) => `${v.toFixed(1)} LUFS`,
        hint: '−23 for EBU R 128 broadcast, −14 for most streaming platforms, −16 for podcasts.',
      },
      {
        kind: 'slider',
        label: 'True peak ceiling',
        min: -6,
        max: 0,
        step: 0.1,
        get: () => c.meters.truePeakCeilingDb,
        set: (v) => {
          c.meters.truePeakCeilingDb = v
        },
        format: fmt.db,
      },
      {
        kind: 'button',
        label: 'Reset integration',
        action: 'reset-meters',
        onClick: () => this.deps.onResetMeters(),
      },
      {
        kind: 'note',
        text: 'K-weighting filters are re-derived from the Recommendation’s analog prototype at the working sample rate, so the measurement stays compliant at 96 and 192 kHz rather than only at 48. True peak uses a 4× polyphase oversampler with 32 taps per phase — the Recommendation’s reference filter uses 12.',
      },
    ]
  }

  private appearanceControls(c: Config): Control[] {
    const s = c.style
    return [
      { kind: 'heading', text: 'Presets' },
      {
        kind: 'row',
        children: STYLE_PRESETS.map((preset) => ({
          kind: 'button' as const,
          label: preset.label,
          action: `preset-${preset.id}`,
          onClick: () => Object.assign(c.style, preset.style),
        })),
      },
      { kind: 'heading', text: 'Colours' },
      {
        kind: 'row',
        children: [
          {
            kind: 'color',
            label: 'Background',
            get: () => s.background,
            set: (v) => {
              s.background = v
            },
          },
          {
            kind: 'color',
            label: 'Wave',
            get: () => s.primary,
            set: (v) => {
              s.primary = v
            },
          },
          {
            kind: 'color',
            label: 'Secondary',
            get: () => s.secondary,
            set: (v) => {
              s.secondary = v
            },
          },
          {
            kind: 'color',
            label: 'Accent',
            get: () => s.accent,
            set: (v) => {
              s.accent = v
            },
          },
        ],
      },
      { kind: 'heading', text: 'Trace' },
      {
        kind: 'slider',
        label: 'Line width',
        min: 0.5,
        max: 8,
        step: 0.1,
        get: () => s.lineWidth,
        set: (v) => {
          s.lineWidth = v
        },
        format: (v) => `${v.toFixed(1)} px`,
      },
      {
        kind: 'slider',
        label: 'Intensity',
        min: 0,
        max: 4,
        step: 0.01,
        get: () => s.intensity,
        set: (v) => {
          s.intensity = v
        },
        format: fmt.fixed(2),
      },
      {
        kind: 'slider',
        label: 'Phosphor persistence',
        min: 0,
        max: 0.98,
        step: 0.01,
        get: () => s.persistence,
        set: (v) => {
          s.persistence = v
        },
        format: (v) => (v <= 0 ? 'off' : v.toFixed(2)),
        hint: 'Fraction of the previous frame retained. Traces accumulate additively, so density becomes brightness the way it does on a CRT.',
      },
      { kind: 'heading', text: 'Tone mapping' },
      {
        kind: 'select',
        label: 'Curve',
        options: [
          { value: 'clip', label: 'Clip' },
          { value: 'reinhard', label: 'Reinhard' },
          { value: 'aces', label: 'ACES filmic' },
        ],
        get: () => s.tonemap,
        set: (v) => {
          s.tonemap = v as typeof s.tonemap
        },
        hint: 'The scene is rendered in linear rgba16float with additive blending, so overlapping traces genuinely exceed 1.0. The curve decides what happens above that.',
      },
      {
        kind: 'slider',
        label: 'Exposure',
        min: 0.05,
        max: 8,
        step: 0.01,
        curve: 'log',
        get: () => s.exposure,
        set: (v) => {
          s.exposure = v
        },
        format: fmt.fixed(2),
      },
      {
        kind: 'slider',
        label: 'Bloom',
        min: 0,
        max: 2,
        step: 0.01,
        get: () => s.bloom,
        set: (v) => {
          s.bloom = v
        },
        format: (v) => (v <= 0 ? 'off' : v.toFixed(2)),
      },
      {
        kind: 'slider',
        label: 'Bloom threshold',
        min: 0,
        max: 3,
        step: 0.01,
        get: () => s.bloomThreshold,
        set: (v) => {
          s.bloomThreshold = v
        },
        format: fmt.fixed(2),
        disabled: () => s.bloom <= 0,
      },
      {
        kind: 'slider',
        label: 'Saturation',
        min: 0,
        max: 2,
        step: 0.01,
        get: () => s.saturation,
        set: (v) => {
          s.saturation = v
        },
        format: fmt.fixed(2),
      },
      {
        kind: 'slider',
        label: 'Gamma',
        min: 0.4,
        max: 2.4,
        step: 0.01,
        get: () => s.gamma,
        set: (v) => {
          s.gamma = v
        },
        format: fmt.fixed(2),
      },
      {
        kind: 'slider',
        label: 'Vignette',
        min: 0,
        max: 1,
        step: 0.01,
        get: () => s.vignette,
        set: (v) => {
          s.vignette = v
        },
        format: (v) => (v <= 0 ? 'off' : v.toFixed(2)),
      },
      { kind: 'heading', text: 'Graticule' },
      {
        kind: 'toggle',
        label: 'Show grid',
        get: () => s.showGrid,
        set: (v) => {
          s.showGrid = v
        },
      },
      {
        kind: 'toggle',
        label: 'Show axis labels',
        get: () => s.showLabels,
        set: (v) => {
          s.showLabels = v
        },
      },
      {
        kind: 'toggle',
        label: 'Show readout bar',
        get: () => s.showReadout,
        set: (v) => {
          s.showReadout = v
        },
      },
      {
        kind: 'slider',
        label: 'Grid brightness',
        min: 0,
        max: 1,
        step: 0.01,
        get: () => s.gridAlpha,
        set: (v) => {
          s.gridAlpha = v
        },
        format: fmt.pct,
      },
    ]
  }

  private systemControls(c: Config): Control[] {
    const info = this.deps.gpuInfo
    const status = this.deps.status()
    const e = status.engine
    return [
      { kind: 'heading', text: 'Performance' },
      {
        kind: 'slider',
        label: 'Analysis frames per paint',
        min: 1,
        max: 64,
        step: 1,
        get: () => c.perf.maxFramesPerRender,
        set: (v) => {
          c.perf.maxFramesPerRender = Math.round(v)
        },
        format: fmt.int,
        hint: 'All frames that arrived since the last paint are batched into one dispatch chain. Beyond this limit the oldest are dropped rather than falling further behind.',
      },
      {
        kind: 'slider',
        label: 'Render scale',
        min: 0.25,
        max: 2,
        step: 0.05,
        get: () => c.perf.resolutionScale,
        set: (v) => {
          c.perf.resolutionScale = v
        },
        format: (v) => `${v.toFixed(2)}×`,
      },
      {
        kind: 'toggle',
        label: '4× multisampling',
        get: () => c.perf.msaa,
        set: (v) => {
          c.perf.msaa = v
        },
        hint: 'Sample count is baked into the render pipelines; this takes effect on reload.',
      },
      { kind: 'heading', text: 'Status' },
      { kind: 'readout', label: 'Display rate', get: () => `${status.fps.toFixed(1)} fps` },
      {
        kind: 'readout',
        label: 'Analysis rate',
        get: () => `${status.analysisFps.toFixed(1)} frames/s`,
      },
      { kind: 'readout', label: 'Frames dropped', get: () => String(status.dropped) },
      { kind: 'readout', label: 'Ring overruns', get: () => String(status.lapped) },
      {
        kind: 'readout',
        label: 'Capture rate',
        get: () => (e.sampleRate ? `${e.sampleRate} Hz` : '—'),
      },
      {
        kind: 'readout',
        label: 'Resampling',
        get: () => (e.bitPerfectRate ? 'none — context matches device' : e.message || 'active'),
      },
      {
        kind: 'readout',
        label: 'Input latency',
        get: () => `${status.latencyMs.toFixed(2)} ms`,
      },
      {
        kind: 'readout',
        label: 'Shared memory',
        get: () =>
          e.sharedMemory
            ? 'SharedArrayBuffer ring (lock-free)'
            : 'postMessage transfer fallback',
        hint: status.crossOriginIsolated
          ? undefined
          : 'This document is not cross-origin isolated, so SharedArrayBuffer is unavailable. Serve with COOP: same-origin and COEP: require-corp for the lock-free path.',
      },
      { kind: 'heading', text: 'Adapter' },
      { kind: 'readout', label: 'Vendor', get: () => info.vendor || 'unknown' },
      { kind: 'readout', label: 'Architecture', get: () => info.architecture || 'unknown' },
      {
        kind: 'readout',
        label: 'Optional features',
        get: () =>
          [
            info.subgroups ? 'subgroups' : null,
            info.shaderF16 ? 'f16' : null,
            info.timestampQuery ? 'timestamps' : null,
          ]
            .filter(Boolean)
            .join(', ') || 'none',
      },
      {
        kind: 'readout',
        label: 'Max storage binding',
        get: () => `${(info.maxStorageBufferBindingSize / (1024 * 1024)).toFixed(0)} MB`,
      },
      { kind: 'heading', text: 'Verification' },
      {
        kind: 'button',
        label: 'Run FFT self-test',
        action: 'self-test',
        onClick: () => {
          void this.deps.onSelfTest()
        },
        hint: 'Pushes a synthetic two-tone signal through the real GPU pipeline and compares the result against the f64 CPU reference in dsp/fft.ts.',
      },
      ...(this.selfTestResult
        ? [{ kind: 'readout' as const, label: 'Result', get: () => this.selfTestResult }]
        : []),
      { kind: 'heading', text: 'Profile' },
      {
        kind: 'button',
        label: 'Reset all settings',
        action: 'reset-config',
        onClick: () => {
          Object.assign(c, structuredClone(DEFAULT_CONFIG))
          this.rebuild()
        },
      },
    ]
  }
}
