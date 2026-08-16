import test from 'node:test'
import assert from 'node:assert/strict'

import { autocorrelation, dftReference, fftComplexInPlace, fftReal } from './fft.ts'
import { buildWindowTables, scallopLossDb, WINDOWS, windowValue } from './windows.ts'
import { kWeightingHighPass, kWeightingShelf } from './biquad.ts'

function randomSignal(n: number, seed = 12345): Float64Array {
  // Deterministic LCG so a failure is reproducible.
  let s = seed
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    out[i] = s / 2147483648 - 1
  }
  return out
}

function maxAbsError(a: ArrayLike<number>, b: ArrayLike<number>, count: number): number {
  let worst = 0
  for (let i = 0; i < count; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]))
  return worst
}

test('complex FFT matches a naive DFT', () => {
  const n = 64
  const signal = randomSignal(n)
  const interleaved = new Float64Array(n * 2)
  for (let i = 0; i < n; i++) interleaved[i * 2] = signal[i]

  fftComplexInPlace(interleaved, n)
  const reference = dftReference(signal, n)

  assert.ok(
    maxAbsError(interleaved, reference, n * 2) < 1e-10,
    'radix-2 FFT diverged from the DFT',
  )
})

test('real FFT packing matches a naive DFT for every size we ship', () => {
  for (const n of [256, 512, 1024, 2048, 4096]) {
    const signal = randomSignal(n, n)
    const packed = fftReal(signal, n)
    const reference = dftReference(signal, n)
    const bins = n / 2 + 1
    let worst = 0
    for (let k = 0; k < bins; k++) {
      worst = Math.max(
        worst,
        Math.abs(packed[k * 2] - reference[k * 2]),
        Math.abs(packed[k * 2 + 1] - reference[k * 2 + 1]),
      )
    }
    // Error grows as sqrt(n) with accumulated rounding; this bound is still ~1e-12 relative.
    assert.ok(worst < 1e-8 * Math.sqrt(n), `n=${n}: real FFT error ${worst}`)
  }
})

test('real FFT gives a real DC and Nyquist bin', () => {
  const n = 512
  const signal = randomSignal(n, 7)
  const bins = fftReal(signal, n)
  assert.ok(Math.abs(bins[1]) < 1e-9, 'DC bin has an imaginary part')
  assert.ok(Math.abs(bins[(n / 2) * 2 + 1]) < 1e-9, 'Nyquist bin has an imaginary part')

  let sum = 0
  for (let i = 0; i < n; i++) sum += signal[i]
  assert.ok(Math.abs(bins[0] - sum) < 1e-9, 'DC bin is not the sum of the samples')
})

test('inverse FFT round-trips', () => {
  const n = 1024
  const signal = randomSignal(n, 99)
  const buf = new Float64Array(n * 2)
  for (let i = 0; i < n; i++) buf[i * 2] = signal[i]
  fftComplexInPlace(buf, n, false)
  fftComplexInPlace(buf, n, true)
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(buf[i * 2] - signal[i]) < 1e-12, `sample ${i} did not round-trip`)
  }
})

test('a bin-centred sine lands entirely in one bin', () => {
  const n = 1024
  const bin = 64
  const signal = new Float64Array(n)
  for (let i = 0; i < n; i++) signal[i] = Math.sin((2 * Math.PI * bin * i) / n)
  const bins = fftReal(signal, n)

  const magnitude = (k: number) => Math.hypot(bins[k * 2], bins[k * 2 + 1])
  // Amplitude 1 sine -> |X[k]| = n/2 with a rectangular window.
  assert.ok(Math.abs(magnitude(bin) - n / 2) < 1e-6, 'wrong peak magnitude')
  for (let k = 0; k <= n / 2; k++) {
    if (Math.abs(k - bin) < 2) continue
    assert.ok(magnitude(k) < 1e-6, `leakage into bin ${k}`)
  }
})

test('Parseval holds for the packed real transform', () => {
  const n = 2048
  const signal = randomSignal(n, 4242)
  let timeEnergy = 0
  for (let i = 0; i < n; i++) timeEnergy += signal[i] * signal[i]

  const bins = fftReal(signal, n)
  let freqEnergy = 0
  for (let k = 0; k <= n / 2; k++) {
    const mag2 = bins[k * 2] ** 2 + bins[k * 2 + 1] ** 2
    // Every bin except DC and Nyquist represents a conjugate pair.
    freqEnergy += k === 0 || k === n / 2 ? mag2 : 2 * mag2
  }
  const relative = Math.abs(freqEnergy / n - timeEnergy) / timeEnergy
  assert.ok(relative < 1e-12, `Parseval mismatch ${relative}`)
})

