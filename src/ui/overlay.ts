/**
 * The control overlay: a tabbed panel that floats over the canvas, plus the always-on readout
 * and the axis labels.
 *
 * The canvas is never resized or inset to make room for chrome — the waveform owns the whole
 * viewport and the panel sits on top of it, dismissable with a single key. Text lives in the
 * DOM rather than in the render pipeline so it stays crisp at any scale factor, is selectable,
 * and is reachable by assistive technology.
 */

import { DEFAULT_CONFIG, FFT_SIZES, SAMPLE_RATES, type Config, type Mode } from '../config.ts'
import { WINDOWS, windowSpec } from '../dsp/windows.ts'
import { PALETTES } from '../gpu/colormap.ts'
import type { AudioDeviceInfo, EngineStatus } from '../audio/engine.ts'
import type { GpuInfo } from '../gpu/device.ts'
import type { LoudnessReading } from '../dsp/loudness.ts'
import type { AxisTick } from './axes.ts'
import { PANE_SPECS, clampSplit, type Pane } from './layout.ts'
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

// Drawn rather than typed: ▶ and ❚❚ are rendered by a different font on every platform and
// sit on a different baseline in each of them.
const PLAY_ICON =
  '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M3.2 2.1 9.6 6 3.2 9.9z"/></svg>'
const RESET_ICON =
  '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M6 1.6a4.4 4.4 0 1 0 4.29 3.44l-1.27.28A3.1 3.1 0 1 1 6 2.9z"/><path d="M5.1 0.6 7.4 2.2 5.1 3.8z"/></svg>'
const STOP_ICON =
  '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><rect x="3" y="2.4" width="2.4" height="7.2" rx="0.5"/><rect x="6.6" y="2.4" width="2.4" height="7.2" rx="0.5"/></svg>'

