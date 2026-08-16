/**
 * CPU reference FFT.
 *
 * This is *not* on the hot path — the production transform runs as a WebGPU compute shader
 * (src/gpu/shaders/fft.wgsl). This implementation exists to
 *
 *   1. validate the GPU kernel numerically at runtime (Diagnostics tab), and
 *   2. be unit-testable in Node without a GPU.
 *
 * Twiddle factors are computed in f64 and cached per size; the GPU uploads the same table as
 * f32, so both paths share one source of truth for the hardest-to-get-right constants.
 */

export interface TwiddleTable {
  n: number
  /** cos/sin interleaved: e^(-2*pi*i*m/n) for m in [0, n). */
  table: Float64Array
}

const twiddleCache = new Map<number, TwiddleTable>()

export function twiddles(n: number): TwiddleTable {
  const cached = twiddleCache.get(n)
  if (cached) return cached
  const table = new Float64Array(n * 2)
  for (let m = 0; m < n; m++) {
    const a = (-2 * Math.PI * m) / n
    table[m * 2] = Math.cos(a)
    table[m * 2 + 1] = Math.sin(a)
  }
  const entry = { n, table }
  twiddleCache.set(n, entry)
  return entry
}

export function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0
}

/**
 * In-place iterative radix-2 complex FFT, decimation in time, on an interleaved re/im array.
 * `inverse` conjugates the twiddles and scales by 1/n.
 */
export function fftComplexInPlace(data: Float64Array, n: number, inverse = false): void {
  if (!isPowerOfTwo(n)) throw new Error(`fft size must be a power of two, got ${n}`)
  if (data.length < n * 2) throw new Error('buffer too small')

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = data[i * 2]
      data[i * 2] = data[j * 2]
      data[j * 2] = t
      t = data[i * 2 + 1]
      data[i * 2 + 1] = data[j * 2 + 1]
      data[j * 2 + 1] = t
    }
  }

  const { table } = twiddles(n)
  const sign = inverse ? -1 : 1

  for (let len = 2; len <= n; len <<= 1) {
    const step = n / len
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const tw = k * step
        const wr = table[tw * 2]
        const wi = sign * table[tw * 2 + 1]
        const a = (i + k) * 2
        const b = (i + k + half) * 2
        const xr = data[b]
        const xi = data[b + 1]
        const vr = xr * wr - xi * wi
        const vi = xr * wi + xi * wr
        data[b] = data[a] - vr
        data[b + 1] = data[a + 1] - vi
        data[a] += vr
        data[a + 1] += vi
      }
    }
  }

  if (inverse) {
    const s = 1 / n
    for (let i = 0; i < n * 2; i++) data[i] *= s
  }
}

/**
 * Real-input FFT using the standard N/2 packing: pack x[2j] + i*x[2j+1] into a half-length
 * complex sequence, transform, then split. Exactly the algorithm the GPU pipeline runs
 * (prepare.wgsl packs, unpack.wgsl splits), so a mismatch between the two is a real bug.
 *
 * Returns n/2 + 1 complex bins, interleaved re/im.
 */
export function fftReal(x: ArrayLike<number>, n: number): Float64Array {
  if (!isPowerOfTwo(n)) throw new Error(`fft size must be a power of two, got ${n}`)
  const m = n >> 1
  const z = new Float64Array(m * 2)
  for (let j = 0; j < m; j++) {
    z[j * 2] = x[2 * j]
    z[j * 2 + 1] = x[2 * j + 1]
  }
  fftComplexInPlace(z, m, false)

  const out = new Float64Array((m + 1) * 2)
  const { table } = twiddles(n)
  for (let k = 0; k <= m; k++) {
    const kk = k % m
    const mk = (m - k) % m
    const zr = z[kk * 2]
    const zi = z[kk * 2 + 1]
    const cr = z[mk * 2]
    const ci = -z[mk * 2 + 1] // conj(Z[m-k])

    // Even part: (Z[k] + conj(Z[m-k])) / 2
    const er = 0.5 * (zr + cr)
    const ei = 0.5 * (zi + ci)
    // Odd part: -i/2 * (Z[k] - conj(Z[m-k]))
    const dr = 0.5 * (zr - cr)
    const di = 0.5 * (zi - ci)
    const or_ = di
    const oi = -dr

    const wr = table[k * 2]
    const wi = table[k * 2 + 1]
    out[k * 2] = er + (or_ * wr - oi * wi)
    out[k * 2 + 1] = ei + (or_ * wi + oi * wr)
  }
  return out
}

/** Naive O(n^2) DFT — ground truth for the unit tests. */
export function dftReference(x: ArrayLike<number>, n: number): Float64Array {
  const out = new Float64Array(n * 2)
  for (let k = 0; k < n; k++) {
    let re = 0
    let im = 0
    for (let j = 0; j < n; j++) {
      const a = (-2 * Math.PI * k * j) / n
      re += x[j] * Math.cos(a)
      im += x[j] * Math.sin(a)
    }
    out[k * 2] = re
    out[k * 2 + 1] = im
  }
  return out
}

/**
 * Circular autocorrelation via the Wiener-Khinchin theorem, with the input zero-padded to
 * twice its length so the result is the *linear* autocorrelation. Used for pitch detection.
 */
export function autocorrelation(x: ArrayLike<number>, length: number): Float64Array {
  let n = 1
  while (n < length * 2) n <<= 1
  const buf = new Float64Array(n * 2)
  for (let i = 0; i < length; i++) buf[i * 2] = x[i]
  fftComplexInPlace(buf, n, false)
  for (let i = 0; i < n; i++) {
    const re = buf[i * 2]
    const im = buf[i * 2 + 1]
    buf[i * 2] = re * re + im * im
    buf[i * 2 + 1] = 0
  }
  fftComplexInPlace(buf, n, true)
  const r = new Float64Array(length)
  for (let i = 0; i < length; i++) r[i] = buf[i * 2]
  return r
}
