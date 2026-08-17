/**
 * The register of what drives what, and the thing that turns an arriving message into a moved
 * control.
 *
 * The awkward part of MIDI in a tabbed panel is that a binding has to outlive its widget. Only
 * the open tab has DOM, but a fader assigned to a Life parameter must keep working while the
 * Source tab is showing, and after a reload when no tab has been opened at all. So this keeps an
 * index of every control in every tab, built from the same descriptors the panel renders, and
 * resolves an incoming message straight to the descriptor's setter without going near an
 * element.
 *
 * The index is rebuilt whenever the panel is, which is exactly when the set of controls can have
 * changed. Descriptors close over the live config object rather than copying out of it, and the
 * config is mutated in place and never replaced, so a cached descriptor's setter stays correct
 * even after the tab it came from has been torn down.
 */

import type { Config } from '../config.ts'
import type { Control, MidiUi } from './widgets.ts'
import {
  applyMessage,
  isBindable,
  sameSignal,
  signalKey,
  signalLabel,
  type MidiMessage,
  type MidiSignal,
} from './midi.ts'

/** A control's address in the panel, which is what a binding remembers. */
export function bindingIdFor(tab: string, section: string, control: Control): string | null {
  if (!isBindable(control)) return null
  const label = 'label' in control ? control.label : ''
  if (!label) return null
  return `${tab}/${section}/${label}`
}

/** "Life / Behaviour / Roaming" — for listing bindings somewhere a person has to read them. */
export function describeId(id: string): string {
  return id
    .split('/')
    .filter(Boolean)
    .join(' · ')
}

export interface BindingsDeps {
  config: Config
  /** Every control in every tab, in the order they appear, tagged with tab and section. */
  index: () => { tab: string; section: string; control: Control }[]
  /** Something changed by MIDI; redraw. `structural` means rebuild rather than refresh. */
  onApplied: (structural: boolean) => void
  /** A binding was made, cleared, or arming changed; the panel's captions need redrawing. */
  onBindingsChanged: () => void
  /** Human-readable confirmation, shown as a toast. */
  onNotice: (text: string) => void
}

export class MidiBindings {
  private readonly deps: BindingsDeps
  private controls = new Map<string, Control>()
  /** Signal key to control id, rebuilt from the config whenever bindings change. */
  private routes = new Map<string, string>()
  private arming: string | null = null

  constructor(deps: BindingsDeps) {
    this.deps = deps
    // Deliberately not indexed here. Indexing walks every tab's controls, and those descriptors
    // close over the panel that is still being constructed — building them from inside this
    // constructor reaches parts of the overlay that do not exist yet. The first `reindex` comes
    // from the panel's own build, and `handle` covers itself in case a message beats it.
    //
    // The routes are safe to build now, and have to be: they come from the stored config alone,
    // and without them `handle` would find no route for a saved binding and return before it
    // ever got as far as noticing the index was empty.
    this.rebuildRoutes()
  }

  /** Ids claimed by more than one control. Empty unless the panel has grown a name collision. */
  readonly collisions: string[] = []

  /** Re-reads every tab's controls. Cheap: these are plain objects, not DOM. */
  reindex(): void {
    this.controls = new Map()
    this.collisions.length = 0
    for (const entry of this.deps.index()) {
      const id = bindingIdFor(entry.tab, entry.section, entry.control)
      if (!id) continue
      // First wins, and the clash is recorded rather than swallowed.
      //
      // An id is a tab, a section and a label, so a duplicate means two controls in one section
      // of one tab share a name — which makes them indistinguishable to a binding, and one of
      // them permanently undrivable. That is a panel bug, and a silent one: everything looks
      // fine until somebody binds a knob and the wrong thing moves. The MIDI tab reports it.
      if (this.controls.has(id)) {
        if (!this.collisions.includes(id)) this.collisions.push(id)
        continue
      }
      this.controls.set(id, entry.control)
    }
    this.rebuildRoutes()
  }

  private rebuildRoutes(): void {
    this.routes = new Map()
    for (const binding of this.deps.config.midi.bindings) {
      this.routes.set(signalKey(binding), binding.id)
    }
  }

  /** Ids that are bound but match no control — a stale profile, or a renamed control. */
  orphans(): string[] {
    return this.deps.config.midi.bindings
      .map((b) => b.id)
      .filter((id) => !this.controls.has(id))
  }

  list(): { id: string; signal: MidiSignal }[] {
    return this.deps.config.midi.bindings.map((b) => ({
      id: b.id,
      signal: { kind: b.kind, channel: b.channel, number: b.number },
    }))
  }

  bindingFor(id: string): MidiSignal | null {
    const found = this.deps.config.midi.bindings.find((b) => b.id === id)
    return found ? { kind: found.kind, channel: found.channel, number: found.number } : null
  }

  isArmed(id: string): boolean {
    return this.arming === id
  }

  get listening(): string | null {
    return this.arming
  }

  arm(id: string | null): void {
    this.arming = id
    this.deps.onBindingsChanged()
  }

  toggleArm(id: string): void {
    this.arm(this.arming === id ? null : id)
  }

  clear(id: string): void {
    const bindings = this.deps.config.midi.bindings
    const at = bindings.findIndex((b) => b.id === id)
    if (at < 0) return
    bindings.splice(at, 1)
    this.rebuildRoutes()
    this.deps.onBindingsChanged()
  }

  clearAll(): void {
    this.deps.config.midi.bindings.length = 0
    this.rebuildRoutes()
    this.deps.onBindingsChanged()
  }

  private bind(id: string, signal: MidiSignal): void {
    const bindings = this.deps.config.midi.bindings
    // One signal drives one control. Rebinding a knob that is already spoken for takes it from
    // whatever had it, which is what someone reaching for a knob they have used before means —
    // the alternative is a silent double-assignment where one fader moves two things.
    const stolen = bindings.find((b) => sameSignal(b, signal) && b.id !== id)
    for (let i = bindings.length - 1; i >= 0; i--) {
      if (bindings[i].id === id || sameSignal(bindings[i], signal)) bindings.splice(i, 1)
    }
    bindings.push({ id, kind: signal.kind, channel: signal.channel, number: signal.number })
    this.rebuildRoutes()
    this.arming = null
    this.deps.onBindingsChanged()
    this.deps.onNotice(
      stolen
        ? `${signalLabel(signal)} → ${describeId(id)}, taken from ${describeId(stolen.id)}`
        : `${signalLabel(signal)} → ${describeId(id)}`,
    )
  }

  /** Called for every message from the selected inputs. */
  handle(message: MidiMessage): void {
    if (this.arming) {
      // A note off would bind the key that was just released, so a release is ignored while
      // arming — otherwise pressing a key binds it and then immediately looks like a second
      // event on the way back up.
      if (message.kind === 'note' && message.value === 0) return
      this.bind(this.arming, message)
      return
    }
    const id = this.routes.get(signalKey(message))
    if (!id) return
    if (!this.controls.size) this.reindex()
    const control = this.controls.get(id)
    if (!control) return
    const result = applyMessage(control, message)
    if (result.changed) this.deps.onApplied(result.structural)
  }

  /** The face this presents to the widget layer. */
  ui(tabOf: () => string): MidiUi {
    return {
      bindingId: (control, section) => bindingIdFor(tabOf(), section, control),
      caption: (id) => {
        const signal = this.bindingFor(id)
        return signal ? signalLabel(signal) : null
      },
      armed: (id) => this.isArmed(id),
      toggle: (id) => this.toggleArm(id),
      clear: (id) => this.clear(id),
    }
  }
}
