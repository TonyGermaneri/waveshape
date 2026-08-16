/**
 * Application configuration: one plain object, fully serialisable, persisted to localStorage.
 * Every knob the overlay exposes lives here, and every consumer reads from the same instance,
 * so there is no second source of truth to drift out of sync.
 */

import type { GeneratorKind, SourceKind } from './audio/engine.ts'
import type { WindowId } from './dsp/windows.ts'

export type Mode = 'wave' | 'spectrum' | 'spectrogram' | 'vector'

export type ChannelMode = 'left' | 'right' | 'mid' | 'side' | 'mono' | 'stereo'

export type TriggerMode = 'free' | 'level' | 'pitch'

export type TraceMode = 'auto' | 'envelope' | 'bandlimited'

/**
 * Chrome colours. The overlay derives every one of its CSS custom properties from these five
 * values, so a theme restyles the panel as well as the canvas rather than leaving a dark
 * control surface floating over a light trace.
 */
export interface UiTheme {
  /** Panel base colour, before the opacity below is applied. */
  panel: string
  opacity: number
  /** Text colour; the muted, faint and border tones are alpha ramps of it. */
  text: string
  accent: string
  radius: number
  /** Backdrop blur behind the panel, in pixels. 0 disables it. */
  blur: number
}

/**
 * Where the cross that divides the four panes sits, as a fraction of the viewport. Dragging it
 * to a rail collapses two panes to nothing, which is how a visualisation is switched off.
 */
export interface LayoutSplit {
  x: number
  y: number
}

export interface Config {
  /**
   * Which pane the contextual keyboard bindings drive. All four are on screen at once, so this
   * is a focus, not a switch — the arrow keys have to mean something in particular.
   */
  mode: Mode
  split: LayoutSplit
  /** Id of the theme last applied. Only used to show which entry is current. */
  themeId: string
  source: {
    kind: SourceKind
    deviceId: string
    sampleRate: number | 'native'
    channels: number
    monitorGain: number
    generator: {
      kind: GeneratorKind
      frequency: number
      sweepStart: number
      sweepEnd: number
      sweepSeconds: number
      amplitude: number
    }
  }
  analysis: {
    fftSize: number
    window: WindowId
    windowParam: number
    /** Samples between analysis windows. Sets the true analysis rate: sampleRate / hop. */
    hop: number
    channelMode: ChannelMode
    reassign: boolean
    /** Reject reassignment corrections larger than this fraction of the analysis window. */
    maxTimeShift: number
    /** Reject frequency corrections larger than this many FFT bins. */
    maxFreqShiftBins: number
    /** Exponential averaging coefficient applied per analysis frame, 0 = off. */
    averaging: number
    /** Peak-hold fall rate, dB per second. */
    peakDecayDbPerSecond: number
    floorDb: number
    /** amplitude = dBFS of a sine's peak; density = dBFS per root hertz. */
    scale: 'amplitude' | 'density'
  }
  wave: {
    timebaseMs: number
    trigger: TriggerMode
    triggerLevel: number
    triggerEdge: 1 | -1
    /** Periods of the detected pitch to display when pitch-locked. */
    cycles: number
    clarityThreshold: number
    pitchMinHz: number
    pitchMaxHz: number
    gain: number
    showRms: boolean
    splitChannels: boolean
    trace: TraceMode
  }
  spectrum: {
    logFrequency: boolean
    freqMin: number
    freqMax: number
    dbMin: number
    dbMax: number
    showPeak: boolean
    fill: number
    source: 'live' | 'average'
    splitChannels: boolean
  }
  spectrogram: {
    historySeconds: number
    logFrequency: boolean
    freqMin: number
    freqMax: number
    dbFloor: number
    dbCeil: number
    gain: number
    splatRadius: number
    palette: string
    normalise: boolean
  }
  meters: {
    targetLufs: number
    truePeakCeilingDb: number
  }
  style: {
    background: string
    primary: string
    secondary: string
    accent: string
    lineWidth: number
    intensity: number
    /** Phosphor persistence: fraction of the previous frame retained, 0 = none. */
    persistence: number
    bloom: number
    bloomThreshold: number
    exposure: number
    gamma: number
    saturation: number
    vignette: number
    tonemap: 'clip' | 'reinhard' | 'aces'
    gridAlpha: number
    showGrid: boolean
    showLabels: boolean
    showReadout: boolean
  }
  ui: UiTheme
  perf: {
    /** Analysis frames processed per rendered frame before older ones are dropped. */
    maxFramesPerRender: number
    /** Render resolution as a fraction of the device pixel ratio. */
    resolutionScale: number
    msaa: boolean
    showStats: boolean
  }
}

