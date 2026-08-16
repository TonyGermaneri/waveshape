/**
 * The keyboard map.
 *
 * One declarative table drives three things: the dispatcher, the on-screen reference, and the
 * hints printed next to the controls. There is no second list of shortcuts to fall out of date,
 * and `keymap.test.ts` proves no two bindings can be reachable from the same keystroke at once.
 *
 * The scheme is: **arrows shape the picture, letters drive the machine.** Arrow keys are
 * contextual — they mean gain and time span in the oscilloscope, level window and frequency
 * range in the spectrum and spectrogram — while the letter and punctuation pairs adjust the
 * transform and the look identically in every mode. Pairs are laid out so the left key of each
 * physical pair decreases and the right key increases: `-` `=`, `[` `]`, `q` `w`, `a` `s`,
 * `z` `x`, `.` `/`, `;` `'`, `9` `0`.
 */

import { FFT_SIZES, type Config, type Mode } from '../config.ts'
import { WINDOWS } from '../dsp/windows.ts'
import { PALETTES } from '../gpu/colormap.ts'
import { fmt } from './widgets.ts'

export const KEY_GROUPS = [
  'Panel',
  'Modes',
  'Analysis',
  'Display',
  'Appearance',
  'Source',
] as const

export type KeyGroup = (typeof KEY_GROUPS)[number]

/** Everything a binding can ask the application to do that is not a plain config write. */
export interface KeyActions {
  togglePanel(): void
  toggleFullscreen(): void
  toggleHelp(): void
  cycleTab(dir: number): string
  cycleTheme(dir: number): string
  restartSource(): void
  stopSource(): void
  resetMeters(): void
  notify(text: string): void
  /** Called after a binding ran. `structural` means the set of visible controls may have changed. */
  changed(structural: boolean): void
}

export interface KeyContext {
  config: Config
  actions: KeyActions
}

export interface KeyStroke {
  token: string
  /** Passed to `run`: −1/+1 for a decrement/increment pair, or an index for a key set. */
  arg: number
  /** An alias that works but is not printed: a second spelling of a key already listed. */
  alias?: boolean
}

export interface Binding {
  keys: readonly KeyStroke[]
  label: string
  group: KeyGroup
  /** Modes this binding is live in. Absent means every mode. */
  modes?: readonly Mode[]
  detail?: string
  when?: (c: Config) => boolean
  structural?: boolean
  /** Returns the text to flash on screen, or nothing to stay silent. */
  run: (ctx: KeyContext, arg: number) => string | void
}

// ---------------------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

const pair = (down: string, up: string): KeyStroke[] => [
  { token: down, arg: -1 },
  { token: up, arg: 1 },
]

/** A single key that cycles forwards, with shift going backwards. */
const cycleKeys = (key: string): KeyStroke[] => [
  { token: key, arg: 1 },
  { token: `shift+${key}`, arg: -1 },
]

const one = (key: string): KeyStroke[] => [{ token: key, arg: 1 }]

interface NumberBinding {
  keys: readonly KeyStroke[]
  label: string
  group: KeyGroup
  modes?: readonly Mode[]
  detail?: string
  when?: (c: Config) => boolean
  get: (c: Config) => number
  set: (c: Config, v: number) => void
  min: number
  max: number
  /** Additive nudge. Ignored when `factor` is given. */
  step?: number
  /** Multiplicative nudge, for the log-scaled quantities. */
  factor?: number
  format: (v: number) => string
}

function number_(spec: NumberBinding): Binding {
  return {
    keys: spec.keys,
    label: spec.label,
    group: spec.group,
    modes: spec.modes,
    detail: spec.detail,
    when: spec.when,
    run: (ctx, arg) => {
      const current = spec.get(ctx.config)
      const next = spec.factor
        ? current * Math.pow(spec.factor, arg)
        : current + (spec.step ?? 1) * arg
      const value = clamp(next, spec.min, spec.max)
      spec.set(ctx.config, value)
      return `${spec.label}  ${spec.format(value)}`
    },
  }
}

interface ChoiceBinding<T extends string | number> {
  keys: readonly KeyStroke[]
  label: string
  group: KeyGroup
  modes?: readonly Mode[]
  detail?: string
  when?: (c: Config) => boolean
  values: readonly T[]
  labels?: readonly string[]
  get: (c: Config) => T
  set: (c: Config, v: T) => void
}

