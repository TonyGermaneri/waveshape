import test from 'node:test'
import assert from 'node:assert/strict'

import { LoudnessMeter } from './loudness.ts'

/** A power-of-two scratch plane, so `length - 1` is a valid wrap mask. */
const PLANE = 1 << 16
const MASK = PLANE - 1

/**
 * Feeds `seconds` of a signal through a meter in fixed-size chunks and returns the reading.
 * The chunk size is the variable under test everywhere in this file.
 */
function meter(
  chunk: number,
  seconds: number,
  fs: number,
  sample: (t: number) => number,
): ReturnType<LoudnessMeter['read']> {
  const m = new LoudnessMeter(fs, 2, 8192)
  const plane = new Float32Array(PLANE)
  const planes = [plane, plane]
  const total = Math.round(seconds * fs)
  let written = 0
  let pos = 0
  while (written < total) {
    const n = Math.min(chunk, total - written)
    for (let i = 0; i < n; i++) plane[(pos + i) & MASK] = sample((written + i) / fs)
    m.process(planes, [pos, pos], n, MASK)
    pos = (pos + n) & MASK
    written += n
  }
  return m.read()
}

/**
 * The bug this pins: the whole incoming chunk used to be added to the running step sum before
 * any 100 ms step was committed, and each step then divided by `stepSamples` regardless of how
 * many samples had actually gone into it. A chunk spanning a boundary therefore inflated one
 * step and starved the next, and the reading became a function of the caller's buffer size.
 */
test('loudness does not depend on how the stream is chunked', () => {
  // Bursts, so energy is concentrated well inside individual 100 ms steps: this is the material
  // that a boundary error moves the furthest.
  const burst = (t: number) => (t % 0.25 < 0.03 ? 0.5 * Math.sin(2 * Math.PI * 1000 * t) : 0)
  const reference = meter(4800, 8, 48000, burst)
  for (const chunk of [1, 128, 777, 4799, 4801, 8192]) {
    const got = meter(chunk, 8, 48000, burst)
    assert.ok(
      Math.abs(got.integrated - reference.integrated) < 1e-9,
      `integrated at chunk ${chunk}: ${got.integrated} vs ${reference.integrated}`,
    )
    assert.ok(
      Math.abs(got.shortTerm - reference.shortTerm) < 1e-9,
      `short-term at chunk ${chunk}: ${got.shortTerm} vs ${reference.shortTerm}`,
    )
    assert.ok(
      Math.abs(got.momentary - reference.momentary) < 1e-9,
      `momentary at chunk ${chunk}: ${got.momentary} vs ${reference.momentary}`,
    )
  }
})

test('a block longer than the scratch buffer is measured, not truncated', () => {
  const tone = (t: number) => 0.5 * Math.sin(2 * Math.PI * 1000 * t)
  const short = meter(4800, 6, 48000, tone)
  const long = meter(48000, 6, 48000, tone)
  assert.ok(
    Math.abs(short.seconds - long.seconds) < 1e-9,
    `seconds integrated: ${short.seconds} vs ${long.seconds}`,
  )
  assert.ok(Math.abs(short.integrated - long.integrated) < 1e-9)
})

/**
 * True peak is the peak of the *reconstructed* waveform, and the sampled waveform is part of
 * that reconstruction. A meter that reads below the sample peak is measuring something else.
 */
test('true peak never reads below sample peak', () => {
  for (const fs of [44100, 48000, 88200, 96000, 176400, 192000]) {
    const m = new LoudnessMeter(fs, 1, 8192)
    const plane = new Float32Array(1024)
    plane[64] = 1
    plane[300] = -1
    m.process([plane], [0], 1024, 1023)
    const r = m.read()
    assert.ok(
      r.truePeakDb >= r.samplePeakDb - 1e-9,
      `${fs} Hz: ${r.truePeakDb} dBTP below ${r.samplePeakDb} dBFS`,
    )
    assert.ok(Math.abs(r.samplePeakDb) < 1e-9, `${fs} Hz: sample peak ${r.samplePeakDb}`)
    assert.ok(Math.abs(r.truePeakDb) < 0.01, `${fs} Hz: full-scale impulse read ${r.truePeakDb}`)
  }
})

