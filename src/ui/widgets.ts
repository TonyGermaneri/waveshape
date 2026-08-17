/**
 * A tiny declarative control layer. Each control is a plain object that knows how to read and
 * write one value; the renderer turns it into DOM and returns a refresh function.
 *
 * The point of the indirection is that the overlay never holds its own copy of a setting. It
 * reads from the config on every refresh, so a value changed by a keyboard shortcut, a preset,
 * or a restored profile shows up in the panel without any synchronisation code.
 */

export interface SelectOption {
  value: string
  label: string
}

export type Control =
  | {
      kind: 'select'
      label: string
      options: SelectOption[]
      get: () => string
      set: (v: string) => void
      hint?: string
      keys?: readonly string[]
      disabled?: () => boolean
    }
  | {
      kind: 'slider'
      label: string
      min: number
      max: number
      step: number
      get: () => number
      set: (v: number) => void
      format?: (v: number) => string
      /** Maps the slider's 0..1 position to a value, for logarithmic controls. */
      curve?: 'linear' | 'log'
      hint?: string
      keys?: readonly string[]
      disabled?: () => boolean
    }
  | {
      kind: 'toggle'
      label: string
      get: () => boolean
      set: (v: boolean) => void
      hint?: string
      keys?: readonly string[]
      disabled?: () => boolean
    }
  | { kind: 'color'; label: string; get: () => string; set: (v: string) => void; hint?: string }
  | {
      kind: 'button'
      label: string
      action: string
      onClick: () => void
      hint?: string
      /** Renders as the primary action of its row. */
      accent?: boolean
      disabled?: () => boolean
    }
  | {
      kind: 'text'
      label: string
      get: () => string
      set: (v: string) => void
      placeholder?: string
      hint?: string
      /** Called on Enter, so a name can be typed and committed without reaching for the mouse. */
      onSubmit?: () => void
    }
  | {
      kind: 'textarea'
      label: string
      get: () => string
      set: (v: string) => void
      rows?: number
      placeholder?: string
      hint?: string
    }
  | {
      kind: 'swatches'
      label: string
      options: SwatchOption[]
      get: () => string
      set: (v: string) => void
      hint?: string
    }
  | {
      kind: 'readout'
      label: string
      get: () => string
      hint?: string
      /**
       * Draws a small bar beside the value. Returns 0..1; anything outside is clamped, because
       * a meter that runs off its own scale is worse than one that pins.
       */
      meter?: () => number
      /** Where the fill starts, 0..1. 0.5 makes a bipolar meter, for things like correlation. */
      origin?: number
      /** Colours the bar as out of spec — over a ceiling, past a target. */
      warn?: () => boolean
    }
  | { kind: 'note'; text: string; tone?: 'plain' | 'warn' }
  | { kind: 'heading'; text: string }
  | { kind: 'row'; children: Control[] }

export interface SwatchOption {
  value: string
  label: string
  /** Background then up to three trace colours, drawn as a miniature of the theme. */
  colors: readonly string[]
  /** Shown as a small superscript tag, e.g. "saved". */
  tag?: string
}

export interface ControlHandle {
  element: HTMLElement
  refresh: () => void
}

/**
 * The panel's view of MIDI binding, which is all this module is allowed to know about it.
 *
 * Widgets render a listen button and report clicks; what a binding *is*, how it is matched and
 * what a controller does to a value all live in `midi.ts`. Keeping the seam here means the
 * control layer has no opinion about MIDI and `midi.ts` has no opinion about the DOM.
 */
export interface MidiUi {
  /**
   * A stable id for this control, or null if it cannot be bound. `section` is the heading it
   * sits under, which is what keeps two controls that happen to share a label apart.
   */
  bindingId: (control: Control, section: string) => string | null
  /** What is bound, e.g. "CC 74", or null for nothing yet. */
  caption: (id: string) => string | null
  /** True while this control is waiting to hear something. */
  armed: (id: string) => boolean
  /** Click: start listening, or stop if already. */
  toggle: (id: string) => void
  /** Shift-click: forget the binding. */
  clear: (id: string) => void
}

/**
 * Called when a control's value changes. `structural` is true for the discrete controls whose
 * value can change *which* controls exist — picking a different source, toggling a feature
 * that reveals its own settings. Those need the panel rebuilt. Sliders and colour pickers pass
 * false, because rebuilding the DOM underneath a drag would drop the pointer capture and the
 * knob would stop following the cursor mid-gesture.
 */
