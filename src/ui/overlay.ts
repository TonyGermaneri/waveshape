/**
 * The control overlay: a tabbed panel that floats over the canvas, plus the always-on readout
 * and the axis labels.
 *
 * The canvas is never resized or inset to make room for chrome — the waveform owns the whole
 * viewport and the panel sits on top of it, dismissable with a single key. Text lives in the
 * DOM rather than in the render pipeline so it stays crisp at any scale factor, is selectable,
 * and is reachable by assistive technology.
 */

import { DEFAULT_CONFIG, FFT_SIZES, SAMPLE_RATES, type Config } from '../config.ts'
import { WINDOWS, windowSpec } from '../dsp/windows.ts'
import { PALETTES } from '../gpu/colormap.ts'
import type { AudioDeviceInfo, EngineStatus } from '../audio/engine.ts'
import type { GpuInfo } from '../gpu/device.ts'
import type { LoudnessReading } from '../dsp/loudness.ts'
import type { AxisTick } from './axes.ts'
import { PANE_SPECS, clampSplit, enabledCount, type Layout, type LayoutAxes, type Pane } from './layout.ts'
import { fmt, renderControls, type Control, type SwatchOption } from './widgets.ts'
import { fullscreenSupported, isFullscreen, onFullscreenChange, toggleFullscreen } from './fullscreen.ts'
import { KeyHelp } from './help.ts'
import { BINDINGS, keyLabel } from './keymap.ts'
import {
  allThemes,
  applyTheme,
  applyUiTheme,
  findTheme,
  loadUserThemes,
  saveUserThemes,
  themeFromConfig,
  themeMatchesConfig,
  themeToJson,
  themesFromJson,
  type Theme,
} from './theme.ts'

// Drawn rather than typed. The glyphs for these — ▶ ❚❚ ⤢ ⌨ — are rendered by a different font
// on every platform, sit on a different baseline in each, and half of them are missing outright
// on some. A path is the same size everywhere and inherits `currentColor` for free.
const svg = (body: string) =>
  `<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">${body}</svg>`

const KEYBOARD_ICON = svg(
  '<rect x="0.7" y="2.8" width="10.6" height="6.4" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.05"/>' +
    '<rect x="2.5" y="4.6" width="1.1" height="1.1" rx="0.2"/>' +
    '<rect x="5.45" y="4.6" width="1.1" height="1.1" rx="0.2"/>' +
    '<rect x="8.4" y="4.6" width="1.1" height="1.1" rx="0.2"/>' +
    '<rect x="3.6" y="6.9" width="4.8" height="1.1" rx="0.5"/>',
)
// Corners pointing out to fill the screen, and in to leave it.
const EXPAND_ICON = svg(
  '<path d="M1 4.6V1h3.6v1.4H2.4v2.2zM7.4 1H11v3.6H9.6V2.4H7.4zM11 7.4V11H7.4V9.6h2.2V7.4zM4.6 11H1V7.4h1.4v2.2h2.2z"/>',
)
const CONTRACT_ICON = svg(
  '<path d="M4.6 1v3.6H1V3.2h2.2V1zM11 3.2v1.4H7.4V1h1.4v2.2zM7.4 11V7.4H11v1.4H8.8V11zM1 8.8V7.4h3.6V11H3.2V8.8z"/>',
)
// A chevron toward the edge the panel lives on: it tucks away rather than closing.
const HIDE_ICON = svg('<path d="M4.2 1.9 8.3 6l-4.1 4.1-1.2-1.2L5.9 6 3 3.1z"/>')

const PLAY_ICON =
  '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M3.2 2.1 9.6 6 3.2 9.9z"/></svg>'
const RESET_ICON =
  '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M6 1.6a4.4 4.4 0 1 0 4.29 3.44l-1.27.28A3.1 3.1 0 1 1 6 2.9z"/><path d="M5.1 0.6 7.4 2.2 5.1 3.8z"/></svg>'
const STOP_ICON =
  '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><rect x="3" y="2.4" width="2.4" height="7.2" rx="0.5"/><rect x="6.6" y="2.4" width="2.4" height="7.2" rx="0.5"/></svg>'

/** Handle diameters in CSS pixels. Kept in step with `--ws-grab-size` in app.css. */
const GRAB_SIZE = 44
const GRAB_CORNER_SIZE = 88
/**
 * How close to both a vertical and a horizontal edge counts as a corner. One base handle's
 * width: comfortably more than any platform's resize grip, and small enough that the large
 * handle only appears when the split really is parked in a corner.
 */
const GRAB_CORNER_ZONE = GRAB_SIZE

const TABS = [
  'Source',
  'Analysis',
  'Waveform',
  'Spectrum',
  'Spectrogram',
  'Life',
  'Meters',
  'Theme',
  'Appearance',
  'System',
] as const
type Tab = (typeof TABS)[number]

export interface OverlayStatus {
  fps: number
  analysisFps: number
  frames: number
  dropped: number
  lapped: number
  pitchHz: number
  clarity: number
  loudness: LoudnessReading | null
  engine: EngineStatus
  crossOriginIsolated: boolean
  binHz: number
  enbwHz: number
  latencyMs: number
}

export interface OverlayDeps {
  config: Config
  gpuInfo: GpuInfo
  onChange: () => void
  onRestartSource: () => void
  onStopSource: () => void
  onResetMeters: () => void
  onSelfTest: () => Promise<string>
  onPickFile: () => void
  status: () => OverlayStatus
}

export class Overlay {
  private readonly root: HTMLElement
  private readonly deps: OverlayDeps
  private readonly panel: HTMLElement
  private readonly body: HTMLElement
  private readonly tabBar: HTMLElement
  private readonly readout: HTMLElement
  private readonly labelLayer: HTMLElement
  private readonly splitLayer: HTMLElement
  private readonly splitHandle: HTMLElement
  private readonly splitLineX: HTMLElement
  private readonly splitLineY: HTMLElement
  private readonly paneLabels: HTMLElement[] = []
  private readonly toast: HTMLElement

  private readonly help: KeyHelp
  private readonly fullscreenButton: HTMLButtonElement
  private readonly playButton: HTMLButtonElement
  private readonly stopButton: HTMLButtonElement
  private transportState = ''

  private tab: Tab = 'Source'
  private refreshControls: () => void = () => {}
  private devices: AudioDeviceInfo[] = []
  private visible = true
  private selfTestResult = ''
  private labelPool: HTMLElement[] = []
  private toastTimer = 0
  private touched = false
  /**
   * The status the current frame reported. Every live readout reads through this rather than
   * calling `deps.status()` itself: one call per frame instead of one per readout, and — the
   * reason it exists — a `get` closure that reads it sees *this* frame rather than the frame
   * the tab happened to be built on.
   */
  private lastStatus: OverlayStatus | null = null

  /** Which dividers exist, so a drag cannot move one that is not on screen. */
  private axes: LayoutAxes = { x: true, y: true }
  private uiSignature = ''
  private userThemes: Theme[] = []
  /** Draft name for the next "save theme", kept out of the config: it is not a setting. */
  private themeName = ''
  private themeTransfer = ''
  private themeMessage = ''

  constructor(root: HTMLElement, deps: OverlayDeps) {
    this.root = root
    this.deps = deps
    this.userThemes = loadUserThemes()
    this.help = new KeyHelp(deps.config)

    this.labelLayer = document.createElement('div')
    this.labelLayer.className = 'ws-labels'

    this.splitLayer = document.createElement('div')
    this.splitLayer.className = 'ws-split'
    this.splitLineX = document.createElement('div')
    this.splitLineX.className = 'ws-split-line ws-split-line-x'
    this.splitLineY = document.createElement('div')
    this.splitLineY.className = 'ws-split-line ws-split-line-y'
    this.splitHandle = this.buildSplitHandle()
    this.splitLayer.append(this.splitLineX, this.splitLineY, this.splitHandle)

    this.tabBar = document.createElement('div')
    this.tabBar.className = 'ws-tabs'
    this.tabBar.setAttribute('role', 'tablist')

    this.body = document.createElement('div')
    this.body.className = 'ws-body'

    this.panel = document.createElement('section')
    this.panel.className = 'ws-panel'
    this.panel.setAttribute('aria-label', 'Analyzer controls')

    const header = document.createElement('header')
    header.className = 'ws-header'
    const title = document.createElement('div')
    title.className = 'ws-title'
    title.innerHTML = '<strong>Waveshape</strong><span>WebGPU spectral analyzer</span>'

    const actions = document.createElement('div')
    actions.className = 'ws-header-actions'
    // Every button in this row is a square icon. The shortcut stays in the tooltip and the
    // accessible name rather than on the face of the button: six labels along the top of a
    // panel this narrow crowd out the thing the panel is for.
    const icon = (glyph: string, label: string, onClick: () => void) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'ws-close ws-icon'
      button.innerHTML = glyph
      button.title = label
      button.setAttribute('aria-label', label)
      button.addEventListener('click', onClick)
      return button
    }
    // Transport sits at the head of the group: it is the only control here that touches the
    // signal rather than the view.
    this.playButton = icon(PLAY_ICON, 'Start capture (r)', () => this.deps.onRestartSource())
    this.stopButton = icon(STOP_ICON, 'Stop capture (shift R)', () => this.deps.onStopSource())
    const resetButton = icon(RESET_ICON, 'Reset the pane layout (\\)', () => this.resetSplit())
    this.fullscreenButton = icon(EXPAND_ICON, 'Full screen (f)', () => void this.toggleFullscreen())

    const divider = document.createElement('span')
    divider.className = 'ws-header-divider'

    actions.append(
      this.playButton,
      this.stopButton,
      resetButton,
      divider,
      icon(KEYBOARD_ICON, 'Keyboard reference (?)', () => this.toggleHelp()),
      this.fullscreenButton,
      icon(HIDE_ICON, 'Hide the control panel (esc)', () => this.setVisible(false)),
    )
    header.append(title, actions)

    this.panel.append(header, this.tabBar, this.body)

    this.readout = document.createElement('div')
    this.readout.className = 'ws-readout'

    this.toast = document.createElement('div')
    this.toast.className = 'ws-toast'

    this.root.append(this.labelLayer, this.splitLayer, this.panel, this.readout, this.toast)

    this.syncChrome()
    onFullscreenChange(() => {
      this.syncFullscreenButton()
      if (this.tab === 'System') this.refreshControls()
    })
    this.syncFullscreenButton()

