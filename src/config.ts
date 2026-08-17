/**
 * Application configuration: one plain object, fully serialisable, persisted to localStorage.
 * Every knob the overlay exposes lives here, and every consumer reads from the same instance,
 * so there is no second source of truth to drift out of sync.
 */

import type { GeneratorKind, SourceKind } from './audio/engine.ts'
import type { WindowId } from './dsp/windows.ts'
import type { PanelPlacement } from './ui/dock.ts'
import type { TuningSettings } from './dsp/tuning.ts'

export type Mode = 'wave' | 'spectrum' | 'spectrogram' | 'vector'

/** How the living population merges with what is already on the target. */
export type LifeBlend = 'add' | 'screen' | 'lighten'

export type ChannelMode = 'left' | 'right' | 'mid' | 'side' | 'mono' | 'stereo'

export type TriggerMode = 'free' | 'level' | 'pitch'

export type TraceMode = 'auto' | 'envelope' | 'bandlimited'

/** How the goniometer plots the pair: rotated into mid and side, or the channels raw. */
export type VectorMode = 'midside' | 'lissajous'

/** The figure as a connected trace, or as one dot per sample. */
export type VectorTrace = 'line' | 'dots'

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
  /**
   * Where the control panel sits and how big it is. Placement is not a theme property — a theme
   * is a look, and where you keep your tools is a habit — so it lives here rather than in `ui`,
   * and a theme change never moves the panel. See `ui/dock.ts` for what the fields mean.
   */
  panel: PanelPlacement
  /** Id of the theme last applied. Only used to show which entry is current. */
  themeId: string
  /**
   * Whether the Life tab is in the panel at all.
   *
   * The organism has more parameters than the analyser does, and most people opening a spectrum
   * analyser did not come for an ecology. It is off by default and revealed from the System tab,
   * which keeps a tab's worth of knobs out of the way of anyone who does not want them without
   * taking the feature away from anyone who does.
   */
  showLife: boolean
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
  vector: {
    /**
     * Radial gain. At 1 a full-scale correlated signal reaches the ±0.707 reference, which is
     * where the rotation puts it. The graticule stays where it is when this moves, the way a
     * scope's does: the figure grows past its own reference rather than taking it along.
     */
    gain: number
    mode: VectorMode
    /**
     * How much audio the figure holds. Long enough to close the figure on low material, short
     * enough that it still moves with the music.
     */
    traceMs: number
    /**
     * Phosphor ramp along the trace: brightness rises as age^fade from the oldest sample to the
     * newest. Zero lights the whole figure evenly, and larger values leave only the leading edge.
     */
    fade: number
    trace: VectorTrace
    /** Dot diameter in pixels. The connected trace takes the theme's line width instead. */
    dotSize: number
    /** Brightness of the figure, on top of the theme's intensity. */
    brightness: number
  }
  /**
   * What the frequency axes are labelled in, and the scale that decides where the notes are.
   *
   * Not in `style`, though the switch for it sits with the graticule controls: a theme carries
   * the whole of `style`, and picking a different look should not silently retune the instrument.
   * See `dsp/tuning.ts` for what the fields mean.
   */
  tuning: TuningSettings
  meters: {
    targetLufs: number
    truePeakCeilingDb: number
  }
  /**
   * MIDI control. Bindings are keyed by a control's position in the panel — tab, section and
   * label — because that is stable across reloads and readable in a saved profile, and because
   * a binding has to outlive the widget it was made on: the widgets for a tab exist only while
   * that tab is open, and a fader assigned to a Life parameter has to keep working from the
   * Source tab.
   */
  midi: {
    /** Web MIDI prompts for permission, so nothing is requested until this is turned on. */
    enabled: boolean
    /** Input port id, or empty for every input at once. */
    deviceId: string
    /**
     * What drives what. A list rather than a map from id to signal, because `merge` keeps only
     * keys that exist in the defaults — a dictionary of bindings would be thrown away on every
     * reload, silently, since the defaults have none of its keys. An array is replaced wholesale
     * and survives, and it reads better in a stored profile besides.
     */
    bindings: { id: string; kind: 'cc' | 'note'; channel: number; number: number }[]
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
    /**
     * How strongly it is drawn into exact ratio with a consonant partner. Negative repels
     * consonance, which pulls a harmonic series apart instead of tightening it.
     */
    harmonicPull: number
    /**
     * How hard a partner at a rough interval — a semitone, a tritone, a major seventh — pushes
     * it away. This is what keeps two chords sounding at once from averaging into one cloud.
     * Negative makes dissonance attractive.
     */
    dissonance: number
    /**
     * How strongly the scope surface underneath is felt. Hunger sets the sign: a starving
     * particle climbs toward energy and a full one is pushed off it. Negative inverts the whole
     * relationship, so the population avoids the signal it came from.
     */
    surfacePull: number
    /** Fraction of the previous step's drift carried forward. Momentum, effectively. */
    damping: number
    /**
     * How far and how eagerly a particle walks its own harmonic series, regardless of where the
     * energy currently is. This is the one behaviour that is not a reaction to the signal.
     */
    roam: number
    /** Depth in cents of the intrinsic oscillation, whose rate is the particle's harmonic number. */
    vibrato: number
    /** Steps an unfed particle survives. How far it can travel before the journey kills it. */
    stamina: number
    /**
     * Fraction of the pheromone field surviving each step. The field only — starvation has its
     * own clock in `stamina`, because one knob cannot sensibly set both the organism's memory
     * and its endurance.
     */
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
    /**
     * How big a particle draws, in pixels — its splat radius in the spectrogram, its point
     * radius in the spectrum and the vectorscope, the width of its sine in the waveform. One
     * size in all four scopes, because it is one organism.
     */
    pointSize: number
    /** How brightly the population is drawn, in all four scopes. */
    brightness: number
    /**
     * Which pitch-class wheel colours the population — id from `gpu/colormap.ts`. Cyclic, not a
     * ramp: it maps where a particle sits inside the octave, so every octave of a note is one
     * colour. One organism, so one wheel across all four scopes.
     */
    wheel: string
    /**
     * How the population merges with whatever is already on the target. Additive is the house
     * style and bleaches when the crowd is dense; screen rolls off toward white instead of
     * through it; lighten keeps the brighter of the two and never mixes hues at all.
     */
    blend: LifeBlend
    /**
     * Chroma of the organism's own colours, applied where they are resolved rather than in
     * post, so the instrument underneath keeps whatever the theme gave it. Above one this
     * recovers the saturation that averaging thousands of hues in one texel takes away.
     */
    saturation: number
    /**
     * Phosphor: how many steps of a particle's own path are drawn behind it. The path is
     * reconstructed from the particle's velocity and its intrinsic wobble rather than stored,
     * so a trail costs a quad per step and no memory at all.
     */
    trail: number
    /** Brightness retained per step back along the trail. */
    trailFade: number
    /**
     * How much the particle's life properties bend its own trail — the wobble it draws into the
     * phosphor and how much of the trail's brightness follows its vitality rather than its
     * level. At zero every trail is a plain fading streak.
     */
    trailModulation: number
    /**
     * Opacity of the instrument underneath — the waveform trace, the spectrum curve, the
     * vectorscope figure, and in the spectrogram the reassigned energy itself. Dropping it to
     * zero leaves only the organism; 1 leaves the instrument untouched and the population
     * purely additive over it.
     */
    baseOpacity: number
    /** How many partials the waveform pane resynthesises. Each one costs a polyline. */
    traces: number
    /**
     * How much of the spectrogram's safety margin to give up, 0..1. The display normally lags
     * the write head by half an analysis window so that reassignment's backwards-in-time
     * corrections have landed before a column is shown. A particle is not a correction — it is
     * painted where it is now — so most of that margin is holding back an edge that is already
     * final, and giving it up brings the organism's leading edge nearer to the present.
     */
    lead: number
    /**
     * Columns by which a quiet particle hangs back from the leading edge, so the edge is
     * contoured by amplitude instead of being a ruled vertical line. The loudest thing in the
     * frame touches the edge; everything else falls short of it in proportion to its level.
     * Negative puts the loud ones behind instead.
     */
    amplitudeLead: number
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

/**
 * Most points the vectorscope will draw at once. A longer trace than this many samples is
 * decimated rather than truncated, so the figure keeps its shape and loses only its detail —
 * and the panel can say so, which is why the cap lives here rather than inside the renderer.
 */
export const VECTOR_MAX_POINTS = 8192

export const DEFAULT_SPLIT: LayoutSplit = { x: 0.5, y: 0.5 }

export const DEFAULT_CONFIG: Config = {
  panes: { wave: true, spectrum: true, spectrogram: true, vector: true },
  split: { ...DEFAULT_SPLIT },
  panel: {
    dock: 'right',
    size: 420,
    // Where it lands the first time it is pulled off an edge, before it has been put anywhere.
    float: { x: 64, y: 64, width: 420, height: 640 },
    push: true,
  },
  themeId: 'studio',
  showLife: false,
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
  vector: {
    gain: 1,
    mode: 'midside',
    traceMs: 40,
    fade: 0.6,
    trace: 'line',
    dotSize: 2,
    brightness: 1,
  },
  tuning: {
    mode: 'frequency',
    id: 'equal',
    referenceHz: 440,
    root: 60,
    imported: [],
  },
  meters: {
    targetLufs: -14,
    truePeakCeilingDb: -1,
  },
  midi: {
    enabled: false,
    deviceId: '',
    bindings: [],
  },
  life: {
    enabled: false,
    sensorCents: 45,
    turnCents: 7,
    harmonicPull: 0.35,
    dissonance: 0.6,
    surfacePull: 1,
    damping: 0.82,
    roam: 0.4,
    vibrato: 20,
    stamina: 240,
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
    wheel: 'even',
    blend: 'screen',
    saturation: 1.4,
    trail: 6,
    trailFade: 0.86,
    trailModulation: 1,
    baseOpacity: 1,
    traces: 256,
    lead: 1,
    amplitudeLead: 8,
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

/**
 * The one thing the defaults cannot know: the shape of the screen they are about to appear on.
 *
 * A column down the right-hand side is the right place for the controls on anything with room
 * for a column, and the wrong place on a phone, where it would leave the instrument a strip too
 * narrow to read. Applied only when there is no stored profile, so it is a first impression
 * rather than a rule — moving the panel afterwards is remembered like any other choice.
 */
function firstRun(config: Config): Config {
  const width = typeof window === 'undefined' ? 0 : window.innerWidth
  if (width > 0 && width < 640) {
    config.panel.dock = 'bottom'
    config.panel.size = 340
  }
  return config
}

export function loadConfig(): Config {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return firstRun(structuredClone(DEFAULT_CONFIG))
    const stored = JSON.parse(raw) as Record<string, unknown>
    const config = merge(structuredClone(DEFAULT_CONFIG), stored)
    // A profile written before the tab could be hidden has no opinion about hiding it, and
    // taking the default would leave anyone already running the organism with it still on screen
    // and no way to reach its controls. Having it on counts as having asked for it.
    if (!('showLife' in stored) && config.life.enabled) config.showLife = true
    return config
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
