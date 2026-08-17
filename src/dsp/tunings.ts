/**
 * The tunings that ship with the analyser.
 *
 * Every one of them is *computed from its definition* rather than copied from a table of cents.
 * A well temperament is not a list of twelve numbers, it is a rule about how far each fifth in
 * the chain falls short of pure — and a list of numbers is that rule with the reasoning thrown
 * away and a transcription error waiting to happen. Werckmeister said "narrow four of the fifths
 * by a quarter of the Pythagorean comma"; that is what is written below, and the twelve numbers
 * come out of it exactly. `tuning.test.ts` checks them against the published values.
 *
 * Sources for the definitions: Kyle Gann, "An Introduction to Historical Tunings"
 * (kylegann.com/histune.html), and the Wikipedia articles on Werckmeister, Kirnberger, Vallotti
 * and Young temperaments, which agree with it to the last figure quoted.
 */

import { centsOf, type Tuning } from './tuning.ts'

/** Intervals every temperament below is built out of. */
const PURE_FIFTH = centsOf(3 / 2)
/** Twelve pure fifths overshoot seven octaves by this much. */
const PYTHAGOREAN_COMMA = centsOf(Math.pow(3, 12) / Math.pow(2, 19))
/** Four pure fifths overshoot a pure major third by this much. */
const SYNTONIC_COMMA = centsOf(81 / 80)
/** The little that is left between the two commas. */
const SCHISMA = centsOf(32805 / 32768)

/**
 * The twelve notes of a chain of eleven fifths.
 *
 * Position 0 is the flattest note of the chain and each position is a fifth above the one before,
 * so the chain runs (for `cIndex` = 1) F C G D A E B F♯ C♯ G♯ E♭ B♭ — with the wolf, whatever is
 * left over, between the last position and the first. `cIndex` says where C sits in that chain,
 * which is the same as saying how many fifths of the chain lie below C. `fifths[i]` is the size
 * of the fifth from position i to position i+1.
 */
function fromFifths(cIndex: number, fifths: number[]): number[] {
  const cents = new Array<number>(12)
  const set = (position: number, value: number) => {
    // Seven semitones per fifth, reduced into one octave: the chain's position *is* the note.
    const semitone = ((((position - cIndex) * 7) % 12) + 12) % 12
    cents[semitone] = ((value % 1200) + 1200) % 1200
  }
  set(cIndex, 0)
  let above = 0
  for (let position = cIndex; position < 11; position++) {
    above += fifths[position]
    set(position + 1, above)
  }
  let below = 0
  for (let position = cIndex; position > 0; position--) {
    below -= fifths[position - 1]
    set(position - 1, below)
  }
  return cents
}

/** Eleven fifths, all the same size. */
const regular = (fifth: number): number[] => new Array(11).fill(fifth)

/** Eleven pure fifths with `narrow` cents taken out of the ones at `positions`. */
function tempered(positions: number[], narrow: number): number[] {
  return regular(PURE_FIFTH).map((fifth, i) => (positions.includes(i) ? fifth - narrow : fifth))
}

/** An equal division of the period. */
function equalSteps(count: number, period = 1200): number[] {
  return Array.from({ length: count }, (_, i) => (i * period) / count)
}

const scale = (
  id: string,
  label: string,
  degrees: number[],
  note: string,
  period = 1200,
): Tuning => ({ kind: 'scale', id, label, source: 'builtin', degrees, period, note })

/**
 * Kirnberger's chain: four fifths carry a quarter of the syntonic comma each, which puts a pure
 * third on C, and the schisma left over once that is spent is hidden in F♯–C♯ so the circle
 * closes exactly.
 */
const KIRNBERGER_FIFTHS = tempered([1, 2, 3, 4], SYNTONIC_COMMA / 4)
KIRNBERGER_FIFTHS[7] -= SCHISMA

/**
 * Ordered as they would be met: equal first because it is what everything else is heard against,
 * then the temperaments in the order they were arrived at historically, then the equal divisions
 * that are not twelve, then the scales that do not have an octave at all.
 */