    this.buildTabBar()
    this.rebuild()
  }

  get isVisible(): boolean {
    return this.visible
  }

  get isHelpOpen(): boolean {
    return this.help.isOpen
  }

  /** Told once a touch has been seen, so the dismissal hint names a gesture and not a key. */
  noteTouchInput(): void {
    this.touched = true
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.panel.classList.toggle('ws-hidden', !visible)
    // Anything could have moved while the panel was away — a shortcut, a preset, a theme — so
    // it comes back showing the truth rather than whatever it was displaying when it left.
    if (visible) this.rebuild()
    else if (this.touched) this.notify('double tap for controls')
    else this.notify('space · esc · h  for controls        ?  for keys')
  }

  toggle(): void {
    this.setVisible(!this.visible)
  }

  /** Flashes a line over the canvas. The only feedback a shortcut gets when the panel is hidden. */
  notify(text: string, ms = 1500): void {
    this.toast.textContent = text
    this.toast.classList.add('ws-toast-show')
    window.clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('ws-toast-show'), ms)
  }

  toggleHelp(): void {
    this.help.toggle()
  }

  async toggleFullscreen(): Promise<void> {
    const wanted = !isFullscreen()
    if (wanted && !fullscreenSupported()) {
      this.notify('Full screen is not available in this browser')
      return
    }
    const on = await toggleFullscreen()
    this.syncFullscreenButton()
    if (wanted && !on) {
      // Refused: no user activation, or a permissions policy that forbids it. Saying "off"
      // here would read as if the toggle had worked in the other direction.
      this.notify('The browser refused full screen')
      return
    }
    this.notify(on ? 'Full screen  ·  press f or esc to leave' : 'Full screen off')
  }

  /** Moves along the tab bar; returns the tab landed on so a shortcut can announce it. */
  cycleTab(dir: number): string {
    const index = TABS.indexOf(this.tab)
    this.tab = TABS[(index + dir + TABS.length) % TABS.length]
    this.syncTabBar()
    // Reaching for a tab is a request to see it, so the panel comes back if it was dismissed.
    if (this.visible) this.rebuild()
    else this.setVisible(true)
    return this.tab
  }

  /** Steps through the built-in and saved themes; returns the label of the one applied. */
  cycleTheme(dir: number): string {
    const themes = allThemes(this.userThemes)
    const index = themes.findIndex((t) => t.id === this.deps.config.themeId)
    const next = themes[(index + dir + themes.length * 2) % themes.length]
    this.applyThemeById(next.id)
    return `Theme  ${next.label}`
  }

  private applyThemeById(id: string): void {
    const theme = findTheme(allThemes(this.userThemes), id)
    if (!theme) return
    applyTheme(this.deps.config, theme)
    this.syncChrome()
    this.deps.onChange()
    this.rebuild()
  }

  /**
   * Pushes the chrome colours into CSS only when they actually changed. A custom property
   * written on the root element invalidates style for the whole document, which is not
   * something to do sixty times a second while an unrelated slider is being dragged.
   */
  private syncChrome(): void {
    const config = this.deps.config
    const signature = `${JSON.stringify(config.ui)}|${config.style.background}`
    if (signature === this.uiSignature) return
    this.uiSignature = signature
    applyUiTheme(config.ui, config.style)
  }

  /**
   * Keeps the transport in step with the engine. Called every frame, so it compares a small
   * state key first: writing the same attributes sixty times a second would be free in effect
   * and not free in style recalculation.
   */
  private syncTransport(engine: EngineStatus): void {
    const key = `${engine.running}|${engine.suspended}`
    if (key === this.transportState) return
    this.transportState = key
    this.playButton.classList.toggle('ws-active', engine.running && !engine.suspended)
    this.playButton.classList.toggle('ws-pending', engine.running && engine.suspended)
    this.playButton.title = engine.suspended
      ? 'Audio is held by autoplay policy — click to let it through'
      : engine.running
        ? 'Restart capture (r)'
        : 'Start capture (r)'
    this.playButton.setAttribute('aria-label', this.playButton.title)
    this.stopButton.disabled = !engine.running
  }

  private syncFullscreenButton(): void {
    const on = isFullscreen()
    this.fullscreenButton.innerHTML = on ? CONTRACT_ICON : EXPAND_ICON
    this.fullscreenButton.title = on ? 'Leave full screen (f)' : 'Full screen (f)'
    this.fullscreenButton.setAttribute('aria-label', this.fullscreenButton.title)
    this.fullscreenButton.setAttribute('aria-pressed', String(on))
  }

  setDevices(devices: AudioDeviceInfo[]): void {
    this.devices = devices
    if (this.tab === 'Source') this.rebuild()
  }

  setSelfTestResult(text: string): void {
    this.selfTestResult = text
    if (this.tab === 'System') this.rebuild()
  }

  private buildTabBar(): void {
    this.tabBar.replaceChildren()
    for (const tab of TABS) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'ws-tab'
      button.textContent = tab
      button.setAttribute('role', 'tab')
      button.addEventListener('click', () => {
        this.tab = tab
        this.syncTabBar()
        this.rebuild()
      })
      this.tabBar.append(button)
    }
    this.syncTabBar()
  }

  private syncTabBar(): void {
    const buttons = Array.from(this.tabBar.children) as HTMLElement[]
    for (const button of buttons) {
      const active = button.textContent === this.tab
      button.classList.toggle('ws-active', active)
      button.setAttribute('aria-selected', String(active))
    }
  }

  /** Rebuilds the active tab's controls. Called on tab change and on structural config change. */
  rebuild(): void {
    const scroll = this.body.scrollTop
    this.refreshControls = renderControls(this.body, this.controlsFor(this.tab), (structural) => {
      this.syncChrome()
      this.deps.onChange()
      if (structural) {
        // A discrete choice can change which controls exist — switching the source from a
        // device to the generator adds a whole block of settings — so the panel is rebuilt
        // rather than merely refreshed.
        this.rebuild()
      } else {
        this.refreshControls()
      }
    })
    this.body.scrollTop = scroll
  }

  /** Reads through the per-frame cache, falling back to a fresh sample before the first frame. */
  private get live(): OverlayStatus {
    return (this.lastStatus ??= this.deps.status())
  }

  /** Cheap per-frame update of live values without rebuilding DOM. */
  update(): void {
    const s = this.deps.status()
    this.lastStatus = s
    this.syncTransport(s.engine)
    if (this.deps.config.style.showReadout) {
      this.readout.classList.remove('ws-hidden')
      this.readout.replaceChildren(...this.readoutItems(s))
    } else {
      this.readout.classList.add('ws-hidden')
    }
    if (this.visible) this.refreshControls()
  }

  private readoutItems(s: OverlayStatus): HTMLElement[] {
    const items: [string, string][] = []
    const e = s.engine
    const source = !e.running
      ? e.sourceLabel.slice(0, 28)
      : e.suspended
        ? 'held — click to start audio'
        : e.sourceLabel.slice(0, 28)
    items.push(['src', source])
    items.push(['rate', e.sampleRate ? `${(e.sampleRate / 1000).toFixed(1)} kHz` : '—'])
    items.push(['fft', `${this.deps.config.analysis.fftSize}`])
    items.push(['Δf', `${s.binHz.toFixed(2)} Hz`])
    items.push(['enbw', `${s.enbwHz.toFixed(2)} Hz`])
    items.push(['rate/s', `${s.analysisFps.toFixed(0)}`])
    // The pitch estimate only drives the oscilloscope's trigger, so it is only worth the space
    // in the readout while that pane is open.
    if (this.deps.config.panes.wave && s.pitchHz > 0) {
      items.push(['pitch', `${s.pitchHz.toFixed(2)} Hz`])
      items.push(['clarity', s.clarity.toFixed(2)])
    }
    const l = s.loudness
    if (l) {
      const num = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '−∞')
      items.push(['M', num(l.momentary)])
      items.push(['S', num(l.shortTerm)])
      items.push(['I', num(l.integrated)])
      items.push(['LRA', l.range.toFixed(1)])
      items.push(['dBTP', num(l.truePeakDb)])
      items.push(['corr', l.correlation.toFixed(2)])
    }
    items.push(['fps', s.fps.toFixed(0)])
    if (s.dropped > 0) items.push(['dropped', String(s.dropped)])

    return items.map(([k, v]) => {
      const node = document.createElement('span')
      node.className = 'ws-stat'
      node.innerHTML = `<em>${k}</em>${v}`
      return node
    })
  }

  // -------------------------------------------------------------------------------------
  // Quad layout
  // -------------------------------------------------------------------------------------

  private buildSplitHandle(): HTMLElement {
    const handle = document.createElement('button')
    handle.type = 'button'
    handle.className = 'ws-grab'
    handle.title = 'Drag to resize the four panes. Push it to an edge to close two of them.'
    handle.setAttribute('aria-label', 'Resize panes')
    handle.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="1.6"/><path d="M8 1.4 6.2 4h3.6zM8 14.6 6.2 12h3.6zM1.4 8 4 6.2v3.6zM14.6 8 12 6.2v3.6z"/></svg>'

    let dragging = false
    handle.addEventListener('pointerdown', (event) => {
      dragging = true
      handle.setPointerCapture(event.pointerId)
      handle.classList.add('ws-grabbing')
      event.preventDefault()
    })
    handle.addEventListener('pointermove', (event) => {
      if (!dragging) return
      // Measured against the layer rather than the handle: the handle moves under the pointer,
      // so anything relative to it would drift by its own displacement each frame.
      const box = this.splitLayer.getBoundingClientRect()
      this.setSplit(
        (event.clientX - box.left) / Math.max(1, box.width),
        (event.clientY - box.top) / Math.max(1, box.height),
      )
    })
    const release = (event: PointerEvent) => {
      if (!dragging) return
      dragging = false
      handle.releasePointerCapture(event.pointerId)
      handle.classList.remove('ws-grabbing')
    }
    handle.addEventListener('pointerup', release)
    handle.addEventListener('pointercancel', release)

    handle.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 0.1 : 0.01
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
      if (dx === 0 && dy === 0) return
      // Swallowed rather than allowed to bubble: the global map would otherwise read the same
      // arrow keys as a gain or frequency change while the handle has focus.
      event.preventDefault()
      event.stopPropagation()
      const split = this.deps.config.split
      this.setSplit(split.x + dx, split.y + dy)
    })

    return handle
  }

  private setSplit(x: number, y: number): void {
    const next = clampSplit({ x, y })
    const split = this.deps.config.split
    // Writing an axis that is not on screen would silently rearrange a layout the user cannot
    // see, and surprise them when they switch a pane back on.
    const wantX = this.axes.x ? next.x : split.x
    const wantY = this.axes.y ? next.y : split.y
    if (wantX === split.x && wantY === split.y) return
    split.x = wantX
    split.y = wantY
    this.deps.onChange()
  }

  resetSplit(): void {
    this.setSplit(0.5, 0.5)
    this.notify('Layout reset to four equal panes')
  }

  /**
   * Places everything that floats over the canvas but belongs to a particular pane: the axis
   * tick labels, the pane names, and the divider cross. Called every frame with the same
   * rectangles the renderer drew into, so a label cannot end up over the wrong visualisation.
   */
  setLayout(layout: Layout, groups: readonly { pane: Pane; ticks: AxisTick[] }[]): void {
    const style = this.deps.config.style
    const height = layout.height

    this.axes = layout.axes
    this.syncSplitHandle(layout)
    this.syncPaneLabels(layout.panes)

    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
    let used = 0
    for (const { pane, ticks } of groups) {
      // Below this a pane is a sliver, and the labels would be all there is to see in it.
      if (!style.showLabels || pane.width < 90 || pane.height < 70) continue
      // Only the bottom row has to clear the readout bar.
      const onBottom = pane.y + pane.height >= height - 1
      const bottomGap = onBottom && style.showReadout ? 42 : 16

      for (const tick of ticks) {
        const node = this.tickNode(used++)
        node.style.display = ''
        node.textContent = tick.label
        if (tick.horizontal) {
          node.style.left = `${pane.x + 5}px`
          node.style.top = `${pane.y + clamp(tick.pos * pane.height, 9, pane.height - bottomGap)}px`
          node.dataset.axis = 'y'
        } else {
          node.style.left = `${pane.x + clamp(tick.pos * pane.width, 18, pane.width - 18)}px`
          node.style.top = `${pane.y + pane.height - bottomGap + 4}px`
          node.dataset.axis = 'x'
        }
      }
    }
    for (let i = used; i < this.labelPool.length; i++) this.labelPool[i].style.display = 'none'
  }

  private tickNode(index: number): HTMLElement {
    let node = this.labelPool[index]
    if (!node) {
      node = document.createElement('span')
      node.className = 'ws-tick'
      this.labelLayer.append(node)
      this.labelPool[index] = node
    }
    return node
  }

  private syncSplitHandle(layout: Layout): void {
    const { axes, rowSplit, cutX, cutY, width, height } = layout

    // The vertical divider spans only the rows that are actually divided. With three panes the
    // bottom one runs the full width, and a line drawn across it would claim a division that
    // is not there.
    const top = rowSplit[0] ? 0 : cutY
    const bottom = rowSplit[1] ? height : cutY
    this.splitLineY.style.left = `${cutX}px`
    this.splitLineY.style.top = `${top}px`
    this.splitLineY.style.height = `${Math.max(0, bottom - top)}px`
    this.splitLineX.style.top = `${cutY}px`
    // A divider is drawn only where a division exists, and only where there is something on
    // both sides of it — otherwise it is a border on the edge of the viewport.
    this.splitLineY.style.display = axes.x && cutX > 0 && cutX < width && bottom > top ? '' : 'none'
    this.splitLineX.style.display = axes.y && cutY > 0 && cutY < height ? '' : 'none'

    // A single pane has no divider to move. The handle is removed rather than disabled: an
    // invisible control that swallows pointer events over the middle of the picture would be
    // worse than no control at all.
    if (!axes.x && !axes.y) {
      this.splitHandle.style.display = 'none'
      return
    }
    this.splitHandle.style.display = ''

    // In a corner the handle is sharing its pixels with the operating system's window resize
    // grip, which wins every fight over a pointer. Growing it there — and only there — leaves
    // enough of it outside the grip to be grabbed. Anywhere else the base size is plenty and a
    // larger target would just be a bigger dead zone over the trace.
    const nearX = axes.x && (cutX < GRAB_CORNER_ZONE || cutX > width - GRAB_CORNER_ZONE)
    const nearY = axes.y && (cutY < GRAB_CORNER_ZONE || cutY > height - GRAB_CORNER_ZONE)
    // With only one divider the handle rides its midpoint and never reaches a corner, so the
    // window's resize grip is not in play.
    const corner = nearX && nearY
    this.splitHandle.classList.toggle('ws-grab-corner', corner)

    // Held fully on screen rather than centred on the split: at a rail the cross itself is on
    // the viewport edge, and a handle centred there would be half outside the window.
    const half = (corner ? GRAB_CORNER_SIZE : GRAB_SIZE) / 2
    const inside = (v: number, extent: number) =>
      Math.min(Math.max(v, Math.min(half, extent / 2)), Math.max(extent - half, extent / 2))
    // On an axis that does not exist the handle has no divider to sit on, so it sits halfway
    // along the one that does.
    this.splitHandle.style.left = `${inside(axes.x ? cutX : width / 2, width)}px`
    this.splitHandle.style.top = `${inside(axes.y ? cutY : height / 2, height)}px`
    this.splitHandle.style.cursor = axes.x && axes.y ? 'move' : axes.x ? 'col-resize' : 'row-resize'
  }

  private syncPaneLabels(panes: readonly Pane[]): void {
    const show = this.deps.config.style.showLabels
    for (let i = 0; i < PANE_SPECS.length; i++) {
      let node = this.paneLabels[i]
      if (!node) {
        node = document.createElement('span')
        node.className = 'ws-pane-name'
        this.labelLayer.append(node)
        this.paneLabels[i] = node
      }
      const pane = panes[i]
      if (!show || !pane || !pane.visible || pane.width < 90 || pane.height < 40) {
        node.style.display = 'none'
        continue
      }
      node.style.display = ''
      node.textContent = pane.label
      // Top right: the value axis puts its labels down the left edge, and the two would sit on
      // top of each other in every pane.
      node.style.left = `${pane.x + pane.width - 6}px`
      node.style.top = `${pane.y + 5}px`
    }
  }

  // -------------------------------------------------------------------------------------
  // Tab contents
  // -------------------------------------------------------------------------------------

  /**
   * Key caps for the binding with this label, so the panel advertises the shortcut next to the
   * control it drives. A label that no longer matches a binding simply prints nothing, which is
   * the failure mode you want: a missing hint rather than a wrong one.
   */
  private keysFor(label: string): string[] | undefined {
    const binding = BINDINGS.find((b) => b.label === label)
    return binding?.keys.filter((k) => !k.alias).map((k) => keyLabel(k.token))
  }

  private controlsFor(tab: Tab): Control[] {
    const c = this.deps.config
    switch (tab) {
      case 'Source':
        return this.sourceControls(c)
      case 'Analysis':
        return this.analysisControls(c)
      case 'Waveform':
        return this.waveControls(c)
      case 'Spectrum':
        return this.spectrumControls(c)
      case 'Spectrogram':
        return this.spectrogramControls(c)
      case 'Life':
        return this.lifeControls(c)
      case 'Meters':
        return this.meterControls(c)
      case 'Theme':
        return this.themeControls(c)
      case 'Appearance':
        return this.appearanceControls(c)
      case 'System':
        return this.systemControls(c)
    }
  }

  private sourceControls(c: Config): Control[] {
    const s = c.source
    const list: Control[] = [
      { kind: 'heading', text: 'Input' },
      {
        kind: 'select',
        label: 'Source',
        options: [
          { value: 'microphone', label: 'Audio input device' },
          { value: 'display', label: 'Tab / system audio' },
          { value: 'file', label: 'Audio file' },
          { value: 'generator', label: 'Test signal generator' },
        ],
        get: () => s.kind,
        set: (v) => {
          s.kind = v as Config['source']['kind']
        },
      },
    ]

    if (s.kind === 'microphone') {
      list.push({
        kind: 'select',
        label: 'Device',
        options: [
          { value: '', label: 'System default' },
          ...this.devices.map((d) => ({ value: d.deviceId, label: d.label })),
        ],
        get: () => s.deviceId,
        set: (v) => {
          s.deviceId = v
        },
        hint: this.devices.length
          ? undefined
          : 'Device names appear once microphone permission has been granted.',
      })
    }

    if (s.kind === 'file') {
      list.push({
        kind: 'button',
        label: 'Choose file…',
        action: 'pick-file',
        onClick: () => this.deps.onPickFile(),
        hint: 'Decoded audio plays looped at the current AudioContext rate.',
      })
    }

    if (s.kind === 'generator') {
      const g = s.generator
      list.push(
        {
          kind: 'select',
          label: 'Signal',
          options: [
            { value: 'sine', label: 'Sine' },
            { value: 'square', label: 'Square' },
            { value: 'sawtooth', label: 'Sawtooth' },
            { value: 'sweep', label: 'Log sweep' },
            { value: 'white', label: 'White noise' },
            { value: 'pink', label: 'Pink noise' },
            { value: 'impulse', label: 'Impulse train' },
          ],
          get: () => g.kind,
          set: (v) => {
            g.kind = v as typeof g.kind
          },
        },
        {
          kind: 'slider',
          label: 'Frequency',
          min: 10,
          max: 20000,
          step: 0.01,
          curve: 'log',
          get: () => g.frequency,
          set: (v) => {
            g.frequency = v
          },
          format: fmt.hz,
        },
        {
          kind: 'slider',
          label: 'Amplitude',
          min: 0,
          max: 1,
          step: 0.001,
          get: () => g.amplitude,
          set: (v) => {
            g.amplitude = v
          },
          format: fmt.pct,
        },
      )
      if (g.kind === 'sweep') {
        list.push(
          {
            kind: 'slider',
            label: 'Sweep start',
            min: 5,
            max: 2000,
            step: 1,
            curve: 'log',
            get: () => g.sweepStart,
            set: (v) => {
              g.sweepStart = v
            },
            format: fmt.hz,
          },
          {
            kind: 'slider',
            label: 'Sweep end',
            min: 1000,
            max: 96000,
            step: 1,
            curve: 'log',
            get: () => g.sweepEnd,
            set: (v) => {
              g.sweepEnd = v
            },
            format: fmt.hz,
          },
          {
            kind: 'slider',
            label: 'Sweep time',
            min: 1,
            max: 60,
            step: 0.5,
            get: () => g.sweepSeconds,
            set: (v) => {
              g.sweepSeconds = v
            },
            format: (v) => `${v.toFixed(1)} s`,
          },
        )
      }
    }

    list.push(
      { kind: 'heading', text: 'Capture' },
      {
        kind: 'select',
        label: 'Sample rate',
        options: SAMPLE_RATES.map((r) => ({
          value: String(r),
          label: r === 'native' ? 'Device native' : `${(r / 1000).toFixed(1)} kHz`,
        })),
        get: () => String(s.sampleRate),
        set: (v) => {
          s.sampleRate = v === 'native' ? 'native' : Number(v)
        },
        hint: 'The AudioContext is opened at the rate the device reports, so nothing is resampled behind your back. Requesting a rate the hardware cannot do will fall back.',
      },
      {
        kind: 'select',
        label: 'Channels',
        options: [
          { value: '1', label: 'Mono' },
          { value: '2', label: 'Stereo' },
        ],
        get: () => String(s.channels),
        set: (v) => {
          s.channels = Number(v)
        },
      },
      {
        kind: 'note',
        text: 'Echo cancellation, noise suppression and automatic gain control are all disabled on the captured track. Chrome enables all three by default and AGC alone makes level measurement meaningless.',
      },
      {
        kind: 'note',
        text: 'Capture opens on its own once a device is bound — on load, when one is plugged in, and when the settings above change. The transport at the top of this panel starts and stops it by hand: ▶ on r, ❚❚ on shift R.',
      },
      {
        kind: 'slider',
        label: 'Monitor to output',
        keys: this.keysFor('Monitor to output'),
        min: 0,
        max: 1,
        step: 0.01,
        get: () => s.monitorGain,
        set: (v) => {
          s.monitorGain = v
        },
        format: fmt.pct,
        hint: 'Off by default. A live microphone routed to the speakers is a feedback loop.',
      },
    )
    return list
  }

  private analysisControls(c: Config): Control[] {
    const a = c.analysis
    const spec = windowSpec(a.window)
    const status = this.deps.status()
    return [
      { kind: 'heading', text: 'Transform' },
      {
        kind: 'select',
        label: 'FFT size',
        keys: this.keysFor('FFT size'),
        options: FFT_SIZES.map((n) => ({ value: String(n), label: String(n) })),
        get: () => String(a.fftSize),
        set: (v) => {
          a.fftSize = Number(v)
        },
        hint: `Bin spacing ${status.binHz.toFixed(3)} Hz. Larger transforms resolve closer partials but smear transients over a longer window.`,
      },
      {
        kind: 'select',
        label: 'Window',
        keys: this.keysFor('Window'),
        options: WINDOWS.map((w) => ({ value: w.id, label: w.label })),
        get: () => a.window,
        set: (v) => {
          a.window = v as typeof a.window
        },
        hint: `${spec.note} Sidelobes ${spec.sidelobeDb} dB, rolloff ${spec.rolloffDbPerOctave} dB/oct, ENBW ${status.enbwHz.toFixed(2)} Hz.`,
      },
      ...(spec.parametric
        ? [
            {
              kind: 'slider' as const,
              label: spec.paramLabel ?? 'Shape',
              min: spec.paramMin ?? 0,
              max: spec.paramMax ?? 1,
              step: 0.1,
              get: () => a.windowParam,
              set: (v: number) => {
                a.windowParam = v
              },
              format: fmt.fixed(2),
            },
          ]
        : []),
      {
        kind: 'slider',
        label: 'Hop size',
        keys: this.keysFor('Hop size'),
        min: 32,
        max: 8192,
        step: 1,
        curve: 'log',
        get: () => a.hop,
        set: (v) => {
          a.hop = Math.max(32, 1 << Math.round(Math.log2(v)))
        },
        // Refreshed every frame, so it reads the live rate rather than the one in force when
        // the tab was built. The hints around it are strings, baked at rebuild time, and that
        // is fine: changing anything they quote rebuilds the tab anyway.
        format: (v) => `${v} smp  ·  ${(this.live.engine.sampleRate / v || 0).toFixed(0)} fps`,
        hint: `Samples between analysis windows — this sets the true analysis rate, independent of the display refresh. Recommended overlap for this window is ${spec.optimalOverlapPct}%.`,
      },
      {
        kind: 'select',
        label: 'Channels analysed',
        keys: this.keysFor('Channels analysed'),
        options: [
          { value: 'stereo', label: 'Stereo (L and R)' },
          { value: 'left', label: 'Left only' },
          { value: 'right', label: 'Right only' },
          { value: 'mid', label: 'Mid (L+R)' },
          { value: 'side', label: 'Side (L−R)' },
          { value: 'mono', label: 'Mono downmix' },
        ],
        get: () => a.channelMode,
        set: (v) => {
          a.channelMode = v as typeof a.channelMode
        },
      },
      {
        kind: 'select',
        label: 'Magnitude scale',
        keys: this.keysFor('Magnitude scale'),
        options: [
          { value: 'amplitude', label: 'Amplitude (dBFS peak)' },
          { value: 'density', label: 'Power spectral density (dBFS/√Hz)' },
        ],
        get: () => a.scale,
        set: (v) => {
          a.scale = v as typeof a.scale
        },
        hint: 'Amplitude reads a sine correctly regardless of FFT size; density reads noise correctly regardless of FFT size. They cannot both be right at once.',
      },
      { kind: 'heading', text: 'Reassignment' },
      {
        kind: 'toggle',
        label: 'Time-frequency reassignment',
        keys: this.keysFor('Reassignment'),
        get: () => a.reassign,
        set: (v) => {
          a.reassign = v
        },
        hint: 'Relocates each bin to the centre of gravity of the energy it represents, computed from the phase derivative. Sharpens the spectrogram far beyond the window’s nominal resolution. Costs two extra transforms per frame.',
      },
      {
        kind: 'slider',
        label: 'Max time correction',
        min: 0.05,
        max: 0.5,
        step: 0.01,
        get: () => a.maxTimeShift,
        set: (v) => {
          a.maxTimeShift = v
        },
        format: (v) => `${(v * 100).toFixed(0)}% of window`,
        disabled: () => !a.reassign,
        hint: 'Corrections larger than this are discarded. A large displacement means the bin sat in a spectral null where the phase derivative is noise.',
      },
      {
        kind: 'slider',
        label: 'Max frequency correction',
        min: 0.5,
        max: 16,
        step: 0.5,
        get: () => a.maxFreqShiftBins,
        set: (v) => {
          a.maxFreqShiftBins = v
        },
        format: (v) => `${v} bins`,
        disabled: () => !a.reassign,
      },
      { kind: 'heading', text: 'Integration' },
      {
        kind: 'slider',
        label: 'Averaging',
        keys: this.keysFor('Averaging'),
        min: 0,
        max: 5,
        step: 0.05,
        get: () => a.averaging,
        set: (v) => {
          a.averaging = v
        },
        format: (v) => (v <= 0 ? 'off' : `${v.toFixed(2)} s`),
        hint: 'Exponential power averaging across analysis frames (Welch). Trades time resolution for a lower-variance estimate — essential when reading a noise floor.',
      },
      {
        kind: 'slider',
        label: 'Peak hold fall',
        min: 0,
        max: 60,
        step: 0.5,
        get: () => a.peakDecayDbPerSecond,
        set: (v) => {
          a.peakDecayDbPerSecond = v
        },
        format: (v) => (v <= 0 ? 'infinite hold' : `${v.toFixed(1)} dB/s`),
      },
      {
        kind: 'slider',
        label: 'Noise floor clamp',
        min: -200,
        max: -60,
        step: 1,
        get: () => a.floorDb,
        set: (v) => {
          a.floorDb = v
        },
        format: fmt.db,
      },
    ]
  }

  private waveControls(c: Config): Control[] {
    const w = c.wave
    return [
      { kind: 'heading', text: 'Timebase' },
      {
        kind: 'slider',
        label: 'Time span',
        keys: this.keysFor('Time span'),
        min: 0.05,
        max: 5000,
        step: 0.01,
        curve: 'log',
        get: () => w.timebaseMs,
        set: (v) => {
          w.timebaseMs = v
        },
        format: fmt.ms,
        disabled: () => w.trigger === 'pitch',
        hint: 'Ignored while pitch-locked, where the span is derived from the detected period.',
      },
      {
        kind: 'select',
        label: 'Trigger',
        keys: this.keysFor('Trigger'),
        options: [
          { value: 'pitch', label: 'Pitch-locked (NSDF)' },
          { value: 'level', label: 'Level' },
          { value: 'free', label: 'Free run' },
        ],
        get: () => w.trigger,
        set: (v) => {
          w.trigger = v as typeof w.trigger
        },
        hint: 'Pitch lock estimates the period with the McLeod Pitch Method and locks the sweep to it, so a harmonically rich waveform stands still where a level trigger would jitter between crossings.',
      },
      {
        kind: 'slider',
        label: 'Cycles shown',
        keys: this.keysFor('Cycles shown'),
        min: 0.25,
        max: 32,
        step: 0.25,
        get: () => w.cycles,
        set: (v) => {
          w.cycles = v
        },
        format: (v) => `${v} periods`,
        disabled: () => w.trigger !== 'pitch',
      },
      {
        kind: 'slider',
        label: 'Clarity threshold',
        keys: this.keysFor('Clarity threshold'),
        min: 0,
        max: 1,
        step: 0.01,
        get: () => w.clarityThreshold,
        set: (v) => {
          w.clarityThreshold = v
        },
        format: fmt.fixed(2),
        disabled: () => w.trigger !== 'pitch',
        hint: 'How periodic the signal must be before the pitch lock is trusted. Below this the display falls back to the fixed time span.',
      },
      {
        kind: 'row',
        children: [
          {
            kind: 'slider',
            label: 'Pitch range low',
            min: 10,
            max: 500,
            step: 1,
            curve: 'log',
            get: () => w.pitchMinHz,
            set: (v) => {
              w.pitchMinHz = v
            },
            format: fmt.hz,
            disabled: () => w.trigger !== 'pitch',
          },
          {
            kind: 'slider',
            label: 'Pitch range high',
            min: 200,
            max: 8000,
            step: 1,
            curve: 'log',
            get: () => w.pitchMaxHz,
            set: (v) => {
              w.pitchMaxHz = v
            },
            format: fmt.hz,
            disabled: () => w.trigger !== 'pitch',
          },
        ],
      },
      {
        kind: 'slider',
        label: 'Trigger level',
        keys: this.keysFor('Trigger level'),
        min: -1,
        max: 1,
        step: 0.001,
        get: () => w.triggerLevel,
        set: (v) => {
          w.triggerLevel = v
        },
        format: fmt.fixed(3),
        disabled: () => w.trigger === 'free',
      },
      {
        kind: 'select',
        label: 'Trigger edge',
        options: [
          { value: '1', label: 'Rising' },
          { value: '-1', label: 'Falling' },
        ],
        get: () => String(w.triggerEdge),
        set: (v) => {
          w.triggerEdge = Number(v) as 1 | -1
        },
        disabled: () => w.trigger === 'free',
      },
      { kind: 'heading', text: 'Trace' },
      {
        kind: 'select',
        label: 'Reconstruction',
        keys: this.keysFor('Reconstruction'),
        options: [
          { value: 'auto', label: 'Automatic' },
          { value: 'envelope', label: 'Min/max envelope' },
          { value: 'bandlimited', label: 'Band-limited (sinc)' },
        ],
        get: () => w.trace,
        set: (v) => {
          w.trace = v as typeof w.trace
        },
        hint: 'Zoomed out, each pixel column shows the true min/max of every sample it covers. Zoomed in, the trace is the Whittaker-Shannon interpolant — the actual band-limited waveform, complete with inter-sample overshoot.',
      },
      {
        kind: 'slider',
        label: 'Vertical gain',
        keys: this.keysFor('Vertical gain'),
        min: 0.05,
        max: 64,
        step: 0.01,
        curve: 'log',
        get: () => w.gain,
        set: (v) => {
          w.gain = v
        },
        format: (v) => `${v.toFixed(2)}×  (${(20 * Math.log10(v)).toFixed(1)} dB)`,
      },
      {
        kind: 'toggle',
        label: 'Show RMS band',
        keys: this.keysFor('RMS band'),
        get: () => w.showRms,
        set: (v) => {
          w.showRms = v
        },
      },
      {
        kind: 'toggle',
        label: 'Split channels into lanes',
        keys: this.keysFor('Split channels into lanes'),
        get: () => w.splitChannels,
        set: (v) => {
          w.splitChannels = v
        },
      },
    ]
  }

  private spectrumControls(c: Config): Control[] {
    const s = c.spectrum
    return [
      { kind: 'heading', text: 'Frequency axis' },
      {
        kind: 'toggle',
        label: 'Logarithmic frequency',
        keys: this.keysFor('Logarithmic frequency axis'),
        get: () => s.logFrequency,
        set: (v) => {
          s.logFrequency = v
        },
      },
      {
        kind: 'row',
        children: [
          {
            kind: 'slider',
            label: 'Low',
            min: 1,
            max: 2000,
            step: 1,
            curve: 'log',
            get: () => s.freqMin,
            set: (v) => {
              s.freqMin = v
            },
            format: fmt.hz,
          },
          {
            kind: 'slider',
            label: 'High',
            min: 1000,
            max: 96000,
            step: 10,
            curve: 'log',
            get: () => s.freqMax,
            set: (v) => {
              s.freqMax = v
            },
            format: fmt.hz,
          },
        ],
      },
      { kind: 'heading', text: 'Level axis' },
      {
        kind: 'row',
        children: [
          {
            kind: 'slider',
            label: 'Floor',
            min: -200,
            max: -20,
            step: 1,
            get: () => s.dbMin,
            set: (v) => {
              s.dbMin = v
            },
            format: fmt.db,
          },
          {
            kind: 'slider',
            label: 'Ceiling',
            min: -60,
            max: 40,
            step: 1,
            get: () => s.dbMax,
            set: (v) => {
              s.dbMax = v
            },
            format: fmt.db,
          },
        ],
      },
      { kind: 'heading', text: 'Display' },
      {
        kind: 'select',
        label: 'Curve source',
        keys: this.keysFor('Curve source'),
        options: [
          { value: 'live', label: 'Instantaneous' },
          { value: 'average', label: 'Averaged' },
        ],
        get: () => s.source,
        set: (v) => {
          s.source = v as typeof s.source
        },
        hint: 'Averaging is configured on the Analysis tab.',
      },
      {
        kind: 'toggle',
        label: 'Peak hold trace',
        keys: this.keysFor('Peak hold trace'),
        get: () => s.showPeak,
        set: (v) => {
          s.showPeak = v
        },
      },
      {
        kind: 'slider',
        label: 'Fill opacity',
        keys: this.keysFor('Fill opacity'),
        min: 0,
        max: 1,
        step: 0.01,
        get: () => s.fill,
        set: (v) => {
          s.fill = v
        },
        format: fmt.pct,
      },
      {
        kind: 'toggle',
        label: 'Split channels into lanes',
        keys: this.keysFor('Split channels into lanes'),
        get: () => s.splitChannels,
        set: (v) => {
          s.splitChannels = v
        },
      },
      {
        kind: 'note',
        text: 'Each pixel column shows the min, mean and max of every bin that falls inside it. A narrow peak can never be lost between columns, and where there is less than one bin per pixel the curve is interpolated rather than stepped.',
      },
    ]
  }

  private spectrogramControls(c: Config): Control[] {
    const s = c.spectrogram
    return [
      { kind: 'heading', text: 'History' },
      {
        kind: 'slider',
        label: 'Time span',
        keys: this.keysFor('History span'),
        min: 1,
        max: 120,
        step: 0.5,
        curve: 'log',
        get: () => s.historySeconds,
        set: (v) => {
          s.historySeconds = v
        },
        format: (v) => `${v.toFixed(1)} s`,
        hint: 'Stored as a ring in GPU memory: scrolling is a texture coordinate offset, not a copy.',
      },
      { kind: 'heading', text: 'Frequency axis' },
      {
        kind: 'toggle',
        label: 'Logarithmic frequency',
        keys: this.keysFor('Logarithmic frequency axis'),
        get: () => s.logFrequency,
        set: (v) => {
          s.logFrequency = v
        },
      },
      {
        kind: 'row',
        children: [
          {
            kind: 'slider',
            label: 'Low',
            min: 1,
            max: 2000,
            step: 1,
            curve: 'log',
            get: () => s.freqMin,
            set: (v) => {
              s.freqMin = v
            },
            format: fmt.hz,
          },
          {
            kind: 'slider',
            label: 'High',
            min: 1000,
            max: 96000,
            step: 10,
            curve: 'log',
            get: () => s.freqMax,
            set: (v) => {
              s.freqMax = v
            },
            format: fmt.hz,
          },
        ],
      },
      { kind: 'heading', text: 'Intensity' },
      {
        kind: 'row',
        children: [
          {
            kind: 'slider',
            label: 'Floor',
            min: -160,
            max: -20,
            step: 1,
            get: () => s.dbFloor,
            set: (v) => {
              s.dbFloor = v
            },
            format: fmt.db,
          },
          {
            kind: 'slider',
            label: 'Ceiling',
            min: -80,
            max: 20,
            step: 1,
            get: () => s.dbCeil,
            set: (v) => {
              s.dbCeil = v
            },
            format: fmt.db,
          },
        ],
      },
      {
        kind: 'slider',
        label: 'Gain',
        min: 0.01,
        max: 100,
        step: 0.01,
        curve: 'log',
        get: () => s.gain,
        set: (v) => {
          s.gain = v
        },
        format: (v) => `${v.toFixed(2)}×`,
      },
      {
        kind: 'slider',
        label: 'Splat radius',
        keys: this.keysFor('Splat radius'),
        min: 0.5,
        max: 4,
        step: 0.05,
        get: () => s.splatRadius,
        set: (v) => {
          s.splatRadius = v
        },
        format: (v) => `${v.toFixed(2)} px`,
        hint: 'Reassigned points land at fractional coordinates. A larger kernel fills gaps in sparse material; a smaller one keeps partials needle-thin.',
      },
      {
        kind: 'toggle',
        label: 'Normalise by coverage',
        keys: this.keysFor('Normalise by coverage'),
        get: () => s.normalise,
        set: (v) => {
          s.normalise = v
        },
        hint: 'Divides accumulated energy by accumulated kernel weight. Evens out density variation at the cost of absolute level accuracy.',
      },
      {
        kind: 'select',
        label: 'Palette',
        keys: this.keysFor('Colour map'),
        options: PALETTES.map((p) => ({ value: p.id, label: p.label })),
        get: () => s.palette,
        set: (v) => {
          s.palette = v
        },
        hint: 'All of these rise monotonically in lightness. A rainbow map would invent a bright band in the middle of a smooth ramp and you would read it as a peak.',
      },
    ]
  }

  private lifeControls(c: Config): Control[] {
    const l = c.life
    const num = (
      label: string,
      key: keyof Config['life'],
      min: number,
      max: number,
      step: number,
      format: (v: number) => string,
      hint?: string,
      curve?: 'log',
    ): Control => ({
      kind: 'slider',
      label,
      min,
      max,
      step,
      curve,
      get: () => l[key] as number,
      set: (v) => {
        ;(l[key] as number) = v
      },
      format,
      disabled: () => !l.enabled,
      hint,
    })

    return [
      {
        kind: 'note',
        text: 'The reassignment pass measures where energy is. This turns each of those measurements into an organism that knows what it is harmonically, and then lets it live: it senses at small integer ratios of its own frequency, migrates toward exact ratio with whatever it finds, and dies at a rate set by how tonal it was at birth.',
      },
      { kind: 'heading', text: 'Population' },
      {
        kind: 'toggle',
        label: 'Harmonic life',
        get: () => l.enabled,
        set: (v) => {
          l.enabled = v
        },
        hint: 'Replaces the spectrogram’s palette with the particles’ own colours: hue is chroma, so every octave of a note is one colour, and saturation is how sure the organism is that it is a note at all rather than noise.',
      },
      {
        kind: 'slider',
        label: 'Population',
        min: 500,
        max: 200000,
        step: 500,
        curve: 'log',
        get: () => l.population,
        set: (v) => {
          l.population = Math.round(v)
        },
        format: (v) => `${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0)} alive`,
        disabled: () => !l.enabled,
        hint: 'How many may be alive at once. Slots are handed out in birth order, so when the cap is reached the ring comes back round to the oldest particle and takes it — culling by age costs nothing because it is what a ring already does.',
      },
      num('Lifespan', 'lifespan', 0, 20000, 10, (v) => (v <= 0 ? 'until spent or off screen' : `${v.toFixed(0)} steps`), 'Zero is no clock at all: a particle then lives until its energy runs out, until it wanders off the top or bottom of the display, or until the population cap claims it.'),
      {
        kind: 'toggle',
        label: 'Wrap the frequency axis',
        get: () => l.wrap,
        set: (v) => {
          l.wrap = v
        },
        disabled: () => !l.enabled,
        hint: 'Leave the top and re-enter at the bottom. For an organism that lives on ratios this is not an arbitrary teleport — it arrives back at the same pitch class, an octave relationship away from where it left.',
      },
      num('Birth threshold', 'birthThreshold', 0.00001, 0.02, 0.00001, (v) => `${(20 * Math.log10(v)).toFixed(0)} dB`, 'Quieter points are measured but not animated. Raising this is the difference between a population and a fog.', 'log'),
      num('Noise mortality', 'noiseMortality', 0, 6, 0.1, fmt.fixed(2), 'How much faster a particle born into a flat spectrum dies than one born on a peak.'),
      num('Family bonus', 'supportBonus', 0, 1, 0.01, fmt.fixed(2), 'How much longer a partial lives for each sibling on its harmonic series. A note persists; a click does not.'),
      num('Stamina', 'stamina', 5, 6000, 5, (v) => `${v.toFixed(0)} steps unfed`, 'How long a particle survives away from any energy — which is to say how far it can travel before the journey kills it. This used to be the trail decay’s job as well, so endurance and memory could not be set apart; they are two knobs now because they were always two things.', 'log'),
      { kind: 'heading', text: 'What moves it' },
      {
        kind: 'note',
        text: 'Four forces, deliberately of different kinds. Three are reactions — to the surface underneath, to the crowd around it, to what interval the neighbours are at. The fourth is not: a particle walks its own harmonic series on a clock of its own, whether or not there is anything at the next station. That last one is why the population crosses the tracks it was measured from instead of lying on them. Every one of these takes a negative value, which inverts the behaviour rather than disabling it.',
      },
      num('Surface', 'surfacePull', -4, 8, 0.05, fmt.fixed(2), 'How strongly the scope surface underneath is felt. Hunger sets the sign by itself: a starving particle climbs toward energy, a full one is pushed off it, and the traffic between the two is most of what you see moving. Negative inverts the whole relationship, so the population avoids the signal that made it.'),
      num('Consonance', 'harmonicPull', -4, 8, 0.05, fmt.fixed(2), 'How strongly a particle is drawn into exact ratio with a partner at a simple interval — an octave, a fifth, a third. Turned up, the population performs just intonation on whatever it is given. Negative repels consonance, which pulls a harmonic series apart instead of tightening it.'),
      num('Dissonance', 'dissonance', -4, 8, 0.05, fmt.fixed(2), 'How hard a partner at a rough interval — a semitone, a tritone, a major seventh — pushes it away. This is what keeps two chords sounding at once from averaging into one cloud: nothing labels a particle with which chord it came from, and nothing needs to, because every cross-pair between two keys lands on one of these intervals. Negative makes dissonance attractive and the two populations merge.'),
      num('Roaming', 'roam', -3, 3, 0.02, (v) => (v === 0 ? 'stays put' : `±${(Math.abs(v) * 1.5).toFixed(2)} octaves`), 'How far up and down its own harmonic series a particle walks, and how eagerly. This is the one behaviour that is not a reaction to anything: it paces its own partials on its own clock, past stations that may be empty. The reach is a ratio of the harmonic number rather than a count of harmonics, so a particle travels the same interval whatever register it lives in — stepping n by a fixed count covers an octave and a fifth down at the bottom of the series and a hundred and sixty cents up at the top, which left the whole upper half of a spectrogram sitting perfectly still. One born into noise has no series and glides freely. Negative is a particle fleeing its own series rather than pacing it.'),
      num('Crowding', 'crowding', -4, 8, 0.05, fmt.fixed(2), 'How hard a particle in the middle of a crowd moves out of it. This is the term that opposes the consonant pull — with it at zero the population converges onto its ratios and stops dead, and a partial is a line instead of a band that keeps rearranging itself. Negative makes them huddle.'),
      num('Vibrato', 'vibrato', 0, 400, 1, (v) => (v <= 0 ? 'none' : `${v.toFixed(0)} cents`), 'Depth of the intrinsic wobble every particle carries. Its rate is the harmonic number the particle was born as, capped at the eighth, so the partials of one note shimmer at integer multiples of one rate and stay recognisably one note while they move. Its depth is scaled by how unsure the particle is that it is a note at all: clean partials hold taut lines, noise-born ones shiver.'),
      num('Feeding', 'feed', 0.01, 1, 0.01, fmt.fixed(2), 'How fast a particle standing where the spectrum still has energy recovers. A particle grazes: stay on your partial and you are sustained, drift into a gap or outlive the note and you starve.'),
      num('Occupancy before renewal', 'occupancy', 0.5, 64, 0.5, (v) => `${v.toFixed(1)} particles`, 'How many may already live at a frequency before new energy renews them instead of spawning more. This is what stops the population being a fountain of identical newborns overwritten on the spot — lower it for a sparse cast of long-lived individuals, raise it for a crowd.'),
      num('Settling', 'settling', 0, 0.2, 0.002, (v) => (v <= 0 ? 'never settles' : `half still by ${(1 / v).toFixed(0)} steps`), 'How quickly a particle stops *reacting* as it ages. Its own itinerary is exempt: an old organism is not a still one, it is one that has stopped being startled.'),
      num('Sensor spread', 'sensorCents', 1, 1200, 1, (v) => `${v.toFixed(0)} cents`, 'How far above and below itself a particle listens for a ridge to follow — vibrato, a bent string, a siren.', 'log'),
      num('Turn rate', 'turnCents', -60, 60, 0.5, (v) => `${v.toFixed(1)} cents`, 'The unit every reactive force is measured in. Negative reverses all three at once, which is a different animal rather than a broken one.'),
      num('Drift limit', 'driftLimitCents', 1, 600, 1, (v) => `${v.toFixed(0)} cents/step`, 'The fastest a particle may migrate. At sixty frames a second, a hundred cents per step is an octave and a half every second.', 'log'),
      num('Momentum', 'damping', 0, 0.995, 0.005, fmt.fixed(3), 'Fraction of the previous step’s drift carried forward.'),
      { kind: 'heading', text: 'Pheromone field' },
      num('Field decay', 'decay', 0.5, 0.999, 0.001, fmt.fixed(3), 'What survives each step. This is the organism’s memory, and it is the only thing letting one particle find another. It used to set how fast an unfed particle starved as well — see Stamina, which is that job given its own knob.'),
      num('Diffusion', 'diffuse', 0, 1, 0.01, fmt.pct, 'Without it the field is a set of spikes and nothing ever senses anything.'),
      num('Deposit', 'deposit', 0.02, 64, 0.02, fmt.fixed(2), 'How loudly a particle announces itself to the others. Everything in “What moves it” that reads the crowd or the intervals is reading this.', 'log'),
      num('Census floor', 'peakFloorDb', -140, -20, 1, fmt.db, 'Level a spectral peak must clear before it counts as a partial when the fundamental is inferred.'),
      { kind: 'heading', text: 'How it draws' },
      {
        kind: 'note',
        text: 'One organism, four windows onto it, and these three settings mean the same thing in all four. The spectrogram shows where the particles have been, over the reassigned energy they left. The spectrum shows each at its own frequency and level — the domain it was born in. The vectorscope arranges them by pitch class around a circle, so every octave of a note lies on one spoke and a chord is a constellation. The waveform draws each living partial as the sine it claims to be: not a reconstruction, since the organism never measured phase and is not entitled to one, but its own account of what it is hearing.',
      },
      num('Point size', 'pointSize', 0.5, 24, 0.1, (v) => `${v.toFixed(1)} px`, 'How big a particle draws: its splat radius in the spectrogram, its point radius in the spectrum and the vectorscope, the width of its sine in the waveform.'),
      num('Brightness', 'brightness', 0, 8, 0.05, fmt.fixed(2)),
      {
        kind: 'select',
        label: 'Merge',
        options: [
          { value: 'add', label: 'Additive' },
          { value: 'screen', label: 'Screen' },
          { value: 'lighten', label: 'Lighten' },
        ],
        get: () => l.blend,
        set: (v) => {
          l.blend = v as Config['life']['blend']
        },
        disabled: () => !l.enabled,
        hint: 'Additive is the house style everywhere else in this renderer, and it is the wrong one here: density becomes brightness, and summing enough hues gets you white however saturated each of them was, so a crowded pane bleaches. Screen adds the same way at low levels and rolls off toward white instead of straight through it. Lighten keeps whichever of the two is brighter and never mixes at all, so colours stay exactly as they were born — at the cost of density becoming invisible, and of needing more brightness to read.',
      },
      num('Saturation', 'saturation', 0, 4, 0.05, fmt.fixed(2), 'Chroma of the organism’s own colours, applied where they are resolved rather than in post, so the instrument underneath keeps whatever the theme gave it. Above one this recovers what averaging takes away: in the spectrogram, thousands of particles deposit into one texel over the life of a column, and the mean of enough hues is grey no matter what the merge mode does.'),
      num(
        'Underlying scope',
        'baseOpacity',
        0,
        1,
        0.01,
        (v) => (v <= 0 ? 'hidden' : v >= 1 ? 'full' : fmt.pct(v)),
        'Opacity of the instrument beneath the organism — the waveform trace, the spectrum curve, the vectorscope figure, and in the spectrogram the reassigned energy itself, laid down as a monochrome ground in the theme’s secondary ink. Keeping it up is how you can see that a particle has left the track it was born on, which is the whole point of it moving. At zero only the population is left.',
      ),
      num('Resynthesised partials', 'traces', 0, 4096, 16, (v) => (v <= 0 ? 'off' : `${v.toFixed(0)} sines`), 'How many partials the waveform pane draws. Each is a polyline, so this is the one parameter here with a real frame-rate cost.'),
      { kind: 'heading', text: 'The leading edge' },
      {
        kind: 'note',
        text: 'The spectrogram normally holds its picture back by half an analysis window, because reassignment can move energy backwards in time and a column shown too early would visibly rewrite itself. A particle is not a correction — it is painted where it is now — so once the organism is running, most of that lag is hiding the one place anything is happening.',
      },
      num('Show up to now', 'lead', 0, 1, 0.02, (v) => (v >= 1 ? 'the live edge' : v <= 0 ? 'fully settled' : `${fmt.pct(v)} of the lag given back`), 'How much of the safety margin to give back so the live edge is on screen. At one you are watching particles land. The cost is that the measurement underneath, which really is still being corrected, settles visibly in the last few columns — turn this down if that bothers you more than not seeing the edge does.'),
      num('Amplitude lead', 'amplitudeLead', -32, 32, 1, (v) => (v === 0 ? 'flat edge' : `${Math.abs(v).toFixed(0)} columns`), 'How far a quiet particle hangs back from the edge. The loudest thing in the frame touches it and everything else falls short in proportion to its level, so the edge is a contour of the present rather than a ruled line. Negative puts the loud ones behind instead.'),
      { kind: 'heading', text: 'Phosphor' },
      {
        kind: 'note',
        text: 'The same persistence the core scopes have, except that this one belongs to each particle rather than to the screen. Nothing records where a particle has been — with tens of thousands of them that would be the largest buffer in the program — but nothing has to, because the motion is reproducible: velocity and an intrinsic wobble that is a pure function of age, harmonic number and slot, both run backwards from the particle’s current state. So the trail costs a quad per step and no memory, and the wobble is reconstructed rather than smeared, which is why a clean low partial trails a taut ribbon and something born in noise high up trails a fast scribble.',
      },
      num('Trail length', 'trail', 0, 48, 1, (v) => (v <= 0 ? 'off' : `${v.toFixed(0)} steps`), 'How many steps of its own path each particle draws behind it. The waveform caps this at four, where the trail becomes a chorus of the same partial beating against itself. That pane is where the cost is — a chorus multiplies polylines, and the resynthesised partials above are the knob to trade against if the frame rate suffers.'),
      num('Trail decay', 'trailFade', 0.3, 0.995, 0.005, fmt.fixed(3), 'Brightness retained per step back along the trail.'),
      num('Trail modulation', 'trailModulation', 0, 3, 0.05, fmt.fixed(2), 'How much the particle’s life bends its own phosphor. The rate half is the wobble drawn into the trail, which runs at the harmonic number it was born as; the amplitude half is that a particle with vitality to spare leaves a long trail and a starving one barely marks the screen. At zero every trail is a plain fading streak.'),
      {
        kind: 'note',
        text: 'Every particle carries 58 bits of life beside its 24 bits of colour: which harmonic it is, how many cents sharp, how many siblings it has, how flat its neighbourhood was, whether it was born on a rising edge, its octave, how far reassignment had to move it, its age, its vitality, its cohort, and how many times new energy has renewed it.',
      },
    ]
  }

  private meterControls(c: Config): Control[] {
    // Everything below reads `this.live` at refresh time rather than closing over a snapshot.
    // Capturing the status here was why this whole tab sat frozen on whatever the numbers had
    // been at the moment it was opened.
    const loud = () => this.live.loudness
    const num = (v: number | undefined) =>
      v === undefined || !Number.isFinite(v) ? '−∞' : v.toFixed(2)
    /** Loudness and peak scales share a 60 dB window, which is what a meter bridge shows. */
    const db60 = (v: number | undefined) =>
      v === undefined || !Number.isFinite(v) ? 0 : (v + 60) / 60
    return [
      { kind: 'heading', text: 'ITU-R BS.1770-4 / EBU R 128' },
      {
        kind: 'readout',
        label: 'Momentary (400 ms)',
        get: () => `${num(loud()?.momentary)} LUFS`,
        meter: () => db60(loud()?.momentary),
      },
      {
        kind: 'readout',
        label: 'Short term (3 s)',
        get: () => `${num(loud()?.shortTerm)} LUFS`,
        meter: () => db60(loud()?.shortTerm),
      },
      {
        kind: 'readout',
        label: 'Integrated (gated)',
        get: () => `${num(loud()?.integrated)} LUFS`,
        meter: () => db60(loud()?.integrated),
        // Over the delivery target is the one thing an integrated reading is checked for.
        warn: () => {
          const v = loud()?.integrated
          return v !== undefined && Number.isFinite(v) && v > c.meters.targetLufs
        },
      },
      {
        kind: 'readout',
        label: 'Loudness range',
        get: () => `${(loud()?.range ?? 0).toFixed(2)} LU`,
        meter: () => (loud()?.range ?? 0) / 20,
      },
      {
        kind: 'readout',
        label: 'True peak',
        get: () => `${num(loud()?.truePeakDb)} dBTP`,
        meter: () => db60(loud()?.truePeakDb),
        warn: () => (loud()?.truePeakDb ?? -Infinity) > c.meters.truePeakCeilingDb,
      },
      {
        kind: 'readout',
        label: 'Sample peak',
        get: () => `${num(loud()?.samplePeakDb)} dBFS`,
        meter: () => db60(loud()?.samplePeakDb),
        warn: () => (loud()?.samplePeakDb ?? -Infinity) > -0.1,
      },
      {
        kind: 'readout',
        label: 'Correlation',
        get: () => (loud()?.correlation ?? 0).toFixed(3),
        // Bipolar: it grows out of the centre, left for out of phase and right for in.
        meter: () => ((loud()?.correlation ?? 0) + 1) / 2,
        origin: 0.5,
        warn: () => (loud()?.correlation ?? 0) < 0,
      },
      {
        kind: 'readout',
        label: 'Integration time',
        get: () => `${(loud()?.seconds ?? 0).toFixed(1)} s`,
      },
      {
        kind: 'readout',
        label: 'Delivery check',
        get: () => {
          const l = loud()
          if (!l || !Number.isFinite(l.integrated)) return 'measuring…'
          const dl = l.integrated - c.meters.targetLufs
          const tp = l.truePeakDb - c.meters.truePeakCeilingDb
          const text = `${dl >= 0 ? '+' : ''}${dl.toFixed(1)} LU vs target`
          return tp > 0 ? `${text}, true peak over by ${tp.toFixed(1)} dB` : text
        },
      },
      { kind: 'heading', text: 'Targets' },
      {
        kind: 'slider',
        label: 'Loudness target',
        min: -31,
        max: -9,
        step: 0.5,
        get: () => c.meters.targetLufs,
        set: (v) => {
          c.meters.targetLufs = v
        },
        format: (v) => `${v.toFixed(1)} LUFS`,
        hint: '−23 for EBU R 128 broadcast, −14 for most streaming platforms, −16 for podcasts.',
      },
      {
        kind: 'slider',
        label: 'True peak ceiling',
        min: -6,
        max: 0,
        step: 0.1,
        get: () => c.meters.truePeakCeilingDb,
        set: (v) => {
          c.meters.truePeakCeilingDb = v
        },
        format: fmt.db,
      },
      {
        kind: 'button',
        label: 'Reset integration',
        action: 'reset-meters',
        onClick: () => this.deps.onResetMeters(),
      },
      {
        kind: 'note',
        text: 'K-weighting filters are re-derived from the Recommendation’s analog prototype at the working sample rate, so the measurement stays compliant at 96 and 192 kHz rather than only at 48. True peak uses a 4× polyphase oversampler with 32 taps per phase — the Recommendation’s reference filter uses 12.',
      },
    ]
  }

  // -------------------------------------------------------------------------------------
  // Themes
  // -------------------------------------------------------------------------------------

  private saveCurrentTheme(): void {
    const label = this.themeName.trim()
    if (!label) {
      this.themeMessage = 'Give the theme a name first.'
      return
    }
    const theme = themeFromConfig(this.deps.config, label)
    const index = this.userThemes.findIndex((t) => t.id === theme.id)
    if (index >= 0) this.userThemes[index] = theme
    else this.userThemes.push(theme)
    saveUserThemes(this.userThemes)
    this.deps.config.themeId = theme.id
    this.themeName = ''
    this.themeMessage = `Saved “${label}”.`
    this.notify(`Theme saved  ${label}`)
  }

  private deleteTheme(id: string): void {
    const theme = findTheme(this.userThemes, id)
    if (!theme) return
    this.userThemes = this.userThemes.filter((t) => t.id !== id)
    saveUserThemes(this.userThemes)
    this.themeMessage = `Deleted “${theme.label}”.`
    // Leave the colours alone — deleting the recipe should not repaint the screen.
    this.deps.config.themeId = ''
  }

  private importThemes(): void {
    try {
      const imported = themesFromJson(this.themeTransfer)
      for (const theme of imported) {
        const index = this.userThemes.findIndex((t) => t.id === theme.id)
        if (index >= 0) this.userThemes[index] = theme
        else this.userThemes.push(theme)
      }
      saveUserThemes(this.userThemes)
      const last = imported[imported.length - 1]
      applyTheme(this.deps.config, last)
      this.syncChrome()
      this.themeMessage =
        imported.length === 1
          ? `Imported and applied “${last.label}”.`
          : `Imported ${imported.length} themes, applied “${last.label}”.`
      this.notify(`Theme  ${last.label}`)
    } catch (error) {
      this.themeMessage = `Could not import: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  /** Live description of what is on screen, which is not always a theme you can name. */
  private currentThemeSummary(): string {
    const current = findTheme(allThemes(this.userThemes), this.deps.config.themeId)
    if (!current) return 'Custom — not saved'
    return themeMatchesConfig(this.deps.config, current) ? current.label : `${current.label} — modified`
  }

  private themeControls(c: Config): Control[] {
    const themes = allThemes(this.userThemes)
    const current = findTheme(themes, c.themeId)
    const options: SwatchOption[] = themes.map((theme) => ({
      value: theme.id,
      label: theme.label,
      colors: [theme.style.background, theme.style.primary, theme.style.accent, theme.style.secondary],
      tag: theme.builtin ? undefined : 'saved',
    }))
    const selectedIsUser = () => {
      const selected = findTheme(allThemes(this.userThemes), c.themeId)
      return Boolean(selected && !selected.builtin)
    }

    return [
      { kind: 'heading', text: 'Theme' },
      { kind: 'readout', label: 'Current', get: () => this.currentThemeSummary() },
      {
        kind: 'swatches',
        label: 'Built in and saved',
        options,
        get: () => c.themeId,
        set: (id) => this.applyThemeById(id),
        hint: 'A theme carries the canvas colours, the whole post chain, the graticule, the spectrogram colour map and the panel’s own chrome. t and ⇧T step through them without opening this tab.',
      },
      { kind: 'heading', text: 'Save' },
      {
        kind: 'text',
        label: 'Name',
        placeholder: current ? `${current.label} copy` : 'My theme',
        get: () => this.themeName,
        set: (v) => {
          this.themeName = v
        },
        onSubmit: () => this.saveCurrentTheme(),
      },
      {
        kind: 'row',
        children: [
          {
            kind: 'button',
            label: 'Save current look',
            action: 'theme-save',
            accent: true,
            onClick: () => this.saveCurrentTheme(),
          },
          {
            kind: 'button',
            label: 'Delete selected',
            action: 'theme-delete',
            disabled: () => !selectedIsUser(),
            onClick: () => this.deleteTheme(c.themeId),
          },
        ],
      },
      {
        kind: 'note',
        text: 'Saved themes live in this browser’s local storage under their own key, so resetting the settings profile on the System tab leaves them intact. Saving over an existing name replaces it.',
      },
      ...(this.themeMessage
        ? [{ kind: 'readout' as const, label: 'Last action', get: () => this.themeMessage }]
        : []),
      { kind: 'heading', text: 'Panel chrome' },
      {
        kind: 'row',
        children: [
          {
            kind: 'color',
            label: 'Panel',
            get: () => c.ui.panel,
            set: (v) => {
              c.ui.panel = v
            },
          },
          {
            kind: 'color',
            label: 'Text',
            get: () => c.ui.text,
            set: (v) => {
              c.ui.text = v
            },
          },
          {
            kind: 'color',
            label: 'Accent',
            get: () => c.ui.accent,
            set: (v) => {
              c.ui.accent = v
            },
          },
        ],
      },
      {
        kind: 'slider',
        label: 'Panel opacity',
        min: 0.3,
        max: 1,
        step: 0.01,
        get: () => c.ui.opacity,
        set: (v) => {
          c.ui.opacity = v
        },
        format: fmt.pct,
      },
      {
        kind: 'slider',
        label: 'Backdrop blur',
        min: 0,
        max: 40,
        step: 1,
        get: () => c.ui.blur,
        set: (v) => {
          c.ui.blur = v
        },
        format: (v) => (v <= 0 ? 'off' : `${v.toFixed(0)} px`),
      },
      {
        kind: 'slider',
        label: 'Corner radius',
        min: 0,
        max: 24,
        step: 1,
        get: () => c.ui.radius,
        set: (v) => {
          c.ui.radius = v
        },
        format: (v) => `${v.toFixed(0)} px`,
        hint: 'The muted, faint and border tones are alpha ramps of the text colour, and the panel switches to a light colour scheme on its own when its background is light.',
      },
      { kind: 'heading', text: 'Transfer' },
      {
        kind: 'row',
        children: [
          {
            kind: 'button',
            label: 'Copy current theme out',
            action: 'theme-export',
            onClick: () => {
              this.themeTransfer = themeToJson(
                themeFromConfig(this.deps.config, current?.label ?? 'Custom'),
              )
              this.themeMessage = 'Theme written below — copy it somewhere safe.'
            },
          },
          {
            kind: 'button',
            label: 'Import from text',
            action: 'theme-import',
            onClick: () => this.importThemes(),
          },
        ],
      },
      {
        kind: 'textarea',
        label: 'Theme JSON',
        rows: 6,
        placeholder: 'Paste a theme here, then press Import.',
        get: () => this.themeTransfer,
        set: (v) => {
          this.themeTransfer = v
        },
      },
    ]
  }

  private appearanceControls(c: Config): Control[] {
    const s = c.style
    return [
      {
        kind: 'note',
        text: 'These are the same values a theme carries. Change them here and the Theme tab will show the current theme as modified until you save it under a name.',
      },
      { kind: 'heading', text: 'Colours' },
      {
        kind: 'row',
        children: [
          {
            kind: 'color',
            label: 'Background',
            get: () => s.background,
            set: (v) => {
              s.background = v
            },
          },
          {
            kind: 'color',
            label: 'Wave',
            get: () => s.primary,
            set: (v) => {
              s.primary = v
            },
          },
          {
            kind: 'color',
            label: 'Secondary',
            get: () => s.secondary,
            set: (v) => {
              s.secondary = v
            },
          },
          {
            kind: 'color',
            label: 'Accent',
            get: () => s.accent,
            set: (v) => {
              s.accent = v
            },
          },
        ],
      },
      { kind: 'heading', text: 'Trace' },
      {
        kind: 'slider',
        label: 'Line width',
        keys: this.keysFor('Line width'),
        min: 0.5,
        max: 8,
        step: 0.1,
        get: () => s.lineWidth,
        set: (v) => {
          s.lineWidth = v
        },
        format: (v) => `${v.toFixed(1)} px`,
      },
      {
        kind: 'slider',
        label: 'Intensity',
        keys: this.keysFor('Intensity'),
        min: 0,
        max: 4,
        step: 0.01,
        get: () => s.intensity,
        set: (v) => {
          s.intensity = v
        },
        format: fmt.fixed(2),
      },
      {
        kind: 'slider',
        label: 'Phosphor persistence',
        keys: this.keysFor('Phosphor persistence'),
        min: 0,
        max: 0.98,
        step: 0.01,
        get: () => s.persistence,
        set: (v) => {
          s.persistence = v
        },
        format: (v) => (v <= 0 ? 'off' : v.toFixed(2)),
        hint: 'Fraction of the previous frame retained. Traces accumulate additively, so density becomes brightness the way it does on a CRT.',
      },
      { kind: 'heading', text: 'Tone mapping' },
      {
        kind: 'select',
        label: 'Curve',
        keys: this.keysFor('Tone mapping'),
        options: [
          { value: 'clip', label: 'Clip' },
          { value: 'reinhard', label: 'Reinhard' },
          { value: 'aces', label: 'ACES filmic' },
        ],
        get: () => s.tonemap,
        set: (v) => {
          s.tonemap = v as typeof s.tonemap
        },
        hint: 'The scene is rendered in linear rgba16float with additive blending, so overlapping traces genuinely exceed 1.0. The curve decides what happens above that.',
      },
      {
        kind: 'slider',
        label: 'Exposure',
        keys: this.keysFor('Exposure'),
        min: 0.05,
        max: 8,
        step: 0.01,
        curve: 'log',
        get: () => s.exposure,
        set: (v) => {
          s.exposure = v
        },
        format: fmt.fixed(2),
      },
      {
        kind: 'slider',
        label: 'Bloom',
        keys: this.keysFor('Bloom'),
        min: 0,
        max: 2,
        step: 0.01,
        get: () => s.bloom,
        set: (v) => {
          s.bloom = v
        },
        format: (v) => (v <= 0 ? 'off' : v.toFixed(2)),
      },
      {
        kind: 'slider',
        label: 'Bloom threshold',
        min: 0,
        max: 3,
        step: 0.01,
        get: () => s.bloomThreshold,
        set: (v) => {
          s.bloomThreshold = v
        },
        format: fmt.fixed(2),
        disabled: () => s.bloom <= 0,
      },
      {
        kind: 'slider',
        label: 'Saturation',
        min: 0,
        max: 2,
        step: 0.01,
        get: () => s.saturation,
        set: (v) => {
          s.saturation = v
        },
        format: fmt.fixed(2),
      },
      {
        kind: 'slider',
        label: 'Gamma',
        min: 0.4,
        max: 2.4,
        step: 0.01,
        get: () => s.gamma,
        set: (v) => {
          s.gamma = v
        },
        format: fmt.fixed(2),
      },
      {
        kind: 'slider',
        label: 'Vignette',
        min: 0,
        max: 1,
        step: 0.01,
        get: () => s.vignette,
        set: (v) => {
          s.vignette = v
        },
        format: (v) => (v <= 0 ? 'off' : v.toFixed(2)),
      },
      { kind: 'heading', text: 'Graticule' },
      {
        kind: 'toggle',
        label: 'Show grid',
        keys: this.keysFor('Graticule'),
        get: () => s.showGrid,
        set: (v) => {
          s.showGrid = v
        },
      },
      {
        kind: 'toggle',
        label: 'Show axis labels',
        keys: this.keysFor('Axis labels'),
        get: () => s.showLabels,
        set: (v) => {
          s.showLabels = v
        },
      },
      {
        kind: 'toggle',
        label: 'Show readout bar',
        keys: this.keysFor('Readout bar'),
        get: () => s.showReadout,
        set: (v) => {
          s.showReadout = v
        },
      },
      {
        kind: 'slider',
        label: 'Grid brightness',
        min: 0,
        max: 1,
        step: 0.01,
        get: () => s.gridAlpha,
        set: (v) => {
          s.gridAlpha = v
        },
        format: fmt.pct,
      },
    ]
  }

  private systemControls(c: Config): Control[] {
    const info = this.deps.gpuInfo
    // Read live, for the same reason as the meters: these are the numbers you watch while
    // changing something else, and a frozen frame rate is worse than none.
    const engine = () => this.live.engine
    return [
      { kind: 'heading', text: 'Panes' },
      ...PANE_SPECS.map((spec, index) => ({
        kind: 'toggle' as const,
        label: spec.label,
        keys: [String(index + 1)],
        get: () => c.panes[spec.mode],
        set: (v: boolean) => {
          c.panes[spec.mode] = v
        },
        // The last one open cannot be closed: an analyzer showing nothing is not a state worth
        // being able to reach.
        disabled: () => c.panes[spec.mode] && enabledCount(c.panes) <= 1,
      })),
      {
        kind: 'button',
        label: 'Reset the pane layout',
        action: 'reset-layout',
        onClick: () => this.resetSplit(),
        hint: 'Four equal quarters. The dividers between panes are dragged by the handle at their intersection, which appears when the pointer is over it.',
      },
      { kind: 'heading', text: 'Display' },
      {
        kind: 'toggle',
        label: 'Full screen',
        keys: this.keysFor('Full screen'),
        get: () => isFullscreen(),
        set: () => void this.toggleFullscreen(),
        disabled: () => !fullscreenSupported(),
        hint: fullscreenSupported()
          ? 'Takes the whole document, not just the canvas, so the controls come with it. Leave with f or esc.'
          : 'This browser will not put a document into full screen. iOS Safari allows it for video elements only.',
      },
      {
        kind: 'button',
        label: 'Keyboard reference…',
        action: 'show-keys',
        onClick: () => this.help.open(),
        hint: 'Every shortcut, generated from the same table the dispatcher runs. Also on ? or F1.',
      },
      { kind: 'heading', text: 'Performance' },
      {
        kind: 'slider',
        label: 'Analysis frames per paint',
        min: 1,
        max: 64,
        step: 1,
        get: () => c.perf.maxFramesPerRender,
        set: (v) => {
          c.perf.maxFramesPerRender = Math.round(v)
        },
        format: fmt.int,
        hint: 'All frames that arrived since the last paint are batched into one dispatch chain. Beyond this limit the oldest are dropped rather than falling further behind.',
      },
      {
        kind: 'slider',
        label: 'Render scale',
        min: 0.25,
        max: 2,
        step: 0.05,
        get: () => c.perf.resolutionScale,
        set: (v) => {
          c.perf.resolutionScale = v
        },
        format: (v) => `${v.toFixed(2)}×`,
      },
      {
        kind: 'toggle',
        label: '4× multisampling',
        get: () => c.perf.msaa,
        set: (v) => {
          c.perf.msaa = v
        },
        hint: 'Sample count is baked into the render pipelines; this takes effect on reload.',
      },
      { kind: 'heading', text: 'Status' },
      {
        kind: 'readout',
        label: 'Display rate',
        get: () => `${this.live.fps.toFixed(1)} fps`,
        meter: () => this.live.fps / 120,
        warn: () => this.live.fps < 30,
      },
      {
        kind: 'readout',
        label: 'Analysis rate',
        get: () => `${this.live.analysisFps.toFixed(1)} frames/s`,
        // Against the rate the current hop *should* produce, so the bar reads full when the
        // pipeline is keeping up and short when it is falling behind — which is the only
        // question worth asking of this number.
        meter: () => {
          const want = (engine().sampleRate || 48000) / Math.max(c.analysis.hop, 1)
          return this.live.analysisFps / Math.max(want, 1)
        },
        warn: () => {
          const want = (engine().sampleRate || 48000) / Math.max(c.analysis.hop, 1)
          return this.live.analysisFps < want * 0.75
        },
      },
      { kind: 'readout', label: 'Frames dropped', get: () => String(this.live.dropped) },
      { kind: 'readout', label: 'Ring overruns', get: () => String(this.live.lapped) },
      {
        kind: 'readout',
        label: 'Capture rate',
        get: () => (engine().sampleRate ? `${engine().sampleRate} Hz` : '—'),
      },
      {
        kind: 'readout',
        label: 'Resampling',
        get: () =>
          engine().bitPerfectRate
            ? 'none — context matches device'
            : engine().message || 'active',
      },
      {
        kind: 'readout',
        label: 'Input latency',
        get: () => `${this.live.latencyMs.toFixed(2)} ms`,
        meter: () => this.live.latencyMs / 50,
        warn: () => this.live.latencyMs > 25,
      },
      {
        kind: 'readout',
        label: 'Shared memory',
        get: () =>
          engine().sharedMemory
            ? 'SharedArrayBuffer ring (lock-free)'
            : 'postMessage transfer fallback',
        hint: this.live.crossOriginIsolated
          ? undefined
          : 'This document is not cross-origin isolated, so SharedArrayBuffer is unavailable. Serve with COOP: same-origin and COEP: require-corp for the lock-free path.',
      },
      { kind: 'heading', text: 'Adapter' },
      { kind: 'readout', label: 'Vendor', get: () => info.vendor || 'unknown' },
      { kind: 'readout', label: 'Architecture', get: () => info.architecture || 'unknown' },
      {
        kind: 'readout',
        label: 'Optional features',
        get: () =>
          [
            info.subgroups ? 'subgroups' : null,
            info.shaderF16 ? 'f16' : null,
            info.timestampQuery ? 'timestamps' : null,
          ]
            .filter(Boolean)
            .join(', ') || 'none',
      },
      {
        kind: 'readout',
        label: 'Max storage binding',
        get: () => `${(info.maxStorageBufferBindingSize / (1024 * 1024)).toFixed(0)} MB`,
      },
      { kind: 'heading', text: 'Verification' },
      {
        kind: 'button',
        label: 'Run FFT self-test',
        action: 'self-test',
        onClick: () => {
          void this.deps.onSelfTest()
        },
        hint: 'Pushes a synthetic two-tone signal through the real GPU pipeline and compares the result against the f64 CPU reference in dsp/fft.ts.',
      },
      ...(this.selfTestResult
        ? [{ kind: 'readout' as const, label: 'Result', get: () => this.selfTestResult }]
        : []),
      { kind: 'heading', text: 'Profile' },
      {
        kind: 'button',
        label: 'Reset all settings',
        action: 'reset-config',
        onClick: () => {
          Object.assign(c, structuredClone(DEFAULT_CONFIG))
          this.syncChrome()
          this.rebuild()
        },
        hint: 'Returns every control to its default. Saved themes are stored separately and survive this.',
      },
    ]
  }
}
