/**
 * The quad layout.
 *
 * All four visualisations are on screen at once, in a 2×2 grid divided by a single cross whose
 * intersection the user drags. There is one degree of freedom per axis, so the four panes are
 * always rectangles that tile the viewport exactly — no gaps, no overlap, and no arithmetic
 * that can leave a one-pixel seam.
 *
 * Collapsing is the switch: drag the cross to a rail and two panes reach zero width or height,
 * and a pane with nothing to draw into is skipped by the analyzer, the renderer and the label
 * layer alike. That is the whole "turn a visualisation off" mechanism — there is no separate
 * enabled flag that could disagree with what is on screen.
 */

import type { LayoutSplit, Mode } from '../config.ts'

export interface PaneSpec {
  mode: Mode
  label: string
  /** 0 = left column / top row, 1 = right column / bottom row. */
  col: 0 | 1
  row: 0 | 1
}

/** Reading order, so the pane numbering matches the 1–4 focus keys. */
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
  /** False once the pane has collapsed below a pixel in either axis. */
  visible: boolean
}

const MIN_VISIBLE_PX = 1

export function clampSplit(split: LayoutSplit): LayoutSplit {
  const clamp = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5)
  return { x: clamp(split.x), y: clamp(split.y) }
}

/**
 * Divides `width` × `height` at the split. The cut lands on a whole pixel and the far pane
 * takes the remainder, so the two always add up to the total exactly.
 */
export function computePanes(split: LayoutSplit, width: number, height: number): Pane[] {
  const safe = clampSplit(split)
  const cutX = Math.round(safe.x * width)
  const cutY = Math.round(safe.y * height)
  const widths = [cutX, width - cutX]
  const heights = [cutY, height - cutY]
  const offsetsX = [0, cutX]
  const offsetsY = [0, cutY]

  return PANE_SPECS.map((spec, index) => {
    const w = widths[spec.col]
    const h = heights[spec.row]
    return {
      mode: spec.mode,
      label: spec.label,
      index,
      x: offsetsX[spec.col],
      y: offsetsY[spec.row],
      width: w,
      height: h,
      visible: w >= MIN_VISIBLE_PX && h >= MIN_VISIBLE_PX,
    }
  })
}

/**
 * Pairs the CSS-pixel panes the DOM lays out against with the device-pixel panes the GPU draws
 * into. A pane counts as visible only if it survives both: at a quarter render scale a pane can
 * still be three CSS pixels wide and round to nothing in the framebuffer, and a zero-sized
 * viewport is a validation error rather than an empty draw.
 */
export interface PanePair {
  css: Pane
  device: Pane
  visible: boolean
}

export function computePanePair(
  split: LayoutSplit,
  cssWidth: number,
  cssHeight: number,
  deviceWidth: number,
  deviceHeight: number,
): PanePair[] {
  const css = computePanes(split, cssWidth, cssHeight)
  const device = computePanes(split, deviceWidth, deviceHeight)
  return css.map((pane, i) => ({
    css: pane,
    device: device[i],
    visible: pane.visible && device[i].visible,
  }))
}