const TABS = [
  'Source',
  'Analysis',
  'Waveform',
  'Spectrum',
  'Spectrogram',
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
    const chip = (text: string, tooltip: string, onClick: () => void) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'ws-close'
      button.textContent = text
      button.title = tooltip
      button.addEventListener('click', onClick)
      return button
    }
    const transport = (icon: string, label: string, onClick: () => void) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'ws-close ws-transport'
      button.innerHTML = icon
      button.title = label
      button.setAttribute('aria-label', label)
      button.addEventListener('click', onClick)
      return button
    }
    // Transport sits at the head of the group: it is the only control here that touches the
    // signal rather than the view.
    this.playButton = transport(PLAY_ICON, 'Start capture (r)', () => this.deps.onRestartSource())
    this.stopButton = transport(STOP_ICON, 'Stop capture (shift R)', () => this.deps.onStopSource())
    const resetButton = transport(RESET_ICON, 'Reset the pane layout to four equal quarters', () =>
      this.resetSplit(),
    )
    this.fullscreenButton = chip('⤢  f', 'Full screen (f)', () => void this.toggleFullscreen())

    const divider = document.createElement('span')
    divider.className = 'ws-header-divider'

    actions.append(
      this.playButton,
      this.stopButton,
      resetButton,
      divider,
      chip('⌨  ?', 'Keyboard reference (?)', () => this.toggleHelp()),
      this.fullscreenButton,
      chip('Hide  ·  esc', 'Hide the control panel (esc)', () => this.setVisible(false)),
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

  setVisible(visible: boolean): void {
    this.visible = visible
    this.panel.classList.toggle('ws-hidden', !visible)
    // Anything could have moved while the panel was away — a shortcut, a preset, a theme — so
    // it comes back showing the truth rather than whatever it was displaying when it left.
    if (visible) this.rebuild()
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
    this.fullscreenButton.textContent = on ? '⤡  f' : '⤢  f'
    this.fullscreenButton.title = on ? 'Leave full screen (f)' : 'Full screen (f)'
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

  /** Cheap per-frame update of live values without rebuilding DOM. */
  update(): void {
    const s = this.deps.status()
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
    if (this.deps.config.mode === 'wave' && s.pitchHz > 0) {
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
    if (next.x === split.x && next.y === split.y) return
    split.x = next.x
    split.y = next.y
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
  setPanes(panes: readonly Pane[], groups: readonly { pane: Pane; ticks: AxisTick[] }[]): void {
    const style = this.deps.config.style
    const width = panes.reduce((m, p) => Math.max(m, p.x + p.width), 1)
    const height = panes.reduce((m, p) => Math.max(m, p.y + p.height), 1)

    this.syncSplitHandle(panes, width, height)
    this.syncPaneLabels(panes)

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

  private syncSplitHandle(panes: readonly Pane[], width: number, height: number): void {
    const cutX = panes[0]?.width ?? width / 2
    const cutY = panes[0]?.height ?? height / 2
    this.splitHandle.style.left = `${cutX}px`
    this.splitHandle.style.top = `${cutY}px`
    this.splitLineY.style.left = `${cutX}px`
    this.splitLineX.style.top = `${cutY}px`
    // A divider with nothing on one side of it is just a border on the viewport edge.
    this.splitLineY.style.display = cutX > 0 && cutX < width ? '' : 'none'
    this.splitLineX.style.display = cutY > 0 && cutY < height ? '' : 'none'
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
      // The focused pane is the one the contextual keys drive; it is worth being able to see
      // which that is without opening the panel.
      node.classList.toggle('ws-pane-focus', pane.mode === this.deps.config.mode)
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
  private keysFor(label: string, mode?: Mode): string[] | undefined {
    const binding = BINDINGS.find(
      (b) => b.label === label && (!mode || !b.modes || b.modes.includes(mode)),
    )
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
        format: (v) => `${v} smp  ·  ${(status.engine.sampleRate / v || 0).toFixed(0)} fps`,
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
        keys: this.keysFor('Time span', 'wave'),
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
        keys: this.keysFor('Trigger', 'wave'),
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
        keys: this.keysFor('Cycles shown', 'wave'),
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
        keys: this.keysFor('Clarity threshold', 'wave'),
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
        keys: this.keysFor('Trigger level', 'wave'),
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
        keys: this.keysFor('Reconstruction', 'wave'),
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
        keys: this.keysFor('Vertical gain', 'wave'),
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
        keys: this.keysFor('RMS band', 'wave'),
        get: () => w.showRms,
        set: (v) => {
          w.showRms = v
        },
      },
      {
        kind: 'toggle',
        label: 'Split channels into lanes',
        keys: this.keysFor('Split channels into lanes', 'wave'),
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
        keys: this.keysFor('Logarithmic frequency axis', 'spectrum'),
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
        keys: this.keysFor('Curve source', 'spectrum'),
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
        keys: this.keysFor('Peak hold trace', 'spectrum'),
        get: () => s.showPeak,
        set: (v) => {
          s.showPeak = v
        },
      },
      {
        kind: 'slider',
        label: 'Fill opacity',
        keys: this.keysFor('Fill opacity', 'spectrum'),
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
        keys: this.keysFor('Split channels into lanes', 'spectrum'),
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
        keys: this.keysFor('History span', 'spectrogram'),
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
        keys: this.keysFor('Logarithmic frequency axis', 'spectrogram'),
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
        keys: this.keysFor('Splat radius', 'spectrogram'),
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
        keys: this.keysFor('Normalise by coverage', 'spectrogram'),
        get: () => s.normalise,
        set: (v) => {
          s.normalise = v
        },
        hint: 'Divides accumulated energy by accumulated kernel weight. Evens out density variation at the cost of absolute level accuracy.',
      },
      {
        kind: 'select',
        label: 'Palette',
        keys: this.keysFor('Colour map', 'spectrogram'),
        options: PALETTES.map((p) => ({ value: p.id, label: p.label })),
        get: () => s.palette,
        set: (v) => {
          s.palette = v
        },
        hint: 'All of these rise monotonically in lightness. A rainbow map would invent a bright band in the middle of a smooth ramp and you would read it as a peak.',
      },
    ]
  }

  private meterControls(c: Config): Control[] {
    const status = this.deps.status()
    const l = status.loudness
    const num = (v: number | undefined) =>
      v === undefined || !Number.isFinite(v) ? '−∞' : v.toFixed(2)
    return [
      { kind: 'heading', text: 'ITU-R BS.1770-4 / EBU R 128' },
      { kind: 'readout', label: 'Momentary (400 ms)', get: () => `${num(l?.momentary)} LUFS` },
      { kind: 'readout', label: 'Short term (3 s)', get: () => `${num(l?.shortTerm)} LUFS` },
      { kind: 'readout', label: 'Integrated (gated)', get: () => `${num(l?.integrated)} LUFS` },
      { kind: 'readout', label: 'Loudness range', get: () => `${(l?.range ?? 0).toFixed(2)} LU` },
      { kind: 'readout', label: 'True peak', get: () => `${num(l?.truePeakDb)} dBTP` },
      { kind: 'readout', label: 'Sample peak', get: () => `${num(l?.samplePeakDb)} dBFS` },
      { kind: 'readout', label: 'Correlation', get: () => (l?.correlation ?? 0).toFixed(3) },
      {
        kind: 'readout',
        label: 'Integration time',
        get: () => `${(l?.seconds ?? 0).toFixed(1)} s`,
      },
      {
        kind: 'readout',
        label: 'Delivery check',
        get: () => {
          if (!l || !Number.isFinite(l.integrated)) return 'measuring…'
          const dl = l.integrated - c.meters.targetLufs
          const tp = l.truePeakDb - c.meters.truePeakCeilingDb
          const loud = `${dl >= 0 ? '+' : ''}${dl.toFixed(1)} LU vs target`
          return tp > 0 ? `${loud}, true peak over by ${tp.toFixed(1)} dB` : loud
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
    const status = this.deps.status()
    const e = status.engine
    return [
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
      { kind: 'readout', label: 'Display rate', get: () => `${status.fps.toFixed(1)} fps` },
      {
        kind: 'readout',
        label: 'Analysis rate',
        get: () => `${status.analysisFps.toFixed(1)} frames/s`,
      },
      { kind: 'readout', label: 'Frames dropped', get: () => String(status.dropped) },
      { kind: 'readout', label: 'Ring overruns', get: () => String(status.lapped) },
      {
        kind: 'readout',
        label: 'Capture rate',
        get: () => (e.sampleRate ? `${e.sampleRate} Hz` : '—'),
      },
      {
        kind: 'readout',
        label: 'Resampling',
        get: () => (e.bitPerfectRate ? 'none — context matches device' : e.message || 'active'),
      },
      {
        kind: 'readout',
        label: 'Input latency',
        get: () => `${status.latencyMs.toFixed(2)} ms`,
      },
      {
        kind: 'readout',
        label: 'Shared memory',
        get: () =>
          e.sharedMemory
            ? 'SharedArrayBuffer ring (lock-free)'
            : 'postMessage transfer fallback',
        hint: status.crossOriginIsolated
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
