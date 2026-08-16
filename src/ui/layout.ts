/**
 * The pane layout.
 *
 * Four visualisations live in a 2×2 grid, and each can be switched off. Rather than special-case
 * every combination, the grid collapses by one rule applied twice:
 *
 *   a row with no panes takes no height, and the other row takes the lot;
 *   a row with one pane gives it the full width.
 *
 * Everything the layout is supposed to do falls out of that. Three panes leaves one row with a
 * pair and one row with a single, so the single spans the width. Two side by side share a row
 * and split it. Two stacked, or two on a diagonal, are alone in their rows and become halves of
 * the screen. One pane is alone in the only occupied row, so it fills the viewport — and with no
 * divider left to move, the handle has nothing to do and is taken away.
 *
 * The split fractions are only consulted for divisions that actually exist, which is what lets
 * a layout be switched around and come back to the same proportions.
 */

import type { LayoutSplit, Mode, PaneToggles } from '../config.ts'

export interface PaneSpec {
  mode: Mode
  label: string
  /** 0 = left column / top row, 1 = right column / bottom row. */
  col: 0 | 1
  row: 0 | 1
}

/** Reading order, so the pane numbering matches the 1–4 keys. */
export const PANE_SPECS: readonly PaneSpec[] = [
  { mode: 'wave', label: 'Waveform', col: 0, row: 0 },
  { mode: 'spectrum', label: 'Spectrum', col: 1, row: 0 },
  { mode: 'spectrogram', label: 'Spectrogram', col: 0, row: 1 },
  { mode: 'vector', label: 'Vectorscope', col: 1, row: 1 },
]

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Pane extends Rect {
  mode: Mode
  label: string
  /** Index into `PANE_SPECS`, and therefore the pane's number on the keyboard. */
  index: number
  /** Switched on by the user. A pane can be enabled and still not visible — see below. */
  enabled: boolean
  /**
   * Enabled *and* big enough to draw into. Dragging a divider to its rail leaves a pane with no
   * room, which stops it being drawn without forgetting that it is meant to be on.
   */
  visible: boolean
}

/** Which divisions exist. Neither means a single pane, and nothing left to drag. */
export interface LayoutAxes {
  x: boolean
  y: boolean
}

export interface Layout {
  /** Always four, in `PANE_SPECS` order. */
  panes: Pane[]
  axes: LayoutAxes
  /** Whether each row is divided in two. The vertical divider only spans the rows that are. */
  rowSplit: readonly [boolean, boolean]
  /** Divider positions in pixels; meaningless on an axis that does not exist. */
  cutX: number
  cutY: number
  width: number
  height: number
}

const MIN_VISIBLE_PX = 1

export function clampSplit(split: LayoutSplit): LayoutSplit {
  const clamp = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5)
  return { x: clamp(split.x), y: clamp(split.y) }
}

export function enabledCount(panes: PaneToggles): number {
  return PANE_SPECS.reduce((n, spec) => n + (panes[spec.mode] ? 1 : 0), 0)
}

export function computeLayout(
  split: LayoutSplit,
  toggles: PaneToggles,
  width: number,
  height: number,
): Layout {
  const safe = clampSplit(split)
  const on = (row: 0 | 1, col: 0 | 1) =>
    PANE_SPECS.some((s) => s.row === row && s.col === col && toggles[s.mode])
  const rowUsed = [on(0, 0) || on(0, 1), on(1, 0) || on(1, 1)] as const
  const rowSplit = [on(0, 0) && on(0, 1), on(1, 0) && on(1, 1)] as const

  const axes: LayoutAxes = {
    x: rowSplit[0] || rowSplit[1],
    y: rowUsed[0] && rowUsed[1],
  }

  // A cut only lands where there is something on both sides of it. Where there is not, it is
  // pushed to the far edge so the surviving row or column simply takes the whole extent.
  const cutY = axes.y ? Math.round(safe.y * height) : rowUsed[0] ? height : 0
  const cutX = axes.x ? Math.round(safe.x * width) : 0
  const rowY = [0, cutY]
  const rowH = [cutY, height - cutY]

  const panes = PANE_SPECS.map((spec, index) => {
    const enabled = toggles[spec.mode]
    const splitHere = rowSplit[spec.row]
    const x = splitHere && spec.col === 1 ? cutX : 0
    const w = !enabled ? 0 : splitHere ? (spec.col === 0 ? cutX : width - cutX) : width
    const h = enabled ? rowH[spec.row] : 0
    return {
      mode: spec.mode,
      label: spec.label,
      index,
      enabled,
      x,
      y: rowY[spec.row],
      width: w,
      height: h,
      visible: enabled && w >= MIN_VISIBLE_PX && h >= MIN_VISIBLE_PX,
    }
  })

  return { panes, axes, rowSplit, cutX, cutY, width, height }
}

/**
 * Pairs the CSS-pixel layout the DOM lays out against with the device-pixel one the GPU draws
 * into. A pane counts as visible only if it survives both: at a quarter render scale a pane can
 * still be three CSS pixels wide and round to nothing in the framebuffer, and a zero-sized
 * viewport is a validation error rather than an empty draw.
 */
export interface PanePair {
  css: Pane
  device: Pane
  visible: boolean
}

export interface LayoutPair {
  panes: PanePair[]
  css: Layout
  axes: LayoutAxes
}

export function computeLayoutPair(
  split: LayoutSplit,
  toggles: PaneToggles,
  cssWidth: number,
  cssHeight: number,
  deviceWidth: number,
  deviceHeight: number,
): LayoutPair {
  const css = computeLayout(split, toggles, cssWidth, cssHeight)
  const device = computeLayout(split, toggles, deviceWidth, deviceHeight)
  return {
    css,
    axes: css.axes,
    panes: css.panes.map((pane, i) => ({
      css: pane,
      device: device.panes[i],
      visible: pane.visible && device.panes[i].visible,
    })),
  }
}
