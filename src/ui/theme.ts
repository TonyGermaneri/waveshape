/**
 * Themes.
 *
 * A theme is a complete look, not a colour pair: the four canvas colours, the whole post
 * chain (persistence, bloom, tone curve, exposure, gamma, saturation, vignette), the graticule,
 * the spectrogram colour map, and the overlay's own chrome. Applying one therefore writes into
 * three places — `config.style`, `config.spectrogram.palette` and `config.ui` — and the panel
 * restyles itself along with the trace.
 *
 * Built-ins are declared as partials over the default style so a new style key picks up a
 * sensible value everywhere instead of having to be added to seventeen literals. User themes
 * are captured whole from the live config and stored under their own localStorage key, so
 * resetting the profile does not take the saved themes with it.
 */

import { DEFAULT_CONFIG, type Config, type UiTheme } from '../config.ts'
import { hexToRgb, srgbToLinear } from '../gpu/colormap.ts'

export interface Theme {
  id: string
  label: string
  /** Built-ins cannot be overwritten or deleted from the panel. */
  builtin: boolean
  style: Config['style']
  /** Spectrogram colour map id. */
  palette: string
  ui: UiTheme
}

interface ThemeSpec {
  id: string
  label: string
  palette: string
  style: Partial<Config['style']>
  ui: Partial<UiTheme>
}

function builtin(spec: ThemeSpec): Theme {
  return {
    id: spec.id,
    label: spec.label,
    builtin: true,
    palette: spec.palette,
    style: { ...DEFAULT_CONFIG.style, ...spec.style },
    ui: { ...DEFAULT_CONFIG.ui, ...spec.ui },
  }
}

