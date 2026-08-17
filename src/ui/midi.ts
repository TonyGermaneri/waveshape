/**
 * MIDI control.
 *
 * Any control in the panel can be driven by a knob, a fader or a key. The binding is made by
 * listening rather than by typing numbers: arm a control, move the thing you want to drive it
 * with, and whatever arrives is what gets bound.
 *
 * Two decisions shape everything else here.
 *
 * A binding names a *control*, not a widget. Widgets exist only for the tab that happens to be
 * open, and a fader assigned to a Life parameter has to keep working while the Source tab is
 * showing — so bindings are keyed by a stable id derived from where a control lives in the
 * panel, and the lookup goes through an index of every control in every tab rather than through
 * the DOM.
 *
 * And the mapping from a message to a value belongs to the *control*, not to the message. A
 * continuous controller sweeping 0..127 means one thing to a slider with a logarithmic curve,
 * another to a three-way select, and another again to a button. Rather than store a mode per
 * binding, each control kind is asked how to interpret what arrived, which is why binding is a
 * single click with nothing to configure afterwards.
 */

import type { Control } from './widgets.ts'

/** What a message is, stripped of its value. This is the half a binding remembers. */
export interface MidiSignal {
  kind: 'cc' | 'note'
  /** 0-15. Kept in the binding so two identical controllers on different channels stay apart. */
  channel: number
  /** Controller number for `cc`, note number for `note`. */
  number: number
}

export interface MidiMessage extends MidiSignal {
  /** 0..127. Controller value, or note velocity — zero for a note off. */
  value: number
}

export interface MidiPort {
  id: string
  name: string
}

/** Every input at once. The common case is one controller, and asking which is a chore. */
export const ALL_INPUTS = ''

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']

/** `60` reads as `C4`, the way a keyboard's own display would put it. */
export function noteName(note: number): string {
  return `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`
}

export function signalLabel(signal: MidiSignal): string {
  const body = signal.kind === 'cc' ? `CC ${signal.number}` : noteName(signal.number)
  // The channel is only worth the space when it is not the first one, which it usually is.
  return signal.channel === 0 ? body : `${body}·${signal.channel + 1}`
}

export function signalKey(signal: MidiSignal): string {
  return `${signal.kind}:${signal.channel}:${signal.number}`
}

export function sameSignal(a: MidiSignal, b: MidiSignal): boolean {
  return a.kind === b.kind && a.channel === b.channel && a.number === b.number
}

/**
 * Decodes one MIDI packet, or null for anything that is not a controller or a key.
 *
 * A note off arrives two ways — status 0x80, or 0x90 with velocity zero, which is what most
 * keyboards actually send — and both have to mean the same thing or a key would bind on press
 * and fire again on release.
 */
export function decode(data: Uint8Array): MidiMessage | null {
  if (data.length < 3) return null
  const status = data[0] & 0xf0
  const channel = data[0] & 0x0f
  if (status === 0xb0) return { kind: 'cc', channel, number: data[1], value: data[2] }
  if (status === 0x90) return { kind: 'note', channel, number: data[1], value: data[2] }
  if (status === 0x80) return { kind: 'note', channel, number: data[1], value: 0 }
  return null
}

// ---------------------------------------------------------------------------------------
// Turning a message into a value
// ---------------------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Position 0..1 to a value, mirroring the slider widget's own curve. */
function fromPosition(t: number, min: number, max: number, log: boolean): number {
  if (!log) return min + t * (max - min)
  const lo = Math.log(Math.max(min, 1e-6))
  const hi = Math.log(Math.max(max, min * 1.0001))
  return Math.exp(lo + t * (hi - lo))
}

/** True for the controls a binding can drive. Headings and prose cannot be turned by a knob. */
export function isBindable(control: Control): boolean {
  return (
    control.kind === 'slider' ||
    control.kind === 'toggle' ||
    control.kind === 'select' ||
    control.kind === 'button'
  )
}

/**
 * Applies a message to a control. Returns true when something changed, so the caller knows
 * whether the panel needs redrawing — a knob held still still sends, and repainting the whole
 * tab on every repeat of an unchanged value would be a waste at controller rates.
 *
 * `structural` mirrors the widget layer's meaning: a discrete choice can change *which* controls
 * exist, and those need the panel rebuilt rather than merely refreshed.
 */
