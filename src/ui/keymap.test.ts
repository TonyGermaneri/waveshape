/**
 * The keyboard map is the one part of the UI that fails silently: a duplicate token does not
 * throw, it just makes the second binding unreachable in whichever mode shadows it. These
 * checks enumerate every reachable state instead of trusting the table to be read carefully.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG, type Config, type Mode } from '../config.ts'
import { BINDINGS, KEY_GROUPS, bindingsFor, keyLabel } from './keymap.ts'

const MODES: Mode[] = ['wave', 'spectrum', 'spectrogram', 'vector']

/** Every configuration that changes which bindings are live, not just every mode. */
function states(): Config[] {
  const out: Config[] = []
  for (const mode of MODES) {
    for (const trigger of ['pitch', 'level', 'free'] as const) {
      const config = structuredClone(DEFAULT_CONFIG)
      config.mode = mode
      config.wave.trigger = trigger
      out.push(config)
    }
  }
  return out
}

test('no two bindings answer to the same keystroke at once', () => {
  for (const config of states()) {
    const seen = new Map<string, string>()
    for (const binding of bindingsFor(config)) {
      for (const stroke of binding.keys) {
        const previous = seen.get(stroke.token)
        assert.equal(
          previous,
          undefined,
          `${stroke.token} is bound to both "${previous}" and "${binding.label}" in ${config.mode} / ${config.wave.trigger}`,
        )
        seen.set(stroke.token, binding.label)
      }
    }
  }
})

test('every binding has at least one key, a label and a known group', () => {
  for (const binding of BINDINGS) {
    assert.ok(binding.keys.length > 0, `${binding.label} has no keys`)
    assert.ok(binding.label.length > 0, 'a binding has no label')
    assert.ok(
      (KEY_GROUPS as readonly string[]).includes(binding.group),
      `${binding.label} is in unknown group ${binding.group}`,
    )
  }
})

test('tokens are canonical: lower case, modifiers in a fixed order', () => {
  const shape = /^(mod\+)?(alt\+)?(shift\+)?[^+]+$/
  for (const binding of BINDINGS) {
    for (const { token } of binding.keys) {
      assert.match(token, shape, `${token} is not a canonical token`)
      assert.equal(token, token.toLowerCase(), `${token} is not lower case`)
    }
  }
})

test('every binding runs, mutates only the config, and reports what it did', () => {
  const noop = () => {}
  for (const config of states()) {
    for (const binding of bindingsFor(config)) {
      for (const stroke of binding.keys) {
        const actions = {
          togglePanel: noop,
          toggleFullscreen: noop,
          toggleHelp: noop,
          cycleTab: () => 'tab',
          cycleTheme: () => 'theme',
          restartSource: noop,
          stopSource: noop,
          resetMeters: noop,
          notify: noop,
          changed: noop,
        }
        const scratch = structuredClone(config)
        const message = binding.run({ config: scratch, actions }, stroke.arg)
        assert.ok(
          message === undefined || typeof message === 'string',
          `${binding.label} returned something that is not a message`,
        )
        assert.ok(
          JSON.stringify(scratch).length > 0,
          `${binding.label} left the config unserialisable`,
        )
      }
    }
  }
})

test('a numeric binding driven to its rail stays finite and in range', () => {
  const config = structuredClone(DEFAULT_CONFIG)
  const actions = {
    togglePanel: () => {},
    toggleFullscreen: () => {},
    toggleHelp: () => {},
    cycleTab: () => '',
    cycleTheme: () => '',
    restartSource: () => {},
    stopSource: () => {},
    resetMeters: () => {},
    notify: () => {},
    changed: () => {},
  }
  for (const mode of MODES) {
    config.mode = mode
    for (const binding of bindingsFor(config)) {
      for (const stroke of binding.keys) {
        for (let i = 0; i < 200; i++) binding.run({ config, actions }, stroke.arg)
      }
    }
  }
  const numbers = JSON.stringify(config).match(/-?\d+(\.\d+)?([eE][-+]?\d+)?/g) ?? []
  for (const n of numbers) assert.ok(Number.isFinite(Number(n)), `${n} is not finite`)
  assert.ok(config.spectrum.freqMax > config.spectrum.freqMin)
  assert.ok(config.spectrogram.freqMax > config.spectrogram.freqMin)
  assert.ok(config.spectrum.dbMax > config.spectrum.dbMin)
  assert.ok(config.spectrogram.dbCeil > config.spectrogram.dbFloor)
})

test('key caps render as something a human can read', () => {
  assert.equal(keyLabel('arrowleft'), '←')
  assert.equal(keyLabel('shift+arrowleft'), '⇧←')
  assert.equal(keyLabel('space'), 'Space')
  assert.equal(keyLabel('escape'), 'Esc')
  assert.equal(keyLabel('shift+t'), '⇧T')
  assert.equal(keyLabel('['), '[')
  assert.equal(keyLabel('?'), '?')
})