export const BUILTIN_THEMES: readonly Theme[] = [
  builtin({
    id: 'studio',
    label: 'Studio',
    palette: 'magma',
    style: {
      background: '#000000',
      primary: '#ffffff',
      secondary: '#8a8a8a',
      accent: '#40b8ff',
      persistence: 0,
      bloom: 0.25,
      bloomThreshold: 0.85,
      tonemap: 'reinhard',
      vignette: 0,
      gridAlpha: 0.22,
    },
    ui: { panel: '#0e0f12', opacity: 0.82, text: '#ffffff', accent: '#4bb4ff' },
  }),
  builtin({
    id: 'phosphor',
    label: 'Phosphor CRT',
    palette: 'phosphor',
    style: {
      background: '#00120a',
      primary: '#7dff9b',
      secondary: '#1d6b3a',
      accent: '#b8ffcb',
      persistence: 0.82,
      bloom: 0.6,
      bloomThreshold: 0.4,
      tonemap: 'reinhard',
      vignette: 0.35,
      gridAlpha: 0.26,
    },
    ui: { panel: '#03130a', opacity: 0.86, text: '#d8ffe2', accent: '#7dff9b' },
  }),
  builtin({
    id: 'amber',
    label: 'Amber CRT',
    palette: 'ember',
    style: {
      background: '#120800',
      primary: '#ffb247',
      secondary: '#7a4b12',
      accent: '#ffe0a8',
      persistence: 0.75,
      bloom: 0.5,
      bloomThreshold: 0.45,
      tonemap: 'aces',
      vignette: 0.3,
      gridAlpha: 0.26,
    },
    ui: { panel: '#150b02', opacity: 0.86, text: '#ffe6c4', accent: '#ffb247' },
  }),
  builtin({
    id: 'ice',
    label: 'Ice',
    palette: 'ice',
    style: {
      background: '#01060e',
      primary: '#9fe8ff',
      secondary: '#1d5878',
      accent: '#ffffff',
      persistence: 0.4,
      bloom: 0.45,
      tonemap: 'aces',
      vignette: 0.15,
      gridAlpha: 0.24,
    },
    ui: { panel: '#04101c', opacity: 0.84, text: '#e6f7ff', accent: '#9fe8ff' },
  }),
  builtin({
    id: 'paper',
    label: 'Paper',
    palette: 'mono',
    style: {
      background: '#f4f2ee',
      primary: '#101014',
      secondary: '#8d8a84',
      accent: '#b03a2e',
      persistence: 0,
      bloom: 0,
      exposure: 1,
      tonemap: 'clip',
      gridAlpha: 0.4,
      vignette: 0,
      lineWidth: 1.2,
    },
    ui: { panel: '#f7f5f1', opacity: 0.92, text: '#14140f', accent: '#b03a2e', blur: 14 },
  }),
  builtin({
    id: 'ink',
    label: 'Ink',
    palette: 'mono',
    style: {
      background: '#ffffff',
      primary: '#000000',
      secondary: '#9a9a9a',
      accent: '#3a3a3a',
      persistence: 0,
      bloom: 0,
      tonemap: 'clip',
      saturation: 0,
      gridAlpha: 0.32,
      vignette: 0,
      lineWidth: 1.1,
    },
    ui: { panel: '#ffffff', opacity: 0.94, text: '#0a0a0a', accent: '#2f2f2f', blur: 10 },
  }),
  builtin({
    id: 'solarized',
    label: 'Solarized',
    palette: 'viridis',
    style: {
      background: '#fdf6e3',
      primary: '#073642',
      secondary: '#93a1a1',
      accent: '#268bd2',
      persistence: 0,
      bloom: 0,
      tonemap: 'clip',
      gridAlpha: 0.45,
      vignette: 0,
      lineWidth: 1.3,
    },
    ui: { panel: '#eee8d5', opacity: 0.93, text: '#002b36', accent: '#268bd2', blur: 14 },
  }),
  builtin({
    id: 'blueprint',
    label: 'Blueprint',
    palette: 'ice',
    style: {
      background: '#06213f',
      primary: '#dfeeff',
      secondary: '#3d7cb5',
      accent: '#ffd166',
      persistence: 0.15,
      bloom: 0.12,
      tonemap: 'clip',
      gridAlpha: 0.55,
      vignette: 0.1,
      lineWidth: 1.3,
    },
    ui: { panel: '#072a4f', opacity: 0.88, text: '#dfeeff', accent: '#ffd166' },
  }),
  builtin({
    id: 'nord',
    label: 'Nord',
    palette: 'viridis',
    style: {
      background: '#2e3440',
      primary: '#eceff4',
      secondary: '#4c566a',
      accent: '#88c0d0',
      persistence: 0.2,
      bloom: 0.2,
      tonemap: 'reinhard',
      gridAlpha: 0.3,
      vignette: 0.08,
    },
    ui: { panel: '#3b4252', opacity: 0.88, text: '#eceff4', accent: '#88c0d0' },
  }),
  builtin({
    id: 'noir',
    label: 'Noir',
    palette: 'mono',
    style: {
      background: '#0b0b0d',
      primary: '#d9d9d9',
      secondary: '#4f4f55',
      accent: '#ff4d4d',
      persistence: 0.35,
      bloom: 0.3,
      bloomThreshold: 0.7,
      saturation: 0.35,
      tonemap: 'reinhard',
      vignette: 0.5,
      gridAlpha: 0.18,
    },
    ui: { panel: '#111114', opacity: 0.86, text: '#e6e6e6', accent: '#ff5a5a' },
  }),
  builtin({
    id: 'matrix',
    label: 'Matrix',
    palette: 'phosphor',
    style: {
      background: '#000700',
      primary: '#38ff6a',
      secondary: '#0b5a1c',
      accent: '#b9ffcb',
      persistence: 0.9,
      bloom: 0.55,
      bloomThreshold: 0.35,
      gamma: 1.1,
      tonemap: 'reinhard',
      vignette: 0.45,
      gridAlpha: 0.14,
    },
    ui: { panel: '#020d03', opacity: 0.9, text: '#a8ffb8', accent: '#38ff6a' },
  }),
  builtin({
    id: 'ultraviolet',
    label: 'Ultraviolet',
    palette: 'plasma',
    style: {
      background: '#0a0413',
      primary: '#e6c8ff',
      secondary: '#5c2f8f',
      accent: '#ff5ecb',
      persistence: 0.55,
      bloom: 0.8,
      bloomThreshold: 0.35,
      saturation: 1.2,
      tonemap: 'aces',
      vignette: 0.3,
      gridAlpha: 0.2,
    },
    ui: { panel: '#140829', opacity: 0.86, text: '#eddcff', accent: '#c86bff' },
  }),
  builtin({
    id: 'vapor',
    label: 'Vaporwave',
    palette: 'plasma',
    style: {
      background: '#12002b',
      primary: '#ff6ec7',
      secondary: '#6f2bd8',
      accent: '#45f0ff',
      persistence: 0.7,
      bloom: 1,
      bloomThreshold: 0.3,
      saturation: 1.35,
      exposure: 1.1,
      tonemap: 'aces',
      vignette: 0.28,
      gridAlpha: 0.3,
      lineWidth: 1.8,
    },
    ui: { panel: '#1b0140', opacity: 0.84, text: '#ffe3fb', accent: '#45f0ff' },
  }),
  builtin({
    id: 'infrared',
    label: 'Infrared',
    palette: 'inferno',
    style: {
      background: '#0b0000',
      primary: '#ff5a4d',
      secondary: '#7a1109',
      accent: '#ffd7a1',
      persistence: 0.6,
      bloom: 0.7,
      bloomThreshold: 0.4,
      tonemap: 'aces',
      vignette: 0.4,
      gridAlpha: 0.18,
    },
    ui: { panel: '#180402', opacity: 0.88, text: '#ffd9cf', accent: '#ff6a52' },
  }),
  builtin({
    id: 'sunset',
    label: 'Sunset',
    palette: 'magma',
    style: {
      background: '#16060f',
      primary: '#ffb37b',
      secondary: '#a13b5c',
      accent: '#ffe9a8',
      persistence: 0.45,
      bloom: 0.5,
      bloomThreshold: 0.5,
      saturation: 1.15,
      tonemap: 'aces',
      vignette: 0.25,
      gridAlpha: 0.22,
    },
    ui: { panel: '#1e0913', opacity: 0.86, text: '#ffe4d2', accent: '#ff9d6b' },
  }),
  builtin({
    id: 'aurora',
    label: 'Aurora',
    palette: 'viridis',
    style: {
      background: '#01110f',
      primary: '#7ef9d0',
      secondary: '#1f6f7a',
      accent: '#c792ff',
      persistence: 0.5,
      bloom: 0.6,
      bloomThreshold: 0.45,
      tonemap: 'aces',
      vignette: 0.2,
      gridAlpha: 0.22,
    },
    ui: { panel: '#04191a', opacity: 0.86, text: '#d8fff2', accent: '#7ef9d0' },
  }),
  builtin({
    id: 'turbojet',
    label: 'Turbo',
    palette: 'turbo',
    style: {
      background: '#04060a',
      primary: '#f2f6ff',
      secondary: '#3a4a63',
      accent: '#ffb020',
      persistence: 0.25,
      bloom: 0.35,
      tonemap: 'reinhard',
      vignette: 0.12,
      gridAlpha: 0.24,
    },
    ui: { panel: '#0a1018', opacity: 0.85, text: '#eaf2ff', accent: '#ffb020' },
  }),
  builtin({
    id: 'contrast',
    label: 'High contrast',
    palette: 'turbo',
    style: {
      background: '#000000',
      primary: '#ffff00',
      secondary: '#00e5ff',
      accent: '#ff40ff',
      lineWidth: 2.6,
      intensity: 1.4,
      persistence: 0,
      bloom: 0,
      tonemap: 'clip',
      saturation: 1,
      gridAlpha: 0.6,
      vignette: 0,
    },
    ui: { panel: '#000000', opacity: 0.96, text: '#ffffff', accent: '#ffff00', blur: 0 },
  }),
]

