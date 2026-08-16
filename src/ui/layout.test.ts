/**
 * The layout rules are easy to state and easy to get subtly wrong: a pane one pixel wide, two
 * panes that overlap by a rounding error, a divider left draggable when there is nothing left
 * to divide. Every combination of switched-on panes is cheap to enumerate, so all sixteen are.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import type { Mode, PaneToggles } from '../config.ts'
import { PANE_SPECS, computeLayout, enabledCount } from './layout.ts'

const W = 1000
const H = 600
const CENTRE = { x: 0.5, y: 0.5 }

const toggles = (...on: Mode[]): PaneToggles => ({
  wave: on.includes('wave'),
  spectrum: on.includes('spectrum'),
  spectrogram: on.includes('spectrogram'),
  vector: on.includes('vector'),
})

const ALL: Mode[] = ['wave', 'spectrum', 'spectrogram', 'vector']

/** Every subset of the four panes. */
function subsets(): Mode[][] {
  const out: Mode[][] = []
  for (let mask = 0; mask < 16; mask++) {
    out.push(ALL.filter((_, i) => mask & (1 << i)))
  }
  return out
}

test('a single pane fills the viewport and leaves nothing to drag', () => {
  for (const mode of ALL) {
    const layout = computeLayout(CENTRE, toggles(mode), W, H)
    const pane = layout.panes.find((p) => p.mode === mode)!
    assert.deepEqual(
      { x: pane.x, y: pane.y, width: pane.width, height: pane.height },
      { x: 0, y: 0, width: W, height: H },
      `${mode} alone should fill the viewport`,
    )
    assert.equal(layout.axes.x, false)
    assert.equal(layout.axes.y, false)
    assert.equal(layout.panes.filter((p) => p.visible).length, 1)
  }
})

test('two panes are halves, split along the axis that separates them', () => {
  // Same row: side by side, full height, one vertical divider.
  const sideBySide = computeLayout(CENTRE, toggles('wave', 'spectrum'), W, H)
  assert.deepEqual(sideBySide.axes, { x: true, y: false })
  for (const pane of sideBySide.panes.filter((p) => p.visible)) {
    assert.equal(pane.width, W / 2)
    assert.equal(pane.height, H)
  }

  // Same column: stacked, full width, one horizontal divider.
  const stacked = computeLayout(CENTRE, toggles('wave', 'spectrogram'), W, H)
  assert.deepEqual(stacked.axes, { x: false, y: true })
  for (const pane of stacked.panes.filter((p) => p.visible)) {
    assert.equal(pane.width, W)
    assert.equal(pane.height, H / 2)
  }

  // Diagonal: each is alone in its row, so each takes a full-width half.
  const diagonal = computeLayout(CENTRE, toggles('wave', 'vector'), W, H)
  assert.deepEqual(diagonal.axes, { x: false, y: true })
  for (const pane of diagonal.panes.filter((p) => p.visible)) {
    assert.equal(pane.width, W)
    assert.equal(pane.height, H / 2)
  }
})

test('with three panes the one that is alone in its row spans the width', () => {
  for (const dropped of ALL) {
    const kept = ALL.filter((m) => m !== dropped)
    const layout = computeLayout(CENTRE, toggles(...kept), W, H)
    assert.deepEqual(layout.axes, { x: true, y: true }, `dropping ${dropped}`)

    const droppedRow = PANE_SPECS.find((s) => s.mode === dropped)!.row
    const alone = layout.panes.find((p) => p.visible && p.index !== undefined && PANE_SPECS[p.index].row === droppedRow)!
    assert.equal(alone.width, W, `the survivor of ${dropped}'s row should span the width`)
    assert.equal(alone.x, 0)

    for (const pane of layout.panes.filter((p) => p.visible && p !== alone)) {
      assert.equal(pane.width, W / 2, 'the full row still splits in two')
    }
  }
})

test('four panes tile the viewport exactly, at any split', () => {
  for (const split of [
    { x: 0.5, y: 0.5 },
    { x: 0.137, y: 0.881 },
    { x: 0, y: 0.4 },
    { x: 1, y: 1 },
  ]) {
    const layout = computeLayout(split, toggles(...ALL), W, H)
    const area = layout.panes.reduce((sum, p) => sum + p.width * p.height, 0)
    assert.equal(area, W * H, `panes should tile exactly at ${JSON.stringify(split)}`)
    for (const p of layout.panes) {
      assert.ok(p.x >= 0 && p.y >= 0, 'no pane starts outside the viewport')
      assert.ok(p.x + p.width <= W && p.y + p.height <= H, 'no pane ends outside it')
    }
  }
})

test('every combination tiles exactly and never overlaps', () => {
  for (const on of subsets()) {
    if (on.length === 0) continue
    const layout = computeLayout({ x: 0.3, y: 0.65 }, toggles(...on), W, H)
    const live = layout.panes.filter((p) => p.width > 0 && p.height > 0)
    const area = live.reduce((sum, p) => sum + p.width * p.height, 0)
    assert.equal(area, W * H, `${on.join('+')} should cover the viewport exactly`)

    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i]
        const b = live[j]
        const apart =
          a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y
        assert.ok(apart, `${a.mode} and ${b.mode} overlap in ${on.join('+')}`)
      }
    }
  }
})

test('a disabled pane is never visible, whatever the split', () => {
  for (const on of subsets()) {
    for (const split of [{ x: 0.5, y: 0.5 }, { x: 0, y: 0 }, { x: 1, y: 1 }]) {
      const layout = computeLayout(split, toggles(...on), W, H)
      for (const pane of layout.panes) {
        if (!on.includes(pane.mode)) {
          assert.equal(pane.visible, false, `${pane.mode} is off but visible`)
          assert.equal(pane.width * pane.height, 0)
        }
      }
      assert.equal(enabledCount(toggles(...on)), on.length)
    }
  }
})

test('a divider driven to its rail collapses a pane without switching it off', () => {
  const layout = computeLayout({ x: 0, y: 0.5 }, toggles(...ALL), W, H)
  const left = layout.panes.filter((p) => PANE_SPECS[p.index].col === 0)
  for (const pane of left) {
    assert.equal(pane.width, 0)
    assert.equal(pane.visible, false, 'no room means not drawn')
    assert.equal(pane.enabled, true, 'but still switched on, so dragging back restores it')
  }
  // The axis survives, or there would be no way to drag the panes back into view.
  assert.equal(layout.axes.x, true)
})
