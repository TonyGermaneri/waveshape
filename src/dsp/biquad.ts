/** Normalised biquad coefficients (a0 divided out). */
export interface BiquadCoeffs {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/** Per-channel state for a transposed direct form II biquad. */
export class BiquadState {
  z1 = 0
  z2 = 0
  reset(): void {
    this.z1 = 0
    this.z2 = 0
  }
}

/**
 * Transposed direct form II. Preferred over DF-I/DF-II for f64 audio: it has the best
 * round-off behaviour of the direct forms and needs only two state words per channel.
 */
export function biquadProcess(
  c: BiquadCoeffs,
  s: BiquadState,
  input: Float64Array,
  output: Float64Array,
  count: number,
): void {
  let { z1, z2 } = s
  const { b0, b1, b2, a1, a2 } = c
  for (let i = 0; i < count; i++) {
    const x = input[i]
    const y = b0 * x + z1
    z1 = b1 * x - a1 * y + z2
    z2 = b2 * x - a2 * y
    output[i] = y
  }
  s.z1 = z1
  s.z2 = z2
}

/**
 * ITU-R BS.1770-4 K-weighting, stage 1: the "pre-filter" high shelf modelling the acoustic
 * effect of a head in a diffuse field.
 *
 * The Recommendation tabulates coefficients only for 48 kHz. These are the analog prototype
 * parameters those coefficients are derived from, re-run through the bilinear transform at
 * the working rate — the approach taken by libebur128 and ffmpeg's ebur128 filter, and the
 * only way to stay compliant at 96/192 kHz.
 */
export function kWeightingShelf(sampleRate: number): BiquadCoeffs {
  const f0 = 1681.974450955533
  const G = 3.999843853973347
  const Q = 0.7071752369554196

  const K = Math.tan((Math.PI * f0) / sampleRate)
  const Vh = Math.pow(10, G / 20)
  const Vb = Math.pow(Vh, 0.4996667741545416)
  const denom = 1 + K / Q + K * K

  return {
    b0: (Vh + (Vb * K) / Q + K * K) / denom,
    b1: (2 * (K * K - Vh)) / denom,
    b2: (Vh - (Vb * K) / Q + K * K) / denom,
    a1: (2 * (K * K - 1)) / denom,
    a2: (1 - K / Q + K * K) / denom,
  }
}

/** ITU-R BS.1770-4 K-weighting, stage 2: the RLB high-pass. */
export function kWeightingHighPass(sampleRate: number): BiquadCoeffs {
  const f0 = 38.13547087602444
  const Q = 0.5003270373238773

  const K = Math.tan((Math.PI * f0) / sampleRate)
  const denom = 1 + K / Q + K * K

  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / denom,
    a2: (1 - K / Q + K * K) / denom,
  }
}
