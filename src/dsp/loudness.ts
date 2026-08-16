/**
 * ITU-R BS.1770-4 / EBU R 128 loudness metering, plus BS.1770-4 Annex 2 true-peak.
 *
 * Runs on f64 in a worker, fed from the same lock-free ring the GPU reads, so the meters see
 * every captured sample rather than a screen-rate approximation.
 */

import {
  type BiquadCoeffs,
  BiquadState,
  biquadProcess,
  kWeightingHighPass,
  kWeightingShelf,
} from './biquad.ts'

/** Absolute gating threshold, LUFS (BS.1770-4 clause 5.3). */
const ABSOLUTE_GATE_LUFS = -70
/** Relative gate offset below the ungated mean, LU. */
const RELATIVE_GATE_LU = -10
/** The empirical offset in the loudness equation. */
const LOUDNESS_OFFSET = -0.691
/** Gating block length, seconds. */
const BLOCK_SECONDS = 0.4
/** Gating block overlap: 75%, i.e. a new block every 100 ms. */
const BLOCK_STEP_SECONDS = 0.1
/** Short-term window, seconds (EBU Tech 3341). */
const SHORT_TERM_SECONDS = 3

/** BS.1770-4 channel weights. Stereo/mono only use unity; surround channels weigh 1.41. */
const CHANNEL_WEIGHT = [1.0, 1.0, 1.0, 1.41, 1.41]

export interface LoudnessReading {
  /** Momentary loudness over the last 400 ms, LUFS. */
  momentary: number
  /** Short-term loudness over the last 3 s, LUFS. */
  shortTerm: number
  /** Gated integrated loudness since the last reset, LUFS. */
  integrated: number
  /** Loudness range (EBU Tech 3342), LU. */
  range: number
  /** Highest inter-sample peak since reset, dBTP. */
  truePeakDb: number
  /** Highest sample peak since reset, dBFS. */
  samplePeakDb: number
  /** Interchannel phase correlation over the recent window, -1..1. */
  correlation: number
  /** Seconds of audio integrated. */
  seconds: number
}

/**
 * Polyphase FIR interpolator for inter-sample peak detection.
 *
 * BS.1770-4 Annex 2 specifies a minimum of 4x oversampling at 48 kHz. We build a Kaiser-
 * windowed sinc with 32 taps per phase (the Recommendation's reference filter uses 12),
 * which puts the passband ripple and stopband rejection comfortably inside the tolerance.
 * Above 48 kHz the Nyquist headroom means fewer phases are needed for the same accuracy.
 */
class TruePeakOversampler {
  private readonly phases: Float64Array[]
  private readonly tapsPerPhase: number
  private readonly history: Float64Array
  private historyPos = 0

  constructor(factor: number, tapsPerPhase = 32) {
    this.tapsPerPhase = tapsPerPhase
    this.phases = []
    const totalTaps = factor * tapsPerPhase
    const beta = 9.0
    const proto = new Float64Array(totalTaps)
    const centre = (totalTaps - 1) / 2
    for (let i = 0; i < totalTaps; i++) {
      const t = (i - centre) / factor
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)
      const u = (2 * i) / (totalTaps - 1) - 1
      const r = Math.max(0, 1 - u * u)
      proto[i] = sinc * (besselI0(beta * Math.sqrt(r)) / besselI0(beta))
    }
    for (let p = 0; p < factor; p++) {
      const phase = new Float64Array(tapsPerPhase)
      let sum = 0
      for (let k = 0; k < tapsPerPhase; k++) {
        phase[k] = proto[k * factor + p]
        sum += phase[k]
      }
      // Unity DC gain per phase keeps a constant input from producing a peak overshoot.
      if (sum !== 0) for (let k = 0; k < tapsPerPhase; k++) phase[k] /= sum
      this.phases.push(phase)
    }
    this.history = new Float64Array(tapsPerPhase)
  }

  /** Returns the maximum absolute interpolated value over the block. */
  push(samples: Float64Array, count: number): number {
    let peak = 0
    const taps = this.tapsPerPhase
    for (let i = 0; i < count; i++) {
      this.history[this.historyPos] = samples[i]
      this.historyPos = (this.historyPos + 1) % taps
      for (const phase of this.phases) {
        let acc = 0
        let idx = this.historyPos
        for (let k = taps - 1; k >= 0; k--) {
          acc += phase[k] * this.history[idx]
          idx = (idx + 1) % taps
        }
        const a = Math.abs(acc)
        if (a > peak) peak = a
      }
    }
    return peak
  }
}

