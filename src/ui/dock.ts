/**
 * Where the control panel sits.
 *
 * Two placements with one rule between them: a docked panel owns a whole edge of the viewport
 * and may take its room out of the canvas; a floating one is a rectangle put wherever you like
 * and never takes anything. Which of those is on is the only state — a docked panel has no
 * position to remember and a floating one has no edge, so there is nothing here that can
 * disagree with itself.
 *
 * All of it is arithmetic on rectangles, with no DOM in sight, because the interesting cases are
 * the awkward ones: a panel wider than the window it is in, a drag that leaves the screen, a
 * viewport that shrinks under a panel already placed. Those are worth having tests for, and a
 * function that reaches for `window` cannot have any.
 */

export type PanelDock = 'left' | 'right' | 'top' | 'bottom' | 'float'

/** The edge or corner of a floating panel being dragged. */
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export interface PanelPlacement {
  dock: PanelDock
  /** Extent along the docked axis: width when left or right, height when top or bottom. */
  size: number
  float: Rect
  /** Whether a docked panel takes its room out of the canvas rather than lying over it. */
  push: boolean
}

export interface Size {
  width: number
  height: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** Edges are named as the inset they consume, so an inset can be keyed by a dock directly. */
export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

/** Below this the tab bar wraps into a column of single words and the sliders lose their scale. */
export const PANEL_MIN_WIDTH = 260
export const PANEL_MIN_HEIGHT = 190
/** The least canvas a docked panel will leave behind, when the viewport can afford it. */
export const STAGE_MIN = 140
/** How near an edge a drag has to be for it to count as a request to dock there. */
export const DOCK_SNAP = 56
/**
 * How far a docked panel has to be pulled off its own edge before it comes away in your hand.
 * Without it, taking hold of the header of a panel docked along a long edge and moving a few
 * pixels would tear it off, because the far end of that header is nowhere near the edge it is
 * docked to — the distance to the edge cannot be what decides, only the distance travelled away
 * from it.
 */
export const TEAR_OFF = 28

/**
 * Clamp that survives an inverted range. Every bound here is derived from a viewport that can
 * be smaller than the minimum it is being compared against, and a plain
 * `min(hi, max(lo, v))` returns `hi` when `hi < lo` — the wrong end. The low bound wins.
 */
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(hi, lo), Math.max(lo, v))

const EDGES = ['left', 'right', 'top', 'bottom'] as const

export function isHorizontal(dock: PanelDock): boolean {
  return dock === 'left' || dock === 'right'
}

/**
 * The extent a docked panel may have along its axis.
 *
 * A viewport too small to hold both a usable panel and a usable canvas gives the room to the
 * panel: it is the thing being reached for, and it is one keystroke from being dismissed
 * entirely, where a panel too narrow to read is no use in either state.
 */
export function clampDockSize(size: number, dock: PanelDock, view: Size): number {
  if (dock === 'float') return Math.round(size)
  const horizontal = isHorizontal(dock)
  const extent = Math.max(1, horizontal ? view.width : view.height)
  const min = Math.min(horizontal ? PANEL_MIN_WIDTH : PANEL_MIN_HEIGHT, extent)
  const max = Math.max(min, extent - STAGE_MIN)
  return clamp(Math.round(size), min, max)
}

/** Brings a floating rectangle wholly back inside the viewport, at a usable size. */
export function clampFloat(rect: Rect, view: Size): Rect {
  const width = clamp(Math.round(rect.width), Math.min(PANEL_MIN_WIDTH, view.width), view.width)
  const height = clamp(Math.round(rect.height), Math.min(PANEL_MIN_HEIGHT, view.height), view.height)
  return {
    x: clamp(Math.round(rect.x), 0, view.width - width),
    y: clamp(Math.round(rect.y), 0, view.height - height),
    width,
    height,
  }
}

/** The panel's rectangle in viewport coordinates, whichever way it is placed. */
export function panelRect(panel: PanelPlacement, view: Size): Rect {
  if (panel.dock === 'float') return clampFloat(panel.float, view)
  const size = clampDockSize(panel.size, panel.dock, view)
  switch (panel.dock) {
    case 'left':
      return { x: 0, y: 0, width: size, height: view.height }
    case 'right':
      return { x: view.width - size, y: 0, width: size, height: view.height }
    case 'top':
      return { x: 0, y: 0, width: view.width, height: size }
    default:
      return { x: 0, y: view.height - size, width: view.width, height: size }
  }
}

/**
 * What the canvas gives up. A floating panel takes nothing, and neither does a hidden one —
 * dismissing the panel hands the whole viewport back, which is what makes it safe for docking
 * to take room in the first place.
 */
export function stageInsets(panel: PanelPlacement, view: Size, visible: boolean): Insets {
  const insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 }
  if (!visible || !panel.push || panel.dock === 'float') return insets
  insets[panel.dock] = clampDockSize(panel.size, panel.dock, view)
  return insets
}