export const FFT_SIZES = [256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536] as const

export const SAMPLE_RATES = [
  'native',
  44100,
  48000,
  88200,
  96000,
  176400,
  192000,
] as const

export const DEFAULT_SPLIT: LayoutSplit = { x: 0.5, y: 0.5 }

export const DEFAULT_CONFIG: Config = {
  mode: 'wave',
  split: { ...DEFAULT_SPLIT },
  themeId: 'studio',
  source: {
    kind: 'microphone',
    deviceId: '',
    sampleRate: 'native',
    channels: 2,
    monitorGain: 0,
    generator: {
      kind: 'sine',
      frequency: 440,
      sweepStart: 20,
      sweepEnd: 20000,
      sweepSeconds: 10,
      amplitude: 0.5,
    },
  },
  analysis: {
    fftSize: 4096,
    window: 'blackman-harris',
    windowParam: 12,
    hop: 256,
    channelMode: 'stereo',
    reassign: true,
    maxTimeShift: 0.5,
    maxFreqShiftBins: 4,
    averaging: 0,
    peakDecayDbPerSecond: 12,
    floorDb: -140,
    scale: 'amplitude',
  },
  wave: {
    timebaseMs: 20,
    trigger: 'pitch',
    triggerLevel: 0,
    triggerEdge: 1,
    cycles: 3,
    clarityThreshold: 0.7,
    pitchMinHz: 30,
    pitchMaxHz: 2000,
    gain: 1,
    showRms: true,
    splitChannels: true,
    trace: 'auto',
  },
  spectrum: {
    logFrequency: true,
    freqMin: 20,
    freqMax: 22050,
    dbMin: -120,
    dbMax: 0,
    showPeak: true,
    fill: 0.35,
    source: 'live',
    splitChannels: false,
  },
  spectrogram: {
    historySeconds: 12,
    logFrequency: true,
    freqMin: 20,
    freqMax: 22050,
    dbFloor: -110,
    dbCeil: -10,
    gain: 1,
    splatRadius: 1.1,
    palette: 'magma',
    normalise: false,
  },
  meters: {
    targetLufs: -14,
    truePeakCeilingDb: -1,
  },
  style: {
    background: '#000000',
    primary: '#ffffff',
    secondary: '#8a8a8a',
    accent: '#40b8ff',
    lineWidth: 1.5,
    intensity: 1,
    persistence: 0,
    bloom: 0.25,
    bloomThreshold: 0.85,
    exposure: 1,
    gamma: 1,
    saturation: 1,
    vignette: 0,
    tonemap: 'reinhard',
    gridAlpha: 0.22,
    showGrid: true,
    showLabels: true,
    showReadout: true,
  },
  ui: {
    panel: '#0e0f12',
    opacity: 0.82,
    text: '#ffffff',
    accent: '#4bb4ff',
    radius: 10,
    blur: 22,
  },
  perf: {
    maxFramesPerRender: 24,
    resolutionScale: 1,
    msaa: true,
    showStats: false,
  },
}

const STORAGE_KEY = 'waveshape.config.v1'

/** Deep-merges stored values over the defaults so new keys appear without wiping the profile. */
function merge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return base
  const out = { ...base } as Record<string, unknown>
  const b = base as Record<string, unknown>
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (!(key in b)) continue
    const current = b[key]
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      out[key] = merge(current, value)
    } else if (typeof current === typeof value) {
      out[key] = value
    }
  }
  return out as T
}

export function loadConfig(): Config {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return structuredClone(DEFAULT_CONFIG)
    return merge(structuredClone(DEFAULT_CONFIG), JSON.parse(raw))
  } catch {
    return structuredClone(DEFAULT_CONFIG)
  }
}

export function saveConfig(config: Config): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  } catch {
    // Private browsing or a full quota. Not worth interrupting the user over.
  }
}

/**
 * Mixing weights that turn the capture channels into the selected analysis channels.
 * Returned as [ch0.l, ch0.r, ch1.l, ch1.r] plus the number of logical channels.
 */
export function channelMix(mode: ChannelMode): { mix: [number, number, number, number]; count: number } {
  const inv = Math.SQRT1_2
  switch (mode) {
    case 'left':
      return { mix: [1, 0, 0, 0], count: 1 }
    case 'right':
      return { mix: [0, 1, 0, 0], count: 1 }
    case 'mid':
      return { mix: [inv, inv, 0, 0], count: 1 }
    case 'side':
      return { mix: [inv, -inv, 0, 0], count: 1 }
    case 'mono':
      return { mix: [0.5, 0.5, 0, 0], count: 1 }
    case 'stereo':
    default:
      return { mix: [1, 0, 0, 1], count: 2 }
  }
}