const THEME_STORAGE_KEY = 'waveshape.themes.v1'

/** Slug used as the id of a user theme, kept stable so re-saving a name overwrites in place. */
export function themeIdFromLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return `user:${slug || 'theme'}`
}

function isTheme(value: unknown): value is Theme {
  if (!value || typeof value !== 'object') return false
  const t = value as Partial<Theme>
  return (
    typeof t.id === 'string' &&
    typeof t.label === 'string' &&
    typeof t.palette === 'string' &&
    !!t.style &&
    typeof t.style === 'object' &&
    !!t.ui &&
    typeof t.ui === 'object'
  )
}

/** Fills any missing key from the defaults, so a theme written by an older build still loads. */
export function normaliseTheme(theme: Theme): Theme {
  return {
    id: theme.id,
    label: theme.label,
    builtin: false,
    palette: theme.palette,
    style: { ...DEFAULT_CONFIG.style, ...theme.style },
    ui: { ...DEFAULT_CONFIG.ui, ...theme.ui },
  }
}

export function loadUserThemes(): Theme[] {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isTheme).map(normaliseTheme)
  } catch {
    return []
  }
}

export function saveUserThemes(themes: readonly Theme[]): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(themes))
  } catch {
    // Private browsing or a full quota. The theme still applies for this session.
  }
}

/** Built-ins first, then user themes in the order they were saved. */
export function allThemes(user: readonly Theme[]): Theme[] {
  return [...BUILTIN_THEMES, ...user]
}

export function findTheme(themes: readonly Theme[], id: string): Theme | undefined {
  return themes.find((t) => t.id === id)
}