test('FFT autocorrelation matches a direct linear autocorrelation', () => {
  const length = 512
  const signal = randomSignal(length, 2024)
  const fast = autocorrelation(signal, length)
  for (const lag of [0, 1, 7, 63, 128, 300, 511]) {
    let direct = 0
    for (let j = 0; j + lag < length; j++) direct += signal[j] * signal[j + lag]
    assert.ok(
      Math.abs(fast[lag] - direct) < 1e-9 * length,
      `lag ${lag}: ${fast[lag]} vs ${direct}`,
    )
  }
})

/**
 * The Normalised Square Difference Function from the McLeod Pitch Method, in the same form
 * nsdf.wgsl computes it. Kept here so the shader's algorithm has a testable twin.
 */
function nsdf(signal: ArrayLike<number>, length: number, minLag: number, maxLag: number) {
  const out = new Float64Array(maxLag - minLag)
  for (let lag = minLag; lag < maxLag; lag++) {
    let r = 0
    let m = 0
    for (let j = 0; j + lag < length; j++) {
      const a = signal[j]
      const b = signal[j + lag]
      r += a * b
      m += a * a + b * b
    }
    out[lag - minLag] = m > 1e-20 ? (2 * r) / m : 0
  }
  return out
}

/** McLeod peak picking: first maximum above 0.9 of the global max, after the first zero crossing. */
function pickPeriod(values: Float64Array, minLag: number): { period: number; clarity: number } {
  let globalMax = 0
  let seenNegative = false
  for (let i = 1; i + 1 < values.length; i++) {
    if (!seenNegative) {
      if (values[i] < 0) seenNegative = true
      continue
    }
    if (values[i] > values[i - 1] && values[i] >= values[i + 1] && values[i] > globalMax) {
      globalMax = values[i]
    }
  }
  seenNegative = false
  for (let i = 1; i + 1 < values.length; i++) {
    if (!seenNegative) {
      if (values[i] < 0) seenNegative = true
      continue
    }
    if (
      values[i] > values[i - 1] &&
      values[i] >= values[i + 1] &&
      values[i] >= globalMax * 0.9
    ) {
      const y0 = values[i - 1]
      const y1 = values[i]
      const y2 = values[i + 1]
      const denom = y0 - 2 * y1 + y2
      const delta = Math.abs(denom) > 1e-12 ? (0.5 * (y0 - y2)) / denom : 0
      return { period: minLag + i + delta, clarity: y1 - 0.25 * (y0 - y2) * delta }
    }
  }
  return { period: 0, clarity: 0 }
}

test('NSDF finds the fundamental of a harmonically rich tone, not an octave', () => {
  const rate = 48000
  const length = 4096
  const minLag = 24
  const maxLag = 1600

  for (const freq of [82.41, 220, 440.7, 1000]) {
    const signal = new Float64Array(length)
    for (let i = 0; i < length; i++) {
      const t = (2 * Math.PI * freq * i) / rate
      // A sawtooth-like stack: the case where plain autocorrelation drops an octave.
      signal[i] =
        Math.sin(t) + 0.6 * Math.sin(2 * t) + 0.4 * Math.sin(3 * t) + 0.25 * Math.sin(4 * t)
    }
    const values = nsdf(signal, length, minLag, maxLag)
    const { period, clarity } = pickPeriod(values, minLag)
    const detected = rate / period
    assert.ok(clarity > 0.8, `${freq} Hz: clarity only ${clarity.toFixed(3)}`)
    assert.ok(
      Math.abs(detected - freq) / freq < 0.01,
      `${freq} Hz: detected ${detected.toFixed(2)} Hz`,
    )
  }
})

