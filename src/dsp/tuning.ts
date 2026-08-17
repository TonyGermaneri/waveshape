/**
 * What a note is, in hertz.
 *
 * A frequency axis says where energy is; a note axis says what it would be called. Going from one
 * to the other needs three things and no more: a scale, saying how the steps within a period are
 * spaced; a reference, fixing one note to one frequency; and a root, saying which key the scale's
 * first degree sits on. Everything here is those three, and nothing here knows about the screen.
 *
 * Two shapes of scale, because two shapes exist in the world. Most are periodic — twelve steps
 * that repeat every octave — and are stored as the steps of one period. Some are not: a piano's
 * stretched octaves are a different frequency for every key with no repeat anywhere, and an
 * imported tuning file is entitled to say so. A periodic tuning is stored as its period because
 * that is what it is; a mapped one is stored key by key for the same reason.
 *
 * Cents throughout: 1200 to the octave, logarithmic, so an interval is a difference rather than a
 * ratio and the arithmetic is addition.
 */

/** MIDI note of A4, the note every tuning here is anchored to. */
export const A4_MIDI = 69

/**
 * MIDI note 0 under standard tuning, and the frequency every cents value in an AnaMark tuning
 * file is measured from. 440 Hz divided by 2^(69/12), to as many figures as the specification
 * prints.
 */
export const TUN_BASE_HZ = 8.1757989156437073336

/** Semitone names, sharps only: a graticule has no way of knowing which spelling was meant. */
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'] as const

interface TuningCommon {
  id: string
  label: string
  /** Built-ins cannot be deleted from the panel; imported ones can. */
  source: 'builtin' | 'imported'
  /** Where it comes from and what it is for, shown under the menu. */
  note?: string
}

/** A scale that repeats: the usual thing, and the only thing a temperament can be. */
export interface ScaleTuning extends TuningCommon {
  kind: 'scale'
  /** Cents above the root for each degree of one period, ascending, starting at 0. */
  degrees: number[]
  /** The period itself, in cents. 1200 is an octave. */
  period: number
}

/**
 * A scale that does not repeat: absolute cents above `TUN_BASE_HZ` for MIDI notes 0..127, which
 * is exactly the table an AnaMark file carries. A stretched piano curve is the everyday example
 * — its octaves are wider than 1200 cents and by a different amount at each end of the keyboard,
 * so there is no period to store.
 */
export interface MappedTuning extends TuningCommon {
  kind: 'map'
  cents: number[]
}

export type Tuning = ScaleTuning | MappedTuning

/** Where the panel's tuning settings live in the profile. */
export interface TuningSettings {
  mode: 'frequency' | 'note'
  id: string
  /** Concert pitch: the frequency of A4, which anchors every tuning. */
  referenceHz: number
  /** MIDI note the scale's first degree sits on. 60 is middle C. */
  root: number
  imported: Tuning[]
}

/** Cents of a frequency ratio. */
export function centsOf(ratio: number): number {
  return 1200 * Math.log2(ratio)
}

/** Ratio of an interval in cents. */
export function ratioOf(cents: number): number {
  return Math.pow(2, cents / 1200)
}

/**
 * Cents above the tuning's own zero for a MIDI note.
 *
 * Only differences of this are meaningful — the zero is the root for a scale and MIDI note 0 for
 * a map — which is why nothing outside this file uses it without subtracting another of them.
 */
function noteCents(tuning: Tuning, midi: number, root: number): number {
  if (tuning.kind === 'map') return mappedCents(tuning.cents, midi)
  const count = tuning.degrees.length
  const index = midi - root
  // Floored division, so the pattern continues downwards as well as up.
  const period = Math.floor(index / count)
  return period * tuning.period + tuning.degrees[index - period * count]
}

/**
 * A mapped tuning outside the 128 keys it was written for.
 *
 * A keyboard stops at MIDI 127, a little over 12 kHz; a spectrum does not. Rather than stop the
 * axis where the table does, the table's own top and bottom octaves are continued at the spacing
 * they end with — which for a stretched tuning is the stretch, carried on.
 */