test('true peak finds an inter-sample over the sample peak misses', () => {
  // A full-scale sine at exactly fs/4, sampled a quarter-cycle off the crests: every sample sits
  // at +/- 1/sqrt(2) while the waveform between them reaches 1.
  const fs = 48000
  const m = new LoudnessMeter(fs, 1, 8192)
  const plane = new Float32Array(4096)
  for (let i = 0; i < plane.length; i++) plane[i] = Math.sin(2 * Math.PI * 0.25 * i + Math.PI / 4)
  m.process([plane], [0], plane.length, plane.length - 1)
  const r = m.read()
  assert.ok(r.samplePeakDb < -2.9 && r.samplePeakDb > -3.1, `sample peak ${r.samplePeakDb}`)
  assert.ok(r.truePeakDb > -0.15, `true peak ${r.truePeakDb} missed the inter-sample crest`)
})

test('a full-scale sine reads its own level', () => {
  const fs = 48000
  const m = new LoudnessMeter(fs, 1, 8192)
  const plane = new Float32Array(1 << 14)
  // -6.02 dBFS, at a frequency that is not a submultiple of the rate.
  for (let i = 0; i < plane.length; i++) plane[i] = 0.5 * Math.sin((2 * Math.PI * 997 * i) / fs)
  m.process([plane], [0], plane.length, plane.length - 1)
  const r = m.read()
  assert.ok(Math.abs(r.samplePeakDb + 6.02) < 0.02, `sample peak ${r.samplePeakDb}`)
  assert.ok(Math.abs(r.truePeakDb + 6.02) < 0.05, `true peak ${r.truePeakDb}`)
})

test('a -23 dBFS reference tone integrates to -23 LUFS', () => {
  // BS.1770 calibration: a 1 kHz sine at -23 dBFS RMS in a *single* channel reads -23 LUFS.
  // K-weighting is flat to within a hundredth of a dB at 1 kHz, and the channel weight is
  // unity, so this is a direct check on the whole chain including the -0.691 offset. Feeding
  // the same tone to both channels would read -20: the standard sums channel powers.
  const fs = 48000
  const amplitude = Math.SQRT2 * Math.pow(10, -23 / 20)
  const m = new LoudnessMeter(fs, 1, 8192)
  const plane = new Float32Array(PLANE)
  const total = 10 * fs
  let written = 0
  let pos = 0
  while (written < total) {
    const n = Math.min(4800, total - written)
    for (let i = 0; i < n; i++) {
      plane[(pos + i) & MASK] = amplitude * Math.sin((2 * Math.PI * 1000 * (written + i)) / fs)
    }
    m.process([plane], [pos], n, MASK)
    pos = (pos + n) & MASK
    written += n
  }
  const r = m.read()
  assert.ok(Math.abs(r.integrated + 23) < 0.1, `integrated ${r.integrated}`)
  assert.ok(Math.abs(r.momentary + 23) < 0.1, `momentary ${r.momentary}`)
  assert.ok(Math.abs(r.shortTerm + 23) < 0.1, `short-term ${r.shortTerm}`)
})

test('correlation reads +1 for mono, -1 for a flipped channel, 0 for uncorrelated', () => {
  const fs = 48000
  const run = (right: (i: number) => number): number => {
    const m = new LoudnessMeter(fs, 2, 8192)
    const l = new Float32Array(1 << 15)
    const r = new Float32Array(1 << 15)
    for (let i = 0; i < l.length; i++) {
      l[i] = Math.sin((2 * Math.PI * 440 * i) / fs)
      r[i] = right(i)
    }
    m.process([l, r], [0, 0], l.length, l.length - 1)
    return m.read().correlation
  }
  assert.ok(run((i) => Math.sin((2 * Math.PI * 440 * i) / fs)) > 0.999)
  assert.ok(run((i) => -Math.sin((2 * Math.PI * 440 * i) / fs)) < -0.999)
  assert.ok(Math.abs(run((i) => Math.cos((2 * Math.PI * 440 * i) / fs))) < 0.05)
})

test('a nonsensical sample rate mismeasures rather than hanging', () => {
  // `process` advances by the room left in the current 100 ms step. A rate that rounds that
  // step to zero would leave no room and the loop would never terminate.
  const m = new LoudnessMeter(0, 1, 8192)
  const plane = new Float32Array(64)
  plane[0] = 0.5
  m.process([plane], [0], 64, 63)
  assert.ok(Number.isFinite(m.read().samplePeakDb))
})
