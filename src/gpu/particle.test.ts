/**
 * The packing has to be exact, because the shader unpacks it by hand from the same bit
 * positions and a disagreement would not crash — it would produce particles that behave
 * plausibly and mean nothing, which is a bug that looks like art and can be stared at for a
 * very long time.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LIFE0,
  LIFE1,
  LIFE_BITS,
  MAX_AGE,
  PARTICLE_BYTES,
  birthColour,
  decodeLife0,
  decodeLife1,
  encodeLife0,
  encodeLife1,
  packColour,
  registerOf,
  unpackColour,
  type Birth,
} from './particle.ts'
import { cents, harmonicIdentity, harmonicSupport, inferFundamental, spectralFlatness } from '../dsp/harmonics.ts'

const birth = (over: Partial<Birth> = {}): Birth => ({
  harmonic: 3,
  detuneCents: -7,
  support: 6,
  flatness: 0.2,
  vacancy: 0.5,
  frequency: 660,
  coherence: 0.8,
  cohort: 11,
  ...over,
})

test('a particle is 32 bytes and spends every spare bit on life', () => {
  assert.equal(PARTICLE_BYTES, 32)
  assert.equal(LIFE_BITS, 64)
})

test('no life field overlaps another', () => {
  for (const word of [LIFE0, LIFE1]) {
    let covered = 0
    for (const { shift, bits } of word.values()) {
      const mask = (((1 << bits) - 1) << shift) >>> 0
      assert.equal(covered & mask, 0, 'two fields claim the same bits')
      covered |= mask
    }
  }
})

test('birth attributes survive a round trip within their quantisation', () => {
  const b = birth()
  const out = decodeLife0(encodeLife0(b))
  assert.equal(out.harmonic, b.harmonic)
  assert.equal(out.detuneCents, b.detuneCents)
  assert.equal(out.support, b.support)
  assert.ok(Math.abs(out.flatness - b.flatness) <= 1 / 15)
  assert.ok(Math.abs(out.vacancy - b.vacancy) <= 1 / 7)
  assert.ok(Math.abs(out.coherence - b.coherence) <= 1 / 15)
  assert.equal(out.register, registerOf(b.frequency))
})

test('every field saturates instead of wrapping into its neighbour', () => {
  const extreme = encodeLife0(
    birth({ harmonic: 999, detuneCents: 5000, support: 999, flatness: 12, vacancy: 40, coherence: 9 }),
  )
  const out = decodeLife0(extreme)
  assert.equal(out.harmonic, 31)
  assert.equal(out.detuneCents, 31)
  assert.equal(out.support, 31)
  assert.equal(out.flatness, 1)
  assert.equal(out.vacancy, 1)
  assert.equal(out.coherence, 1)

  const negative = decodeLife0(encodeLife0(birth({ detuneCents: -5000, vacancy: -40 })))
  assert.equal(negative.detuneCents, -32)
  assert.equal(negative.vacancy, -8 / 7)
})

test('running state round trips, and age reaches far past the visible history', () => {
  const state = { age: 40000, vitality: 0.5, cohort: 42, generation: 9 }
  const out = decodeLife1(encodeLife1(state))
  assert.equal(out.age, 40000)
  assert.equal(out.cohort, 42)
  assert.equal(out.generation, 9)
  assert.ok(Math.abs(out.vitality - 0.5) <= 1 / 63)

  // Two minutes of history at 120 Hz is 14,400 steps; the counter has to clear that with room.
  assert.ok(MAX_AGE > 14400)
  assert.equal(decodeLife1(encodeLife1({ ...state, age: 1e9 })).age, MAX_AGE)
})

test('colour and flags share a word without touching each other', () => {
  const word = packColour(1, 0.5, 0, 0b1011)
  const out = unpackColour(word)
  assert.equal(out.r, 1)
  assert.ok(Math.abs(out.g - 0.5) <= 1 / 255)
  assert.equal(out.b, 0)
  assert.equal(out.flags, 0b1011)
})

test('an octave of the same note is born the same hue', () => {
  const a = birthColour(birth({ frequency: 440, harmonic: 1 }))
  const b = birthColour(birth({ frequency: 880, harmonic: 1 }))
  for (const channel of ['r', 'g', 'b'] as const) {
    assert.ok(
      Math.abs(a[channel] - b[channel]) < 1e-6,
      'chroma should repeat every octave, so A4 and A5 are the same colour',
    )
  }
})

test('noise is born grey and a supported partial is born vivid', () => {
  const spread = (c: { r: number; g: number; b: number }) =>
    Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)
  const noise = birthColour(birth({ flatness: 1, support: 0, harmonic: 0 }))
  const tone = birthColour(birth({ flatness: 0, support: 12, harmonic: 1 }))
  assert.ok(spread(noise) < 0.02, 'flat spectra should have almost no chroma')
  assert.ok(spread(tone) > 0.3, 'a well-supported partial should be saturated')
})

// ---------------------------------------------------------------------------------------
// The harmonic measurements the birth attributes come from
// ---------------------------------------------------------------------------------------

test('cents are the interval, not the difference', () => {
  assert.ok(Math.abs(cents(880, 440) - 1200) < 1e-9)
  assert.ok(Math.abs(cents(440, 880) + 1200) < 1e-9)
  assert.ok(Math.abs(cents(440 * Math.pow(2, 1 / 12), 440) - 100) < 1e-9)
})

test('a partial is placed on the series it belongs to', () => {
  const id = harmonicIdentity(1320, 440)
  assert.equal(id.number, 3)
  assert.ok(Math.abs(id.detune) < 1e-6)
  assert.ok(id.fit > 0.99)
})

test('a partial between harmonics belongs to neither', () => {
  // Halfway between the 2nd and 3rd harmonics: 350 cents from one, 350 from the other.
  assert.equal(harmonicIdentity(440 * 2.5, 440).number, 0)
})

test('the gate widens for stiffness but never past the neighbouring harmonic', () => {
  // 40 cents sharp is comfortably inside the gate on the 2nd partial, where real strings do
  // run sharp and the next harmonic is 350 cents away.
  assert.equal(harmonicIdentity(440 * 2 * Math.pow(2, 40 / 1200), 440).number, 2)
  // The same 40 cents on the 16th is refused: 16 and 17 are 105 cents apart, so a partial that
  // far off is no longer identifiably either of them.
  assert.equal(harmonicIdentity(440 * 16 * Math.pow(2, 40 / 1200), 440).number, 0)
  // And a small error up there is still accepted.
  assert.equal(harmonicIdentity(440 * 16 * Math.pow(2, 10 / 1200), 440).number, 16)
})

test('a present fundamental beats the octave below it', () => {
  // The 1/sqrt(n) weighting has to make f0 win when it is really there, and lose when it is not.
  assert.ok(Math.abs(cents(inferFundamental([220, 440, 660, 880]).frequency, 220)) < 35)
})

test('support counts the family, not the peaks', () => {
  const series = [220, 440, 660, 880, 1100]
  const { count } = harmonicSupport(series, 220)
  assert.equal(count, 5)
  // Duplicates of the same harmonic are one sibling, not two.
  assert.equal(harmonicSupport([440, 441, 442], 220).count, 1)
  // Nothing on the series is no family at all.
  assert.equal(harmonicSupport([317, 519, 733], 220).count, 0)
})

test('a missing fundamental is still inferred from its harmonics', () => {
  // 2nd through 6th of 110 Hz, with no energy at 110 itself.
  const peaks = [220, 330, 440, 550, 660]
  const { frequency } = inferFundamental(peaks)
  assert.ok(Math.abs(cents(frequency, 110)) < 35, `expected ~110 Hz, got ${frequency}`)
})

test('flatness separates a tone from noise', () => {
  const tone = [0.0001, 0.0001, 1, 0.0001, 0.0001]
  const noise = [0.5, 0.52, 0.48, 0.51, 0.49]
  assert.ok(spectralFlatness(tone) < 0.05)
  assert.ok(spectralFlatness(noise) > 0.9)
  assert.equal(spectralFlatness([]), 0)
})
