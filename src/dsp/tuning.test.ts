/**
 * Two things are worth pinning here.
 *
 * The temperaments are computed from their definitions rather than transcribed, which is only
 * better than transcribing them if the arithmetic actually lands on the published numbers — so
 * each is checked against the cents quoted by Kyle Gann's "An Introduction to Historical Tunings"
 * and the Wikipedia articles on Kirnberger, Vallotti and Young, to the figures those sources give.
 *
 * And the tuning-file reader has to survive real files: sections in any case, comments, a base
 * frequency that is not the standard one, and the specification's completion rule, where a file
 * stops at the top of one period and every key above it repeats.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  A4_MIDI,
  TUN_BASE_HZ,
  centsOf,
  degreeOf,
  isTwelveTone,
  nearestNote,
  noteHz,
  noteName,
  parseTun,
  type Tuning,
  type TuningSettings,
} from './tuning.ts'
import { BUILTIN_TUNINGS, allTunings, findTuning } from './tunings.ts'

const settings = (over: Partial<TuningSettings> = {}): TuningSettings => ({
  mode: 'note',
  id: 'equal',
  referenceHz: 440,
  root: 60,
  imported: [],
  ...over,
})

const byId = (id: string): Tuning => {
  const tuning = BUILTIN_TUNINGS.find((t) => t.id === id)
  assert.ok(tuning, `no built-in tuning ${id}`)
  return tuning
}

/** Cents of each degree, rounded the way the sources quote them. */
const degrees = (id: string, places: number): number[] => {
  const tuning = byId(id)
  assert.equal(tuning.kind, 'scale')
  return tuning.kind === 'scale'
    ? tuning.degrees.map((c) => Number(c.toFixed(places)))
    : []
}

test('equal temperament is what everyone else is measured against', () => {
  assert.deepEqual(degrees('equal', 3), [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100])
  const equal = byId('equal')
  const s = settings()
  assert.equal(noteHz(equal, A4_MIDI, s), 440)
  // Middle C, to the two figures every tuning fork prints.
  assert.equal(noteHz(equal, 60, s).toFixed(2), '261.63')
  assert.equal(noteHz(equal, 81, s).toFixed(1), '880.0', 'an octave up is a doubling')
  assert.equal(noteHz(equal, 57, s).toFixed(1), '220.0', 'and an octave down is a halving')
})

test('the concert pitch moves everything with it', () => {
  const equal = byId('equal')
  assert.equal(noteHz(equal, A4_MIDI, settings({ referenceHz: 432 })), 432)
  assert.equal(noteHz(equal, 60, settings({ referenceHz: 432 })).toFixed(2), '256.87')
})

test('Pythagorean is a chain of pure fifths with the wolf pushed out of the way', () => {
  // Gann: 0, 113.7, 203.9, 294.1, 407.8, 498, 611.7, 702, 792.2, 905.9, 996.1, 1109.8
  assert.deepEqual(
    degrees('pythagorean', 1),
    [0, 113.7, 203.9, 294.1, 407.8, 498, 611.7, 702, 792.2, 905.9, 996.1, 1109.8],
  )
})

test('quarter-comma meantone buys pure thirds with narrow fifths', () => {
  // Gann: 0, 76.0, 193.2, 310.3, 386.3, 503.4, 579.5, 696.8, 772.6, 889.7, 1006.8, 1082.9
  assert.deepEqual(
    degrees('meantone-quarter', 1),
    [0, 76, 193.2, 310.3, 386.3, 503.4, 579.5, 696.6, 772.6, 889.7, 1006.8, 1082.9],
  )
  // The major third above the root is pure 5/4, which is the whole point of the temperament.
  const meantone = byId('meantone-quarter')
  assert.equal(meantone.kind === 'scale' ? meantone.degrees[4].toFixed(3) : '', centsOf(5 / 4).toFixed(3))
})

test('Werckmeister III lands on the published cents exactly', () => {
  // Gann, to three places: 0, 90.225, 192.18, 294.135, 390.225, 498.045, 588.27, 696.09,
  // 792.18, 888.27, 996.09, 1092.18
  assert.deepEqual(
    degrees('werckmeister3', 3),
    [0, 90.225, 192.18, 294.135, 390.225, 498.045, 588.27, 696.09, 792.18, 888.27, 996.09, 1092.18],
  )
})

test('Kirnberger III lands on the published cents exactly', () => {
  // Wikipedia: C 0, C♯ 90.225, D 193.157, D♯ 294.135, E 386.314, F 498.045, F♯ 590.224,
  // G 696.578, G♯ 792.180, A 889.735, B♭ 996.090, B 1088.269
  assert.deepEqual(
    degrees('kirnberger3', 3),
    [0, 90.225, 193.157, 294.135, 386.314, 498.045, 590.224, 696.578, 792.18, 889.735, 996.09, 1088.269],
  )
})

