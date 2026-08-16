/**
 * Harmonic identity: what a partial *is*, measured at the moment it is born.
 *
 * The spectrogram already knows where energy is. This is about what that energy means in the
 * only vernacular the signal actually speaks — small integer ratios. A partial at 880 Hz over a
 * 220 Hz fundamental is not merely "energy at 880 Hz", it is the fourth harmonic, it is four
 * cents sharp, it has five siblings on the same series, and it was born into a peak rather than
 * into a noise floor. Those are the facts a particle carries for the rest of its life, and they
 * are what its behaviour is derived from.
 *
 * This module is the reference implementation, in f64, and it is what `life.wgsl` is checked
 * against. Both must agree: the shader computes these at birth for every particle, in parallel,
 * and a divergence between the two would be invisible on screen and impossible to debug.
 */

/** Cents between two frequencies. 1200 to the octave, signed, `a` relative to `b`. */
export function cents(a: number, b: number): number {
  if (a <= 0 || b <= 0) return 0
  return 1200 * Math.log2(a / b)
}

export interface HarmonicIdentity {
  /** Which harmonic of the fundamental this is, 1-based. 0 when it fits none. */
  number: number
  /** Signed cents from the exact integer multiple. Zero for a perfectly tuned partial. */
  detune: number
  /** How well it fits, 1 at dead centre falling to 0 at the tolerance. */
  fit: number
}

/**
 * Places a frequency on the harmonic series of `fundamental`.
 *
 * Rounding f/f0 to the nearest integer is the whole method, but the tolerance has to be
 * expressed in cents rather than in hertz: 3 Hz is a quarter tone at 40 Hz and imperceptible at
 * 4 kHz. Real instruments are also progressively sharp in the upper partials — piano strings
 * famously so, from stiffness — hence a tolerance that widens with harmonic number rather than
 * one that calls the twentieth partial inharmonic for being 30 cents high.
 */
export function harmonicIdentity(
  frequency: number,
  fundamental: number,
  maxHarmonic = 31,
  toleranceCents = 35,
): HarmonicIdentity {
  const none: HarmonicIdentity = { number: 0, detune: 0, fit: 0 }
  if (!(frequency > 0) || !(fundamental > 0)) return none

  const ratio = frequency / fundamental
  const n = Math.round(ratio)
  if (n < 1 || n > maxHarmonic) return none

  const detune = cents(frequency, n * fundamental)
  // Inharmonicity grows with the partial number, so the gate widens with it — but it cannot
  // widen past half the distance to the neighbouring harmonic, or "nearest harmonic" stops
  // meaning anything. Adjacent harmonics converge: 16 and 17 are only 105 cents apart, so up
  // there the cap does the deciding and genuinely ambiguous partials are honestly refused.
  const halfSpacing = 600 * Math.log2((n + 1) / n)
  const tolerance = Math.min(toleranceCents * (1 + Math.log2(n) * 0.35), halfSpacing * 0.5)
  if (Math.abs(detune) > tolerance) return none

  return { number: n, detune, fit: 1 - Math.abs(detune) / tolerance }
}

/**
 * How many of `peaks` sit on the same harmonic series, and how strongly.
 *
 * This is the particle's family. A partial with eight siblings is part of a note; a partial
 * standing alone at an arbitrary frequency is a click, a hum, or a piece of the noise floor —
 * and they should not behave the same way or live the same length of time.
 */
export function harmonicSupport(
  peaks: readonly number[],
  fundamental: number,
  maxHarmonic = 31,
  toleranceCents = 35,
): { count: number; strength: number } {
  if (!(fundamental > 0)) return { count: 0, strength: 0 }
  let count = 0
  let strength = 0
  const seen = new Set<number>()
  for (const peak of peaks) {
    const id = harmonicIdentity(peak, fundamental, maxHarmonic, toleranceCents)
    if (id.number === 0 || seen.has(id.number)) continue
    seen.add(id.number)
    count++
    strength += id.fit
  }
  return { count, strength: count > 0 ? strength / count : 0 }
}

/**
 * Spectral flatness (Wiener entropy) of a magnitude band: the geometric mean over the
 * arithmetic mean, 0 for a pure tone and 1 for white noise.
 *
 * Computed as the exponential of the mean log rather than as a product of N terms, because a
 * product of a few thousand magnitudes underflows f32 long before it finishes.
 */
export function spectralFlatness(magnitudes: readonly number[]): number {
  if (magnitudes.length === 0) return 0
  let logSum = 0
  let sum = 0
  let n = 0
  for (const m of magnitudes) {
    const v = Math.max(m, 1e-20)
    logSum += Math.log(v)
    sum += v
    n++
  }
  if (n === 0 || sum <= 0) return 0
  const geometric = Math.exp(logSum / n)
  const arithmetic = sum / n
  return Math.min(1, geometric / arithmetic)
}

/**
 * The strongest fundamental implied by a set of peaks, scored by how much of the set falls on
 * its series.
 *
 * Each peak is tried as a fundamental, and each is also tried as though it were the 2nd, 3rd or
 * 4th harmonic of something lower — otherwise a spectrum whose true fundamental is missing (a
 * telephone-band voice, a bassoon's weak first partial) would be assigned to its second
 * harmonic and every particle in it would carry the wrong identity.
 */
export function inferFundamental(
  peaks: readonly number[],
  weights?: readonly number[],
): { frequency: number; score: number } {
  let best = { frequency: 0, score: 0 }
  if (peaks.length === 0) return best

  for (let i = 0; i < peaks.length; i++) {
    for (const divisor of [1, 2, 3, 4]) {
      const candidate = peaks[i] / divisor
      if (candidate <= 0) continue
      let score = 0
      for (let j = 0; j < peaks.length; j++) {
        const id = harmonicIdentity(peaks[j], candidate)
        if (id.number === 0) continue
        // Weight by amplitude where it is known, and favour low harmonic numbers: a series
        // explained by partials 1-5 is a better reading than one explained by 17-21.
        //
        // That 1/sqrt(n) is also the entire defence against the octave-below trap. Halving a
        // candidate explains everything the original did with every harmonic number doubled,
        // which costs exactly sqrt(2) — so f0/2 only wins when it genuinely explains more, as
        // it does when the fundamental itself is missing from the spectrum.
        const weight = weights?.[j] ?? 1
        score += (weight * id.fit) / Math.sqrt(id.number)
      }
      if (score > best.score) best = { frequency: candidate, score }
    }
  }
  return best
}
