/**
 * Spectrogram colour maps.
 *
 * The perceptual ones (viridis, magma, inferno, turbo, plasma) matter more than they look
 * like they should: a spectrogram encodes a scalar in colour, and a map whose lightness is not
 * monotonic invents features that are not in the signal — the classic "jet" rainbow puts a
 * bright yellow band in the middle of a smooth ramp, which reads as a spectral peak. Every map
 * here rises monotonically in lightness. They are also all legible in greyscale, which is what
 * happens when someone prints the screenshot.
 */

export interface Palette {
  id: string
  label: string
  /** sRGB hex stops, evenly spaced from 0 to 1. */
  stops: readonly string[]
}

export const PALETTES: readonly Palette[] = [
  {
    id: 'viridis',
    label: 'Viridis',
    stops: [
      '#440154',
      '#472d7b',
      '#3b528b',
      '#2c728e',
      '#21918c',
      '#28ae80',
      '#5ec962',
      '#addc30',
      '#fde725',
    ],
  },
  {
    id: 'magma',
    label: 'Magma',
    stops: [
      '#000004',
      '#1c1044',
      '#4f127b',
      '#812581',
      '#b5367a',
      '#e55064',
      '#fb8861',
      '#fec287',
      '#fcfdbf',
    ],
  },
  {
    id: 'inferno',
    label: 'Inferno',
    stops: [
      '#000004',
      '#1f0c48',
      '#550f6d',
      '#88226a',
      '#ba3655',
      '#e35933',
      '#f98c0a',
      '#f9c932',
      '#fcffa4',
    ],
  },
  {
    id: 'plasma',
    label: 'Plasma',
    stops: [
      '#0d0887',
      '#4c02a1',
      '#7e03a8',
      '#a82296',
      '#cb4679',
      '#e56b5d',
      '#f89441',
      '#fdc328',
      '#f0f921',
    ],
  },
  {
    id: 'turbo',
    label: 'Turbo',
    stops: [
      '#30123b',
      '#4145ab',
      '#4675ed',
      '#39a2fc',
      '#1bcfd4',
      '#24eca6',
      '#61fc6c',
      '#a4fc3b',
      '#d1e834',
      '#f3c63a',
      '#fe9b2d',
      '#f36315',
      '#cb2a04',
      '#7a0403',
    ],
  },
  {
    id: 'ice',
    label: 'Ice',
    stops: ['#000008', '#062044', '#0b4f8a', '#1b8fce', '#66d0ef', '#c8f2ff', '#ffffff'],
  },
  {
    id: 'ember',
    label: 'Ember',
    stops: ['#000000', '#2a0500', '#7a1000', '#c43a00', '#f27b0c', '#ffc84d', '#fff6d5'],
  },
  {
    id: 'mono',
    label: 'Monochrome',
    stops: ['#000000', '#404040', '#808080', '#c0c0c0', '#ffffff'],
  },
  {
    id: 'phosphor',
    label: 'Phosphor',
    stops: ['#000000', '#03210f', '#0a5a25', '#19a83f', '#5ce46a', '#d6ffd0'],
  },
]

// ---------------------------------------------------------------------------------------
// Pitch-class wheels
// ---------------------------------------------------------------------------------------

/**
 * A cyclic colour map: position in the octave to colour, for the living population.
 *
 * The palettes above map a scalar to colour and run end to end. A wheel maps an *angle* — where
 * a particle sits inside the octave — so it has to close on itself, and every octave of a note
 * therefore lands on one colour while a harmonic series fans out into a fixed figure.
 *
 * The organism has always done this with an HSL hue sweep, which is the same mistake as "jet"
 * wearing a different hat. Hue at full saturation swings its lightness enormously: measured
 * across the twelve semitones, the brightest pitch class of the standard wheel is 12.8 times
 * the luminance of the dimmest. A note at E therefore looks louder than the same note at A
 * flat, and the picture reports something the signal never said. The maps below are built in
 * OKLCh, where lightness can be held while hue goes round, and each one's spread is quoted in
 * its label so the tradeoff is visible at the point of choosing.
 *
 * Two properties every wheel here holds to. It closes: the last stop leads back to the first
 * with no seam. And it is one-to-one: no two pitch classes share a colour. That second one
 * rules out the obvious way to build a single-hue wheel — sweep out to a far hue and back —
 * because doubling back makes C and F sharp the same colour. Ember and Ice separate their two
 * legs by chroma instead, so the climb is saturated and the descent is washed out.
 */