function mappedCents(cents: number[], midi: number): number {
  const last = cents.length - 1
  if (midi >= 0 && midi <= last) return cents[midi]
  if (midi > last) {
    const octave = (cents[last] - cents[Math.max(0, last - 12)]) / 12
    return cents[last] + (midi - last) * octave
  }
  const octave = (cents[Math.min(last, 12)] - cents[0]) / 12
  return cents[0] + midi * octave
}

/** The frequency of a MIDI note, with A4 at the reference pitch. */
export function noteHz(tuning: Tuning, midi: number, settings: TuningSettings): number {
  const relative = noteCents(tuning, midi, settings.root) - noteCents(tuning, A4_MIDI, settings.root)
  return settings.referenceHz * ratioOf(relative)
}

/** Which degree of the scale a MIDI note is, counting from the root. 0 is the root itself. */
export function degreeOf(tuning: Tuning, midi: number, root: number): number {
  const count = tuning.kind === 'scale' ? tuning.degrees.length : 12
  const index = midi - (tuning.kind === 'scale' ? root : 0)
  return ((index % count) + count) % count
}

/** Scientific pitch notation, where MIDI 60 is C4. */
export function noteName(midi: number): string {
  const pitchClass = ((midi % 12) + 12) % 12
  return `${NOTE_NAMES[pitchClass]}${Math.floor(midi / 12) - 1}`
}

/** True when the tuning is twelve steps to the octave, and so can wear the keyboard's names. */
export function isTwelveTone(tuning: Tuning): boolean {
  if (tuning.kind === 'map') return true
  return tuning.degrees.length === 12 && Math.abs(tuning.period - 1200) < 1e-6
}

/**
 * The note nearest a frequency, and how far above it that frequency is in cents. Searched rather
 * than solved: a tuning is an arbitrary table, and only a regular one has an inverse.
 */
export function nearestNote(
  tuning: Tuning,
  hz: number,
  settings: TuningSettings,
  lowest = 0,
  highest = 140,
): { midi: number; cents: number } {
  if (!(hz > 0)) return { midi: A4_MIDI, cents: 0 }
  let best = lowest
  let bestDistance = Infinity
  for (let midi = lowest; midi <= highest; midi++) {
    const distance = Math.abs(centsOf(hz / noteHz(tuning, midi, settings)))
    if (distance < bestDistance) {
      bestDistance = distance
      best = midi
    }
  }
  return { midi: best, cents: centsOf(hz / noteHz(tuning, best, settings)) }
}

// ---------------------------------------------------------------------------------------
// AnaMark tuning files
// ---------------------------------------------------------------------------------------

/** What a parsed file yields: the scale, and the concert pitch it was written at. */
export interface TuningImport {
  tuning: Tuning
  referenceHz: number
}

/**
 * Reads an AnaMark tuning file (.tun), to version 2.00 of the specification.
 *
 * Three sections can carry a tuning and they are ranked: `[Functional Tuning]` is an algorithmic
 * definition, `[Exact Tuning]` a table of real numbers with a base frequency, and `[Tuning]` the
 * same table quantised to whole cents. The exact table is read where there is one and the
 * quantised one otherwise; the functional section is ignored, which costs nothing in practice
 * because a file carrying it is required to carry a table as well for compatibility with the
 * readers that came first.
 *
 * The completion rule at the end is the specification's, and it is what makes a periodic scale
 * expressible in a handful of lines: a file may stop at the top of one period, and every key
 * above it repeats that period. Its own paragraph, because it is the one part of reading this
 * format that cannot be guessed at from a sample file.
 */
