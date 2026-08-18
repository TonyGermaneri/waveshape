/**
 * The particle record.
 *
 * A reassigned time-frequency point used to be four floats — when, how high, how loud, and
 * whether to believe it — and it existed for exactly one frame. Here it becomes an organism
 * with a birth, a lineage and a death, and the extra state is what it is born knowing about its
 * own harmonic situation.
 *
 * The layout is eight 32-bit words, 32 bytes:
 *
 *   0  f32  time        samples relative to the write head, from reassignment
 *   1  f32  freq        current frequency in Hz — this is what migrates during life
 *   2  f32  energy      current linear energy, decaying
 *   3  f32  drift       current frequency velocity, cents per step
 *   4  u32  colour      24-bit sRGB | 8-bit flags
 *   5  u32  life0       what it was born as: harmonic identity and circumstances
 *   6  u32  life1       what it has become: age, vitality, lineage
 *   7  f32  birthFreq   where it started, so how far it has wandered is knowable
 *
 * Words 5 and 6 carry 58 bits of life between them. The exact bit positions are duplicated in
 * `life.wgsl`, and `particle.test.ts` exists because a packing that disagrees between the two
 * would produce particles that behave plausibly and mean nothing — the worst kind of bug, since
 * it looks like art.
 */

export const PARTICLE_WORDS = 8
export const PARTICLE_BYTES = PARTICLE_WORDS * 4

/** Field widths in bits, in order, for each of the two life words. */
export const LIFE0_FIELDS = [
  /** Which harmonic of the inferred fundamental, 1-based. 0 = fits no series. */
  ['harmonic', 5],
  /** Cents from the exact multiple, signed, biased by 32. */
  ['detune', 6],
  /**
   * How much of the inferred harmonic series was present in the frame this particle was born
   * in, saturating at 31. A property of the *series*, not of this particle's neighbourhood:
   * every particle born into the same frame from the same fundamental gets the same number.
   */
  ['support', 5],
  /**
   * Spectral flatness, 0 a clean tone and 15 white noise. Of the whole frame rather than of
   * anywhere in particular, and sampled every thirty-seventh bin — one number the entire
   * generation shares, not a local measurement.
   */
  ['flatness', 4],
  /**
   * How empty the birth frequency was, signed and biased by 8: positive means nothing much was
   * already living there. This is occupancy of the pheromone field, which is to say how many
   * particles the frequency already holds — *not* spectral flux, and not an attack detector.
   */
  ['vacancy', 4],
  /** Octave band of the birth frequency, 0 = below 20 Hz, 15 = above 20 kHz. */
  ['register', 4],
  /**
   * How small reassignment's corrections were: 15 a stable partial, 0 phase noise. Also 0 when
   * reassignment is switched off, because then there is no measurement — unknown rather than
   * certain, which is what it used to claim.
   */
  ['coherence', 4],
] as const

export const LIFE1_FIELDS = [
  /**
   * Steps lived, saturating.
   *
   * Sixteen bits rather than eight because eight was a ceiling nobody asked for: 255 steps is
   * four seconds at 60 Hz, and the spectrogram's history runs to two minutes. A particle should
   * be able to outlive the window it is drawn in, so the counter has to reach eighteen minutes
   * rather than stop just past the first bar of music.
   */
  ['age', 16],
  /** Current energy over birth energy, 0-63. Reaching zero is death. */
  ['vitality', 6],
  /** Which harmonic series it belongs to, so siblings can recognise each other. */
  ['cohort', 6],
  /** How many times new energy has arrived at its frequency and renewed it. */
  ['generation', 4],
] as const

type FieldSpec = readonly (readonly [string, number])[]

function offsets(fields: FieldSpec): Map<string, { shift: number; bits: number }> {
  const out = new Map<string, { shift: number; bits: number }>()
  let shift = 0
  for (const [name, bits] of fields) {
    out.set(name, { shift, bits })
    shift += bits
  }
  if (shift > 32) throw new Error(`life word overflows 32 bits: ${shift}`)
  return out
}

export const LIFE0 = offsets(LIFE0_FIELDS)
export const LIFE1 = offsets(LIFE1_FIELDS)

/** Total life bits spent, beside the 24 of colour. */
export const LIFE_BITS =
  LIFE0_FIELDS.reduce((n, [, b]) => n + b, 0) + LIFE1_FIELDS.reduce((n, [, b]) => n + b, 0)

function pack(fields: Map<string, { shift: number; bits: number }>, values: Record<string, number>): number {
  let word = 0
  for (const [name, { shift, bits }] of fields) {
    const max = (1 << bits) - 1
    const v = Math.max(0, Math.min(max, Math.round(values[name] ?? 0)))
    // `>>> 0` after each field, not just at the end: a field whose top bit lands on bit 31
    // makes the running value negative, and the next `|=` would sign-extend it.
    word = (word | (v << shift)) >>> 0
  }
  return word >>> 0
}

function unpack(fields: Map<string, { shift: number; bits: number }>, word: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [name, { shift, bits }] of fields) {
    out[name] = (word >>> shift) & ((1 << bits) - 1)
  }
  return out
}

// ---------------------------------------------------------------------------------------
// Birth attributes, in the units they are measured in
// ---------------------------------------------------------------------------------------