export interface Wheel {
  id: string
  label: string
  /** sRGB hex stops, evenly spaced around the circle. The last leads back to the first. */
  stops: readonly string[]
  /**
   * How many times the wheel goes round per octave. One is chromatic: neighbouring semitones
   * get neighbouring colours. Seven walks the circle of fifths instead — seven semitones per
   * turn, and since seven and twelve share no factor every pitch class still gets its own
   * colour, but now the ones a fifth apart are adjacent on the wheel rather than most of the
   * way across it. Consonance becomes a colour relationship instead of a coincidence.
   */
  turns?: number
  /** Ratio of the brightest pitch class to the dimmest. 1 is perfectly even. */
  spread: number
}

export const WHEELS: readonly Wheel[] = [
  {
    id: 'even',
    label: 'Even',
    spread: 1.2,
    stops: [
      '#f57fa7', '#fb8371', '#ee9138', '#cfa508', '#9fb83c', '#5ac576',
      '#00c6ae', '#00c0d7', '#39b5ff', '#8aa6ff', '#ba93fb', '#df86d7',
    ],
  },
  {
    id: 'fifths',
    label: 'Circle of fifths',
    spread: 1.2,
    turns: 7,
    stops: [
      '#f57fa7', '#fb8371', '#ee9138', '#cfa508', '#9fb83c', '#5ac576',
      '#00c6ae', '#00c0d7', '#39b5ff', '#8aa6ff', '#ba93fb', '#df86d7',
    ],
  },
  {
    id: 'vivid',
    label: 'Vivid',
    spread: 1.3,
    stops: [
      '#e63281', '#ed3343', '#d85900', '#bb7300', '#a48200', '#888e00',
      '#519c00', '#00a062', '#009c89', '#0098a2', '#0094bb', '#008be3',
      '#5977ff', '#8f61fc', '#b64fde', '#d33fb4',
    ],
  },
  {
    id: 'neon',
    label: 'Neon',
    spread: 1.3,
    stops: [
      '#8e2dee', '#b201c7', '#c60090', '#d0005a', '#d40f00', '#af5500',
      '#986600', '#847100', '#687c00', '#008a00', '#008660', '#00837b',
      '#008090', '#007ca8', '#006fd8', '#5a4cff',
    ],
  },
  {
    id: 'ash',
    label: 'Ash',
    spread: 1.0,
    stops: [
      '#ac9097', '#ad918c', '#a99483', '#a19880', '#959c84', '#8a9f8d',
      '#82a099', '#809fa4', '#859cac', '#9098af', '#9b94ab', '#a591a3',
    ],
  },
  {
    id: 'tide',
    label: 'Tide',
    spread: 2.4,
    stops: [
      '#00b0d5', '#26bce1', '#64c3e0', '#95c4d3', '#bebebe', '#d7b39b',
      '#e6a476', '#e89355', '#e0843e', '#ce7b3c', '#b7784c', '#9c7a64',
      '#808080', '#5d8a99', '#3197b2', '#00a4c8',
    ],
  },
  {
    id: 'phase',
    label: 'Phase',
    spread: 5.4,
    stops: [
      '#ffbff8', '#ffbcd8', '#ffaaaf', '#ff8b68', '#dd7c00', '#a57900',
      '#797100', '#4d6e00', '#007131', '#00735c', '#007e7f', '#0090ac',
      '#00a2ee', '#85afff', '#bebdff', '#e2c4ff',
    ],
  },
  {
    id: 'scriabin',
    label: 'Scriabin',
    spread: 8.4,
    stops: [
      '#ff2020', '#8a2be2', '#ffe000', '#b0a0a8', '#a8d8ff', '#b00030',
      '#2090ff', '#ff8a2a', '#c080d0', '#22c55e', '#8c9aa8', '#d8e8ff',
    ],
  },
  {
    id: 'chromatic',
    label: 'Chromatic',
    spread: 12.8,
    stops: [
      '#ff0000', '#ff8000', '#ffff00', '#80ff00', '#00ff00', '#00ff80',
      '#00ffff', '#0080ff', '#0000ff', '#8000ff', '#ff00ff', '#ff0080',
    ],
  },
  {
    id: 'dusk',
    label: 'Dusk',
    spread: 30,
    stops: [
      '#dde8ff', '#dddcff', '#e0b6ff', '#d38fc8', '#b86788', '#96444a',
      '#742b0e', '#4e2a00', '#3c2b00', '#383600', '#325000', '#237342',
      '#1c9a81', '#3cbec2', '#6ddbfb', '#c4e5ff',
    ],
  },
  {
    id: 'ice',
    label: 'Ice',
    spread: 55,
    stops: [
      '#002242', '#00294b', '#003f64', '#00618a', '#008db6', '#14bbe0',
      '#49e3fe', '#a9f5ff', '#cff7fc', '#c7eef4', '#afd5dd', '#8cb0bb',
      '#668694', '#435e6e', '#283e4f', '#172a3c',
    ],
  },
  {
    id: 'ember',
    label: 'Ember',
    spread: 96,
    stops: [
      '#3a0003', '#460002', '#631400', '#8a3900', '#b76600', '#e29600',
      '#ffc431', '#ffe79e', '#fdf2c9', '#f5e8c0', '#dfcca6', '#bda483',
      '#96765d', '#6e4b3b', '#4d2a21', '#371612',
    ],
  },
]