test('cosine-sum windows have the analytically expected sums', () => {
  const n = 4096
  const hann = buildWindowTables('hann', n, 0)
  // Periodic Hann: sum w = n/2 exactly, sum w^2 = 3n/8, so NENBW = 1.5 bins.
  assert.ok(Math.abs(hann.s1 - n / 2) < 1e-6, `Hann S1 = ${hann.s1}`)
  assert.ok(Math.abs(hann.s2 - (3 * n) / 8) < 1e-6, `Hann S2 = ${hann.s2}`)
  assert.ok(Math.abs(hann.nenbw - 1.5) < 1e-9, `Hann NENBW = ${hann.nenbw}`)

  const rect = buildWindowTables('rectangular', n, 0)
  assert.ok(Math.abs(rect.nenbw - 1) < 1e-9, `rectangular NENBW = ${rect.nenbw}`)
})

test('every window is finite, non-negative in energy, and centred', () => {
  const n = 1024
  for (const spec of WINDOWS) {
    const param = spec.paramDefault ?? 0
    const tables = buildWindowTables(spec.id, n, param)
    assert.ok(Number.isFinite(tables.s1) && tables.s1 > 0, `${spec.id}: bad S1`)
    assert.ok(Number.isFinite(tables.s2) && tables.s2 > 0, `${spec.id}: bad S2`)
    // The measured NENBW should be close to the tabulated figure.
    assert.ok(
      Math.abs(tables.nenbw - spec.nenbw) < 0.35,
      `${spec.id}: NENBW ${tables.nenbw.toFixed(4)} vs table ${spec.nenbw}`,
    )
    // The window's time centroid must sit at n/2, which is the reference the reassignment
    // maths adds back. Under the periodic convention this is exact only for windows that
    // vanish at the endpoints; for the rest the centroid is offset by exactly
    // -w(0) / 2 samples, because the sample set is asymmetric by half a sample. That is a
    // constant reference shift, not an error — the impulse test below confirms reassignment
    // still lands on the exact sample — but the offset must stay sub-sample.
    let sum = 0
    for (let i = 0; i < n; i++) sum += tables.tw[i]
    const centroidOffset = sum / tables.s1
    assert.ok(
      Math.abs(centroidOffset) < 0.55,
      `${spec.id}: time centroid off by ${centroidOffset.toFixed(4)} samples`,
    )
    if (spec.cosine) {
      const endpoint = spec.cosine.reduce((a, b) => a + b, 0)
      const expected = (-endpoint * n) / 2
      assert.ok(
        Math.abs(sum - expected) < 1e-6 * n,
        `${spec.id}: sum(t*w) = ${sum}, expected ${expected}`,
      )
    }
  }
})

/**
 * Time-frequency reassignment, in exactly the form analyze.wgsl computes it. Having a CPU
 * twin is the only way to know the shader's sign conventions are right — a flipped sign in a
 * reassignment term still produces a plausible-looking spectrogram, just a wrong one.
 */
function reassign(
  signal: ArrayLike<number>,
  start: number,
  n: number,
  sampleRate: number,
): { bin: number; timeSamples: number; freqHz: number; magnitude: number }[] {
  const tables = buildWindowTables('hann', n, 0)
  const wx = new Float64Array(n)
  const twx = new Float64Array(n)
  const dwx = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const s = signal[start + i]
    wx[i] = s * tables.w[i]
    twx[i] = s * tables.tw[i]
    dwx[i] = s * tables.dw[i]
  }
  const Xw = fftReal(wx, n)
  const Xtw = fftReal(twx, n)
  const Xdw = fftReal(dwx, n)

  const out = []
  for (let k = 0; k <= n / 2; k++) {
    const wr = Xw[k * 2]
    const wi = Xw[k * 2 + 1]
    const power = wr * wr + wi * wi
    if (power < 1e-30) continue
    const dt = (Xtw[k * 2] * wr + Xtw[k * 2 + 1] * wi) / power
    const dwIm = (Xdw[k * 2 + 1] * wr - Xdw[k * 2] * wi) / power
    out.push({
      bin: k,
      timeSamples: start + n / 2 + dt,
      freqHz: ((k / n) * sampleRate) - (dwIm / (2 * Math.PI)) * sampleRate,
      magnitude: Math.sqrt(power),
    })
  }
  return out
}

test('reassignment places an impulse at its exact sample', () => {
  const n = 1024
  const impulseAt = 3400
  const signal = new Float64Array(8192)
  signal[impulseAt] = 1

  // Window covering the impulse, deliberately not centred on it.
  const start = 3000
  const points = reassign(signal, start, n, 48000)
  // An impulse has equal energy in every bin, so every bin should agree on the time.
  for (const k of [10, 64, 200, 400]) {
    const p = points.find((q) => q.bin === k)
    assert.ok(p, `bin ${k} missing`)
    assert.ok(
      Math.abs(p.timeSamples - impulseAt) < 1e-6,
      `bin ${k}: reassigned to ${p.timeSamples}, expected ${impulseAt}`,
    )
  }
})