function choice<T extends string | number>(spec: ChoiceBinding<T>): Binding {
  return {
    keys: spec.keys,
    label: spec.label,
    group: spec.group,
    modes: spec.modes,
    detail: spec.detail,
    when: spec.when,
    structural: true,
    run: (ctx, arg) => {
      const index = spec.values.indexOf(spec.get(ctx.config))
      const next = (index + arg + spec.values.length * 2) % spec.values.length
      spec.set(ctx.config, spec.values[next])
      return `${spec.label}  ${spec.labels?.[next] ?? String(spec.values[next])}`
    },
  }
}

interface FlagBinding {
  key: string
  label: string
  group: KeyGroup
  modes?: readonly Mode[]
  detail?: string
  when?: (c: Config) => boolean
  get: (c: Config) => boolean
  set: (c: Config, v: boolean) => void
}

function flag(spec: FlagBinding): Binding {
  return {
    keys: one(spec.key),
    label: spec.label,
    group: spec.group,
    modes: spec.modes,
    detail: spec.detail,
    when: spec.when,
    structural: true,
    run: (ctx) => {
      const value = !spec.get(ctx.config)
      spec.set(ctx.config, value)
      return `${spec.label}  ${value ? 'on' : 'off'}`
    },
  }
}

// ---------------------------------------------------------------------------------------
// Shared range arithmetic
// ---------------------------------------------------------------------------------------

const FREQ_FLOOR = 1
const FREQ_CEIL = 96000

interface FreqRange {
  freqMin: number
  freqMax: number
}

/** Slides the frequency window along the log axis, keeping its width in octaves. */
function panFrequency(range: FreqRange, dir: number): string {
  const ratio = range.freqMax / Math.max(range.freqMin, FREQ_FLOOR)
  let lo = range.freqMin * Math.pow(1.18, dir)
  if (lo < FREQ_FLOOR) lo = FREQ_FLOOR
  if (lo * ratio > FREQ_CEIL) lo = FREQ_CEIL / ratio
  range.freqMin = lo
  range.freqMax = lo * ratio
  return `${fmt.hz(range.freqMin)} – ${fmt.hz(range.freqMax)}`
}

/** Widens (dir < 0) or narrows (dir > 0) the window about its geometric centre. */
function zoomFrequency(range: FreqRange, dir: number): string {
  const centre = Math.sqrt(Math.max(range.freqMin, FREQ_FLOOR) * range.freqMax)
  const half = Math.sqrt(range.freqMax / Math.max(range.freqMin, FREQ_FLOOR))
  const next = Math.max(1.02, Math.pow(half, dir > 0 ? 1 / 1.2 : 1.2))
  range.freqMin = clamp(centre / next, FREQ_FLOOR, FREQ_CEIL / 1.02)
  range.freqMax = clamp(centre * next, range.freqMin * 1.02, FREQ_CEIL)
  return `${fmt.hz(range.freqMin)} – ${fmt.hz(range.freqMax)}`
}

interface DbRange {
  lo: number
  hi: number
}

/** Moves floor and ceiling together — the level equivalent of panning. */
function shiftDb(range: DbRange, dir: number, floor: number, ceil: number): string {
  const step = 2 * dir
  const span = range.hi - range.lo
  let hi = clamp(range.hi + step, floor + span, ceil)
  let lo = hi - span
  if (lo < floor) {
    lo = floor
    hi = lo + span
  }
  range.lo = lo
  range.hi = hi
  return `${lo.toFixed(0)} … ${hi.toFixed(0)} dB`
}

// ---------------------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------------------

const MODES: readonly Mode[] = ['wave', 'spectrum', 'spectrogram', 'vector']
const MODE_LABELS: Record<Mode, string> = {
  wave: 'Waveform',
  spectrum: 'Spectrum',
  spectrogram: 'Spectrogram',
  vector: 'Vectorscope',
}

const WAVE_ONLY: readonly Mode[] = ['wave']
const SPECTRUM_ONLY: readonly Mode[] = ['spectrum']
const SPECTROGRAM_ONLY: readonly Mode[] = ['spectrogram']

