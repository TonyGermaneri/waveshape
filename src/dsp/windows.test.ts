import test from 'node:test'
import assert from 'node:assert/strict'

import {
  REASSIGN_ENDPOINT_LIMIT,
  WINDOWS,
  buildWindowTables,
  windowEndpointRatio,
  windowSupportsReassignment,
  windowValue,
} from './windows.ts'

/**
 * A Kaiser with beta = 0 is a rectangular window: I0(0*sqrt(r)) / I0(0) is 1 everywhere.
 * The endpoint used to be short-circuited to zero when 1 - u^2 reached zero, which put a hole
 * in the first sample of every Kaiser and, at beta = 0, produced a rectangular window with a
 * notch in it.
 */
test('a Kaiser window is continuous at its first sample', () => {
  const flat = buildWindowTables('kaiser', 64, 0)
  for (let n = 0; n < 64; n++) {
    assert.ok(Math.abs(flat.w[n] - 1) < 1e-12, `beta 0, sample ${n} is ${flat.w[n]}`)
  }
  assert.ok(Math.max(...flat.dw) < 1e-9, 'a constant window has a zero derivative')

  // At a useful beta the endpoint is small but not zero, and it is exactly 1 / I0(beta).
  const shaped = buildWindowTables('kaiser', 4096, 12)
  assert.ok(shaped.w[0] > 0, 'endpoint zeroed')
  assert.ok(
    Math.abs(shaped.w[0] - windowValue('kaiser', 0, 4096, 12)) < 1e-15,
    'table disagrees with the continuous definition',
  )
})

/**
 * The derivative is taken by central difference, so a discontinuity at the endpoint shows up as
 * an impulse in the table — and that table is what frequency reassignment reads. Forcing w(0)
 * to zero made dw[0] fourteen thousand times its own neighbour.
 */
test('no window has an impulse at the start of its derivative table', () => {
  for (const spec of WINDOWS) {
    const param = spec.paramDefault ?? 0
    const t = buildWindowTables(spec.id, 1024, param)
    let interior = 0
    for (let n = 2; n < 1024; n++) interior = Math.max(interior, Math.abs(t.dw[n]))
    // Constant windows have a zero derivative everywhere, which is a legitimate flat table.
    const bound = Math.max(interior, 1e-12) * 4
    assert.ok(
      Math.abs(t.dw[0]) <= bound,
      `${spec.id}: dw[0] = ${t.dw[0]} against an interior maximum of ${interior}`,
    )
  }
})

/**
 * Reassignment's frequency correction is read from dw/dn, and the derivation assumes the window
 * has compact support. A window that does not taper has boundary deltas the table cannot hold;
 * rectangular is the limit case, where the interior derivative is identically zero and the
 * correction silently evaluates to nothing at all.
 */
test('windows that do not taper are refused for reassignment', () => {
  assert.equal(windowSupportsReassignment('rectangular', 4096, 0), false)
  assert.equal(windowSupportsReassignment('kaiser', 4096, 0), false)
  for (const id of ['hann', 'blackman-harris', 'nuttall', 'flat-top', 'hft248d'] as const) {
    assert.equal(windowSupportsReassignment(id, 4096, 0), true, id)
    assert.ok(windowEndpointRatio(id, 4096, 0) < 1e-3, `${id} should close at both ends`)
  }
  // Hamming and Blackman stand off zero but stay well inside the limit: usable, with bias.
  assert.ok(windowEndpointRatio('hamming', 4096, 0) > 0.07)
  assert.ok(windowEndpointRatio('hamming', 4096, 0) < REASSIGN_ENDPOINT_LIMIT)
  assert.equal(windowSupportsReassignment('kaiser', 4096, 12), true)
})

test('the measured endpoint ratio agrees with the built table', () => {
  for (const spec of WINDOWS) {
    const param = spec.paramDefault ?? 0
    const t = buildWindowTables(spec.id, 512, param)
    const measured = windowEndpointRatio(spec.id, 512, param)
    assert.ok(
      Math.abs(t.endpointRatio - measured) < 1e-12,
      `${spec.id}: ${t.endpointRatio} vs ${measured}`,
    )
  }
})
