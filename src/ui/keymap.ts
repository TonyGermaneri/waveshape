/**
 * The keyboard map.
 *
 * One declarative table drives three things: the dispatcher, the on-screen reference, and the
 * hints printed next to the controls. There is no second list of shortcuts to fall out of date,
 * and `keymap.test.ts` proves no two bindings can be reachable from the same keystroke at once.
 *
 * Every key means one thing, everywhere. All four visualisations are on screen at once, so a
 * binding that depended on which one had "focus" would be a binding you had to aim before you
 * could use — and aiming is a step that exists only to work around an ambiguity. Where two
 * panes share a concept the key moves both of them: the frequency keys pan the spectrum and the
 * spectrogram together, because both have a frequency axis and there is no sense in which one
 * of them is the one you meant.
 *
 * Pairs are laid out so the left key of each physical pair decreases and the right key
 * increases: `-` `=`, `[` `]`, `q` `w`, `a` `s`, `o` `p`, `z` `x`, `.` `/`, `;` `'`, `9` `0`.
 * Shift on a pair reaches the related quantity — `o` `p` is the oscilloscope's span, `⇧O` `⇧P`
 * the spectrogram's.
 */

import { FFT_SIZES, type Config, type Mode } from '../config.ts'
import { WINDOWS } from '../dsp/windows.ts'
import { PALETTES } from '../gpu/colormap.ts'
import { fmt } from './widgets.ts'

