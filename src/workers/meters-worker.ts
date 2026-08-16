/**
 * Loudness and peak metering, off the main thread.
 *
 * The meters read the same lock-free ring the GPU reads, through their own independent cursor.
 * That matters: metering must see *every* sample to be standards-compliant, while the render
 * path is allowed to drop analysis frames when the display cannot keep up. Two cursors over
 * one buffer give each consumer the guarantee it actually needs.
 *
 * Without SharedArrayBuffer the ring cannot be shared across threads, so the main thread
 * forwards blocks instead. The measurement is identical; only the transport differs.
 */

import { AudioRing, type RingLayout, type RingReader } from '../audio/ring.ts'
import { LoudnessMeter, type LoudnessReading } from '../dsp/loudness.ts'

const MAX_BLOCK = 8192

let ring: AudioRing | null = null
let reader: RingReader | null = null
let meter: LoudnessMeter | null = null
let timer: ReturnType<typeof setInterval> | null = null

export interface MetersMessage {
  type: 'init' | 'reset' | 'stop' | 'audio'
  layout?: RingLayout
  sampleRate?: number
  channels?: number
  planes?: Float32Array[]
  frames?: number
}

export interface MetersReport {
  type: 'reading'
  reading: LoudnessReading
}

function report(): void {
  if (meter) self.postMessage({ type: 'reading', reading: meter.read() } satisfies MetersReport)
}

function pump(): void {
  if (!ring || !reader || !meter) return
  let available = reader.available()
  const planes: Float32Array[] = []
  for (let c = 0; c < ring.channels; c++) planes.push(ring.plane(c))
  const mask = ring.capacity - 1

  while (available > 0) {
    const take = Math.min(available, MAX_BLOCK)
    const offsets = new Array<number>(ring.channels).fill(reader.position)
    meter.process(planes, offsets, take, mask)
    reader.advance(take)
    available -= take
  }
  report()
}

self.onmessage = (event: MessageEvent<MetersMessage>) => {
  const msg = event.data
  switch (msg.type) {
    case 'init': {
      if (timer !== null) clearInterval(timer)
      timer = null
      if (msg.layout) {
        ring = AudioRing.attach(msg.layout)
        reader = ring.reader()
        meter = new LoudnessMeter(ring.sampleRate, ring.channels, MAX_BLOCK)
        // 20 Hz polling is comfortably faster than the 100 ms gating step, so no block is
        // ever missed, and slow enough that the UI is not repainting numbers nobody can read.
        timer = setInterval(pump, 50)
      } else {
        ring = null
        reader = null
        meter = new LoudnessMeter(msg.sampleRate ?? 48000, msg.channels ?? 2, MAX_BLOCK)
      }
      break
    }
    case 'reset':
      meter?.reset()
      break
    case 'stop':
      if (timer !== null) clearInterval(timer)
      timer = null
      ring = null
      reader = null
      meter = null
      break
    case 'audio': {
      if (!meter || !msg.planes || !msg.frames) return
      // The forwarded blocks are power-of-two sized, so length - 1 is a valid wrap mask.
      const mask = msg.planes[0].length - 1
      const offsets = new Array<number>(msg.planes.length).fill(0)
      meter.process(msg.planes, offsets, msg.frames, mask)
      report()
      break
    }
  }
}
