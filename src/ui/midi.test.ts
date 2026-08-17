import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applyMessage, decode, isBindable, noteName, signalKey, signalLabel } from './midi.ts'
import { bindingIdFor } from './midi-bindings.ts'
import type { Control } from './widgets.ts'

const cc = (number: number, value: number, channel = 0) =>
  ({ kind: 'cc', channel, number, value }) as const
const note = (number: number, value: number, channel = 0) =>
  ({ kind: 'note', channel, number, value }) as const

function slider(over: Partial<Extract<Control, { kind: 'slider' }>> = {}) {
  let v = 0
  const control: Control = {
    kind: 'slider',
    label: 'Test',
    min: 0,
    max: 100,
    step: 1,
    get: () => v,
    set: (x) => {
      v = x
    },
    ...over,
  }
  return { control, read: () => v }
}

test('a status byte is decoded into a signal, and both spellings of note off agree', () => {
  assert.deepEqual(decode(new Uint8Array([0xb3, 74, 100])), {
    kind: 'cc',
    channel: 3,
    number: 74,
    value: 100,
  })
  // 0x90 with velocity zero is what most keyboards send for a release; 0x80 is the other
  // spelling. If these disagreed, a bound key would fire again when it came back up.
  assert.deepEqual(decode(new Uint8Array([0x90, 60, 0])), decode(new Uint8Array([0x80, 60, 0])))
  assert.equal(decode(new Uint8Array([0xf8])), null, 'clock is not a control')
  assert.equal(decode(new Uint8Array([0xe0, 0, 64])), null, 'pitch bend is not bindable here')
})

test('a signal reads back as something a person can look for on their hardware', () => {
  assert.equal(noteName(60), 'C4')
  assert.equal(noteName(21), 'A0')
  assert.equal(signalLabel({ kind: 'cc', channel: 0, number: 74 }), 'CC 74')
  // The channel earns its space only when it is not the first one.
  assert.equal(signalLabel({ kind: 'cc', channel: 0, number: 1 }), 'CC 1')
  assert.equal(signalLabel({ kind: 'cc', channel: 9, number: 1 }), 'CC 1·10')
  assert.notEqual(
    signalKey({ kind: 'cc', channel: 0, number: 1 }),
    signalKey({ kind: 'note', channel: 0, number: 1 }),
    'a controller and a key of the same number are different signals',
  )
})

test('a controller sweeps a slider across its whole range', () => {
  const { control, read } = slider()
  applyMessage(control, cc(1, 0))
  assert.equal(read(), 0)
  applyMessage(control, cc(1, 127))
  assert.equal(read(), 100, 'the top of the range has to be reachable')
  applyMessage(control, cc(1, 64))
  assert.ok(Math.abs(read() - 50) <= 1)
})

test('a slider honours its own step and curve rather than the wire format', () => {
  const stepped = slider({ min: 0, max: 10, step: 5 })
  applyMessage(stepped.control, cc(1, 70))
  assert.equal(stepped.read() % 5, 0, 'quantised to the step the widget uses')

  const log = slider({ min: 20, max: 20000, step: 0, curve: 'log' })
  applyMessage(log.control, cc(1, 64))
  const mid = log.read()
  // Halfway up a logarithmic control is the geometric mean, not the arithmetic one. If this
  // used a linear map, a mid-travel fader would sit at 10 kHz instead of near 630 Hz.
  assert.ok(mid > 300 && mid < 1200, `midpoint was ${mid}`)
})

test('a value that has not moved reports no change, so a held knob does not repaint', () => {
  const { control } = slider()
  assert.equal(applyMessage(control, cc(1, 100)).changed, true)
  assert.equal(applyMessage(control, cc(1, 100)).changed, false)
})

test('a disabled control ignores MIDI, as it ignores the mouse', () => {
  const { control, read } = slider({ disabled: () => true })
  applyMessage(control, cc(1, 127))
  assert.equal(read(), 0)
})

test('a controller sets a toggle from its position; a key flips it', () => {
  let on = false
  const control: Control = {
    kind: 'toggle',
    label: 'T',
    get: () => on,
    set: (v) => {
      on = v
    },
  }
  applyMessage(control, cc(1, 127))
  assert.equal(on, true)
  applyMessage(control, cc(1, 0))
  assert.equal(on, false)

  // A key that only ever set "on" would need a second key to undo it.
  applyMessage(control, note(60, 100))
  assert.equal(on, true)
  applyMessage(control, note(60, 0))
  assert.equal(on, true, 'the release is not a second press')
  applyMessage(control, note(60, 100))
  assert.equal(on, false)
})

test('a controller reaches every option of a select, including the last', () => {
  let value = 'a'
  const control: Control = {
    kind: 'select',
    label: 'S',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
      { value: 'c', label: 'C' },
    ],
    get: () => value,
    set: (v) => {
      value = v
    },
  }
  const seen = new Set<string>()
  for (let v = 0; v <= 127; v++) {
    applyMessage(control, cc(1, v))
    seen.add(value)
  }
  assert.deepEqual([...seen].sort(), ['a', 'b', 'c'], 'every option is reachable')
  applyMessage(control, cc(1, 127))
  assert.equal(value, 'c', 'the top of the range selects the last option')

  // A key steps through instead, so one pad can cycle a menu.
  value = 'a'
  applyMessage(control, note(60, 100))
  assert.equal(value, 'b')
})

test('a button fires on the way in and not on the way out', () => {
  let fired = 0
  const control: Control = {
    kind: 'button',
    label: 'Go',
    action: 'go',
    onClick: () => {
      fired++
    },
  }
  applyMessage(control, note(60, 100))
  applyMessage(control, note(60, 0))
  assert.equal(fired, 1, 'a press is one action, not two')

  // A controller parked above the midpoint repeats; only the crossing should count as a press,
  // which for a stateless button means the caller must not hold it there. Both halves fire here
  // because each is a rising value — documented as a limitation rather than pretended away.
  fired = 0
  applyMessage(control, cc(1, 0))
  assert.equal(fired, 0, 'the bottom of a fader is not a press')
})

test('prose and colour wells cannot be bound', () => {
  assert.equal(isBindable({ kind: 'heading', text: 'x' }), false)
  assert.equal(isBindable({ kind: 'note', text: 'x' }), false)
  assert.equal(
    isBindable({ kind: 'color', label: 'c', get: () => '#000', set: () => {} }),
    false,
    'a colour is not a scalar a knob can sweep',
  )
  assert.equal(
    isBindable({ kind: 'toggle', label: 't', get: () => false, set: () => {} }),
    true,
  )
})

test('an id names where a control lives, so it survives a reload and reads back', () => {
  const control: Control = { kind: 'toggle', label: 'Roaming', get: () => false, set: () => {} }
  assert.equal(bindingIdFor('Life', 'What moves it', control), 'Life/What moves it/Roaming')
  // Same label, different section: two ids, which is the whole reason the section is in there.
  assert.notEqual(
    bindingIdFor('Life', 'Phosphor', control),
    bindingIdFor('Life', 'What moves it', control),
  )
  assert.equal(bindingIdFor('Life', '', { kind: 'heading', text: 'x' }), null)
})