function besselI0(x: number): number {
  let sum = 1
  let term = 1
  const q = (x * x) / 4
  for (let k = 1; k < 64; k++) {
    term *= q / (k * k)
    sum += term
    if (term < sum * 1e-17) break
  }
  return sum
}

export class LoudnessMeter {
  private readonly sampleRate: number
  private readonly channels: number
  private readonly shelf: BiquadCoeffs
  private readonly hpf: BiquadCoeffs
  private readonly shelfState: BiquadState[]
  private readonly hpfState: BiquadState[]
  private readonly oversamplers: TruePeakOversampler[]

  private readonly blockSamples: number
  private readonly stepSamples: number
  /** Running sum of squares of the K-weighted signal within the current step, per channel. */
  private stepSum: Float64Array
  private stepCount = 0
  /** Ring of per-step mean squares, one entry per 100 ms, per channel. */
  private stepRing: Float64Array
  private stepRingLen: number
  private stepRingHead = 0
  private stepsSeen = 0

  /** Gated block loudness history (z values) for the integrated measurement. */
  private blockZ: number[] = []
  /** Short-term (3 s) block loudness history for LRA. */
  private shortTermZ: number[] = []
  private shortTermCounter = 0

  private truePeak = 0
  private samplePeak = 0
  private totalSamples = 0

  private corrLR = 0
  private corrLL = 0
  private corrRR = 0
  private readonly corrDecay: number

  private readonly scratchIn: Float64Array
  private readonly scratchA: Float64Array
  private readonly scratchB: Float64Array

  constructor(sampleRate: number, channels: number, maxBlock = 8192) {
    this.sampleRate = sampleRate
    this.channels = channels
    this.shelf = kWeightingShelf(sampleRate)
    this.hpf = kWeightingHighPass(sampleRate)
    this.shelfState = Array.from({ length: channels }, () => new BiquadState())
    this.hpfState = Array.from({ length: channels }, () => new BiquadState())

    const factor = sampleRate <= 48000 ? 4 : sampleRate <= 96000 ? 2 : 1
    this.oversamplers = Array.from(
      { length: channels },
      () => new TruePeakOversampler(Math.max(1, factor)),
    )

    this.blockSamples = Math.round(BLOCK_SECONDS * sampleRate)
    this.stepSamples = Math.round(BLOCK_STEP_SECONDS * sampleRate)
    this.stepRingLen = Math.round(SHORT_TERM_SECONDS / BLOCK_STEP_SECONDS) + 4
    this.stepSum = new Float64Array(channels)
    this.stepRing = new Float64Array(this.stepRingLen * channels)

    // ~300 ms exponential window for the correlation meter.
    this.corrDecay = Math.exp(-1 / (0.3 * sampleRate))

    this.scratchIn = new Float64Array(maxBlock)
    this.scratchA = new Float64Array(maxBlock)
    this.scratchB = new Float64Array(maxBlock)
  }

  reset(): void {
    for (const s of this.shelfState) s.reset()
    for (const s of this.hpfState) s.reset()
    this.stepSum.fill(0)
    this.stepRing.fill(0)
    this.stepCount = 0
    this.stepRingHead = 0
    this.stepsSeen = 0
    this.blockZ = []
    this.shortTermZ = []
    this.shortTermCounter = 0
    this.truePeak = 0
    this.samplePeak = 0
    this.totalSamples = 0
    this.corrLR = this.corrLL = this.corrRR = 0
  }