/** Snapshots everything a theme owns out of the live config. */
export function themeFromConfig(config: Config, label: string): Theme {
  return {
    id: themeIdFromLabel(label),
    label,
    builtin: false,
    palette: config.spectrogram.palette,
    style: structuredClone(config.style),
    ui: structuredClone(config.ui),
  }
}

export function applyTheme(config: Config, theme: Theme): void {
  Object.assign(config.style, theme.style)
  Object.assign(config.ui, theme.ui)
  config.spectrogram.palette = theme.palette
  config.themeId = theme.id
}

/** True when the live config still matches the theme it claims — i.e. nothing was hand-edited. */
export function themeMatchesConfig(config: Config, theme: Theme): boolean {
  if (config.spectrogram.palette !== theme.palette) return false
  const same = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    Object.keys(b).every((k) => a[k] === b[k])
  return (
    same(config.style as unknown as Record<string, unknown>, theme.style as unknown as Record<string, unknown>) &&
    same(config.ui as unknown as Record<string, unknown>, theme.ui as unknown as Record<string, unknown>)
  )
}

// ---------------------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------------------

function rgb255(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex)
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]
}

function mix(hex: string, alpha: number): string {
  const [r, g, b] = rgb255(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** Relative luminance, used only to decide whether the chrome is light or dark. */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex)
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

/**
 * Pushes the chrome colours into CSS custom properties. Everything in app.css reads from these,
 * so there is no second palette hidden in the stylesheet to keep in sync.
 *
 * Two surfaces are involved and they are not the same colour. The panel sits on its own
 * background, but the tick labels and the readout bar sit directly on the canvas — so their ink
 * is derived from the *scene* background. A light canvas under a dark panel is a perfectly
 * reasonable theme, and white tick labels on white paper are not.
 */
export function applyUiTheme(ui: UiTheme, style: Config['style']): void {
  const root = document.documentElement
  const light = luminance(ui.panel) > 0.4
  const set = (name: string, value: string) => root.style.setProperty(name, value)

  const canvasLight = luminance(style.background) > 0.4
  const ink = canvasLight ? '#0d0d10' : '#ffffff'
  set('--ws-canvas', style.background)
  set('--ws-canvas-ink', mix(ink, 0.78))
  set('--ws-canvas-ink-soft', mix(ink, 0.5))
  set('--ws-canvas-scrim', mix(style.background, 0.42))
  set('--ws-canvas-shadow', canvasLight ? 'rgba(255, 255, 255, 0.85)' : 'rgba(0, 0, 0, 0.8)')

  set('--ws-panel', mix(ui.panel, ui.opacity))
  set('--ws-panel-solid', ui.panel)
  set('--ws-text', mix(ui.text, 0.94))
  set('--ws-muted', mix(ui.text, 0.6))
  set('--ws-faint', mix(ui.text, 0.4))
  set('--ws-line', mix(ui.text, light ? 0.16 : 0.11))
  set('--ws-line-strong', mix(ui.text, light ? 0.3 : 0.22))
  set('--ws-surface', mix(ui.text, light ? 0.07 : 0.05))
  set('--ws-surface-strong', mix(ui.text, light ? 0.14 : 0.11))
  set('--ws-accent', ui.accent)
  set('--ws-accent-soft', mix(ui.accent, 0.18))
  set('--ws-accent-line', mix(ui.accent, 0.45))
  set('--ws-knob', light ? '#1b1d22' : '#eaf4ff')
  set('--ws-scrim', light ? 'rgba(40, 40, 44, 0.42)' : 'rgba(0, 0, 0, 0.62)')
  set('--ws-shadow', light ? 'rgba(0, 0, 0, 0.22)' : 'rgba(0, 0, 0, 0.55)')
  set('--ws-radius', `${ui.radius}px`)
  set('--ws-blur', ui.blur > 0 ? `blur(${ui.blur}px) saturate(140%)` : 'none')
  set('color-scheme', light ? 'light' : 'dark')
  root.dataset.wsChrome = light ? 'light' : 'dark'
}

// ---------------------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------------------

export function themeToJson(theme: Theme): string {
  return JSON.stringify({ ...theme, builtin: undefined }, null, 2)
}

/** Parses one theme, or a whole exported array of them. Throws with a readable message. */
export function themesFromJson(text: string): Theme[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('not valid JSON')
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  const themes = list.filter(isTheme).map(normaliseTheme)
  if (themes.length === 0) throw new Error('no theme found — expected id, label, style and ui')
  return themes
}