export const KEY_GROUPS = [
  'Panel',
  'Panes',
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
  /** Moves the panel to the next placement — the four edges, then floating. */
  cycleDock(dir: number): string
  cycleTheme(dir: number): string
  restartSource(): void
  stopSource(): void
  resetMeters(): void
  resetLayout(): void
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
  detail?: string
  /** Live only in some states — never "only in some pane", which is the thing focus was for. */
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

/** Prints one value when both panes agree, and both when they have been pulled apart. */
const agree = (a: string, b: string): string => (a === b ? a : `${a}  ·  ${b}`)

const gainText = (v: number): string => `${v.toFixed(2)}×  (${(20 * Math.log10(v)).toFixed(1)} dB)`

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
  {
    // Forward only: `h` already hides the panel, and its shifted twin cannot itself be shifted.
    keys: one('shift+h'),
    label: 'Panel placement',
    group: 'Panel',
    detail:
      'Right, bottom, left, top, then floating. A docked panel takes its room out of the canvas; dragging the title bar does the same thing by hand.',
    structural: true,
    run: (ctx, arg) => `Panel  ${ctx.actions.cycleDock(arg)}`,
  },

  // ------------------------------------------------------------------------------ panes
  {
    keys: MODES.map((_, i) => ({ token: String(i + 1), arg: i })),
    label: 'Switch a visualisation on or off',
    group: 'Panes',
    detail:
      'The grid collapses around whatever is left: three panes leave one spanning the width, two become halves, one fills the screen.',
    structural: true,
    run: (ctx, arg) => {
      const mode = MODES[arg]
      const panes = ctx.config.panes
      const next = !panes[mode]
      // Switching off the last one would leave an analyzer with nothing to look at.
      if (!next && MODES.filter((m) => panes[m]).length <= 1) {
        return `${MODE_LABELS[mode]} is the last pane open`
      }
      panes[mode] = next
      return `${MODE_LABELS[mode]}  ${next ? 'on' : 'off'}`
    },
  },
  {
    keys: one('\\'),
    label: 'Reset the pane layout',
    group: 'Panes',
    structural: true,
    run: (ctx) => {
      ctx.actions.resetLayout()
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
    keys: one('m'),
    label: 'Magnitude scale',
    group: 'Analysis',
    values: ['amplitude', 'density'] as const,
    labels: ['Amplitude (dBFS)', 'Density (dBFS/√Hz)'],
    get: (c) => c.analysis.scale,
    set: (c, v) => {
      c.analysis.scale = v
    },
  }),

  // ------------------------------------------------------------------------------ display
  //
  // Nothing here asks which pane you meant. Where a control belongs to one visualisation it has
  // a key of its own; where two of them share an axis, one key moves both.
  {
    keys: [
      { token: 'arrowup', arg: 1 },
      { token: 'arrowdown', arg: -1 },
    ],
    label: 'Vertical gain',
    group: 'Display',
    detail:
      'The oscilloscope and the vectorscope together — both are a deflection off a centre line. Each keeps its own value, so a ratio set between them survives the key.',
    run: (ctx, arg) => {
      const step = (v: number) => clamp(v * Math.pow(1.15, arg), 0.05, 64)
      ctx.config.wave.gain = step(ctx.config.wave.gain)
      ctx.config.vector.gain = step(ctx.config.vector.gain)
      return `Vertical gain  ${agree(gainText(ctx.config.wave.gain), gainText(ctx.config.vector.gain))}`
    },
  },
  {
    keys: [
      { token: 'shift+arrowup', arg: 1 },
      { token: 'shift+arrowdown', arg: -1 },
    ],
    label: 'Level window',
    group: 'Display',
    detail: 'Slides floor and ceiling together, 2 dB at a time, in the spectrum and the spectrogram.',
    run: (ctx, arg) => {
      const s = ctx.config.spectrum
      const g = ctx.config.spectrogram
      const a = { lo: s.dbMin, hi: s.dbMax }
      const b = { lo: g.dbFloor, hi: g.dbCeil }
      const textA = shiftDb(a, arg, -200, 40)
      const textB = shiftDb(b, arg, -160, 20)
      s.dbMin = a.lo
      s.dbMax = a.hi
      g.dbFloor = b.lo
      g.dbCeil = b.hi
      return `Level window  ${agree(textA, textB)}`
    },
  },
  {
    keys: pair('arrowleft', 'arrowright'),
    label: 'Pan the frequency range',
    group: 'Display',
    detail: 'Both frequency axes at once — the spectrum and the spectrogram.',
    run: (ctx, arg) =>
      `Frequency  ${agree(panFrequency(ctx.config.spectrum, arg), panFrequency(ctx.config.spectrogram, arg))}`,
  },
  {
    keys: pair('shift+arrowleft', 'shift+arrowright'),
    label: 'Zoom the frequency range',
    group: 'Display',
    run: (ctx, arg) =>
      `Frequency  ${agree(zoomFrequency(ctx.config.spectrum, arg), zoomFrequency(ctx.config.spectrogram, arg))}`,
  },
  {
    keys: pair('o', 'p'),
    label: 'Oscilloscope span',
    group: 'Display',
    detail:
      'Pitch-locked, the span is a whole number of detected periods and this changes how many; otherwise it is a duration and this stretches it.',
    run: (ctx, arg) => {
      const w = ctx.config.wave
      if (w.trigger === 'pitch') {
        w.cycles = clamp(Math.round((w.cycles + arg * 0.25) * 4) / 4, 0.25, 32)
        return `Cycles shown  ${w.cycles} periods`
      }
      w.timebaseMs = clamp(w.timebaseMs * Math.pow(1.25, arg), 0.05, 5000)
      return `Time span  ${fmt.ms(w.timebaseMs)}`
    },
  },
  number_({
    keys: pair('shift+o', 'shift+p'),
    label: 'Spectrogram span',
    group: 'Display',
    get: (c) => c.spectrogram.historySeconds,
    set: (c, v) => {
      c.spectrogram.historySeconds = Math.round(v * 2) / 2
    },
    min: 1,
    max: 120,
    factor: 1.25,
    format: (v) => `${v.toFixed(1)} s`,
  }),
  {
    keys: one('k'),
    label: 'Logarithmic frequency axis',
    group: 'Display',
    structural: true,
    run: (ctx) => {
      // One key, one state: if they had drifted apart, this brings them together.
      const next = !ctx.config.spectrum.logFrequency
      ctx.config.spectrum.logFrequency = next
      ctx.config.spectrogram.logFrequency = next
      return `Logarithmic frequency axis  ${next ? 'on' : 'off'}`
    },
  },
  {
    keys: one('j'),
    label: 'Split channels into lanes',
    group: 'Display',
    structural: true,
    run: (ctx) => {
      const next = !ctx.config.wave.splitChannels
      ctx.config.wave.splitChannels = next
      ctx.config.spectrum.splitChannels = next
      return `Split channels into lanes  ${next ? 'on' : 'off'}`
    },
  },
  flag({
    key: 'v',
    label: 'Peak hold trace',
    group: 'Display',
    get: (c) => c.spectrum.showPeak,
    set: (c, v) => {
      c.spectrum.showPeak = v
    },
  }),
  flag({
    key: 'shift+v',
    label: 'RMS band',
    group: 'Display',
    get: (c) => c.wave.showRms,
    set: (c, v) => {
      c.wave.showRms = v
    },
  }),
  choice({
    keys: one('d'),
    label: 'Trigger',
    group: 'Display',
    values: ['pitch', 'level', 'free'] as const,
    labels: ['Pitch-locked', 'Level', 'Free run'],
    get: (c) => c.wave.trigger,
    set: (c, v) => {
      c.wave.trigger = v
    },
  }),
  choice({
    keys: one('shift+d'),
    label: 'Spectrum curve source',
    group: 'Display',
    values: ['live', 'average'] as const,
    labels: ['Instantaneous', 'Averaged'],
    get: (c) => c.spectrum.source,
    set: (c, v) => {
      c.spectrum.source = v
    },
  }),
  choice({
    keys: cycleKeys('n'),
    label: 'Spectrogram colour map',
    group: 'Display',
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
    label: 'Axis and pane labels',
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
    keys: one('shift+m'),
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
  return BINDINGS.filter((b) => !b.when || b.when(config))
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

export { MODE_LABELS }