  /**
   * Feed one planar block of up to `maxBlock` frames.
   *
   * `planes[c]` is the channel's storage, `offsets[c]` the absolute index of the first frame,
   * and `mask` wraps that index into the storage. Callers reading a ring pass capacity - 1;
   * callers holding a standalone block pass offset 0 and length - 1, which requires the block
   * length to be a power of two.
   */
  process(planes: Float32Array[], offsets: number[], count: number, mask: number): void {
    const n = Math.min(count, this.scratchIn.length)
    if (n <= 0) return

    for (let c = 0; c < this.channels; c++) {
      const src = planes[Math.min(c, planes.length - 1)]
      const base = offsets[Math.min(c, offsets.length - 1)]
      for (let i = 0; i < n; i++) this.scratchIn[i] = src[(base + i) & mask]

      // Sample peak and true peak on the *unweighted* signal, per the Recommendation.
      for (let i = 0; i < n; i++) {
        const a = Math.abs(this.scratchIn[i])
        if (a > this.samplePeak) this.samplePeak = a
      }
      const tp = this.oversamplers[c].push(this.scratchIn, n)
      if (tp > this.truePeak) this.truePeak = tp

      // K-weighting: high shelf then RLB high-pass.
      biquadProcess(this.shelf, this.shelfState[c], this.scratchIn, this.scratchA, n)
      biquadProcess(this.hpf, this.hpfState[c], this.scratchA, this.scratchB, n)

      let sum = 0
      for (let i = 0; i < n; i++) sum += this.scratchB[i] * this.scratchB[i]
      this.stepSum[c] += sum
    }

    if (this.channels >= 2 && planes.length >= 2) {
      const l = planes[0]
      const r = planes[1]
      const lo = offsets[0]
      const ro = offsets[Math.min(1, offsets.length - 1)]
      const lm = mask
      const rm = mask
      let lr = this.corrLR
      let ll = this.corrLL
      let rr = this.corrRR
      const d = this.corrDecay
      for (let i = 0; i < n; i++) {
        const a = l[(lo + i) & lm]
        const b = r[(ro + i) & rm]
        lr = lr * d + a * b
        ll = ll * d + a * a
        rr = rr * d + b * b
      }
      this.corrLR = lr
      this.corrLL = ll
      this.corrRR = rr
    }

    this.totalSamples += n
    this.stepCount += n
    while (this.stepCount >= this.stepSamples) {
      this.commitStep()
      this.stepCount -= this.stepSamples
    }
  }

  private commitStep(): void {
    for (let c = 0; c < this.channels; c++) {
      this.stepRing[this.stepRingHead * this.channels + c] = this.stepSum[c] / this.stepSamples
      this.stepSum[c] = 0
    }
    this.stepRingHead = (this.stepRingHead + 1) % this.stepRingLen
    this.stepsSeen++

    // A 400 ms gating block is four consecutive 100 ms steps.
    const stepsPerBlock = Math.round(this.blockSamples / this.stepSamples)
    if (this.stepsSeen >= stepsPerBlock) {
      const z = this.meanSquareOverSteps(stepsPerBlock)
      const l = LOUDNESS_OFFSET + 10 * Math.log10(z)
      if (l > ABSOLUTE_GATE_LUFS) this.blockZ.push(z)
    }

    // Short-term blocks for LRA, one per second (3 s window, 66.7% overlap minimum).
    const stepsPerShortTerm = Math.round(SHORT_TERM_SECONDS / BLOCK_STEP_SECONDS)
    this.shortTermCounter++
    if (this.stepsSeen >= stepsPerShortTerm && this.shortTermCounter >= 10) {
      this.shortTermCounter = 0
      const z = this.meanSquareOverSteps(stepsPerShortTerm)
      const l = LOUDNESS_OFFSET + 10 * Math.log10(z)
      if (l > ABSOLUTE_GATE_LUFS) this.shortTermZ.push(z)
    }
  }