function edgeDistance(edge: (typeof EDGES)[number], point: Point, view: Size): number {
  switch (edge) {
    case 'left':
      return point.x
    case 'right':
      return view.width - point.x
    case 'top':
      return point.y
    default:
      return view.height - point.y
  }
}

/** The edges whose snap zone contains this point. Usually none; in a corner, two. */
export function edgesNear(point: Point, view: Size): PanelDock[] {
  return EDGES.filter((edge) => edgeDistance(edge, point, view) < DOCK_SNAP)
}

/**
 * The edge a drag ending at this point is asking for, or `float` for anywhere else. In a corner
 * the nearer edge wins.
 *
 * `muted` is the answer to a gesture that would otherwise be unusable: the pointer is usually
 * inside a snap zone before the drag has gone anywhere at all — the header of a panel docked
 * down the right-hand side sits in the *top* edge's zone as much as the right one — so an edge
 * the drag began inside is not a request to dock there. The caller mutes those at the start and
 * unmutes each as the pointer leaves it, which turns "I happened to start here" into "I came
 * back here", and only the second of those is a gesture.
 */
export function dockTarget(point: Point, view: Size, muted: readonly PanelDock[] = []): PanelDock {
  let best: PanelDock = 'float'
  let least = DOCK_SNAP
  for (const edge of EDGES) {
    if (muted.includes(edge)) continue
    const distance = edgeDistance(edge, point, view)
    if (distance < least) {
      best = edge
      least = distance
    }
  }
  return best
}

/**
 * Whether a drag has taken a docked panel off its edge: distance travelled *away from* that
 * edge, and nothing else. Sliding along the edge never counts, however far it goes — a panel
 * docked down one side has its header in the opposite corner of the screen from the other end
 * of the same edge, so any rule involving where the pointer *is* rather than where it has *gone*
 * tears the panel off the moment it is touched.
 */
export function tornOff(dock: PanelDock, start: Point, point: Point): boolean {
  if (dock === 'float') return true
  const away =
    dock === 'right'
      ? start.x - point.x
      : dock === 'left'
        ? point.x - start.x
        : dock === 'bottom'
          ? start.y - point.y
          : point.y - start.y
  return away > TEAR_OFF
}

/**
 * The rectangle a panel takes when it is pulled off an edge: the size it had along the axis it
 * owned, a good fraction of the viewport along the axis it did not, and placed so that the point
 * the pointer took hold of stays at the same relative place inside it. Anything else makes the
 * panel jump out from under the hand that is holding it.
 */
export function undockRect(panel: PanelPlacement, from: Rect, grab: Point, view: Size): Rect {
  const horizontal = isHorizontal(panel.dock)
  const size = clampDockSize(panel.size, panel.dock, view)
  const width = horizontal ? size : Math.round(view.width * 0.62)
  const height = horizontal ? Math.round(view.height * 0.74) : size
  const u = from.width > 0 ? (grab.x - from.x) / from.width : 0.5
  const v = from.height > 0 ? (grab.y - from.y) / from.height : 0.5
  return clampFloat(
    { x: Math.round(grab.x - u * width), y: Math.round(grab.y - v * height), width, height },
    view,
  )
}

/** A floating panel resized by one of its edges or corners. The opposite side stays put. */
export function resizeFloat(rect: Rect, edge: ResizeEdge, point: Point, view: Size): Rect {
  const minWidth = Math.min(PANEL_MIN_WIDTH, view.width)
  const minHeight = Math.min(PANEL_MIN_HEIGHT, view.height)
  const right = rect.x + rect.width
  const bottom = rect.y + rect.height
  let { x, y, width, height } = rect

  if (edge.includes('w')) {
    x = clamp(point.x, 0, right - minWidth)
    width = right - x
  } else if (edge.includes('e')) {
    width = clamp(point.x - x, minWidth, view.width - x)
  }
  if (edge.includes('n')) {
    y = clamp(point.y, 0, bottom - minHeight)
    height = bottom - y
  } else if (edge.includes('s')) {
    height = clamp(point.y - y, minHeight, view.height - y)
  }
  return clampFloat({ x, y, width, height }, view)
}

/** The size a docked panel is asking for when its inner edge is dragged to here. */
export function resizeDock(dock: PanelDock, point: Point, view: Size): number {
  switch (dock) {
    case 'left':
      return clampDockSize(point.x, dock, view)
    case 'right':
      return clampDockSize(view.width - point.x, dock, view)
    case 'top':
      return clampDockSize(point.y, dock, view)
    case 'bottom':
      return clampDockSize(view.height - point.y, dock, view)
    default:
      return Math.round(view.width * 0.3)
  }
}

/** Which handles a placement offers: every side of a floating panel, the inner edge of a docked one. */
export function resizeEdges(dock: PanelDock): readonly ResizeEdge[] {
  switch (dock) {
    case 'left':
      return ['e']
    case 'right':
      return ['w']
    case 'top':
      return ['s']
    case 'bottom':
      return ['n']
    default:
      return ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
  }
}
