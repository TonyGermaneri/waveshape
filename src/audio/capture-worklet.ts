/**
 * Capture processor. Runs on the audio render thread at the render-quantum rate
 * (128 frames — 375 Hz at 48 kHz, 1500 Hz at 192 kHz).
 *
 * The only rule that matters here: **never allocate, never lock, never do unbounded work.**
 * Everything this processor touches is pre-allocated in the constructor.
 *
 * Primary path writes straight into a SharedArrayBuffer ring. Fallback path (no cross-origin
 * isolation, hence no SharedArrayBuffer) accumulates into pooled buffers and transfers them;
 * the main thread returns the buffers so the pool stays in steady state.
 */

import { AudioRing, type RingLayout } from './ring.ts'

interface CaptureOptions {
  ring: RingLayout | null
  channels: number
  chunkFrames: number
}

class CaptureProcessor extends AudioWorkletProcessor {
  private readonly channels: number
  private readonly ring: AudioRing | null

  // Fallback transfer state.
  private readonly chunkFrames: number
  private pool: Float32Array[][] = []
  private current: Float32Array[] | null = null
  private filled = 0
  private silentQuanta = 0

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    const opts = (options?.processorOptions ?? {}) as Partial<CaptureOptions>
    this.channels = Math.max(1, opts.channels ?? 2)
    this.chunkFrames = Math.max(128, opts.chunkFrames ?? 1024)
    this.ring = opts.ring ? AudioRing.attach(opts.ring) : null

    if (!this.ring) {
      for (let i = 0; i < 8; i++) this.pool.push(this.allocChunk())
      this.current = this.pool.pop() ?? this.allocChunk()
    }

    this.port.onmessage = (event: MessageEvent) => {
      const msg = event.data as { type: string; planes?: Float32Array[] }
      if (msg.type === 'recycle' && msg.planes) this.pool.push(msg.planes)
    }
    this.port.postMessage({ type: 'ready', sampleRate })
  }

  private allocChunk(): Float32Array[] {
    const planes: Float32Array[] = []
    for (let c = 0; c < this.channels; c++) planes.push(new Float32Array(this.chunkFrames))
    return planes
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]
    if (!input || input.length === 0 || !input[0]) {
      // Input disconnected or not yet producing. Keep the node alive.
      this.silentQuanta++
      if (this.silentQuanta === 400) this.port.postMessage({ type: 'no-input' })
      return true
    }
    this.silentQuanta = 0
    const frames = input[0].length

    if (this.ring) {
      this.ring.write(input, frames)
      return true
    }

    // Fallback: accumulate then transfer.
    let consumed = 0
    while (consumed < frames) {
      const chunk = this.current
      if (!chunk) return true
      const take = Math.min(frames - consumed, this.chunkFrames - this.filled)
      for (let c = 0; c < this.channels; c++) {
        const src = input[Math.min(c, input.length - 1)]
        chunk[c].set(src.subarray(consumed, consumed + take), this.filled)
      }
      this.filled += take
      consumed += take
      if (this.filled === this.chunkFrames) {
        const transfer: Transferable[] = []
        for (const p of chunk) transfer.push(p.buffer as ArrayBuffer)
        this.port.postMessage({ type: 'audio', planes: chunk, frames: this.chunkFrames }, transfer)
        this.current = this.pool.pop() ?? this.allocChunk()
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('waveshape-capture', CaptureProcessor)