export const BUILTIN_TUNINGS: readonly Tuning[] = [
  scale(
    'equal',
    '12-tone equal temperament',
    equalSteps(12),
    'Twelve equal semitones. Every key sounds alike and no interval but the octave is pure — the compromise the last two centuries settled on.',
  ),
  scale(
    'pythagorean',
    'Pythagorean',
    fromFifths(4, regular(PURE_FIFTH)),
    'Eleven pure fifths in a chain from A♭ to C♯, which leaves the twelfth a comma short: the wolf. Thirds are wide and restless, fifths are perfect.',
  ),
  scale(
    'just',
    'Just intonation (5-limit)',
    [1, 16 / 15, 9 / 8, 6 / 5, 5 / 4, 4 / 3, 45 / 32, 3 / 2, 8 / 5, 5 / 3, 9 / 5, 15 / 8].map(
      centsOf,
    ),
    'Whole-number ratios throughout, so the triads on the root lock without a beat. Modulate away from that root and the same ratios turn against you.',
  ),
  scale(
    'meantone-quarter',
    'Quarter-comma meantone',
    fromFifths(3, regular(PURE_FIFTH - SYNTONIC_COMMA / 4)),
    'Every fifth narrowed by a quarter of the syntonic comma, which buys eight pure major thirds. The standard of the sixteenth and seventeenth centuries.',
  ),
  scale(
    'meantone-sixth',
    'Sixth-comma meantone',
    fromFifths(3, regular(PURE_FIFTH - SYNTONIC_COMMA / 6)),
    'A gentler meantone — thirds a little wide, fifths a little less narrow, and a wolf you can almost live with. Silbermann tuned his organs this way.',
  ),
  scale(
    'werckmeister3',
    'Werckmeister III',
    fromFifths(1, tempered([1, 2, 3, 6], PYTHAGOREAN_COMMA / 4)),
    'Four fifths — C–G, G–D, D–A and B–F♯ — narrowed by a quarter of the Pythagorean comma, the rest pure. 1691, and the first temperament in which every key is playable.',
  ),
  scale(
    'kirnberger3',
    'Kirnberger III',
    fromFifths(1, KIRNBERGER_FIFTHS),
    'A pure C–E third carried by four quarter-comma fifths, the leftover schisma hidden in F♯–C♯. 1779, from a pupil of Bach.',
  ),
  scale(
    'vallotti',
    'Vallotti',
    fromFifths(1, tempered([0, 1, 2, 3, 4, 5], PYTHAGOREAN_COMMA / 6)),
    'Six fifths from F to B each narrowed by a sixth of the Pythagorean comma, six pure. The plainest of the well temperaments and the easiest to tune by ear.',
  ),
  scale(
    'young2',
    'Young II',
    fromFifths(1, tempered([1, 2, 3, 4, 5, 6], PYTHAGOREAN_COMMA / 6)),
    'Vallotti moved one fifth along the chain, so the tempering runs C to F♯ and the key colours turn with it. Thomas Young, 1799.',
  ),
  scale(
    'edo19',
    '19-tone equal',
    equalSteps(19),
    'Nineteen equal steps. Meantone taken to its conclusion: thirds close to pure, and sharps genuinely lower than the flats above them.',
  ),
  scale(
    'edo24',
    '24-tone equal (quarter tones)',
    equalSteps(24),
    'Semitones halved. The common ground of twentieth-century microtonal notation and of maqam approximations.',
  ),
  scale(
    'edo31',
    '31-tone equal',
    equalSteps(31),
    'Thirty-one equal steps, near enough to quarter-comma meantone to pass for it, and closed. Huygens worked it out in 1691.',
  ),
  scale(
    'edo53',
    '53-tone equal',
    equalSteps(53),
    'Fifty-three equal steps: fifths and thirds both within a cent of pure, and the Pythagorean comma is exactly one step.',
  ),
  scale(
    'harmonic',
    'Harmonic series 8–16',
    [8, 9, 10, 11, 12, 13, 14, 15].map((n) => centsOf(n / 8)),
    'The eighth to the sixteenth harmonics, laid out as a scale. On a spectrum this is where the partials of one note actually fall.',
  ),
  scale(
    'bohlen-pierce',
    'Bohlen-Pierce',
    equalSteps(13, centsOf(3)),
    'Thirteen equal steps of a *twelfth* rather than an octave. Built on odd harmonics, with no octave in it anywhere.',
    centsOf(3),
  ),
]

/** Built-ins first, then whatever has been imported, which is the order the menu wants. */
export function allTunings(imported: readonly Tuning[]): Tuning[] {
  return [...BUILTIN_TUNINGS, ...imported]
}

/** The tuning in force, falling back to equal temperament if the profile names one that is gone. */
export function findTuning(imported: readonly Tuning[], id: string): Tuning {
  return allTunings(imported).find((tuning) => tuning.id === id) ?? BUILTIN_TUNINGS[0]
}