export type ChangeHandler = (structural: boolean) => void

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function withHint(row: HTMLElement, hint?: string): HTMLElement {
  if (!hint) return row
  const wrap = el('div', 'ws-field')
  wrap.append(row, el('p', 'ws-hint', hint))
  return wrap
}

/**
 * The control's own name, with the keys that drive it printed beside it. The captions arrive
 * pre-formatted from the caller: `keymap` reads `fmt` from this module, so this module must not
 * read anything back out of `keymap`.
 */
function labelWith(text: string, keys?: readonly string[]): HTMLElement {
  const span = el('span', 'ws-label', text)
  if (!keys?.length) return span
  const caps = el('span', 'ws-label-keys')
  for (const cap of keys) {
    const kbd = el('kbd')
    kbd.textContent = cap
    caps.append(kbd)
  }
  span.append(caps)
  return span
}

/**
 * A label with the listen button pushed to the far end of its line, for the rows that have no
 * value readout of their own to hang it beside.
 */
function headWith(label: HTMLElement, bind: { element: HTMLElement } | null): HTMLElement {
  if (!bind) return label
  const head = el('span', 'ws-control-head')
  head.append(label, bind.element)
  return head
}

/**
 * The listen button: click to bind this control to the next thing that moves.
 *
 * Returns null when there is no MIDI layer or the control cannot take a binding, so callers can
 * append the result unconditionally and rows without one keep their old shape exactly.
 */
function midiButton(
  control: Control,
  section: string,
  midi: MidiUi | undefined,
): { element: HTMLElement; refresh: () => void } | null {
  if (!midi) return null
  const id = midi.bindingId(control, section)
  if (!id) return null
  const button = el('button', 'ws-midi')
  button.type = 'button'
  // A knob seen from the front: a socket with a pointer. Legible at ten pixels, which a five-pin
  // DIN is not, and it says "something you can turn" rather than naming a protocol.
  button.innerHTML =
    '<svg class="ws-midi-icon" viewBox="0 0 12 12" aria-hidden="true" focusable="false">' +
    '<circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
    '<path d="M6 6 V2.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' +
    '</svg>'
  const caption = el('span', 'ws-midi-caption')
  button.append(caption)
  button.addEventListener('click', (event) => {
    event.preventDefault()
    // The click has to stop here. Most of these rows are a <label>, and a click anywhere inside
    // one is forwarded to its input — arming a slider would jump the slider to wherever the
    // button happens to sit.
    event.stopPropagation()
    if (event.shiftKey) midi.clear(id)
    else midi.toggle(id)
  })
  const refresh = () => {
    const armed = midi.armed(id)
    const bound = midi.caption(id)
    button.classList.toggle('ws-midi-armed', armed)
    button.classList.toggle('ws-midi-bound', !armed && bound !== null)
    caption.textContent = armed ? 'listening' : (bound ?? '')
    const label = armed
      ? 'Move a knob, fader or key to bind it. Click again to stop listening.'
      : bound
        ? `Bound to ${bound}. Click to rebind, shift-click to clear.`
        : 'Click, then move a knob, fader or key to bind it.'
    button.title = label
    // The icon alone says nothing to a screen reader, and the caption is a bare "CC 74".
    button.setAttribute('aria-label', `MIDI binding. ${label}`)
  }
  return { element: button, refresh }
}

const toSlider = (v: number, min: number, max: number, log: boolean): number => {
  if (!log) return (v - min) / (max - min)
  const lo = Math.log(Math.max(min, 1e-6))
  const hi = Math.log(Math.max(max, min * 1.0001))
  return (Math.log(Math.max(v, 1e-6)) - lo) / (hi - lo)
}

const fromSlider = (t: number, min: number, max: number, log: boolean): number => {
  if (!log) return min + t * (max - min)
  const lo = Math.log(Math.max(min, 1e-6))
  const hi = Math.log(Math.max(max, min * 1.0001))
  return Math.exp(lo + t * (hi - lo))
}

