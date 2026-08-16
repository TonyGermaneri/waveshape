/**
 * Analysis window functions.
 *
 * Every window is defined as a *continuous* function of the sample index so that we can
 * derive the two auxiliary windows required by time-frequency reassignment:
 *
 *   w(n)        the analysis window
 *   t*w(n)      the time-weighted window, t measured from the window centre
 *   dw/dn(n)    the derivative window
 *
 * All windows use the **periodic** (DFT-even) convention, w(n) = f(n / N), which is the
 * correct choice for spectral analysis — the symmetric convention biases the estimate
 * because it repeats the endpoint.
 *
 * Sidelobe / NENBW / overlap figures follow G. Heinzel, A. Rudiger, R. Schilling,
 * "Spectrum and spectral density estimation by the Discrete Fourier transform (DFT)",
 * Max-Planck-Institut fur Gravitationsphysik (2002) — the standard reference table.
 */

export type WindowId =
  | 'rectangular'
  | 'hann'
  | 'hamming'
  | 'blackman'
  | 'blackman-harris'
  | 'nuttall'
  | 'blackman-nuttall'
  | 'flat-top'
  | 'hft248d'
  | 'kaiser'
  | 'gaussian'

export interface WindowSpec {
  id: WindowId
  label: string
  /** Cosine-sum coefficients a_k for w(x) = sum a_k cos(2*pi*k*x); undefined for parametric windows. */
  cosine?: readonly number[]
  /** Highest sidelobe level, dB relative to the main lobe (nominal, from the reference table). */
  sidelobeDb: number
  /** Asymptotic sidelobe rolloff, dB per octave. */
  rolloffDbPerOctave: number
  /** Normalised equivalent noise bandwidth, in FFT bins (nominal — the exact value is measured). */
  nenbw: number
  /** Overlap that minimises the variance of the averaged estimate, in percent. */
  optimalOverlapPct: number
  /** True when the window has a free shape parameter (Kaiser beta, Gaussian sigma). */
  parametric?: boolean
  paramLabel?: string
  paramDefault?: number
  paramMin?: number
  paramMax?: number
  note: string
}

export const WINDOWS: readonly WindowSpec[] = [
  {
    id: 'rectangular',
    label: 'Rectangular',
    cosine: [1],
    sidelobeDb: -13.3,
    rolloffDbPerOctave: -6,
    nenbw: 1.0,
    optimalOverlapPct: 0,
    note: 'No leakage suppression. Only correct for exactly periodic signals or transient capture.',
  },
  {
    id: 'hann',
    label: 'Hann',
    cosine: [0.5, -0.5],
    sidelobeDb: -31.5,
    rolloffDbPerOctave: -18,
    nenbw: 1.5,
    optimalOverlapPct: 65.96,
    note: 'The general-purpose default. Fast rolloff, narrow main lobe, exact COLA at 50% / 75% overlap.',
  },
  {
    id: 'hamming',
    label: 'Hamming',
    cosine: [0.54, -0.46],
    sidelobeDb: -42.7,
    rolloffDbPerOctave: -6,
    nenbw: 1.3628,
    optimalOverlapPct: 60.96,
    note: 'Lower first sidelobe than Hann but the tail only falls 6 dB/octave.',
  },
  {
    id: 'blackman',
    label: 'Blackman (exact)',
    cosine: [0.42659, -0.49656, 0.076849],
    sidelobeDb: -68.24,
    rolloffDbPerOctave: -6,
    nenbw: 1.7269,
    optimalOverlapPct: 66.31,
    note: 'Three-term. Good compromise when Hann leaks too much.',
  },
  {
    id: 'blackman-harris',
    label: 'Blackman-Harris (4-term)',
    cosine: [0.35875, -0.48829, 0.14128, -0.01168],
    sidelobeDb: -92.0,
    rolloffDbPerOctave: -6,
    nenbw: 2.0044,
    optimalOverlapPct: 66.1,
    note: 'The workhorse for high dynamic range. ~92 dB sidelobe rejection, moderate main lobe.',
  },
  {
    id: 'nuttall',
    label: 'Nuttall (4-term, C1)',
    cosine: [0.355768, -0.487396, 0.144232, -0.012604],
    sidelobeDb: -93.32,
    rolloffDbPerOctave: -18,
    nenbw: 1.9761,
    optimalOverlapPct: 65.7,
    note: 'Continuous first derivative, so the tail falls 18 dB/octave instead of 6.',
  },
  {
    id: 'blackman-nuttall',
    label: 'Blackman-Nuttall',
    cosine: [0.3635819, -0.4891775, 0.1365995, -0.0106411],
    sidelobeDb: -98.17,
    rolloffDbPerOctave: -6,
    nenbw: 1.9761,
    optimalOverlapPct: 66.3,
    note: 'Slightly deeper first sidelobe than Nuttall at the cost of the fast rolloff.',
  },
  {
    id: 'flat-top',
    label: 'Flat-top (SFT5F)',
    cosine: [0.21557895, -0.41663158, 0.277263158, -0.083578947, 0.006947368],
    sidelobeDb: -93.6,
    rolloffDbPerOctave: -6,
    nenbw: 3.8354,
    optimalOverlapPct: 75.5,
    note: 'Amplitude-accurate: scallop loss below 0.01 dB. Use when you must read a level, not a shape.',
  },
  {
    id: 'hft248d',
    label: 'HFT248D (Heinzel)',
    cosine: [
      1, -1.985844164102, 1.791176438506, -1.282075284005, 0.667777530266, -0.240160796576,
      0.056656381764, -0.008134974479, 0.00062454465, -0.000019808998, 0.000000132974,
    ],
    sidelobeDb: -248.4,
    rolloffDbPerOctave: -6,
    nenbw: 5.6512,
    optimalOverlapPct: 84.1,
    note: '11-term. 248 dB of sidelobe rejection — for resolving a whisper next to a full-scale tone.',
  },
  {
    id: 'kaiser',
    label: 'Kaiser',
    sidelobeDb: -89.1,
    rolloffDbPerOctave: -6,
    nenbw: 1.9,
    optimalOverlapPct: 68,
    parametric: true,
    paramLabel: 'beta',
    paramDefault: 12,
    paramMin: 0,
    paramMax: 30,
    note: 'Continuously tunable leakage/resolution trade-off. beta ~= 12 approximates Blackman-Harris.',
  },
  {
    id: 'gaussian',
    label: 'Gaussian',
    sidelobeDb: -55,
    rolloffDbPerOctave: -6,
    nenbw: 1.6,
    optimalOverlapPct: 67,
    parametric: true,
    paramLabel: 'sigma',
    paramDefault: 0.3,
    paramMin: 0.05,
    paramMax: 0.5,
    note: 'Minimises the time-bandwidth product. The natural window for reassignment maths.',
  },
]