test('reassignment recovers a sinusoid between two bins', () => {
  const n = 4096
  const rate = 48000
  const freq = 1000.37 // deliberately off-bin: bin spacing here is 11.72 Hz
  const signal = new Float64Array(16384)
  for (let i = 0; i < signal.length; i++) signal[i] = Math.sin((2 * Math.PI * freq * i) / rate)

  const start = 4096
  const points = reassign(signal, start, n, rate)
  const peak = points.reduce((a, b) => (b.magnitude > a.magnitude ? b : a))

  const binCentre = (peak.bin / n) * rate
  const binError = Math.abs(binCentre - freq)
  assert.ok(binError > 1, `test is not exercising anything: bin centre is already ${binError} Hz away`)
  assert.ok(
    Math.abs(peak.freqHz - freq) < 0.01,
    `reassigned to ${peak.freqHz.toFixed(4)} Hz, expected ${freq}`,
  )
  // A stationary tone's energy centroid is the window centre, so the time correction is ~0.
  assert.ok(
    Math.abs(peak.timeSamples - (start + n / 2)) < 0.5,
    `time drifted to ${peak.timeSamples}, expected ${start + n / 2}`,
  )
})

test('the derivative window matches a finite difference of the window itself', () => {
  const n = 512
  for (const id of ['hann', 'blackman-harris', 'kaiser'] as const) {
    const param = id === 'kaiser' ? 12 : 0
    const tables = buildWindowTables(id, n, param)
    for (const i of [64, 128, 200, 300, 400]) {
      const numeric = (windowValue(id, i + 1, n, param) - windowValue(id, i - 1, n, param)) / 2
      assert.ok(
        Math.abs(numeric - tables.dw[i]) < 1e-4,
        `${id}: dw[${i}] = ${tables.dw[i]} vs ${numeric}`,
      )
    }
  }
})

test('a flat-top window has far less scallop loss than a Hann window', () => {
  const n = 4096
  const flat = scallopLossDb('flat-top', n, 0)
  const hann = scallopLossDb('hann', n, 0)
  assert.ok(Math.abs(flat) < 0.05, `flat-top scallop loss ${flat} dB`)
  assert.ok(hann < -1.3 && hann > -1.5, `Hann scallop loss ${hann} dB`)
})

test('K-weighting reproduces the tabulated 48 kHz coefficients', () => {
  // ITU-R BS.1770-4 Tables 1 and 2.
  const shelf = kWeightingShelf(48000)
  assert.ok(Math.abs(shelf.b0 - 1.53512485958697) < 1e-9, `b0 ${shelf.b0}`)
  assert.ok(Math.abs(shelf.b1 - -2.69169618940638) < 1e-9, `b1 ${shelf.b1}`)
  assert.ok(Math.abs(shelf.b2 - 1.19839281085285) < 1e-9, `b2 ${shelf.b2}`)
  assert.ok(Math.abs(shelf.a1 - -1.69065929318241) < 1e-9, `a1 ${shelf.a1}`)
  assert.ok(Math.abs(shelf.a2 - 0.73248077421585) < 1e-9, `a2 ${shelf.a2}`)

  const hpf = kWeightingHighPass(48000)
  assert.ok(Math.abs(hpf.a1 - -1.99004745483398) < 1e-8, `a1 ${hpf.a1}`)
  assert.ok(Math.abs(hpf.a2 - 0.99007225036621) < 1e-8, `a2 ${hpf.a2}`)
})

test('K-weighting stays stable at every rate we support', () => {
  for (const rate of [44100, 48000, 88200, 96000, 176400, 192000]) {
    for (const c of [kWeightingShelf(rate), kWeightingHighPass(rate)]) {
      // Poles inside the unit circle: |a2| < 1 and |a1| < 1 + a2.
      assert.ok(Math.abs(c.a2) < 1, `${rate}: |a2| = ${Math.abs(c.a2)}`)
      assert.ok(Math.abs(c.a1) < 1 + c.a2, `${rate}: unstable pole pair`)
    }
  }
})
