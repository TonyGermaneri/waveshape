/**
 * Wait-free, single-producer / multi-consumer audio ring.
 *
 * Design notes
 * ------------
 * * **Planar, not interleaved.** Each channel occupies a contiguous span, so a channel can be
 *   uploaded to a GPU storage buffer with one `writeBuffer` and read by a compute shader with
 *   a single masked index. Interleaving would cost a de-interleave pass every frame.
 *
 * * **Overwriting, not blocking.** The producer runs on the audio render thread and must never
 *   wait, allocate, or branch on consumer state. It writes unconditionally and publishes a
 *   monotonic frame counter. Consumers hold their own private cursors and detect being lapped
 *   by comparing against the capacity. For a visualiser, dropping old audio is strictly better
 *   than stalling the render thread.
 *
 * * **Multiple independent consumers.** The GPU uploader and the loudness meter each keep their
 *   own cursor over the same memory, so the meters see every sample even when a frame is
 *   dropped on the render path.
 *
 * * **30-bit wrapping counter.** A plain `Int32` frame counter would overflow into negative
 *   territory after ~3 hours at 192 kHz. We publish `writeIndex mod 2^30` instead; because the
 *   capacity is a power of two that divides 2^30, masked difference arithmetic stays exact and
 *   unambiguous for any lag under 2^30 frames (~1.5 h at 192 kHz — consumers poll at 60 Hz).
 *   BigInt64 atomics would also work but allocate on the audio thread.
 */

const CONTROL_WORDS = 16

const IDX_WRITE = 0
const IDX_CAPACITY = 1
const IDX_CHANNELS = 2
const IDX_SAMPLE_RATE = 3
const IDX_OVERFLOW = 4
const IDX_UNDERRUN = 5
const IDX_RUNNING = 6

/** Frame counters are published modulo 2^30. */
export const COUNTER_MASK = 0x3fffffff

export interface RingLayout {
  buffer: ArrayBufferLike
  capacity: number
  channels: number
  sampleRate: number
}

export class AudioRing {
  readonly control: Int32Array
  readonly data: Float32Array
  readonly capacity: number
  readonly mask: number
  readonly channels: number
  readonly sampleRate: number
  private readonly planes: Float32Array[]

  private constructor(buffer: ArrayBufferLike, capacity: number, channels: number, rate: number) {
    this.control = new Int32Array(buffer, 0, CONTROL_WORDS)
    this.data = new Float32Array(buffer, CONTROL_WORDS * 4, capacity * channels)
    this.capacity = capacity
    this.mask = capacity - 1
    this.channels = channels
    this.sampleRate = rate
    this.planes = []
    for (let c = 0; c < channels; c++) {
      this.planes.push(this.data.subarray(c * capacity, (c + 1) * capacity))
    }
  }

  static byteLength(capacity: number, channels: number): number {
    return CONTROL_WORDS * 4 + capacity * channels * 4
  }