test('Vallotti and Young II are the same six fifths, one step apart in the chain', () => {
  const vallotti = degrees('vallotti', 3)
  const young = degrees('young2', 3)
  assert.deepEqual(
    vallotti,
    [0, 94.135, 196.09, 298.045, 392.18, 501.955, 592.18, 698.045, 796.09, 894.135, 1000, 1090.225],
  )
  assert.deepEqual(
    young,
    [0, 90.225, 196.09, 294.135, 392.18, 498.045, 588.27, 698.045, 792.18, 894.135, 996.09, 1090.225],
  )
  // Six fifths tempered and six pure in both, so they share their D, E, A and B.
  for (const degree of [2, 4, 9, 11]) assert.equal(vallotti[degree], young[degree])
})

test('every built-in scale rises from its root and stays inside its period', () => {
  for (const tuning of BUILTIN_TUNINGS) {
    assert.equal(tuning.kind, 'scale', `${tuning.id} should be a scale`)
    if (tuning.kind !== 'scale') continue
    assert.equal(tuning.degrees[0], 0, `${tuning.id} does not start on its root`)
    assert.ok(tuning.period > 0, `${tuning.id} has no period`)
    for (let i = 1; i < tuning.degrees.length; i++) {
      assert.ok(
        tuning.degrees[i] > tuning.degrees[i - 1],
        `${tuning.id} degree ${i} does not rise`,
      )
      assert.ok(tuning.degrees[i] < tuning.period, `${tuning.id} degree ${i} leaves the period`)
    }
    // A tuning that cannot be told apart from another by id is a tuning the profile cannot name.
    assert.equal(
      BUILTIN_TUNINGS.filter((other) => other.id === tuning.id).length,
      1,
      `${tuning.id} is not unique`,
    )
  }
})

test('a temperament is a shape, and the root decides which key it sits on', () => {
  const werckmeister = byId('werckmeister3')
  // With the root on C, the fifth C–G is the narrow one and D–A is narrow too; move the root up
  // two semitones and the same pattern of fifths moves with it.
  const onC = noteHz(werckmeister, 67, settings()) / noteHz(werckmeister, 60, settings())
  const onD = noteHz(werckmeister, 69, settings({ root: 62 })) / noteHz(werckmeister, 62, settings({ root: 62 }))
  assert.equal(centsOf(onC).toFixed(3), centsOf(onD).toFixed(3))
})

test('degrees and names read off the keyboard, not off the scale', () => {
  assert.equal(noteName(60), 'C4')
  assert.equal(noteName(69), 'A4')
  assert.equal(noteName(61), 'C♯4')
  assert.equal(noteName(59), 'B3')
  assert.equal(noteName(0), 'C-1')
  assert.equal(degreeOf(byId('equal'), 60, 60), 0)
  assert.equal(degreeOf(byId('equal'), 67, 60), 7)
  assert.equal(degreeOf(byId('equal'), 48, 60), 0, 'an octave down is the same degree')
  assert.equal(degreeOf(byId('edo31'), 60 + 31, 60), 0, 'and so is a period down in 31')
  assert.ok(isTwelveTone(byId('vallotti')))
  assert.ok(!isTwelveTone(byId('edo19')))
  assert.ok(!isTwelveTone(byId('bohlen-pierce')))
})

test('Bohlen-Pierce has no octave in it at all', () => {
  const bp = byId('bohlen-pierce')
  assert.equal(bp.kind === 'scale' ? bp.period.toFixed(3) : '', centsOf(3).toFixed(3))
  const s = settings()
  // A period up is a twelfth: three times the frequency, not two.
  assert.equal((noteHz(bp, 60 + 13, s) / noteHz(bp, 60, s)).toFixed(6), '3.000000')
})

test('the nearest note is found with the deviation that goes with it', () => {
  const equal = byId('equal')
  const s = settings()
  const exact = nearestNote(equal, 440, s)
  assert.equal(exact.midi, A4_MIDI)
  assert.equal(Math.abs(exact.cents) < 1e-9, true)

  const sharp = nearestNote(equal, 440 * Math.pow(2, 20 / 1200), s)
  assert.equal(sharp.midi, A4_MIDI)
  assert.equal(sharp.cents.toFixed(1), '20.0')

  // Just over half a semitone up is the next note down, by a whisker.
  const between = nearestNote(equal, 440 * Math.pow(2, 51 / 1200), s)
  assert.equal(between.midi, A4_MIDI + 1)
  assert.equal(between.cents.toFixed(0), '-49')
})

// ---------------------------------------------------------------------------------------
// Tuning files
// ---------------------------------------------------------------------------------------

/** A minimal but valid file: the quantised section only, twelve equal semitones. */
const EQUAL_TUN = [
  '; a comment, ignored',
  '[Info]',
  'Name = "Twelve equal"',
  '[Tuning]',
  ...Array.from({ length: 128 }, (_, i) => `note ${i}=${i * 100}`),
].join('\n')