export const BINDINGS: readonly Binding[] = [
  // ------------------------------------------------------------------------------ panel
  {
    keys: [
      { token: 'space', arg: 1 },
      { token: 'escape', arg: 1 },
      { token: 'h', arg: 1 },
    ],
    label: 'Show or hide the control panel',
    group: 'Panel',
    run: (ctx) => ctx.actions.togglePanel(),
  },
  {
    keys: one('f'),
    label: 'Full screen',
    group: 'Panel',
    detail: 'The canvas already fills the window; this drops the browser chrome as well.',
    run: (ctx) => ctx.actions.toggleFullscreen(),
  },
  {
    keys: [
      { token: '?', arg: 1 },
      { token: 'f1', arg: 1 },
      // Layouts and remote input stacks that report the unshifted character land here instead.
      { token: 'shift+/', arg: 1, alias: true },
    ],
    label: 'Keyboard reference',
    group: 'Panel',
    run: (ctx) => ctx.actions.toggleHelp(),
  },
  {
    keys: [
      { token: '`', arg: 1 },
      { token: '~', arg: -1 },
    ],
    label: 'Next / previous panel tab',
    group: 'Panel',
    run: (ctx, arg) => `Tab  ${ctx.actions.cycleTab(arg)}`,
  },

  // ------------------------------------------------------------------------------ modes
  {
    keys: MODES.map((_, i) => ({ token: String(i + 1), arg: i })),
    label: 'Waveform · Spectrum · Spectrogram · Vectorscope',
    group: 'Modes',
    structural: true,
    run: (ctx, arg) => {
      ctx.config.mode = MODES[arg]
      return MODE_LABELS[MODES[arg]]
    },
  },

  // ------------------------------------------------------------------------------ analysis
  choice({
    keys: pair('-', '='),
    label: 'FFT size',
    group: 'Analysis',
    values: FFT_SIZES,
    get: (c) => c.analysis.fftSize as (typeof FFT_SIZES)[number],
    set: (c, v) => {
      c.analysis.fftSize = v
    },
    detail: 'Bin spacing is sampleRate / N — doubling halves it and doubles the window length.',
  }),
  number_({
    keys: pair('[', ']'),
    label: 'Hop size',
    group: 'Analysis',
    get: (c) => c.analysis.hop,
    set: (c, v) => {
      c.analysis.hop = Math.max(32, 1 << Math.round(Math.log2(v)))
    },
    min: 32,
    max: 8192,
    factor: 2,
    format: (v) => `${v} samples`,
    detail: 'Samples between analysis windows: the true analysis rate is sampleRate / hop.',
  }),
  choice({
    keys: pair('q', 'w'),
    label: 'Window',
    group: 'Analysis',
    values: WINDOWS.map((w) => w.id),
    labels: WINDOWS.map((w) => w.label),
    get: (c) => c.analysis.window,
    set: (c, v) => {
      c.analysis.window = v
    },
  }),
  number_({
    keys: pair('a', 's'),
    label: 'Averaging',
    group: 'Analysis',
    get: (c) => c.analysis.averaging,
    set: (c, v) => {
      c.analysis.averaging = v
    },
    min: 0,
    max: 5,
    step: 0.1,
    format: (v) => (v <= 0.001 ? 'off' : `${v.toFixed(2)} s`),
  }),
  choice({
    keys: cycleKeys('c'),
    label: 'Channels analysed',
    group: 'Analysis',
    values: ['stereo', 'left', 'right', 'mid', 'side', 'mono'] as const,
    labels: ['Stereo', 'Left', 'Right', 'Mid', 'Side', 'Mono'],
    get: (c) => c.analysis.channelMode,
    set: (c, v) => {
      c.analysis.channelMode = v
    },
  }),
  flag({
    key: 'e',
    label: 'Reassignment',
    group: 'Analysis',
    get: (c) => c.analysis.reassign,
    set: (c, v) => {
      c.analysis.reassign = v
    },
  }),
  choice({
    keys: cycleKeys('m'),
    label: 'Magnitude scale',
    group: 'Analysis',
    values: ['amplitude', 'density'] as const,
    labels: ['Amplitude (dBFS)', 'Density (dBFS/√Hz)'],
    get: (c) => c.analysis.scale,
    set: (c, v) => {
      c.analysis.scale = v
    },
  }),

  // ------------------------------------------------------------------------------ display: waveform
  number_({
    keys: [
      { token: 'arrowup', arg: 1 },
      { token: 'arrowdown', arg: -1 },
    ],
    label: 'Vertical gain',
    group: 'Display',
    modes: ['wave', 'vector'],
    get: (c) => c.wave.gain,
    set: (c, v) => {
      c.wave.gain = v
    },
    min: 0.05,
    max: 64,
    factor: 1.15,
    format: (v) => `${v.toFixed(2)}×  (${(20 * Math.log10(v)).toFixed(1)} dB)`,
  }),
  number_({
    keys: [
      { token: 'shift+arrowup', arg: 1 },
      { token: 'shift+arrowdown', arg: -1 },
    ],
    label: 'Trigger level',
    group: 'Display',
    modes: WAVE_ONLY,
    when: (c) => c.wave.trigger !== 'free',
    get: (c) => c.wave.triggerLevel,
    set: (c, v) => {
      c.wave.triggerLevel = v
    },
    min: -1,
    max: 1,
    step: 0.02,
    format: fmt.fixed(3),
  }),
  number_({
    keys: pair('arrowleft', 'arrowright'),
    label: 'Time span',
    group: 'Display',
    modes: WAVE_ONLY,
    when: (c) => c.wave.trigger !== 'pitch',
    get: (c) => c.wave.timebaseMs,
    set: (c, v) => {
      c.wave.timebaseMs = v
    },
    min: 0.05,
    max: 5000,
    factor: 1.25,
    format: fmt.ms,
  }),
  number_({
    keys: pair('arrowleft', 'arrowright'),
    label: 'Cycles shown',
    group: 'Display',
    modes: WAVE_ONLY,
    when: (c) => c.wave.trigger === 'pitch',
    detail: 'While pitch-locked the span is a whole number of detected periods, not a duration.',
    get: (c) => c.wave.cycles,
    set: (c, v) => {
      c.wave.cycles = Math.round(v * 4) / 4
    },
    min: 0.25,
    max: 32,
    step: 0.25,
    format: (v) => `${v} periods`,
  }),
  number_({
    keys: pair('shift+arrowleft', 'shift+arrowright'),
    label: 'Clarity threshold',
    group: 'Display',
    modes: WAVE_ONLY,
    when: (c) => c.wave.trigger === 'pitch',
    get: (c) => c.wave.clarityThreshold,
    set: (c, v) => {
      c.wave.clarityThreshold = v
    },
    min: 0,
    max: 1,
    step: 0.02,
    format: fmt.fixed(2),
  }),
  choice({
    keys: cycleKeys('d'),
    label: 'Trigger',
    group: 'Display',
    modes: WAVE_ONLY,
    values: ['pitch', 'level', 'free'] as const,
    labels: ['Pitch-locked', 'Level', 'Free run'],
    get: (c) => c.wave.trigger,
    set: (c, v) => {
      c.wave.trigger = v
    },
  }),
  flag({
    key: 'v',
    label: 'RMS band',
    group: 'Display',
    modes: WAVE_ONLY,
    get: (c) => c.wave.showRms,
    set: (c, v) => {
      c.wave.showRms = v
    },
  }),
  flag({
    key: 'j',
    label: 'Split channels into lanes',
    group: 'Display',
    modes: WAVE_ONLY,
    get: (c) => c.wave.splitChannels,
    set: (c, v) => {
      c.wave.splitChannels = v
    },
  }),
  choice({
    keys: cycleKeys('k'),
    label: 'Reconstruction',
    group: 'Display',
    modes: WAVE_ONLY,
    values: ['auto', 'envelope', 'bandlimited'] as const,
    labels: ['Automatic', 'Min/max envelope', 'Band-limited'],
    get: (c) => c.wave.trace,
    set: (c, v) => {
      c.wave.trace = v
    },
  }),

  // ------------------------------------------------------------------------------ display: spectrum
  {
    keys: [
      { token: 'arrowup', arg: 1 },
      { token: 'arrowdown', arg: -1 },
    ],
    label: 'Level window',
    group: 'Display',
    modes: SPECTRUM_ONLY,
    detail: 'Slides floor and ceiling together, 2 dB at a time.',
    run: (ctx, arg) => {
      const s = ctx.config.spectrum
      const range = { lo: s.dbMin, hi: s.dbMax }
      const text = shiftDb(range, arg, -200, 40)
      s.dbMin = range.lo
      s.dbMax = range.hi
      return `Level window  ${text}`
    },
  },
  number_({
    keys: [
      { token: 'shift+arrowup', arg: 1 },
      { token: 'shift+arrowdown', arg: -1 },
    ],
    label: 'Dynamic range',
    group: 'Display',
    modes: SPECTRUM_ONLY,
    get: (c) => c.spectrum.dbMax - c.spectrum.dbMin,
    set: (c, v) => {
      c.spectrum.dbMin = c.spectrum.dbMax - v
    },
    min: 10,
    max: 200,
    step: 5,
    format: (v) => `${v.toFixed(0)} dB`,
  }),
  {
    keys: pair('arrowleft', 'arrowright'),
    label: 'Pan frequency range',
    group: 'Display',
    modes: SPECTRUM_ONLY,
    run: (ctx, arg) => `Frequency  ${panFrequency(ctx.config.spectrum, arg)}`,
  },
  {
    keys: pair('shift+arrowleft', 'shift+arrowright'),
    label: 'Zoom frequency range',
    group: 'Display',
    modes: SPECTRUM_ONLY,
    run: (ctx, arg) => `Frequency  ${zoomFrequency(ctx.config.spectrum, arg)}`,
  },
  choice({
    keys: cycleKeys('d'),
    label: 'Curve source',
    group: 'Display',
    modes: SPECTRUM_ONLY,
    values: ['live', 'average'] as const,
    labels: ['Instantaneous', 'Averaged'],
    get: (c) => c.spectrum.source,
    set: (c, v) => {
      c.spectrum.source = v
    },
  }),
  flag({
    key: 'v',
    label: 'Peak hold trace',
    group: 'Display',
    modes: SPECTRUM_ONLY,
    get: (c) => c.spectrum.showPeak,
    set: (c, v) => {
      c.spectrum.showPeak = v
    },
  }),
  flag({
    key: 'j',
    label: 'Split channels into lanes',
    group: 'Display',
    modes: SPECTRUM_ONLY,
    get: (c) => c.spectrum.splitChannels,
    set: (c, v) => {
      c.spectrum.splitChannels = v
    },
  }),
  number_({
    keys: pair('o', 'p'),
    label: 'Fill opacity',
    group: 'Display',
    modes: SPECTRUM_ONLY,
    get: (c) => c.spectrum.fill,
    set: (c, v) => {
      c.spectrum.fill = v
    },
    min: 0,
    max: 1,
    step: 0.05,
    format: fmt.pct,
  }),
  flag({
    key: 'k',
    label: 'Logarithmic frequency axis',
    group: 'Display',
    modes: SPECTRUM_ONLY,
    get: (c) => c.spectrum.logFrequency,
    set: (c, v) => {
      c.spectrum.logFrequency = v
    },
  }),

  // ------------------------------------------------------------------------------ display: spectrogram
  {
    keys: [
      { token: 'arrowup', arg: 1 },
      { token: 'arrowdown', arg: -1 },
    ],
    label: 'Intensity window',
    group: 'Display',
    modes: SPECTROGRAM_ONLY,
    run: (ctx, arg) => {
      const s = ctx.config.spectrogram
      const range = { lo: s.dbFloor, hi: s.dbCeil }
      const text = shiftDb(range, arg, -160, 20)
      s.dbFloor = range.lo
      s.dbCeil = range.hi
      return `Intensity window  ${text}`
    },
  },
  number_({
    keys: [
      { token: 'shift+arrowup', arg: 1 },
      { token: 'shift+arrowdown', arg: -1 },
    ],
    label: 'Dynamic range',
    group: 'Display',
    modes: SPECTROGRAM_ONLY,
    get: (c) => c.spectrogram.dbCeil - c.spectrogram.dbFloor,
    set: (c, v) => {
      c.spectrogram.dbFloor = c.spectrogram.dbCeil - v
    },
    min: 10,
    max: 160,
    step: 5,
    format: (v) => `${v.toFixed(0)} dB`,
  }),
  {
    keys: pair('arrowleft', 'arrowright'),
    label: 'Pan frequency range',
    group: 'Display',
    modes: SPECTROGRAM_ONLY,
    run: (ctx, arg) => `Frequency  ${panFrequency(ctx.config.spectrogram, arg)}`,
  },
  {
    keys: pair('shift+arrowleft', 'shift+arrowright'),
    label: 'Zoom frequency range',
    group: 'Display',
    modes: SPECTROGRAM_ONLY,
    run: (ctx, arg) => `Frequency  ${zoomFrequency(ctx.config.spectrogram, arg)}`,
  },
  number_({
    keys: pair('o', 'p'),
    label: 'History span',
    group: 'Display',
    modes: SPECTROGRAM_ONLY,
    get: (c) => c.spectrogram.historySeconds,
    set: (c, v) => {
      c.spectrogram.historySeconds = Math.round(v * 2) / 2
    },
    min: 1,
    max: 120,
    factor: 1.25,
    format: (v) => `${v.toFixed(1)} s`,
  }),
  number_({
    keys: pair('d', 'shift+d'),
    label: 'Splat radius',
    group: 'Display',
    modes: SPECTROGRAM_ONLY,
    get: (c) => c.spectrogram.splatRadius,
    set: (c, v) => {
      c.spectrogram.splatRadius = v
    },
    min: 0.5,
    max: 4,
    step: 0.05,
    format: (v) => `${v.toFixed(2)} px`,
  }),
  flag({
    key: 'v',
    label: 'Normalise by coverage',
    group: 'Display',
    modes: SPECTROGRAM_ONLY,
    get: (c) => c.spectrogram.normalise,
    set: (c, v) => {
      c.spectrogram.normalise = v
    },
  }),
  flag({
    key: 'k',
    label: 'Logarithmic frequency axis',
    group: 'Display',
    modes: SPECTROGRAM_ONLY,
    get: (c) => c.spectrogram.logFrequency,
    set: (c, v) => {
      c.spectrogram.logFrequency = v
    },
  }),
  choice({
    keys: cycleKeys('j'),
    label: 'Colour map',
    group: 'Display',
    modes: SPECTROGRAM_ONLY,
    values: PALETTES.map((p) => p.id),
    labels: PALETTES.map((p) => p.label),
    get: (c) => c.spectrogram.palette,
    set: (c, v) => {
      c.spectrogram.palette = v
    },
  }),

  // ------------------------------------------------------------------------------ appearance
  {
    keys: cycleKeys('t'),
    label: 'Next / previous theme',
    group: 'Appearance',
    structural: true,
    run: (ctx, arg) => ctx.actions.cycleTheme(arg),
  },
  number_({
    keys: pair('z', 'x'),
    label: 'Phosphor persistence',
    group: 'Appearance',
    get: (c) => c.style.persistence,
    set: (c, v) => {
      c.style.persistence = v
    },
    min: 0,
    max: 0.98,
    step: 0.02,
    format: (v) => (v <= 0.001 ? 'off' : v.toFixed(2)),
  }),
  number_({
    keys: pair('.', '/'),
    label: 'Exposure',
    group: 'Appearance',
    get: (c) => c.style.exposure,
    set: (c, v) => {
      c.style.exposure = v
    },
    min: 0.05,
    max: 8,
    factor: 1.12,
    format: fmt.fixed(2),
  }),
  number_({
    keys: pair(';', "'"),
    label: 'Bloom',
    group: 'Appearance',
    get: (c) => c.style.bloom,
    set: (c, v) => {
      c.style.bloom = v
    },
    min: 0,
    max: 2,
    step: 0.05,
    format: (v) => (v <= 0.001 ? 'off' : v.toFixed(2)),
  }),
  number_({
    keys: pair('<', '>'),
    label: 'Intensity',
    group: 'Appearance',
    get: (c) => c.style.intensity,
    set: (c, v) => {
      c.style.intensity = v
    },
    min: 0,
    max: 4,
    step: 0.05,
    format: fmt.fixed(2),
  }),
  number_({
    keys: pair('9', '0'),
    label: 'Line width',
    group: 'Appearance',
    get: (c) => c.style.lineWidth,
    set: (c, v) => {
      c.style.lineWidth = v
    },
    min: 0.5,
    max: 8,
    step: 0.1,
    format: (v) => `${v.toFixed(1)} px`,
  }),
  choice({
    keys: cycleKeys('b'),
    label: 'Tone mapping',
    group: 'Appearance',
    values: ['clip', 'reinhard', 'aces'] as const,
    labels: ['Clip', 'Reinhard', 'ACES filmic'],
    get: (c) => c.style.tonemap,
    set: (c, v) => {
      c.style.tonemap = v
    },
  }),
  flag({
    key: 'g',
    label: 'Graticule',
    group: 'Appearance',
    get: (c) => c.style.showGrid,
    set: (c, v) => {
      c.style.showGrid = v
    },
  }),
  flag({
    key: 'l',
    label: 'Axis labels',
    group: 'Appearance',
    get: (c) => c.style.showLabels,
    set: (c, v) => {
      c.style.showLabels = v
    },
  }),
  flag({
    key: 'y',
    label: 'Readout bar',
    group: 'Appearance',
    get: (c) => c.style.showReadout,
    set: (c, v) => {
      c.style.showReadout = v
    },
  }),

  // ------------------------------------------------------------------------------ source
  {
    keys: one('r'),
    label: 'Start or restart capture',
    group: 'Source',
    run: (ctx) => {
      ctx.actions.restartSource()
      return 'Restarting capture…'
    },
  },
  {
    keys: one('shift+r'),
    label: 'Stop capture',
    group: 'Source',
    run: (ctx) => {
      ctx.actions.stopSource()
      return 'Capture stopped'
    },
  },
  {
    keys: one('n'),
    label: 'Reset loudness integration',
    group: 'Source',
    run: (ctx) => {
      ctx.actions.resetMeters()
      return 'Loudness integration reset'
    },
  },
  number_({
    keys: pair('u', 'i'),
    label: 'Monitor to output',
    group: 'Source',
    detail: 'Off by default: a live microphone routed to the speakers is a feedback loop.',
    get: (c) => c.source.monitorGain,
    set: (c, v) => {
      c.source.monitorGain = v
    },
    min: 0,
    max: 1,
    step: 0.05,
    format: fmt.pct,
  }),
]

