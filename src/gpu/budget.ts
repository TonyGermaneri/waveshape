/**
 * One budget for everything the GPU is asked to hold and to do.
 *
 * The settings that cost memory were each bounded on their own and never against each other,
 * which is how a configuration that is reasonable in every individual respect adds up to one
 * that is not. At the top of every range: a 12-second history at a 128-sample hop and 192 kHz
 * is 8192 columns, at 4096 rows of `rgba16float`, which is 256 MiB on its own; a 4K viewport at
 * render scale 2 with 4x MSAA is another 253 MiB of scene target before the resolve, the
 * accumulator and the bloom chain; the analysis buffers are a fixed 55 MiB; the particle pool is
 * 8 MiB. Nothing in that list knows about anything else in it.
 *
 * There is no VRAM query in WebGPU — deliberately, since it would be a fingerprinting surface —
 * so the ceiling here is a heuristic derived from the one allocation limit the device does
 * report. It is not a hard guarantee and is not treated as one: exceeding it degrades the two
 * settings that can be changed between one frame and the next, and *reports* the rest rather
 * than silently rewriting what the panel says.
 */

import {
  BLOOM_DIVISOR,
  COMPLEX_BUDGET,
  FIELD_BINS,
  MAX_COLUMNS,
  MAX_FFT_SIZE,
  MAX_LAGS,
  PARTICLE_CAPACITY,
  POINT_BUDGET,
  RING_CAPACITY,
  SCENE_BYTES_PER_TEXEL,
} from './limits.ts'
import { PARTICLE_BYTES } from './particle.ts'

export interface BudgetInputs {
  /** Framebuffer size in device pixels, after the render scale. */
  width: number
  height: number
  /** MSAA sample count for the scene target. */
  sampleCount: number
  /** Spectrogram history, in analysis columns and frequency rows. */
  historyColumns: number
  historyRows: number
  /** Whether a spectrogram pane is open at all. */
  spectrogram: boolean
  /** Capture channels, which size the GPU's mirror of the audio ring. */
  channels: number
  /** Life's population cap and trail length, which cost draw instances rather than bytes. */
  population: number
  trail: number
  lifeEnabled: boolean
  /** Panes currently drawing the population. */
  livePanes: number
}

export interface BudgetLine {
  label: string
  bytes: number
}

export interface BudgetReport {
  lines: BudgetLine[]
  total: number
  ceiling: number
  /** Draw instances per frame for the population across every pane showing it. */
  lifeInstances: number
}

/** Fixed cost of the analysis chain: allocated once at the maximum and reinterpreted. */
function analysisBytes(channels: number): number {
  const bins = 2 * (MAX_FFT_SIZE / 2 + 1) * 4
  return (
    MAX_FFT_SIZE * 3 * 4 + // window, t*w and dw/dn tables
    MAX_FFT_SIZE * 8 + // twiddles
    COMPLEX_BUDGET * 8 * 2 + // the FFT ping-pong pair
    (COMPLEX_BUDGET + 8192) * 8 + // unpacked bins
    bins * 3 + // spectrum, peaks, average
    POINT_BUDGET * 16 + // reassigned points
    MAX_COLUMNS * 2 * 16 * 2 + // spectrum columns and waveform envelope
    MAX_LAGS * 4 + // NSDF
    RING_CAPACITY * Math.max(1, channels) * 4 // the GPU's mirror of the audio ring
  )
}

/** Fixed cost of the organism, whether or not it is switched on. */
function lifeBytes(): number {
  return PARTICLE_CAPACITY * PARTICLE_BYTES + FIELD_BINS * 4 * 3
}

/** Offscreen surfaces: multisampled scene, its resolve, the accumulator and the bloom pair. */
function targetBytes(width: number, height: number, sampleCount: number): number {
  const full = width * height * SCENE_BYTES_PER_TEXEL
  const bw = Math.max(1, Math.floor(width / BLOOM_DIVISOR))
  const bh = Math.max(1, Math.floor(height / BLOOM_DIVISOR))
  return full * sampleCount + full * 2 + bw * bh * SCENE_BYTES_PER_TEXEL * 2
}