export function parseTun(text: string, fallbackLabel: string): TuningImport | null {
  const exact = new Map<number, number>()
  const quantised = new Map<number, number>()
  let baseFreq = TUN_BASE_HZ
  let name = ''
  let section = ''

  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(';')) continue
    if (line.startsWith('[')) {
      const end = line.indexOf(']')
      section = end < 0 ? '' : line.slice(1, end).trim().toLowerCase()
      continue
    }
    const split = line.indexOf('=')
    if (split < 0) continue
    const key = line.slice(0, split).trim().toLowerCase()
    const value = line.slice(split + 1).trim()
    // Key names may carry spaces within them, which is how `note 60` names one of an array.
    const note = /^note\s*(\d+)$/.exec(key)

    if (section === 'info' && key === 'name') name = value.replace(/^"|"$/g, '')
    else if (section === 'exact tuning' && key === 'basefreq') baseFreq = Number(value) || baseFreq
    else if (section === 'exact tuning' && note) exact.set(Number(note[1]), Number(value))
    else if (section === 'tuning' && note) quantised.set(Number(note[1]), Number(value))
  }

  const table = exact.size > 0 ? exact : quantised
  const base = exact.size > 0 ? baseFreq : TUN_BASE_HZ

  // Notes below the highest one given that the file left out are the standard semitones; the
  // ones above it repeat the period, which is the tuning of that highest note. One note is not a
  // period, so a file that gives only note 0 has told us nothing to repeat.
  const highest = table.size > 0 ? Math.max(...table.keys()) : 0
  if (highest < 1) return null
  const cents: number[] = []
  for (let midi = 0; midi <= Math.min(highest, 127); midi++) {
    cents[midi] = table.get(midi) ?? 100 * midi
  }
  const period = cents[Math.min(highest, 127)]
  for (let midi = highest + 1; midi <= 127; midi++) cents[midi] = cents[midi - highest] + period

  // Cents in the file are measured from its own base frequency; here they are measured from the
  // standard one, so that two files with different bases can be compared without carrying theirs.
  const offset = centsOf(base / TUN_BASE_HZ)
  const absolute = cents.map((c) => c + offset)
  const label = name || fallbackLabel
  const id = `tun:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
  const referenceHz = TUN_BASE_HZ * ratioOf(absolute[A4_MIDI])
  const scale = asScale(absolute)

  return {
    referenceHz,
    tuning: scale
      ? { kind: 'scale', id, label, source: 'imported', ...scale }
      : { kind: 'map', id, label, source: 'imported', cents: absolute },
  }
}

/**
 * Recovers the repeating scale behind a table of 128 notes, or nothing when there is not one.
 *
 * Worth the search because almost every tuning in circulation *is* periodic, and a period is both
 * a hundred times smaller to store and the thing the panel can describe — "twelve degrees to the
 * octave" rather than a hundred and twenty-eight numbers. A tuning that genuinely does not repeat
 * keeps its table.
 */
function asScale(cents: number[]): { degrees: number[]; period: number } | null {
  const repeatsEvery = (count: number): number | null => {
    const period = cents[count] - cents[0]
    if (!(period > 0)) return null
    for (let midi = 0; midi + count < cents.length; midi++) {
      if (Math.abs(cents[midi + count] - cents[midi] - period) > 1e-6) return null
    }
    return period
  }
  // Every multiple of a period is also a period, so "the smallest one that repeats" would call
  // equal temperament a scale of one degree a hundred cents wide — true, and no use to anyone.
  // The octave settles it wherever there is one, and the smallest period speaks for scales like
  // Bohlen-Pierce that do not have an octave to be settled by.
  let smallest: { count: number; period: number } | null = null
  for (let count = 1; count <= 64; count++) {
    const period = repeatsEvery(count)
    if (period === null) continue
    if (!smallest) smallest = { count, period }
    if (Math.abs(period - 1200) < 1e-6) {
      smallest = { count, period }
      break
    }
  }
  if (!smallest) return null
  // Degrees are quoted from the root of a period rather than from MIDI note 0, so that a scale
  // read out of a file reads the same way as one written by hand.
  const root = 60 % smallest.count
  const degrees = Array.from({ length: smallest.count }, (_, i) => cents[root + i] - cents[root])
  return { degrees, period: smallest.period }
}