export interface Birth {
  /** 0 when the partial fits no harmonic series. */
  harmonic: number
  /** Signed cents from the exact harmonic, clamped to ±31. */
  detuneCents: number
  /** Members of the series present in this frame; see LIFE0_FIELDS. */
  support: number
  /** 0..1, for the whole frame rather than for a neighbourhood. */
  flatness: number
  /** Signed, roughly −1..1. Field vacancy at the birth frequency; see LIFE0_FIELDS. */
  vacancy: number
  /** Hz. */
  frequency: number
  /** 0..1, where 1 means reassignment barely had to move the point. */
  coherence: number
  cohort: number
}

/** Octave band of a frequency, 0 at 20 Hz and 15 above 20 kHz — the display's whole range. */
export function registerOf(frequency: number): number {
  if (!(frequency > 0)) return 0
  const band = Math.floor(Math.log2(frequency / 20))
  return Math.max(0, Math.min(15, band))
}

export function encodeLife0(birth: Birth): number {
  return pack(LIFE0, {
    harmonic: Math.min(31, Math.max(0, birth.harmonic)),
    detune: Math.max(0, Math.min(63, Math.round(birth.detuneCents) + 32)),
    support: Math.min(31, Math.max(0, birth.support)),
    flatness: Math.round(Math.max(0, Math.min(1, birth.flatness)) * 15),
    vacancy: Math.max(0, Math.min(15, Math.round(birth.vacancy * 7) + 8)),
    register: registerOf(birth.frequency),
    coherence: Math.round(Math.max(0, Math.min(1, birth.coherence)) * 15),
  })
}

export interface Life0 {
  harmonic: number
  detuneCents: number
  support: number
  flatness: number
  vacancy: number
  register: number
  coherence: number
}

export function decodeLife0(word: number): Life0 {
  const raw = unpack(LIFE0, word)
  return {
    harmonic: raw.harmonic,
    detuneCents: raw.detune - 32,
    support: raw.support,
    flatness: raw.flatness / 15,
    vacancy: (raw.vacancy - 8) / 7,
    register: raw.register,
    coherence: raw.coherence / 15,
  }
}

export interface Life1 {
  age: number
  vitality: number
  cohort: number
  generation: number
}

export const MAX_AGE = 65535

/**
 * The bit layout is what this mirrors, not the rounding. `life.wgsl` dithers the vitality
 * quantiser with a per-particle sequence instead of rounding to nearest, because six bits make a
 * level 1/63 and any starvation slower than half of that would round back to where it started —
 * an immortal particle, silently, for every stamina worth setting. Here, where nothing is
 * integrating a slow drain step by step, rounding to nearest is the honest thing.
 */
export function encodeLife1(state: Life1): number {
  return pack(LIFE1, {
    age: Math.min(MAX_AGE, Math.max(0, state.age)),
    vitality: Math.min(63, Math.max(0, Math.round(state.vitality * 63))),
    cohort: state.cohort & 63,
    generation: Math.min(15, Math.max(0, state.generation)),
  })
}

export function decodeLife1(word: number): Life1 {
  const raw = unpack(LIFE1, word)
  return {
    age: raw.age,
    vitality: raw.vitality / 63,
    cohort: raw.cohort,
    generation: raw.generation,
  }
}

// ---------------------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------------------

/** Alive. A slot with this clear is free for the birth allocator to take. */
export const FLAG_ALIVE = 1 << 0
/** Sits on a harmonic series rather than standing alone. */
export const FLAG_HARMONIC = 1 << 1
/** Born on a rising edge. */
export const FLAG_VACANT = 1 << 2
/** Born into a flat, noise-like neighbourhood. */
export const FLAG_NOISE = 1 << 3

export function packColour(r: number, g: number, b: number, flags = 0): number {
  const q = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)))
  return (((q(r) << 16) | (q(g) << 8) | q(b)) | ((flags & 255) << 24)) >>> 0
}

export function unpackColour(word: number): { r: number; g: number; b: number; flags: number } {
  return {
    r: ((word >>> 16) & 255) / 255,
    g: ((word >>> 8) & 255) / 255,
    b: (word & 255) / 255,
    flags: (word >>> 24) & 255,
  }
}

/**
 * The colour a particle is born with, and the only place harmonic identity becomes visible.
 *
 * Hue is chroma — position within the octave — so every octave of the same note is the same
 * colour and a harmonic series lays itself out as a repeating sequence rather than a gradient.
 * Saturation is how sure we are that it is a note at all: a partial locked to a series with
 * many siblings is vivid, and noise is grey. Lightness leans on the harmonic number so a
 * fundamental reads heavier than its upper partials.
 */
export function birthColour(birth: Birth): { r: number; g: number; b: number } {
  const chroma = birth.frequency > 0 ? (Math.log2(birth.frequency / 16.3516) % 1 + 1) % 1 : 0
  const support = Math.min(1, birth.support / 8)
  const saturation = Math.max(0, Math.min(1, (1 - birth.flatness) * (0.35 + 0.65 * support)))
  const depth = birth.harmonic > 0 ? 1 / Math.sqrt(birth.harmonic) : 0.5
  const lightness = 0.35 + 0.45 * depth
  return hslToRgb(chroma, saturation, lightness)
}

export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const f = (n: number) => {
    const k = (n + h * 12) % 12
    const a = s * Math.min(l, 1 - l)
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))
  }
  return { r: f(0), g: f(8), b: f(4) }
}