  static create(capacity: number, channels: number, sampleRate: number): AudioRing {
    if (capacity <= 0 || (capacity & (capacity - 1)) !== 0) {
      throw new Error(`ring capacity must be a power of two, got ${capacity}`)
    }
    const bytes = AudioRing.byteLength(capacity, channels)
    const shared =
      typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated !== false
    const buffer = shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes)
    const ring = new AudioRing(buffer, capacity, channels, sampleRate)
    Atomics.store(ring.control, IDX_WRITE, 0)
    Atomics.store(ring.control, IDX_CAPACITY, capacity)
    Atomics.store(ring.control, IDX_CHANNELS, channels)
    Atomics.store(ring.control, IDX_SAMPLE_RATE, sampleRate | 0)
    Atomics.store(ring.control, IDX_OVERFLOW, 0)
    Atomics.store(ring.control, IDX_UNDERRUN, 0)
    Atomics.store(ring.control, IDX_RUNNING, 0)
    return ring
  }

  /** Re-create a view over memory shared from another thread. */
  static attach(layout: RingLayout): AudioRing {
    return new AudioRing(layout.buffer, layout.capacity, layout.channels, layout.sampleRate)
  }

  get shared(): boolean {
    return typeof SharedArrayBuffer !== 'undefined' && this.data.buffer instanceof SharedArrayBuffer
  }

  get layout(): RingLayout {
    return {
      buffer: this.data.buffer,
      capacity: this.capacity,
      channels: this.channels,
      sampleRate: this.sampleRate,
    }
  }

  plane(channel: number): Float32Array {
    return this.planes[Math.min(channel, this.channels - 1)]
  }

  get writeIndex(): number {
    return Atomics.load(this.control, IDX_WRITE)
  }

  get overflowCount(): number {
    return Atomics.load(this.control, IDX_OVERFLOW)
  }

  get underrunCount(): number {
    return Atomics.load(this.control, IDX_UNDERRUN)
  }

  noteUnderrun(): void {
    Atomics.add(this.control, IDX_UNDERRUN, 1)
  }

  setRunning(running: boolean): void {
    Atomics.store(this.control, IDX_RUNNING, running ? 1 : 0)
  }

  get running(): boolean {
    return Atomics.load(this.control, IDX_RUNNING) === 1
  }

  /**
   * Producer entry point. Real-time safe: no allocation, no branching on consumer state,
   * no unbounded loops. `sources.length` may be fewer than the ring's channel count, in which
   * case the last source is duplicated (mono input into a stereo ring).
   */
  write(sources: Float32Array[], count: number): void {
    const start = Atomics.load(this.control, IDX_WRITE)
    const offset = start & this.mask
    const contiguous = Math.min(count, this.capacity - offset)
    for (let c = 0; c < this.channels; c++) {
      const src = sources[Math.min(c, sources.length - 1)]
      if (!src) continue
      const dst = this.planes[c]
      dst.set(src.subarray(0, contiguous), offset)
      if (contiguous < count) dst.set(src.subarray(contiguous, count), 0)
    }
    Atomics.store(this.control, IDX_WRITE, (start + count) & COUNTER_MASK)
  }

  /** Create an independent consumer positioned at the newest sample. */
  reader(): RingReader {
    return new RingReader(this)
  }
}

export class RingReader {
  private readonly ring: AudioRing
  private cursor: number
  private lapped = 0

  constructor(ring: AudioRing) {
    this.ring = ring
    this.cursor = ring.writeIndex
  }

  /** Frames published but not yet consumed, clamped to the ring capacity. */
  available(): number {
    const write = this.ring.writeIndex
    const diff = (write - this.cursor) & COUNTER_MASK
    if (diff > this.ring.capacity) {
      // Consumer fell behind far enough to be overwritten. Skip to the oldest valid frame.
      this.lapped++
      this.cursor = (write - this.ring.capacity) & COUNTER_MASK
      return this.ring.capacity
    }
    return diff
  }

  get lapCount(): number {
    return this.lapped
  }

  /** Absolute frame index of the next unread frame (modulo 2^30). */
  get position(): number {
    return this.cursor
  }

  /** Absolute frame index one past the newest published frame. */
  get head(): number {
    return this.ring.writeIndex
  }

  advance(frames: number): void {
    this.cursor = (this.cursor + frames) & COUNTER_MASK
  }

  /** Jump to the newest sample, discarding any backlog. */
  skipToHead(): void {
    this.cursor = this.ring.writeIndex
  }

  /**
   * Copy `count` frames of one channel ending at absolute index `end` into `out`.
   * Used by consumers that need a specific analysis window rather than a stream.
   */
  readWindow(channel: number, end: number, count: number, out: Float32Array): void {
    const plane = this.ring.plane(channel)
    const mask = this.ring.mask
    const start = (end - count) & COUNTER_MASK
    for (let i = 0; i < count; i++) out[i] = plane[(start + i) & mask]
  }
}

/**
 * Chunk shuttled from the AudioWorklet when SharedArrayBuffer is unavailable
 * (the document is not cross-origin isolated). Buffers are pooled and transferred back
 * so the fallback path also avoids steady-state allocation.
 */
export interface TransferChunk {
  planes: Float32Array[]
  frames: number
}