export function applyMessage(
  control: Control,
  message: MidiMessage,
): { changed: boolean; structural: boolean } {
  const none = { changed: false, structural: false }
  // A control the panel has greyed out is greyed out for MIDI too: a fader should not be able to
  // set a parameter that the current state says has no meaning.
  if ('disabled' in control && control.disabled?.()) return none
  // A key press is a moment, not a level. Everything below reads a note's *arrival* as the
  // event and ignores the release, so a bound key does not fire twice per press.
  const pressed = message.kind === 'note' ? message.value > 0 : message.value >= 64
  const released = message.kind === 'note' && message.value === 0

  switch (control.kind) {
    case 'slider': {
      if (message.kind === 'note') {
        // A key has no position, so it plays its velocity into the range. Useless for a fader,
        // occasionally exactly what is wanted from a pad.
        if (!pressed) return none
      }
      const t = message.value / 127
      const raw = fromPosition(t, control.min, control.max, control.curve === 'log')
      const quantised = control.step > 0 ? Math.round(raw / control.step) * control.step : raw
      const next = clamp(quantised, control.min, control.max)
      if (next === control.get()) return none
      control.set(next)
      return { changed: true, structural: false }
    }
    case 'toggle': {
      // A controller sets the state from its position; a key flips it, because a key that only
      // ever set "on" would need a second key to undo it.
      if (message.kind === 'note') {
        if (!pressed) return none
        control.set(!control.get())
        return { changed: true, structural: true }
      }
      if (pressed === control.get()) return none
      control.set(pressed)
      return { changed: true, structural: true }
    }
    case 'select': {
      const options = control.options
      if (!options.length) return none
      let next: string
      if (message.kind === 'note') {
        if (!pressed) return none
        const at = options.findIndex((o) => o.value === control.get())
        next = options[(at + 1) % options.length].value
      } else {
        // The top of the range has to reach the last option, so the divisor is the option count
        // rather than 127 — otherwise only a value of exactly 127 selects the last one.
        const index = clamp(Math.floor((message.value / 128) * options.length), 0, options.length - 1)
        next = options[index].value
      }
      if (next === control.get()) return none
      control.set(next)
      return { changed: true, structural: true }
    }
    case 'button': {
      // Rising edge only: a controller parked above the midpoint would otherwise re-trigger on
      // every repeat it sends.
      if (released || !pressed) return none
      control.onClick()
      return { changed: true, structural: true }
    }
    default:
      return none
  }
}

// ---------------------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------------------

export interface MidiEvents {
  /** A decoded message from the selected input. */
  onMessage: (message: MidiMessage) => void
  /** Ports appeared or disappeared, or access state changed. */
  onPortsChanged: () => void
}

type Access = MIDIAccess

export class MidiInput {
  private access: Access | null = null
  private readonly events: MidiEvents
  private selected: string = ALL_INPUTS
  private bound = new Set<MIDIInput>()

  /** Set when the browser refused, so the panel can say why rather than showing nothing. */
  error = ''
  /** False until `enable()` has succeeded; requesting access prompts, so it is never automatic. */
  get available(): boolean {
    return this.access !== null
  }

  get supported(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function'
  }

  constructor(events: MidiEvents) {
    this.events = events
  }

  /**
   * Asks for access. This prompts, so it is only ever called from a click — a spectrum analyser
   * that asked for your MIDI devices on load would be a rude thing to open.
   */
  async enable(): Promise<boolean> {
    if (this.access) return true
    if (!this.supported) {
      this.error = 'This browser has no Web MIDI. Chrome and Edge do; Safari and Firefox do not.'
      return false
    }
    try {
      // No sysex. Nothing here needs it, and asking for it turns a mild permission into one
      // that can reprogram the hardware on the other end.
      this.access = await navigator.requestMIDIAccess({ sysex: false })
      this.error = ''
      this.access.onstatechange = () => {
        this.attach()
        this.events.onPortsChanged()
      }
      this.attach()
      this.events.onPortsChanged()
      return true
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'MIDI access was refused.'
      return false
    }
  }

  ports(): MidiPort[] {
    if (!this.access) return []
    return [...this.access.inputs.values()].map((input, i) => ({
      id: input.id,
      name: input.name || `Input ${i + 1}`,
    }))
  }

  select(id: string): void {
    this.selected = id
    this.attach()
  }

  get selectedId(): string {
    return this.selected
  }

  /**
   * Subscribes to the chosen inputs and drops the rest.
   *
   * Re-run whenever the selection changes or a device is plugged in. Handlers are set to null on
   * the way out rather than tracked per port, because a port that has gone away cannot be
   * unsubscribed from and holding a reference to it would leak the device.
   */
  private attach(): void {
    if (!this.access) return
    for (const port of this.bound) port.onmidimessage = null
    this.bound.clear()
    for (const input of this.access.inputs.values()) {
      if (this.selected !== ALL_INPUTS && input.id !== this.selected) continue
      input.onmidimessage = (event: MIDIMessageEvent) => {
        const decoded = event.data ? decode(event.data) : null
        if (decoded) this.events.onMessage(decoded)
      }
      this.bound.add(input)
    }
  }

  dispose(): void {
    for (const port of this.bound) port.onmidimessage = null
    this.bound.clear()
    if (this.access) this.access.onstatechange = null
    this.access = null
  }
}