/**
 * A ceiling for total GPU allocation, in bytes.
 *
 * `maxBufferSize` is the largest single allocation the device admits to, and on every adapter
 * this has been checked against it tracks the memory class: 256 MiB on the floor the spec
 * requires, 2 GiB and up on discrete parts. Eight times it, held between 512 MiB and 4 GiB, is
 * a defensible working figure for "how much of this device may we hold at once". It is a
 * heuristic and nothing here treats it as more than one.
 */
export function budgetCeiling(limits: GPUSupportedLimits): number {
  const max = Number(limits.maxBufferSize ?? 268435456)
  return Math.max(512 * 1024 * 1024, Math.min(4 * 1024 * 1024 * 1024, max * 8))
}

export function estimateBudget(inputs: BudgetInputs, ceiling: number): BudgetReport {
  const lines: BudgetLine[] = [
    { label: 'Analysis', bytes: analysisBytes(inputs.channels) },
    { label: 'Render targets', bytes: targetBytes(inputs.width, inputs.height, inputs.sampleCount) },
    {
      label: 'Spectrogram history',
      bytes: inputs.spectrogram
        ? inputs.historyColumns * inputs.historyRows * SCENE_BYTES_PER_TEXEL
        : 0,
    },
    { label: 'Harmonic life', bytes: lifeBytes() },
  ]
  const total = lines.reduce((n, line) => n + line.bytes, 0)
  // A trail is a quad per step per particle, and the waveform multiplies it again by its
  // polyline segments — no memory at all, and the largest single number in the program.
  const perPane = inputs.population * (Math.max(0, Math.round(inputs.trail)) + 1)
  return {
    lines,
    total,
    ceiling,
    lifeInstances: inputs.lifeEnabled ? perPane * Math.max(0, inputs.livePanes) : 0,
  }
}

export interface BudgetCaps {
  /** Ceiling on spectrogram history columns. */
  historyColumns: number
  /** Ceiling on the living population. */
  population: number
  /** What had to be reduced to fit, in the order it was reduced. Empty when nothing was. */
  reduced: string[]
}

/**
 * Bring an over-budget configuration back under it.
 *
 * Only two things are reduced, and the choice is about what can honestly be changed between one
 * frame and the next. Render scale and MSAA cannot: both rebuild the entire target chain, and a
 * budget that flipped them while a window was being resized would spend its life reallocating.
 * History length and population can — the history is a ring that is cleared and refilled anyway,
 * and the population is a cap on a ring of slots. The history goes first because it is the
 * larger allocation by an order of magnitude and because losing the oldest seconds of a
 * spectrogram is a smaller loss than losing half the organism.
 *
 * What is *not* reduced is still reported, so an over-budget setup that this cannot rescue says
 * so rather than quietly running out of memory later.
 */
export function fitToBudget(inputs: BudgetInputs, ceiling: number): BudgetCaps {
  const reduced: string[] = []
  let historyColumns = inputs.historyColumns
  let population = inputs.population

  const fixed =
    analysisBytes(inputs.channels) +
    lifeBytes() +
    targetBytes(inputs.width, inputs.height, inputs.sampleCount)

  const historyTexel = Math.max(1, inputs.historyRows) * SCENE_BYTES_PER_TEXEL
  if (inputs.spectrogram && fixed + historyColumns * historyTexel > ceiling) {
    // Never below 256 columns: a spectrogram narrower than its own pane is not a spectrogram.
    const room = Math.floor((ceiling - fixed) / historyTexel)
    const capped = Math.max(256, Math.min(historyColumns, room))
    if (capped < historyColumns) {
      historyColumns = capped
      reduced.push('spectrogram history')
    }
  }

  // The population costs a fixed 8 MB whatever the cap is — the pool is allocated once — so this
  // is a *work* reduction, not a memory one, and it only applies once memory is already lost.
  if (fixed > ceiling) {
    const capped = Math.min(population, 24000)
    if (capped < population) {
      population = capped
      reduced.push('population')
    }
    reduced.push('render scale and MSAA are over budget and cannot be changed mid-frame')
  }

  return { historyColumns, population, reduced }
}

/** Bytes as the panel wants to read them. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 ** 2)} MiB`
  return `${Math.round(bytes / 1024)} KiB`
}
