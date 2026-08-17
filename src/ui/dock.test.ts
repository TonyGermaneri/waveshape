/**
 * Panel placement is arithmetic with a lot of edges to fall off: a viewport smaller than the
 * panel's own minimum, a stored rectangle from a window that no longer exists, a drag that ends
 * outside the screen, a resize pushed through the opposite side. Each of those has one right
 * answer and several plausible wrong ones, so each is pinned here.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DOCK_SNAP,
  PANEL_MIN_HEIGHT,
  PANEL_MIN_WIDTH,
  STAGE_MIN,
  TEAR_OFF,
  clampDockSize,
  clampFloat,
  dockTarget,
  edgesNear,
  panelRect,
  resizeDock,
  resizeEdges,
  resizeFloat,
  stageInsets,
  tornOff,
  undockRect,
  type PanelDock,
  type PanelPlacement,
} from './dock.ts'

const VIEW = { width: 1600, height: 900 }

const placement = (over: Partial<PanelPlacement> = {}): PanelPlacement => ({
  dock: 'right',
  size: 420,
  float: { x: 100, y: 80, width: 420, height: 620 },
  push: true,
  ...over,
})

const EDGES: PanelDock[] = ['left', 'right', 'top', 'bottom']

test('a docked panel spans its whole edge and reaches it exactly', () => {
  for (const dock of EDGES) {
    const rect = panelRect(placement({ dock, size: 300 }), VIEW)
    if (dock === 'left' || dock === 'right') {
      assert.equal(rect.width, 300)
      assert.equal(rect.height, VIEW.height, `${dock} should span the full height`)
      assert.equal(dock === 'left' ? rect.x : rect.x + rect.width, dock === 'left' ? 0 : VIEW.width)
    } else {
      assert.equal(rect.height, 300)
      assert.equal(rect.width, VIEW.width, `${dock} should span the full width`)
      assert.equal(dock === 'top' ? rect.y : rect.y + rect.height, dock === 'top' ? 0 : VIEW.height)
    }
  }
})

test('a docked panel leaves the canvas room, until the window is too small to give any', () => {
  assert.equal(clampDockSize(10_000, 'right', VIEW), VIEW.width - STAGE_MIN)
  assert.equal(clampDockSize(10, 'right', VIEW), PANEL_MIN_WIDTH)
  assert.equal(clampDockSize(10, 'bottom', VIEW), PANEL_MIN_HEIGHT)

  // Narrower than the panel's own minimum: the panel wins, because it is one keystroke from
  // being dismissed and a panel too narrow to read is no use in either state.
  const tiny = { width: 200, height: 150 }
  assert.equal(clampDockSize(420, 'right', tiny), 200)
  assert.equal(clampDockSize(420, 'top', tiny), 150)
})

test('only a docked panel that is visible and pushing takes room from the canvas', () => {
  const insets = stageInsets(placement({ dock: 'right', size: 420 }), VIEW, true)
  assert.deepEqual(insets, { top: 0, right: 420, bottom: 0, left: 0 })

  assert.deepEqual(stageInsets(placement({ dock: 'bottom', size: 300 }), VIEW, true), {
    top: 0,
    right: 0,
    bottom: 300,
    left: 0,
  })

  const none = { top: 0, right: 0, bottom: 0, left: 0 }
  // Hidden hands the whole viewport back, which is what makes docking safe to have on.
  assert.deepEqual(stageInsets(placement(), VIEW, false), none)
  assert.deepEqual(stageInsets(placement({ push: false }), VIEW, true), none)
  assert.deepEqual(stageInsets(placement({ dock: 'float' }), VIEW, true), none)
})

test('a floating rectangle is brought back inside a viewport that shrank under it', () => {
  const small = { width: 700, height: 400 }
  const rect = clampFloat({ x: 1200, y: 900, width: 900, height: 800 }, small)
  assert.ok(rect.x >= 0 && rect.y >= 0)
  assert.ok(rect.x + rect.width <= small.width, 'right edge is inside')
  assert.ok(rect.y + rect.height <= small.height, 'bottom edge is inside')

  // A viewport smaller than the minimum gives everything it has rather than overflowing.
  const cramped = clampFloat({ x: 0, y: 0, width: 400, height: 400 }, { width: 200, height: 120 })
  assert.deepEqual(cramped, { x: 0, y: 0, width: 200, height: 120 })
})

test('a drag docks only near an edge, and the nearer edge wins a corner', () => {
  assert.equal(dockTarget({ x: VIEW.width / 2, y: VIEW.height / 2 }, VIEW), 'float')
  assert.equal(dockTarget({ x: 4, y: VIEW.height / 2 }, VIEW), 'left')
  assert.equal(dockTarget({ x: VIEW.width - 4, y: 10 }, VIEW), 'right', 'the right edge is nearer')
  assert.equal(dockTarget({ x: VIEW.width - 20, y: 5 }, VIEW), 'top', 'the top edge is nearer')
  assert.equal(dockTarget({ x: 300, y: VIEW.height - 1 }, VIEW), 'bottom')
  // Just outside the zone is not a request to dock.
  assert.equal(dockTarget({ x: DOCK_SNAP + 1, y: VIEW.height / 2 }, VIEW), 'float')
})

test('an edge the drag began inside is not a request to dock there', () => {
  // The header of a panel docked down the right-hand side is in the top zone before the drag
  // has gone anywhere. Muted, that corner reads as "no edge" until the pointer has left it.
  const header = { x: VIEW.width - 300, y: 22 }
  assert.deepEqual(edgesNear(header, VIEW), ['top'])
  assert.equal(dockTarget(header, VIEW), 'top')
  assert.equal(dockTarget(header, VIEW, ['top']), 'float')
  // Leaving the zone is what unmutes it, so a deliberate return still docks.
  assert.deepEqual(edgesNear({ x: 800, y: 400 }, VIEW), [])
  assert.equal(dockTarget({ x: 800, y: 10 }, VIEW), 'top')
})

test('a docked panel comes away only when pulled off its own edge', () => {
  const start = { x: VIEW.width - 400, y: 300 }
  // Moved along the edge, not away from it: still docked, however far it goes.
  assert.equal(tornOff('right', start, { x: start.x, y: 20 }), false)
  assert.equal(tornOff('right', start, { x: start.x - TEAR_OFF + 2, y: 300 }), false)
  assert.equal(tornOff('right', start, { x: start.x - TEAR_OFF - 2, y: 300 }), true)
  // Thrown across the screen, which is the same rule taken further.
  assert.equal(tornOff('right', start, { x: 2, y: 300 }), true)
  // Pushed further *into* its own edge is not a tear-off either.
  assert.equal(tornOff('right', start, { x: VIEW.width - 2, y: 300 }), false)
  // Every dock measures the distance off its own edge, and only that.
  assert.equal(tornOff('bottom', start, { x: 40, y: start.y - TEAR_OFF - 2 }), true)
  assert.equal(tornOff('top', start, { x: 40, y: start.y + TEAR_OFF + 2 }), true)
  assert.equal(tornOff('left', start, { x: start.x + TEAR_OFF + 2, y: 300 }), true)
})

test('a panel pulled off an edge lands under the pointer that pulled it', () => {
  const from = panelRect(placement({ dock: 'right' }), VIEW)
  const grab = { x: from.x + 40, y: 18 }
  const rect = undockRect(placement({ dock: 'right' }), from, grab, VIEW)
  assert.ok(grab.x >= rect.x && grab.x <= rect.x + rect.width, 'the grab point is still on it')
  assert.ok(grab.y >= rect.y && grab.y <= rect.y + rect.height)
  // Held by the header, it is still the header that is under the pointer.
  assert.ok(grab.y - rect.y < 40, 'the header stayed under the pointer')
  assert.equal(rect.width, 420, 'it keeps the width it had')
})

test('resizing a floating panel leaves the opposite side where it was', () => {
  const rect = { x: 200, y: 150, width: 500, height: 400 }
  const west = resizeFloat(rect, 'w', { x: 260, y: 0 }, VIEW)
  assert.equal(west.x, 260)
  assert.equal(west.x + west.width, rect.x + rect.width, 'the right edge did not move')

  const south = resizeFloat(rect, 's', { x: 0, y: 700 }, VIEW)
  assert.equal(south.y, rect.y, 'the top edge did not move')
  assert.equal(south.height, 550)

  const corner = resizeFloat(rect, 'ne', { x: 900, y: 200 }, VIEW)
  assert.equal(corner.x, rect.x)
  assert.equal(corner.width, 700)
  assert.equal(corner.y, 200)
  assert.equal(corner.y + corner.height, rect.y + rect.height)
})

test('a resize cannot be pushed through the opposite side', () => {
  const rect = { x: 200, y: 150, width: 500, height: 400 }
  const crushed = resizeFloat(rect, 'w', { x: 5000, y: 0 }, VIEW)
  assert.equal(crushed.width, PANEL_MIN_WIDTH)
  assert.equal(crushed.x + crushed.width, rect.x + rect.width, 'and it still ends where it did')

  const flattened = resizeFloat(rect, 'n', { x: 0, y: 5000 }, VIEW)
  assert.equal(flattened.height, PANEL_MIN_HEIGHT)
  assert.equal(flattened.y + flattened.height, rect.y + rect.height)
})

test('dragging a docked edge sets the size, measured from the edge it is docked to', () => {
  assert.equal(resizeDock('right', { x: VIEW.width - 500, y: 0 }, VIEW), 500)
  assert.equal(resizeDock('left', { x: 500, y: 0 }, VIEW), 500)
  assert.equal(resizeDock('bottom', { x: 0, y: VIEW.height - 320 }, VIEW), 320)
  assert.equal(resizeDock('top', { x: 0, y: 320 }, VIEW), 320)
  // And is bounded by the same rule the stored size is.
  assert.equal(resizeDock('right', { x: 4, y: 0 }, VIEW), VIEW.width - STAGE_MIN)
})

test('a docked panel offers one handle, on the edge that faces the canvas', () => {
  assert.deepEqual(resizeEdges('right'), ['w'])
  assert.deepEqual(resizeEdges('left'), ['e'])
  assert.deepEqual(resizeEdges('top'), ['s'])
  assert.deepEqual(resizeEdges('bottom'), ['n'])
  assert.equal(resizeEdges('float').length, 8, 'a floating panel offers every side and corner')
})

test('every placement stays inside the viewport it is given', () => {
  const views = [VIEW, { width: 360, height: 640 }, { width: 240, height: 180 }]
  const docks: PanelDock[] = ['left', 'right', 'top', 'bottom', 'float']
  for (const view of views) {
    for (const dock of docks) {
      const rect = panelRect(placement({ dock, size: 900 }), view)
      assert.ok(rect.x >= 0 && rect.y >= 0, `${dock} at ${view.width}×${view.height}`)
      assert.ok(rect.x + rect.width <= view.width, `${dock} fits across`)
      assert.ok(rect.y + rect.height <= view.height, `${dock} fits down`)
      assert.ok(rect.width > 0 && rect.height > 0)
    }
  }
})
