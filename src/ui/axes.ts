/**
 * Graticule generation.
 *
 * One function produces both the line positions handed to the GPU and the tick labels placed
 * in the DOM, so a label can never end up next to the wrong line. Text stays in the DOM
 * deliberately: it renders with the platform's own hinting and subpixel positioning, it can be
 * selected and read by a screen reader, and it costs no font atlas.
 */

import type { Config, Mode } from '../config.ts'
import { degreeOf, isTwelveTone, noteHz, noteName } from '../dsp/tuning.ts'
import { findTuning } from '../dsp/tunings.ts'

export interface GridLine {
  /** Position along its axis, 0..1. */
  pos: number
  horizontal: boolean
  /** Brightness multiplier — major lines are brighter than minor ones. */
  weight: number
  width: number
}

export interface AxisTick {
  pos: number
  horizontal: boolean
  label: string
}

export interface Graticule {
  lines: GridLine[]
  ticks: AxisTick[]
}

function freqAxis(f: number, min: number, max: number, log: boolean): number {
  if (log) {
    const lo = Math.log2(Math.max(min, 1))
    const hi = Math.log2(Math.max(max, min + 1))
    return (Math.log2(Math.max(f, 1)) - lo) / (hi - lo)
  }
  return (f - min) / Math.max(max - min, 1)
}

function formatHz(f: number): string {
  if (f >= 1000) {
    const k = f / 1000
    return `${k >= 10 ? k.toFixed(0) : k.toFixed(1)}k`
  }
  if (f >= 100) return f.toFixed(0)
  return f >= 10 ? f.toFixed(0) : f.toFixed(1)
}

function formatTime(seconds: number): string {
  const ms = seconds * 1000
  if (Math.abs(ms) < 1) return `${(ms * 1000).toFixed(0)}µs`
  if (Math.abs(ms) < 1000) return `${ms.toFixed(ms < 10 ? 2 : 0)}ms`
  return `${seconds.toFixed(2)}s`
}

/** Decade ticks at 1, 2, 5 (major) and 3, 4, 6, 7, 8, 9 (minor). */
function decadeFrequencies(min: number, max: number): { f: number; major: boolean }[] {
  const out: { f: number; major: boolean }[] = []
  const startDecade = Math.floor(Math.log10(Math.max(min, 1)))
  const endDecade = Math.ceil(Math.log10(Math.max(max, 10)))
  for (let d = startDecade; d <= endDecade; d++) {
    const base = Math.pow(10, d)
    for (const m of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const f = base * m
      if (f < min || f > max) continue
      out.push({ f, major: m === 1 || m === 2 || m === 5 })
    }
  }
  return out
}

/**
 * The notes of the tuning that fall inside a frequency range, with the ones worth naming marked.
 *
 * Two densities, one rule each. A line is dropped when it would land within `MIN_LINE` of the
 * previous one, because past that the graticule stops being a scale and becomes a wash — and at
 * the bottom of a log axis, where a semitone is a few hundredths of a pixel, it would be a very
 * expensive wash. A label is placed on the roots of the scale, which on a keyboard means every C,
 * unless the range is narrow enough to hold no roots at all — a spectrum zoomed into a hundred
 * hertz is not improved by being the only axis on screen with nothing written on it, so there
 * the notes themselves are named.
 */
function noteLines(
  config: Config,
  min: number,
  max: number,
  log: boolean,
): { pos: number; root: boolean; label?: string }[] {
  /** Nearest two lines, as a fraction of the axis. */
  const MIN_LINE = 0.006
  /** And of two labels, which need room for the text between them. */
  const MIN_LABEL = 0.045

  const settings = config.tuning
  const tuning = findTuning(settings.imported, settings.id)
  const twelve = isTwelveTone(tuning)
  const count = tuning.kind === 'scale' ? tuning.degrees.length : 12
  const octaves = tuning.kind === 'map' || Math.abs(tuning.period - 1200) < 1e-6

  const found: { pos: number; root: boolean; hz: number; midi: number }[] = []
  let previous = -Infinity
  // Low enough to be under any hearing and high enough to be over it: a keyboard is 128 keys, a
  // spectrum axis runs to the Nyquist frequency, and the scale carries on past both of them.
  for (let midi = -24; midi <= 200; midi++) {
    const hz = noteHz(tuning, midi, settings)
    if (hz < min) continue
    if (hz > max) break
    const pos = freqAxis(hz, min, max, log)
    if (pos - previous < MIN_LINE) continue
    previous = pos
    found.push({ pos, root: degreeOf(tuning, midi, settings.root) === 0, hz, midi })
  }

  /**
   * What to write against a note.
   *
   * A twelve-tone scale wears the keyboard's names however far its tuning has moved them, since
   * the key is still the key. A scale that is not twelve to the octave has no keyboard to borrow
   * from, so only its period roots are named, and named for the octave they open — nineteen steps
   * up from middle C is still the C above it, whatever MIDI number the step landed on. A scale
   * with no octave in it has neither, and its roots are given their frequency, which is the one
   * thing that is true of them.
   */
  const name = (note: { midi: number; hz: number; root: boolean }): string => {
    if (twelve) return noteName(note.midi)
    if (!octaves) return formatHz(note.hz)
    return noteName(settings.root + 12 * Math.floor((note.midi - settings.root) / count))
  }

  const roots = found.filter((note) => note.root).length
  let labelled = -Infinity
  return found.map((note) => {
    const worth = roots > 1 ? note.root : twelve
    if (!worth || note.pos - labelled < MIN_LABEL) return { pos: note.pos, root: note.root }
    labelled = note.pos
    return { pos: note.pos, root: note.root, label: name(note) }
  })
}

function niceStep(range: number, target: number): number {
  const raw = range / Math.max(target, 1)
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1
  return step * mag
}

