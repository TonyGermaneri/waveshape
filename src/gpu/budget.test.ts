import test from 'node:test'
import assert from 'node:assert/strict'

import { budgetCeiling, estimateBudget, fitToBudget, formatBytes } from './budget.ts'
import type { BudgetInputs } from './budget.ts'

const MIB = 1024 * 1024

/** The default session: a 1080p viewport, MSAA on, a 12 s history, the default population. */
const DEFAULTS: BudgetInputs = {
  width: 1920,
  height: 1080,
  sampleCount: 4,
  historyColumns: 2258,
  historyRows: 1024,
  spectrogram: true,
  channels: 2,
  population: 24000,
  trail: 12,
  lifeEnabled: true,
  livePanes: 4,
}

/** Every slider at its maximum at once — the configuration nothing used to add up. */
const EXTREME: BudgetInputs = {
  width: 3840 * 2,
  height: 2160 * 2,
  sampleCount: 4,
  historyColumns: 8192,
  historyRows: 4096,
  spectrogram: true,
  channels: 2,
  population: 200000,
  trail: 48,
  lifeEnabled: true,
  livePanes: 4,
}

const ceiling = (bytes: number): number =>
  budgetCeiling({ maxBufferSize: bytes / 8 } as unknown as GPUSupportedLimits)

test('the ceiling tracks the device and stays inside sane rails', () => {
  // The floor the spec requires is 256 MiB, which must not produce a ceiling below 512 MiB.
  assert.equal(budgetCeiling({ maxBufferSize: 256 * MIB } as GPUSupportedLimits), 2048 * MIB)
  assert.equal(budgetCeiling({ maxBufferSize: 16 * MIB } as GPUSupportedLimits), 512 * MIB)
  assert.equal(budgetCeiling({ maxBufferSize: 8192 * MIB } as GPUSupportedLimits), 4096 * MIB)
})

test('a default session is comfortably inside the budget', () => {
  const report = estimateBudget(DEFAULTS, ceiling(1024 * MIB))
  assert.ok(report.total < 512 * MIB, `${formatBytes(report.total)} for a default session`)
  assert.equal(report.lines.length, 4)
  for (const line of report.lines) assert.ok(line.bytes > 0, `${line.label} costs nothing?`)
  assert.equal(
    report.total,
    report.lines.reduce((n, l) => n + l.bytes, 0),
    'the total is not the sum of its parts',
  )
})

/**
 * The point of the module. Each of these settings was bounded on its own and never against the
 * others, so the maximum of every range at once is a configuration nothing refused to build.
 */
test('every slider at maximum exceeds a gigabyte', () => {
  const report = estimateBudget(EXTREME, ceiling(1024 * MIB))
  assert.ok(report.total > 1024 * MIB, `${formatBytes(report.total)} at the top of every range`)
  const history = report.lines.find((l) => l.label === 'Spectrogram history')!
  assert.equal(history.bytes, 8192 * 4096 * 8)
  assert.ok(report.lifeInstances > 9_000_000, `${report.lifeInstances} trail instances`)
})

test('the history is what gives way first, and never below a usable width', () => {
  // An ordinary viewport with the history at its maximum: this is the case the budget can
  // actually rescue, because the history is the part that can be made smaller between frames.
  const wide: BudgetInputs = { ...DEFAULTS, historyColumns: 8192, historyRows: 4096 }
  const limit = 256 * MIB
  assert.ok(estimateBudget(wide, limit).total > limit, 'the fixture was already inside the limit')

  const caps = fitToBudget(wide, limit)
  assert.ok(caps.historyColumns < wide.historyColumns, 'the history was not reduced')
  assert.ok(caps.historyColumns >= 256, `reduced to ${caps.historyColumns} columns`)
  assert.deepEqual(caps.reduced, ['spectrogram history'])
  assert.equal(caps.population, wide.population, 'the population gave way before it had to')

  const fitted = estimateBudget({ ...wide, historyColumns: caps.historyColumns }, limit)
  assert.ok(fitted.total <= limit, `${formatBytes(fitted.total)} after fitting`)
})

test('a history reduction that cannot rescue the frame does not pretend to', () => {
  // 4K at render scale 2 with MSAA is over a gigabyte of render target before anything else is
  // asked for. Shrinking the history to its floor is not going to fix that, and the report says
  // so instead of quietly returning a number that still does not fit.
  const caps = fitToBudget(EXTREME, 1024 * MIB)
  assert.ok(caps.historyColumns >= 256)
  assert.ok(caps.reduced.length > 0)
})

test('a configuration that fits is left alone', () => {
  const caps = fitToBudget(DEFAULTS, ceiling(1024 * MIB))
  assert.equal(caps.historyColumns, DEFAULTS.historyColumns)
  assert.equal(caps.population, DEFAULTS.population)
  assert.deepEqual(caps.reduced, [])
})

test('when even the fixed cost is over budget, that is reported rather than hidden', () => {
  // A ceiling below the render targets alone: nothing the budget can reduce will rescue this.
  const caps = fitToBudget(EXTREME, 64 * MIB)
  assert.ok(caps.reduced.length > 0)
  assert.ok(
    caps.reduced.some((r) => r.includes('render scale')),
    `expected the unreducible settings to be named, got ${caps.reduced.join('; ')}`,
  )
})

test('closing the spectrogram costs nothing to hold', () => {
  const report = estimateBudget({ ...DEFAULTS, spectrogram: false }, ceiling(1024 * MIB))
  assert.equal(report.lines.find((l) => l.label === 'Spectrogram history')!.bytes, 0)
})

test('bytes are formatted at the scale a person reads them', () => {
  assert.equal(formatBytes(2048), '2 KiB')
  assert.equal(formatBytes(256 * MIB), '256 MiB')
  assert.equal(formatBytes(1536 * MIB), '1.50 GiB')
})