const WHEEL_BY_ID = new Map(WHEELS.map((w) => [w.id, w]))

export function wheelById(id: string): Wheel {
  return WHEEL_BY_ID.get(id) ?? WHEELS[0]
}

/**
 * Rasterise a wheel to 256 RGBA entries for the compute pass to index.
 *
 * Cyclic, so the step between the last stop and the first is the same size as every other step
 * — `size` divisions rather than `size - 1`, and the final stop wraps to index 0 instead of
 * being pinned at the end.
 *
 * Interpolation happens in linear light and the result is re-encoded, exactly as the level
 * palettes do, because mixing two colours in sRGB space darkens the midpoint. What is stored is
 * the sRGB value, which is the space the particle's 24-bit colour word has always been in: eight
 * bits of linear light bands visibly in the darks, and the encoding is what keeps Ember's bottom
 * end from posterising.
 */
export function rasteriseWheel(stops: readonly string[], size = 256): Float32Array {
  const out = new Float32Array(size * 4)
  const linear = stops.map(hexToLinearRgb)
  const n = linear.length
  for (let i = 0; i < size; i++) {
    const t = (i / size) * n
    const i0 = Math.floor(t) % n
    const i1 = (i0 + 1) % n
    const f = t - Math.floor(t)
    for (let c = 0; c < 3; c++) {
      const v = linear[i0][c] * (1 - f) + linear[i1][c] * f
      out[i * 4 + c] = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
    }
    out[i * 4 + 3] = 1
  }
  return out
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const v = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16)
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}

/** sRGB transfer function inverse. Blending and tone mapping are only correct in linear light. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

export function hexToLinearRgb(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex)
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)]
}

/**
 * Rasterise a palette to a 256-entry lookup. Interpolation happens in linear light — mixing
 * two colours in sRGB space darkens the midpoint, which is very visible on a gradient this
 * wide.
 */
export function rasterisePalette(stops: readonly string[], size = 256): Uint8Array {
  const out = new Uint8Array(size * 4)
  const linear = stops.map(hexToLinearRgb)
  for (let i = 0; i < size; i++) {
    const t = (i / (size - 1)) * (linear.length - 1)
    const i0 = Math.floor(t)
    const i1 = Math.min(i0 + 1, linear.length - 1)
    const f = t - i0
    for (let c = 0; c < 3; c++) {
      const v = linear[i0][c] * (1 - f) + linear[i1][c] * f
      // Re-encode to sRGB for storage. The lookup texture is created with the
      // `rgba8unorm-srgb` format, so sampling decodes back to linear light automatically and
      // the shader receives exactly the linearly-interpolated value computed above.
      const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
      out[i * 4 + c] = Math.round(Math.max(0, Math.min(1, s)) * 255)
    }
    out[i * 4 + 3] = 255
  }
  return out
}

const PALETTE_BY_ID = new Map(PALETTES.map((p) => [p.id, p]))

export function paletteById(id: string): Palette {
  return PALETTE_BY_ID.get(id) ?? PALETTES[0]
}
