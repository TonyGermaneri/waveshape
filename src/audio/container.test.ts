import test from 'node:test'
import assert from 'node:assert/strict'

import { containerSampleRate } from './container.ts'

function buffer(size: number): { bytes: ArrayBuffer; view: DataView } {
  const bytes = new ArrayBuffer(size)
  return { bytes, view: new DataView(bytes) }
}

function ascii(view: DataView, at: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i))
}

/** A RIFF/WAVE header, optionally with a junk chunk in front of `fmt ` to exercise the walk. */
function wav(rate: number, { lead = false } = {}): ArrayBuffer {
  const leadSize = lead ? 8 + 10 : 0
  const { bytes, view } = buffer(12 + leadSize + 8 + 16 + 8)
  ascii(view, 0, 'RIFF')
  view.setUint32(4, bytes.byteLength - 8, true)
  ascii(view, 8, 'WAVE')
  let at = 12
  if (lead) {
    // An odd-length chunk, so the parser must also honour the pad byte.
    ascii(view, at, 'LIST')
    view.setUint32(at + 4, 9, true)
    at += 8 + 10
  }
  ascii(view, at, 'fmt ')
  view.setUint32(at + 4, 16, true)
  view.setUint16(at + 8, 1, true)
  view.setUint16(at + 10, 2, true)
  view.setUint32(at + 12, rate, true)
  view.setUint32(at + 16, rate * 4, true)
  view.setUint16(at + 20, 4, true)
  view.setUint16(at + 22, 16, true)
  ascii(view, at + 24, 'data')
  return bytes
}

function flac(rate: number): ArrayBuffer {
  const { bytes, view } = buffer(4 + 4 + 34)
  ascii(view, 0, 'fLaC')
  view.setUint8(4, 0) // last-block flag clear, block type 0 = STREAMINFO
  view.setUint8(5, 0)
  view.setUint8(6, 0)
  view.setUint8(7, 34)
  // 20 bits of rate, then 3 bits of channel count and 5 of bit depth.
  view.setUint32(8 + 10, (rate << 12) | (1 << 9) | (15 << 4), false)
  return bytes
}

function aiff(rate: number): ArrayBuffer {
  const { bytes, view } = buffer(12 + 8 + 18)
  ascii(view, 0, 'FORM')
  view.setUint32(4, bytes.byteLength - 8, false)
  ascii(view, 8, 'AIFF')
  ascii(view, 12, 'COMM')
  view.setUint32(16, 18, false)
  view.setUint16(20, 2, false)
  view.setUint32(22, 1000, false)
  view.setUint16(26, 16, false)
  // 80-bit IEEE extended: normalise the rate into [1, 2) and store the exponent biased by 16383.
  const exponent = Math.floor(Math.log2(rate))
  const mantissa = BigInt(Math.round((rate / 2 ** exponent) * 2 ** 63))
  view.setUint16(28, 16383 + exponent, false)
  view.setUint32(30, Number(mantissa >> 32n), false)
  view.setUint32(34, Number(mantissa & 0xffffffffn), false)
  return bytes
}

function ogg(codec: 'vorbis' | 'opus', rate: number): ArrayBuffer {
  const { bytes, view } = buffer(128)
  ascii(view, 0, 'OggS')
  view.setUint8(26, 1) // one lacing value, so the packet starts at 28
  if (codec === 'vorbis') {
    view.setUint8(28, 1)
    ascii(view, 29, 'vorbis')
    view.setUint32(28 + 7, 0, true)
    view.setUint8(28 + 11, 2)
    view.setUint32(28 + 12, rate, true)
  } else {
    ascii(view, 28, 'OpusHead')
    view.setUint32(28 + 12, rate, true)
  }
  return bytes
}

test('WAVE states its rate, wherever the fmt chunk sits', () => {
  for (const rate of [44100, 48000, 96000, 192000]) {
    assert.equal(containerSampleRate(wav(rate)), rate)
    assert.equal(containerSampleRate(wav(rate, { lead: true })), rate)
  }
})

test('FLAC states its rate', () => {
  for (const rate of [44100, 88200, 192000]) assert.equal(containerSampleRate(flac(rate)), rate)
})

test('AIFF states its rate, through an 80-bit float', () => {
  for (const rate of [44100, 48000, 96000]) assert.equal(containerSampleRate(aiff(rate)), rate)
})

test('Ogg Vorbis states its rate; Opus always decodes at 48 kHz', () => {
  assert.equal(containerSampleRate(ogg('vorbis', 44100)), 44100)
  // Opus stores the rate of the audio that went in, but every decoder emits 48 kHz.
  assert.equal(containerSampleRate(ogg('opus', 44100)), 48000)
})

/**
 * The whole point of the tri-state: a container this cannot read must come back unknown, so the
 * indicator says "could not check" rather than claiming agreement it never established.
 */
test('an unreadable container is unknown, not agreement', () => {
  const { bytes, view } = buffer(64)
  ascii(view, 0, '\xff\xfb\x90\x00') // an MP3 frame header
  assert.equal(containerSampleRate(bytes), null)
  assert.equal(containerSampleRate(new ArrayBuffer(0)), null)
  assert.equal(containerSampleRate(new ArrayBuffer(8)), null)
})

test('a malformed header is unknown rather than a throw or a wild number', () => {
  // Truncated WAVE: the magic is there, the fmt chunk is not.
  const { bytes, view } = buffer(20)
  ascii(view, 0, 'RIFF')
  ascii(view, 8, 'WAVE')
  ascii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  assert.equal(containerSampleRate(bytes), null)

  // A rate no audio file has: rejected rather than reported.
  const absurd = wav(1)
  assert.equal(containerSampleRate(absurd), null)

  // A leading chunk whose size would send the walk past the end of the buffer: the walk stops
  // rather than looping or reading out of bounds, and the rate is unknown.
  const runaway = wav(48000, { lead: true })
  new DataView(runaway).setUint32(16, 0xffffff00, true)
  assert.equal(containerSampleRate(runaway), null)
})