// ---------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------

/**
 * Canonical name for a keystroke. Printable characters carry their own shifted identity — `?`
 * and `>` are already distinct from `/` and `.` — so shift is only recorded for letters and
 * named keys, where it is the only thing that separates them.
 */
export function keyToken(event: KeyboardEvent): string {
  const key = event.key
  const name = key === ' ' ? 'space' : key.toLowerCase()
  const isLetter = key.length === 1 && key.toLowerCase() !== key.toUpperCase()
  const parts: string[] = []
  if (event.ctrlKey || event.metaKey) parts.push('mod')
  if (event.altKey) parts.push('alt')
  if (event.shiftKey && (isLetter || key.length > 1)) parts.push('shift')
  parts.push(name)
  return parts.join('+')
}

export function bindingsFor(config: Config): Binding[] {
  return BINDINGS.filter(
    (b) => (!b.modes || b.modes.includes(config.mode)) && (!b.when || b.when(config)),
  )
}

/** Runs the binding this keystroke selects, if any. Returns true when the event was consumed. */
export function dispatchKey(event: KeyboardEvent, ctx: KeyContext): boolean {
  const token = keyToken(event)
  for (const binding of bindingsFor(ctx.config)) {
    const stroke = binding.keys.find((k) => k.token === token)
    if (!stroke) continue
    const message = binding.run(ctx, stroke.arg)
    if (message) ctx.actions.notify(message)
    ctx.actions.changed(binding.structural ?? false)
    return true
  }
  return false
}

// ---------------------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------------------

const GLYPHS: Record<string, string> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  space: 'Space',
  escape: 'Esc',
  enter: '↵',
  f1: 'F1',
  shift: '⇧',
}

/** Turns a token into the label printed on its key cap. */
export function keyLabel(token: string): string {
  const parts = token.split('+')
  const base = parts.pop() ?? ''
  const prefix = parts
    .map((p) => (p === 'shift' ? '⇧' : p === 'alt' ? '⌥' : '⌘'))
    .join('')
  const glyph = GLYPHS[base] ?? (base.length === 1 ? base.toUpperCase() : base)
  return prefix + glyph
}

/** The scope tag shown in the reference, e.g. "waveform only". */
export function bindingScope(binding: Binding): string {
  if (!binding.modes || binding.modes.length === MODES.length) return ''
  return binding.modes.map((m) => MODE_LABELS[m].toLowerCase()).join(' · ')
}

export { MODE_LABELS }