const WINDOW_BY_ID = new Map(WINDOWS.map((w) => [w.id, w]))

export function windowSpec(id: WindowId): WindowSpec {
  const spec = WINDOW_BY_ID.get(id)
  if (!spec) throw new Error(`unknown window: ${id}`)
  return spec
}

/** Modified Bessel function of the first kind, order zero. Series converges fast for the beta we allow. */
function besselI0(x: number): number {
  let sum = 1
  let term = 1
  const halfSq = (x * x) / 4
  for (let k = 1; k < 64; k++) {
    term *= halfSq / (k * k)
    sum += term
    if (term < sum * 1e-17) break
  }
  return sum
}

/**
 * Continuous window value at (possibly fractional) sample index `n` for a length-`size` window.
 * Defined for real n so that derivatives can be taken by central difference.
 */
export function windowValue(id: WindowId, n: number, size: number, param: number): number {
  const spec = windowSpec(id)
  if (spec.cosine) {
    const x = (2 * Math.PI * n) / size
    let v = 0
    for (let k = 0; k < spec.cosine.length; k++) v += spec.cosine[k] * Math.cos(k * x)
    return v
  }
  if (id === 'kaiser') {
    // Argument runs over [-1, 1] across the window.
    const u = (2 * n) / size - 1
    const r = 1 - u * u
    if (r <= 0) return 0
    return besselI0(param * Math.sqrt(r)) / besselI0(param)
  }
  // Gaussian: param is sigma expressed as a fraction of the half-width.
  const u = (2 * n) / size - 1
  return Math.exp(-0.5 * (u / param) * (u / param))
}

export interface WindowTables {
  /** w(n) */
  w: Float64Array
  /** (n - size/2) * w(n) — time-weighted window, t in samples from the window centre. */
  tw: Float64Array
  /** dw/dn(n) — derivative window, per sample. */
  dw: Float64Array
  /** S1 = sum w. Coherent gain is S1/size. */
  s1: number
  /** S2 = sum w^2. */
  s2: number
  /** Normalised equivalent noise bandwidth, measured: size * S2 / S1^2 (bins). */
  nenbw: number
  /** Amplitude correction: multiply a windowed FFT magnitude by this to recover a sine's peak amplitude. */
  amplitudeScale: number
  /** Power-spectral-density correction (per Hz), excluding the 1/fs term. */
  densityScale: number
}

/**
 * Build w, t*w and dw/dn for one window.
 *
 * The derivative is taken by central difference on the continuous definition. With h = 1e-3
 * samples the truncation error is O(h^2) ~ 1e-6 relative — far below f32 storage precision —
 * and it keeps every window (including the parametric ones, whose analytic derivatives need
 * Bessel functions of order one) on a single code path.
 */
export function buildWindowTables(id: WindowId, size: number, param: number): WindowTables {
  const w = new Float64Array(size)
  const tw = new Float64Array(size)
  const dw = new Float64Array(size)
  const centre = size / 2
  const h = 1e-3

  let s1 = 0
  let s2 = 0
  for (let n = 0; n < size; n++) {
    const v = windowValue(id, n, size, param)
    w[n] = v
    tw[n] = (n - centre) * v
    dw[n] =
      (windowValue(id, n + h, size, param) - windowValue(id, n - h, size, param)) / (2 * h)
    s1 += v
    s2 += v * v
  }

  const nenbw = (size * s2) / (s1 * s1)
  return {
    w,
    tw,
    dw,
    s1,
    s2,
    nenbw,
    amplitudeScale: 2 / s1,
    densityScale: 2 / s2,
  }
}

/** Scallop loss in dB: the worst-case amplitude error for a tone landing between two bins. */
export function scallopLossDb(id: WindowId, size: number, param: number): number {
  let re = 0
  let im = 0
  let sum = 0
  for (let n = 0; n < size; n++) {
    const v = windowValue(id, n, size, param)
    const phase = (-Math.PI * n) / size // half-bin offset
    re += v * Math.cos(phase)
    im += v * Math.sin(phase)
    sum += v
  }
  return 20 * Math.log10(Math.hypot(re, im) / sum)
}