  /** Weighted mean square across channels over the last `steps` 100 ms steps. */
  private meanSquareOverSteps(steps: number): number {
    let acc = 0
    for (let c = 0; c < this.channels; c++) {
      const g = CHANNEL_WEIGHT[Math.min(c, CHANNEL_WEIGHT.length - 1)]
      let s = 0
      for (let k = 1; k <= steps; k++) {
        const idx = (this.stepRingHead - k + this.stepRingLen) % this.stepRingLen
        s += this.stepRing[idx * this.channels + c]
      }
      acc += g * (s / steps)
    }
    return Math.max(acc, 1e-30)
  }

  read(): LoudnessReading {
    const stepsPerBlock = Math.round(this.blockSamples / this.stepSamples)
    const stepsPerShortTerm = Math.round(SHORT_TERM_SECONDS / BLOCK_STEP_SECONDS)

    const momentary =
      this.stepsSeen >= stepsPerBlock
        ? LOUDNESS_OFFSET + 10 * Math.log10(this.meanSquareOverSteps(stepsPerBlock))
        : -Infinity
    const shortTerm =
      this.stepsSeen >= stepsPerShortTerm
        ? LOUDNESS_OFFSET + 10 * Math.log10(this.meanSquareOverSteps(stepsPerShortTerm))
        : -Infinity

    const denom = Math.sqrt(this.corrLL * this.corrRR)
    const correlation = denom > 1e-20 ? this.corrLR / denom : 0

    return {
      momentary,
      shortTerm,
      integrated: this.gatedIntegrated(),
      range: this.loudnessRange(),
      truePeakDb: this.truePeak > 0 ? 20 * Math.log10(this.truePeak) : -Infinity,
      samplePeakDb: this.samplePeak > 0 ? 20 * Math.log10(this.samplePeak) : -Infinity,
      correlation: Math.max(-1, Math.min(1, correlation)),
      seconds: this.totalSamples / this.sampleRate,
    }
  }

  /** BS.1770-4 clause 5.3: absolute gate, then a relative gate 10 LU below the ungated mean. */
  private gatedIntegrated(): number {
    if (this.blockZ.length === 0) return -Infinity
    let sum = 0
    for (const z of this.blockZ) sum += z
    const ungated = LOUDNESS_OFFSET + 10 * Math.log10(sum / this.blockZ.length)
    const relativeGate = ungated + RELATIVE_GATE_LU

    let gatedSum = 0
    let gatedCount = 0
    for (const z of this.blockZ) {
      if (LOUDNESS_OFFSET + 10 * Math.log10(z) > relativeGate) {
        gatedSum += z
        gatedCount++
      }
    }
    if (gatedCount === 0) return -Infinity
    return LOUDNESS_OFFSET + 10 * Math.log10(gatedSum / gatedCount)
  }

  /** EBU Tech 3342: 95th minus 10th percentile of gated short-term loudness. */
  private loudnessRange(): number {
    if (this.shortTermZ.length < 3) return 0
    let sum = 0
    for (const z of this.shortTermZ) sum += z
    const gate = LOUDNESS_OFFSET + 10 * Math.log10(sum / this.shortTermZ.length) - 20

    const kept: number[] = []
    for (const z of this.shortTermZ) {
      const l = LOUDNESS_OFFSET + 10 * Math.log10(z)
      if (l > gate) kept.push(l)
    }
    if (kept.length < 2) return 0
    kept.sort((a, b) => a - b)
    const pick = (p: number) => kept[Math.min(kept.length - 1, Math.round(p * (kept.length - 1)))]
    return pick(0.95) - pick(0.1)
  }
}
