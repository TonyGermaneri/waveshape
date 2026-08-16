/**
 * Graticule generation.
 *
 * One function produces both the line positions handed to the GPU and the tick labels placed
 * in the DOM, so a label can never end up next to the wrong line. Text stays in the DOM
 * deliberately: it renders with the platform's own hinting and subpixel positioning, it can be
 * selected and read by a screen reader, and it costs no font atlas.
 */

import type { Config, Mode } from '../config.ts'

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
): Graticule {
  const lines: GridLine[] = []
  const ticks: AxisTick[] = []
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
    if (logFrequency) {
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
    if (logFrequency) {
      for (const { f, major } of decadeFrequencies(freqMin, fMax)) {
        // Frequency runs bottom to top, so the axis position is inverted.
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

  // Vectorscope: centre cross plus the +/-0.707 reference, which is where a full-scale
  // correlated signal reaches on the rotated mid/side axes.
  for (const v of [-1, -Math.SQRT1_2, 0, Math.SQRT1_2, 1]) {
    const p = (v + 1) / 2
    const major = v === 0
    push(p, true, major)
    push(p, false, major)
  }
  ticks.push({ pos: 0.5, horizontal: false, label: 'S' })
  ticks.push({ pos: 0.5, horizontal: true, label: 'M' })
  return { lines, ticks }
}