test('a tuning file is read, named, and recognised as the scale it is', () => {
  const parsed = parseTun(EQUAL_TUN, 'fallback')
  assert.ok(parsed)
  assert.equal(parsed.tuning.label, 'Twelve equal')
  assert.equal(parsed.tuning.source, 'imported')
  assert.equal(parsed.referenceHz.toFixed(3), '440.000')
  assert.equal(parsed.tuning.kind, 'scale', 'twelve repeating semitones are a scale, not a table')
  if (parsed.tuning.kind === 'scale') {
    assert.equal(parsed.tuning.degrees.length, 12)
    assert.equal(parsed.tuning.period.toFixed(3), '1200.000')
    assert.equal(parsed.tuning.degrees[7], 700)
  }
})

test("the file's own base frequency is folded in, and read back as its concert pitch", () => {
  // The base frequency is MIDI note 0, so a base scaled by 432/440 puts A4 on 432.
  const base = (TUN_BASE_HZ * 432) / 440
  const shifted = EQUAL_TUN.replace('[Tuning]', `[Exact Tuning]\nBaseFreq = ${base.toFixed(9)}`)
  const parsed = parseTun(shifted, 'fallback')
  assert.ok(parsed)
  assert.equal(parsed.referenceHz.toFixed(3), '432.000')
})

test('the completion rule turns one period into a keyboard', () => {
  // The specification: a file may stop at the top of one period, and every key above it repeats.
  const short = ['[Exact Tuning]', ...Array.from({ length: 13 }, (_, i) => `note ${i} = ${i * 100}`)].join('\n')
  const parsed = parseTun(short, 'short')
  assert.ok(parsed)
  assert.equal(parsed.tuning.kind, 'scale')
  if (parsed.tuning.kind === 'scale') {
    assert.equal(parsed.tuning.period, 1200)
    assert.equal(parsed.tuning.degrees.length, 12)
  }
})

test('a tuning that does not repeat keeps its table', () => {
  // A stretched octave: every key a little wider than the last, which is what a piano is.
  const stretched = [
    '[Exact Tuning]',
    ...Array.from({ length: 128 }, (_, i) => `note ${i} = ${(i * 100 + i * i * 0.01).toFixed(6)}`),
  ].join('\n')
  const parsed = parseTun(stretched, 'stretched')
  assert.ok(parsed)
  assert.equal(parsed.tuning.kind, 'map')
  if (parsed.tuning.kind === 'map') {
    assert.equal(parsed.tuning.cents.length, 128)
    const s = settings()
    const octave = centsOf(noteHz(parsed.tuning, 72, s) / noteHz(parsed.tuning, 60, s))
    assert.ok(octave > 1200, 'the stretch survived the round trip')
  }
  // And it still runs off the end of the keyboard, because a spectrum does not stop at MIDI 127.
  const s = settings()
  assert.ok(noteHz(parsed.tuning, 130, s) > noteHz(parsed.tuning, 127, s))
})

test('sections, keys and whitespace are read as the specification writes them', () => {
  const messy = [
    'anything before the first section is ignored',
    '[INFO]',
    '   nAmE   =   "Messy"  ',
    '[EXACT TUNING]',
    'basefreq=8.1757989156',
    ...Array.from({ length: 13 }, (_, i) => `NOTE ${i}\t=\t${i * 100}`),
    '[Editor Specifics]',
    'note 0 = 999999',
  ].join('\r\n')
  const parsed = parseTun(messy, 'fallback')
  assert.ok(parsed)
  assert.equal(parsed.tuning.label, 'Messy')
  assert.equal(parsed.referenceHz.toFixed(2), '440.00')
})

test('a file with nothing to say is refused rather than half-read', () => {
  assert.equal(parseTun('', 'x'), null)
  assert.equal(parseTun('[Info]\nName = "Empty"', 'x'), null)
  assert.equal(parseTun('[Tuning]\nnote 0 = 0', 'x'), null, 'one note is not a period')
})

test('an imported tuning joins the list and can be found again', () => {
  const parsed = parseTun(EQUAL_TUN, 'fallback')
  assert.ok(parsed)
  const list = allTunings([parsed.tuning])
  assert.equal(list.length, BUILTIN_TUNINGS.length + 1)
  assert.equal(findTuning([parsed.tuning], parsed.tuning.id).label, 'Twelve equal')
  // A profile naming a tuning that has since been deleted still starts.
  assert.equal(findTuning([], 'tun:gone').id, 'equal')
})

test('the standard base frequency is the one MIDI note 0 sits on', () => {
  const equal = byId('equal')
  assert.equal(noteHz(equal, 0, settings()).toFixed(10), TUN_BASE_HZ.toFixed(10))
})