export function buildGraticule(
  mode: Mode,
  config: Config,
  timebaseSeconds: number,
  nyquist: number,
  /** Pane width over height. Only the vectorscope needs it — see below. */
  aspect = 1,
): Graticule {
  const lines: GridLine[] = []
  const ticks: AxisTick[] = []
  /** Both frequency axes are divided the same way, whichever way that is. */
  const notes = config.tuning.mode === 'note'
  const push = (pos: number, horizontal: boolean, major: boolean, label?: string) => {
    if (!(pos >= 0 && pos <= 1)) return
    lines.push({ pos, horizontal, weight: major ? 1 : 0.42, width: major ? 1.25 : 1 })
    if (label !== undefined) ticks.push({ pos, horizontal, label })
  }

  if (mode === 'wave') {
    // Amplitude divisions. The centre line is drawn brightest: it is the zero reference and
    // the thing the eye uses to judge DC offset and asymmetry.
    for (const v of [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1]) {
      const y = (1 - v) / 2
      const major = v === 0 || Math.abs(v) === 1
      push(y, true, major, major || Math.abs(v) === 0.5 ? v.toFixed(2) : undefined)
    }
    const divisions = 10
    for (let i = 0; i <= divisions; i++) {
      const t = i / divisions
      push(
        t,
        false,
        i === 0 || i === divisions || i === divisions / 2,
        i % 2 === 0 ? formatTime(t * timebaseSeconds) : undefined,
      )
    }
    return { lines, ticks }
  }

  if (mode === 'spectrum') {
    const { freqMin, freqMax, logFrequency, dbMin, dbMax } = config.spectrum
    const fMax = Math.min(freqMax, nyquist)
    if (notes) {
      for (const note of noteLines(config, freqMin, fMax, logFrequency)) {
        push(note.pos, false, note.root, note.label)
      }
    } else if (logFrequency) {
      for (const { f, major } of decadeFrequencies(freqMin, fMax)) {
        push(freqAxis(f, freqMin, fMax, true), false, major, major ? formatHz(f) : undefined)
      }
    } else {
      const step = niceStep(fMax - freqMin, 10)
      for (let f = Math.ceil(freqMin / step) * step; f <= fMax; f += step) {
        push(freqAxis(f, freqMin, fMax, false), false, true, formatHz(f))
      }
    }
    const dbStep = niceStep(dbMax - dbMin, 10)
    for (let db = Math.ceil(dbMin / dbStep) * dbStep; db <= dbMax; db += dbStep) {
      const y = 1 - (db - dbMin) / (dbMax - dbMin)
      push(y, true, db % (dbStep * 2) === 0, `${db.toFixed(0)}`)
    }
    return { lines, ticks }
  }

  if (mode === 'spectrogram') {
    const { freqMin, freqMax, logFrequency, historySeconds } = config.spectrogram
    const fMax = Math.min(freqMax, nyquist)
    if (notes) {
      // Frequency runs bottom to top here, so every position is inverted.
      for (const note of noteLines(config, freqMin, fMax, logFrequency)) {
        push(1 - note.pos, true, note.root, note.label)
      }
    } else if (logFrequency) {
      for (const { f, major } of decadeFrequencies(freqMin, fMax)) {
        push(1 - freqAxis(f, freqMin, fMax, true), true, major, major ? formatHz(f) : undefined)
      }
    } else {
      const step = niceStep(fMax - freqMin, 10)
      for (let f = Math.ceil(freqMin / step) * step; f <= fMax; f += step) {
        push(1 - freqAxis(f, freqMin, fMax, false), true, true, formatHz(f))
      }
    }
    const tStep = niceStep(historySeconds, 8)
    for (let t = 0; t <= historySeconds + 1e-6; t += tStep) {
      // Time runs left (oldest) to right (now), labelled as seconds ago.
      push(1 - t / historySeconds, false, true, t === 0 ? 'now' : `-${t.toFixed(1)}s`)
    }
    return { lines, ticks }
  }

  // Vectorscope: centre cross, an outer ruling at ±1 and an inner one at ±0.5. Both modes use
  // the same two, because both are scaled so that the same signals land on them:
  //
  //   ±1     a full-scale signal — mono at the top of the mid/side figure, out of phase at its
  //          side, and either channel on its own axis in Lissajous
  //   ±0.5   one channel at full scale, which in mid/side puts the figure on the diagonal
  //
  // The mid/side rotation used to divide by sqrt(2) rather than by 2, which sent a full-scale
  // mono signal to 1.414 — past the outer ruling and off the pane — while this comment claimed
  // it landed on ±0.707. The graticule and the shader now agree; see gpu/shaders/draw_vector.wgsl.
  //
  // The figure is scaled by the pane's *shorter* side so that a circle stays a circle, so on a
  // pane that is not square the reference is not a fixed fraction of the width. Squaring the
  // horizontal divisions up here is what keeps the graticule meaning the same thing on both
  // axes: an amplitude, not a proportion of however wide the pane happens to be.
  const squeeze = aspect > 1 ? 1 / aspect : 1
  const stretch = aspect < 1 ? aspect : 1
  const lissajous = config.vector.mode === 'lissajous'
  for (const v of [-1, -0.5, 0, 0.5, 1]) {
    const major = v === 0
    push(0.5 + (v * squeeze) / 2, false, major)
    push(0.5 - (v * stretch) / 2, true, major)
  }
  // Unrotated the axes are the channels themselves: X is left, Y is right.
  ticks.push({ pos: 0.5, horizontal: false, label: lissajous ? 'L' : 'S' })
  ticks.push({ pos: 0.5, horizontal: true, label: lissajous ? 'R' : 'M' })
  return { lines, ticks }
}