export function buildControl(
  control: Control,
  onChange: ChangeHandler,
  midi?: MidiUi,
  section = '',
): ControlHandle {
  const bind = midiButton(control, section, midi)
  switch (control.kind) {
    case 'heading': {
      const node = el('h3', 'ws-heading', control.text)
      return { element: node, refresh: () => {} }
    }
    case 'note': {
      const node = el('p', control.tone === 'warn' ? 'ws-note ws-note-warn' : 'ws-note', control.text)
      return { element: node, refresh: () => {} }
    }
    case 'row': {
      const node = el('div', 'ws-row')
      const handles = control.children.map((c) => buildControl(c, onChange, midi, section))
      for (const h of handles) node.append(h.element)
      return { element: node, refresh: () => handles.forEach((h) => h.refresh()) }
    }
    case 'select': {
      const row = el('label', 'ws-control')
      row.append(headWith(labelWith(control.label, control.keys), bind))
      const select = el('select', 'ws-select')
      for (const option of control.options) {
        const opt = el('option')
        opt.value = option.value
        opt.textContent = option.label
        select.append(opt)
      }
      select.addEventListener('change', () => {
        control.set(select.value)
        onChange(true)
      })
      row.append(select)
      return {
        element: withHint(row, control.hint),
        refresh: () => {
          select.value = control.get()
          select.disabled = control.disabled?.() ?? false
          bind?.refresh()
        },
      }
    }
    case 'slider': {
      const row = el('label', 'ws-control')
      const labelEl = labelWith(control.label, control.keys)
      const valueEl = el('span', 'ws-value')
      const head = el('span', 'ws-control-head')
      head.append(labelEl, valueEl)
      if (bind) head.append(bind.element)
      const input = el('input', 'ws-slider')
      input.type = 'range'
      const log = control.curve === 'log'
      if (log) {
        input.min = '0'
        input.max = '1000'
        input.step = '1'
      } else {
        input.min = String(control.min)
        input.max = String(control.max)
        input.step = String(control.step)
      }
      const quantise = (v: number) =>
        control.step > 0 ? Math.round(v / control.step) * control.step : v
      input.addEventListener('input', () => {
        const raw = log
          ? fromSlider(Number(input.value) / 1000, control.min, control.max, true)
          : Number(input.value)
        control.set(Math.min(control.max, Math.max(control.min, quantise(raw))))
        onChange(false)
      })
      row.append(head, input)
      const format = control.format ?? ((v: number) => String(Math.round(v * 1000) / 1000))
      return {
        element: withHint(row, control.hint),
        refresh: () => {
          const v = control.get()
          input.value = log
            ? String(Math.round(toSlider(v, control.min, control.max, true) * 1000))
            : String(v)
          valueEl.textContent = format(v)
          input.disabled = control.disabled?.() ?? false
          bind?.refresh()
        },
      }
    }
    case 'toggle': {
      const row = el('label', 'ws-control ws-control-inline')
      const input = el('input', 'ws-check')
      input.type = 'checkbox'
      input.addEventListener('change', () => {
        control.set(input.checked)
        onChange(true)
      })
      row.append(input, labelWith(control.label, control.keys))
      if (bind) row.append(bind.element)
      return {
        element: withHint(row, control.hint),
        refresh: () => {
          input.checked = control.get()
          input.disabled = control.disabled?.() ?? false
          bind?.refresh()
        },
      }
    }
    case 'color': {
      const row = el('label', 'ws-control ws-control-inline')
      const input = el('input', 'ws-color')
      input.type = 'color'
      input.addEventListener('input', () => {
        control.set(input.value)
        onChange(false)
      })
      row.append(input, el('span', 'ws-label', control.label))
      return {
        element: withHint(row, control.hint),
        refresh: () => {
          input.value = control.get()
        },
      }
    }
    case 'button': {
      const button = el('button', control.accent ? 'ws-button ws-button-accent' : 'ws-button', control.label)
      button.type = 'button'
      button.dataset.action = control.action
      button.addEventListener('click', () => {
        control.onClick()
        onChange(true)
      })
      if (!bind) {
        return {
          element: withHint(button, control.hint),
          refresh: () => {
            button.disabled = control.disabled?.() ?? false
          },
        }
      }
      const pair = el('span', 'ws-control-inline')
      pair.append(button, bind.element)
      return {
        element: withHint(pair, control.hint),
        refresh: () => {
          button.disabled = control.disabled?.() ?? false
          bind.refresh()
        },
      }
    }
    case 'text': {
      const row = el('label', 'ws-control')
      row.append(el('span', 'ws-label', control.label))
      const input = el('input', 'ws-input')
      input.type = 'text'
      if (control.placeholder) input.placeholder = control.placeholder
      input.addEventListener('input', () => {
        control.set(input.value)
        onChange(false)
      })
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        control.onSubmit?.()
        onChange(true)
      })
      row.append(input)
      return {
        element: withHint(row, control.hint),
        refresh: () => {
          // Never write over a field being typed into: the caret would jump to the end.
          if (document.activeElement !== input) input.value = control.get()
        },
      }
    }
    case 'textarea': {
      const row = el('label', 'ws-control')
      row.append(el('span', 'ws-label', control.label))
      const input = el('textarea', 'ws-input ws-textarea')
      input.rows = control.rows ?? 5
      input.spellcheck = false
      if (control.placeholder) input.placeholder = control.placeholder
      input.addEventListener('input', () => {
        control.set(input.value)
        onChange(false)
      })
      row.append(input)
      return {
        element: withHint(row, control.hint),
        refresh: () => {
          if (document.activeElement !== input) input.value = control.get()
        },
      }
    }
    case 'swatches': {
      const wrap = el('div', 'ws-control')
      wrap.append(el('span', 'ws-label', control.label))
      const grid = el('div', 'ws-swatches')
      const buttons: { node: HTMLButtonElement; value: string }[] = []
      for (const option of control.options) {
        const button = el('button', 'ws-swatch')
        button.type = 'button'
        button.dataset.value = option.value
        button.title = option.label

        const chip = el('span', 'ws-swatch-chip')
        const [background, ...traces] = option.colors
        chip.style.background = background ?? '#000'
        for (const colour of traces.slice(0, 3)) {
          const bar = el('span', 'ws-swatch-bar')
          bar.style.background = colour
          chip.append(bar)
        }

        const name = el('span', 'ws-swatch-name', option.label)
        button.append(chip, name)
        if (option.tag) button.append(el('span', 'ws-swatch-tag', option.tag))
        button.addEventListener('click', () => {
          control.set(option.value)
          onChange(true)
        })
        grid.append(button)
        buttons.push({ node: button, value: option.value })
      }
      wrap.append(grid)
      return {
        element: withHint(wrap, control.hint),
        refresh: () => {
          const current = control.get()
          for (const b of buttons) {
            const active = b.value === current
            b.node.classList.toggle('ws-active', active)
            b.node.setAttribute('aria-pressed', String(active))
          }
        },
      }
    }
    case 'readout': {
      const row = el('div', 'ws-control ws-control-inline')
      const value = el('span', 'ws-value ws-value-wide')
      row.append(el('span', 'ws-label', control.label))

      let fill: HTMLElement | null = null
      if (control.meter) {
        row.classList.add('ws-has-vu')
        const bar = el('span', 'ws-vu')
        fill = el('span', 'ws-vu-fill')
        bar.append(fill)
        row.append(bar)
      }
      row.append(value)

      const origin = control.origin ?? 0
      return {
        element: withHint(row, control.hint),
        refresh: () => {
          value.textContent = control.get()
          if (!fill || !control.meter) return
          const v = Math.min(1, Math.max(0, control.meter()))
          // Drawn from the origin to the value rather than always from the left, so a bipolar
          // meter grows out of its centre in whichever direction the number went.
          const lo = Math.min(v, origin)
          const hi = Math.max(v, origin)
          fill.style.left = `${lo * 100}%`
          fill.style.width = `${(hi - lo) * 100}%`
          fill.classList.toggle('ws-vu-warn', control.warn?.() ?? false)
        },
      }
    }
  }
}

export function renderControls(
  container: HTMLElement,
  controls: Control[],
  onChange: ChangeHandler,
  midi?: MidiUi,
): () => void {
  container.replaceChildren()
  // Headings are what a control's section is: the list is flat, so a control belongs to the last
  // heading above it. That is also how a binding id stays unique when two sections of the same
  // tab both have an "Opacity".
  let section = ''
  const handles = controls.map((c) => {
    if (c.kind === 'heading') section = c.text
    return buildControl(c, onChange, midi, section)
  })
  for (const h of handles) container.append(h.element)
  const refresh = () => handles.forEach((h) => h.refresh())
  refresh()
  return refresh
}

export const fmt = {
  hz: (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${v.toFixed(v < 100 ? 1 : 0)} Hz`),
  db: (v: number) => `${v.toFixed(1)} dB`,
  ms: (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : v >= 1 ? `${v.toFixed(2)} ms` : `${(v * 1000).toFixed(0)} µs`),
  pct: (v: number) => `${Math.round(v * 100)}%`,
  int: (v: number) => String(Math.round(v)),
  fixed: (digits: number) => (v: number) => v.toFixed(digits),
}
