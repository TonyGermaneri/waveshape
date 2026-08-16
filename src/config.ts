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

/** Which visualisations are on. The layout is derived from this, not stored alongside it. */
export type PaneToggles = Record<Mode, boolean>

export interface Config {
  panes: PaneToggles
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
  /**
   * The harmonic organism. Every parameter here is a property of a life form rather than of a
   * measurement, which is why they live apart from `analysis` — nothing in this block changes
   * what the signal *is*, only what grows on top of it.
   */
  life: {
    enabled: boolean
    /** How far above and below itself a particle listens, in cents. */
    sensorCents: number
    /** How hard it turns toward the louder spatial sensor, in cents per step. */
    turnCents: number
    /** How strongly it is drawn into exact ratio with a harmonic partner, 0 = not at all. */
    harmonicPull: number
    /** Fraction of the previous step's drift carried forward. Momentum, effectively. */
    damping: number
    /** Fraction of the pheromone field surviving each step. */
    decay: number
    /** How much of each field bin is smeared into its neighbours, 0..1. */
    diffuse: number
    /** Scales what a particle leaves behind relative to its energy. */
    deposit: number
    /**
     * Steps a particle may live before it dies of age. Zero means no clock: it lives until its
     * energy is spent, until it leaves the screen, or until the population cap claims it.
     */
    lifespan: number
    /** How many particles may be alive at once. The oldest is culled to make room. */
    population: number
    /** Wrap the frequency axis into a loop instead of letting particles leave the screen. */
    wrap: boolean
    /**
     * How hard a particle sitting in a crowd moves out of it. This is the term that opposes
     * the harmonic pull; with it at zero the population converges and stops.
     */
    crowding: number
    /** How quickly a particle stops casting about as it ages. 0 keeps it restless for ever. */
    settling: number
    /** How fast a particle standing in energy recovers its vitality. */
    feed: number
    /**
     * How many particles a frequency may already hold before new energy renews them instead of
     * spawning more. This is what stops the population being a fountain of clones.
     */
    occupancy: number
    /** Amplitude a reassigned point must carry before it is worth animating. */
    birthThreshold: number
    /** How much faster a noise-born particle dies than a tonal one. */
    noiseMortality: number
    /** How much longer a particle with a large harmonic family lives. */
    supportBonus: number
    /** Cents per step a particle may migrate. */
    driftLimitCents: number
    /** Level a spectral peak must clear before the census counts it as a partial. */
    peakFloorDb: number
    /** Radius of a particle where it is drawn as a point, in pixels. */
    pointSize: number
    /** How brightly the population is drawn over the other three scopes. */
    brightness: number
    /**
     * Opacity of the scope underneath — the waveform trace, the spectrum curve, the
     * vectorscope figure. Dropping it to zero leaves only the organism; 1 leaves the
     * instrument untouched and the population purely additive over it.
     */
    baseOpacity: number
    /** How many partials the waveform pane resynthesises. Each one costs a polyline. */
    traces: number
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
  panes: { wave: true, spectrum: true, spectrogram: true, vector: true },
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
  life: {
    enabled: false,
    sensorCents: 45,
    turnCents: 7,
    harmonicPull: 0.35,
    damping: 0.82,
    decay: 0.94,
    diffuse: 0.55,
    deposit: 1.6,
    lifespan: 0,
    population: 24000,
    wrap: false,
    crowding: 1.4,
    settling: 0.02,
    feed: 0.12,
    occupancy: 2.5,
    birthThreshold: 0.0004,
    noiseMortality: 2.2,
    supportBonus: 0.28,
    driftLimitCents: 25,
    peakFloorDb: -75,
    pointSize: 1.6,
    brightness: 0.8,
    baseOpacity: 1,
    traces: 256,
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
