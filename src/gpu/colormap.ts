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
