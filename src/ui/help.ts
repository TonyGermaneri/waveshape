/**
 * The keyboard reference.
 *
 * Generated from the same table the dispatcher runs, so a binding cannot exist without being
 * documented and cannot be documented without existing. Every key means one thing everywhere,
 * so there is nothing here to qualify — a binding is dimmed only when the state it needs is not
 * the current one.
 *
 * A native `<dialog>` carries the modal semantics, the focus trap, the backdrop and Escape
 * handling; none of that is worth reimplementing.
 */

import type { Config } from '../config.ts'
import { BINDINGS, KEY_GROUPS, bindingsFor, keyLabel, type Binding } from './keymap.ts'

export class KeyHelp {
  private readonly dialog: HTMLDialogElement
  private readonly list: HTMLElement
  private readonly filterInput: HTMLInputElement
  private readonly config: Config
  private filter = ''

  constructor(config: Config) {
    this.config = config

    this.dialog = document.createElement('dialog')
    this.dialog.className = 'ws-dialog'
    this.dialog.setAttribute('aria-label', 'Keyboard reference')

    const header = document.createElement('header')
    header.className = 'ws-dialog-head'
    const title = document.createElement('div')
    title.className = 'ws-title'
    title.innerHTML =
      '<strong>Keyboard</strong><span>arrows shape the picture, letters drive the machine</span>'

    this.filterInput = document.createElement('input')
    this.filterInput.type = 'search'
    this.filterInput.className = 'ws-input ws-dialog-filter'
    this.filterInput.placeholder = 'Filter…'
    this.filterInput.setAttribute('aria-label', 'Filter shortcuts')
    this.filterInput.addEventListener('input', () => {
      this.filter = this.filterInput.value.trim().toLowerCase()
      this.render()
    })

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'ws-close'
    close.textContent = 'Close  ·  esc'
    close.addEventListener('click', () => this.close())

    header.append(title, this.filterInput, close)

    this.list = document.createElement('div')
    this.list.className = 'ws-dialog-body'

    const footer = document.createElement('p')
    footer.className = 'ws-dialog-foot'
    footer.textContent =
      'Shortcuts are ignored while a control has focus, so a slider still takes the arrow keys. Press ? at any time to come back here.'

    this.dialog.append(header, this.list, footer)
    document.body.append(this.dialog)

    // Clicking the backdrop lands on the dialog element itself; clicking the card does not.
    this.dialog.addEventListener('click', (event) => {
      if (event.target === this.dialog) this.close()
    })
    this.dialog.addEventListener('keydown', (event) => {
      // Escape is the dialog's own default action. `?` toggles back out, unless it is being
      // typed into the filter box.
      const typing = event.target === this.filterInput
      if (event.key === 'F1' || (event.key === '?' && !typing)) {
        event.preventDefault()
        this.close()
      }
    })
  }

  get isOpen(): boolean {
    return this.dialog.open
  }

  open(): void {
    this.render()
    if (!this.dialog.open) this.dialog.showModal()
    // showModal focuses the first focusable descendant, which is the filter box — the right
    // place to land, since the reference is long enough to be worth searching.
    this.filterInput.select()
  }

  close(): void {
    if (this.dialog.open) this.dialog.close()
  }

  toggle(): void {
    if (this.dialog.open) this.close()
    else this.open()
  }

  private matches(binding: Binding): boolean {
    if (!this.filter) return true
    const haystack = [
      binding.label,
      binding.detail ?? '',
      binding.group,
      binding.keys.map((k) => `${k.token} ${keyLabel(k.token)}`).join(' '),
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(this.filter)
  }

  private active(binding: Binding): boolean {
    return bindingsFor(this.config).includes(binding)
  }

  private render(): void {
    this.list.replaceChildren()
    let shown = 0

    for (const group of KEY_GROUPS) {
      const bindings = BINDINGS.filter((b) => b.group === group && this.matches(b))
      if (bindings.length === 0) continue

      const section = document.createElement('section')
      section.className = 'ws-keygroup'
      const heading = document.createElement('h3')
      heading.className = 'ws-heading'
      heading.textContent = group
      section.append(heading)

      for (const binding of bindings) {
        section.append(this.row(binding))
        shown++
      }
      this.list.append(section)
    }

    if (shown === 0) {
      const empty = document.createElement('p')
      empty.className = 'ws-note'
      empty.textContent = `Nothing matches “${this.filterInput.value}”.`
      this.list.append(empty)
    }
  }

  private row(binding: Binding): HTMLElement {
    const row = document.createElement('div')
    row.className = 'ws-keyrow'
    if (!this.active(binding)) row.classList.add('ws-keyrow-dim')

    const keys = document.createElement('div')
    keys.className = 'ws-keys'
    for (const stroke of binding.keys) {
      if (stroke.alias) continue
      const cap = document.createElement('kbd')
      cap.textContent = keyLabel(stroke.token)
      keys.append(cap)
    }

    const text = document.createElement('div')
    text.className = 'ws-keytext'
    const label = document.createElement('span')
    label.className = 'ws-keylabel'
    label.textContent = binding.label
    text.append(label)

    if (binding.detail) {
      const detail = document.createElement('p')
      detail.className = 'ws-hint'
      detail.textContent = binding.detail
      text.append(detail)
    }

    row.append(keys, text)
    return row
  }
}
