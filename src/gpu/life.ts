/**
 * The harmonic organism.
 *
 * Owns the particle pool, the pheromone field over log frequency, and the four compute passes
 * that make a cloud of one-frame measurements into something with a life cycle. The physics is
 * in `life.wgsl`; this file is the plumbing and the parameter surface.
 *
 * Two design notes worth stating here rather than in the shader:
 *
 * The pool is a ring. Births take the next slot and overwrite whatever was there, alive or not.
 * A free list would be tidier and would cost a compaction pass, an indirect dispatch and a
 * second buffer to hold the survivors — for a pool this size, letting the oldest particle be
 * the one that dies is both cheaper and, as it happens, exactly the mortality rule the display
 * wants anyway.
 *
 * The field is ping-ponged rather than updated in place, because `settle` blurs each bin with
 * its neighbours and would otherwise be reading values another workgroup had already written.
 */

import type { Config } from '../config.ts'
import { PARTICLE_BYTES } from './particle.ts'
import { rasteriseWheel, wheelById } from './colormap.ts'
import type { Analyzer } from './analyzer.ts'

import lifeWgsl from './shaders/life.wgsl?raw'
import { FIELD_BINS, FIELD_MIN_HZ, FIELD_OCTAVES, PARTICLE_CAPACITY } from './limits.ts'

export { FIELD_BINS, FIELD_MIN_HZ, FIELD_OCTAVES, PARTICLE_CAPACITY }

/** Entries in the rasterised pitch-class wheel. A shade over twenty per semitone. */
const WHEEL_ENTRIES = 256

const CENSUS_BYTES = 16 + 32 * 8
/** Nine vec4s. Kept in step with `Params` in life.wgsl. */
const PARAM_BYTES = 9 * 16
/** Uniform slot stride; must be a multiple of minUniformBufferOffsetAlignment. */
const PARAM_STRIDE = 256

/**
 * The organism's clock, in steps per second of *audio*.
 *
 * It used to be one step per rendered frame, which made every rate in the physics — drift,
 * vibrato, the walk along its own series, starvation, the lifespan — a function of the monitor
 * in front of it. The same signal grew a different organism at 60 Hz and at 120 Hz, and none at
 * all in a background tab, where the browser throttles the frame callback to once a second.
 *
 * Sixty was chosen rather than derived. It is what the defaults here were tuned against, so a
 * session on an ordinary 60 Hz display sees exactly what it saw before; every other display,
 * hop size and sample rate now sees the same thing rather than its own variation. Deriving it
 * from the analysis rate would have been the more obvious choice and is the wrong one: the hop
 * is a resolution setting, and moving it should not change how fast anything lives.
 */
export const LIFE_STEPS_PER_SECOND = 60

/**
 * Steps one paint may run before the clock is allowed to fall behind.
 *
 * The organism catches up after a hitch, which is the whole point, but catching up is also work
 * — and a frame that stalled once should not be handed the bill for the stall on top of its own
 * paint. Past this the debt is written off rather than carried: a tab that was hidden for a
 * minute resumes where the audio is, not where it would have been.
 */
const MAX_STEPS_PER_RECORD = 16

export interface LifeFrame {
  config: Config
  pointCount: number
  /** Ceiling on the population from the GPU budget; see gpu/budget.ts. */
  maxPopulation: number
  /** Samples of audio the analysis advanced by since the last paint. The organism's clock. */
  elapsedSamples: number
  sampleRate: number
  /** Bins in the magnitude spectrum, i.e. fftSize / 2 + 1. */
  spectrumBins: number
  /** The frequency range actually on screen. Leaving it is how a particle dies of old age. */
  viewLowHz: number
  viewHighHz: number
}

export class Life {
  private readonly device: GPUDevice
  private readonly analyzer: Analyzer

  readonly particles: GPUBuffer
  /** Exposed so the draw passes can find the newest births without a readback. */
  readonly allocator: GPUBuffer
  private readonly fields: [GPUBuffer, GPUBuffer]
  private readonly deposit: GPUBuffer
  private readonly census: GPUBuffer
  private readonly params: GPUBuffer
  private readonly wheel: GPUBuffer
  /** Which wheel is currently uploaded, so it is rasterised on change rather than every frame. */
  private wheelId = ''

  private readonly surveyPipeline: GPUComputePipeline
  private readonly birthPipeline: GPUComputePipeline
  private readonly stepPipeline: GPUComputePipeline
  private readonly settlePipeline: GPUComputePipeline
  private readonly layout: GPUBindGroupLayout

  /** Two bind groups, differing only in which field buffer is read and which is written. */
  private binds: [GPUBindGroup, GPUBindGroup] | null = null
  private parity = 0
  private frame = 0
  /** Audio time owed to the organism but not yet stepped, in seconds. */
  private clockDebt = 0

  private readonly scratch = new ArrayBuffer(PARAM_BYTES)
  private readonly f32 = new Float32Array(this.scratch)
  private readonly u32 = new Uint32Array(this.scratch)

  constructor(device: GPUDevice, analyzer: Analyzer) {
    this.device = device
    this.analyzer = analyzer

    // COPY_SRC throughout: a population's health is not visible on screen — a particle with the
    // wrong harmonic number still draws a plausible line — so being able to read the pool back
    // and check what it thinks it is, is the only way to know the organism is working.
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    const mk = (label: string, size: number) =>
      device.createBuffer({ label: `life-${label}`, size, usage: storage })

    this.particles = mk('particles', PARTICLE_CAPACITY * PARTICLE_BYTES)
    this.fields = [mk('field-a', FIELD_BINS * 4), mk('field-b', FIELD_BINS * 4)]
    this.deposit = mk('deposit', FIELD_BINS * 4)
    this.census = mk('census', CENSUS_BYTES)
    this.allocator = mk('allocator', 16)
    // Uniform, not storage: the pass already holds the eight storage buffers a device is
    // required to offer, and this would have been the ninth. See the binding in life.wgsl.
    this.wheel = device.createBuffer({
      label: 'life-wheel',
      size: WHEEL_ENTRIES * 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    // One slot per step this pass may run, selected by dynamic offset. The steps of a single
    // paint have to differ from one another — the wander term and the vitality dither are both
    // hashed from the step counter — and `queue.writeBuffer` is ordered ahead of the entire
    // command buffer, so rewriting one slot between dispatches would give every dispatch the
    // last value written. Slots are the only way to hand consecutive steps consecutive numbers.
    this.params = device.createBuffer({
      label: 'life-params',
      size: PARAM_STRIDE * MAX_STEPS_PER_RECORD,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    const C = GPUShaderStage.COMPUTE
    const entry = (
      binding: number,
      type: GPUBufferBindingType,
      hasDynamicOffset = false,
    ): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: C,
      buffer: { type, hasDynamicOffset },
    })
    this.layout = device.createBindGroupLayout({
      label: 'life',
      entries: [
        entry(0, 'uniform', true),
        entry(1, 'read-only-storage'),
        entry(2, 'storage'),
        entry(3, 'read-only-storage'),
        entry(4, 'storage'),
        entry(5, 'storage'),
        entry(6, 'read-only-storage'),
        entry(7, 'storage'),
        entry(8, 'storage'),
        entry(9, 'uniform'),
      ],
    })

    const module = device.createShaderModule({ label: 'life', code: lifeWgsl })
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] })
    const pipeline = (entryPoint: string) =>
      device.createComputePipeline({
        label: `life-${entryPoint}`,
        layout: pipelineLayout,
        compute: { module, entryPoint },
      })

    this.surveyPipeline = pipeline('survey')
    this.birthPipeline = pipeline('birth')
    this.stepPipeline = pipeline('step')
    this.settlePipeline = pipeline('settle')
  }

  /**
   * Copies a slice of the pool and the census back to the CPU. Diagnostic only — nothing in the
   * render path waits on this, and calling it every frame would stall the pipeline.
   */
  async inspect(slots = 64): Promise<{ census: Float32Array; particles: ArrayBuffer }> {
    const device = this.device
    const take = Math.min(slots, PARTICLE_CAPACITY) * PARTICLE_BYTES
    const readback = device.createBuffer({
      size: take + CENSUS_BYTES,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    const encoder = device.createCommandEncoder({ label: 'life-inspect' })
    encoder.copyBufferToBuffer(this.particles, 0, readback, 0, take)
    encoder.copyBufferToBuffer(this.census, 0, readback, take, CENSUS_BYTES)
    device.queue.submit([encoder.finish()])
    await readback.mapAsync(GPUMapMode.READ)
    const copy = readback.getMappedRange().slice(0)
    readback.unmap()
    readback.destroy()
    return {
      particles: copy.slice(0, take),
      census: new Float32Array(copy.slice(take)),
    }
  }

  /**
   * Called when the source changes: the previous signal's organism has nothing to say here.
   *
   * The pool is cleared along with the field. It used to be left alone, on the reasoning that
   * the birth ring would overwrite it within a second or two and eight megabytes of zeroes was
   * not worth the bandwidth — but "within a second or two" assumed a new signal busy enough to
   * fill the ring, and the case that matters most is the opposite one. Stop the capture, or
   * open a quiet file, and nothing is born: the previous source's population goes on being
   * stepped and drawn over material it never heard, which is the one thing an organism seeded
   * by measurement must never do. A single 8 MB upload on a source change is not a cost.
   */
  reset(): void {
    const zeros = new Uint32Array(FIELD_BINS)
    for (const field of this.fields) this.device.queue.writeBuffer(field, 0, zeros)
    this.device.queue.writeBuffer(this.deposit, 0, zeros)
    this.device.queue.writeBuffer(this.allocator, 0, new Uint32Array(4))
    this.clockDebt = 0
    // The whole pool, not just the slots currently inside the population cap: raising the cap
    // afterwards would otherwise walk straight back into the old cast.
    this.device.queue.writeBuffer(
      this.particles,
      0,
      new Uint32Array((PARTICLE_CAPACITY * PARTICLE_BYTES) / 4),
    )
    this.frame = 0
    this.binds = null
  }

  private ensureBinds(): [GPUBindGroup, GPUBindGroup] {
    if (this.binds) return this.binds
    const make = (read: GPUBuffer, write: GPUBuffer): GPUBindGroup =>
      this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.params, size: PARAM_BYTES } },
          { binding: 1, resource: { buffer: this.analyzer.pointsBuf } },
          { binding: 2, resource: { buffer: this.particles } },
          { binding: 3, resource: { buffer: read } },
          { binding: 4, resource: { buffer: this.deposit } },
          { binding: 5, resource: { buffer: this.census } },
          { binding: 6, resource: { buffer: this.analyzer.spectrumBuf } },
          { binding: 7, resource: { buffer: this.allocator } },
          { binding: 8, resource: { buffer: write } },
          { binding: 9, resource: { buffer: this.wheel } },
        ],
      })
    this.binds = [
      make(this.fields[0], this.fields[1]),
      make(this.fields[1], this.fields[0]),
    ]
    return this.binds
  }

  /**
   * Records one generation. Returns the number of particle slots the renderer should draw —
   * the whole pool, since deciding which slots are alive is the vertex stage's job and doing it
   * here would mean a readback.
   *
   * "One generation" is however many fixed steps the audio that arrived since the last paint
   * pays for, which is normally one or two and is zero when nothing arrived. The census and the
   * births happen once — the points are already a batch covering the whole interval — and then
   * the population is stepped and the field settled once per tick of the organism's own clock.
   */
  record(encoder: GPUCommandEncoder, frame: LifeFrame): number {
    const life = frame.config.life
    const f = this.f32
    const u = this.u32

    // Whole steps only; the remainder is carried so a display rate that does not divide the
    // step rate evenly still averages out to the right speed rather than rounding down forever.
    this.clockDebt += frame.elapsedSamples / Math.max(frame.sampleRate, 1)
    let steps = Math.floor(this.clockDebt * LIFE_STEPS_PER_SECOND)
    if (steps >= MAX_STEPS_PER_RECORD) {
      steps = MAX_STEPS_PER_RECORD
      this.clockDebt = 0
    } else if (steps > 0) {
      this.clockDebt -= steps / LIFE_STEPS_PER_SECOND
    }

    u[0] = frame.pointCount
    u[1] = PARTICLE_CAPACITY
    u[2] = FIELD_BINS
    u[3] = 0
    f[4] = frame.sampleRate
    f[5] = FIELD_MIN_HZ
    f[6] = FIELD_OCTAVES
    f[7] = frame.config.analysis.hop
    f[8] = life.sensorCents
    f[9] = life.turnCents
    f[10] = life.harmonicPull
    f[11] = life.damping
    f[12] = life.decay
    f[13] = life.diffuse
    f[14] = life.deposit
    f[15] = life.lifespan
    f[16] = life.birthThreshold
    f[17] = life.noiseMortality
    f[18] = life.supportBonus
    f[19] = life.driftLimitCents
    f[20] = frame.spectrumBins
    f[21] = life.peakFloorDb
    f[22] = frame.viewLowHz
    f[23] = frame.viewHighHz
    f[24] = life.wrap ? 1 : 0
    const cap = Math.min(life.population, frame.maxPopulation, PARTICLE_CAPACITY)
    f[25] = cap
    f[26] = life.crowding
    f[27] = life.settling
    f[28] = life.feed
    f[29] = life.occupancy
    f[30] = life.roam
    f[31] = life.vibrato
    f[32] = life.stamina
    f[33] = life.dissonance
    f[34] = life.surfacePull
    const wheel = wheelById(life.wheel)
    f[35] = wheel.turns ?? 1
    // One slot per step, differing only in the step counter. See the buffer's own note.
    for (let i = 0; i < Math.max(1, steps); i++) {
      u[3] = this.frame + i
      this.device.queue.writeBuffer(this.params, i * PARAM_STRIDE, this.scratch, 0, PARAM_BYTES)
    }
    this.frame += Math.max(1, steps)

    // Rasterised on change rather than every frame. Two wheels can share stops and differ only
    // in how many turns they take — the circle of fifths is the even wheel walked sevenfold —
    // so the id is what decides, not the stops.
    if (this.wheelId !== wheel.id) {
      this.device.queue.writeBuffer(this.wheel, 0, rasteriseWheel(wheel.stops, WHEEL_ENTRIES))
      this.wheelId = wheel.id
    }

    const binds = this.ensureBinds()
    // Only the live part of the ring is stepped. With a cap of a few thousand there is no
    // reason to walk a quarter of a million dead slots to find them.
    const live = cap
    const stepGroups = Math.ceil(live / 64)
    const settleGroups = Math.ceil(FIELD_BINS / 64)

    const pass = encoder.beginComputePass({ label: 'life' })
    pass.setBindGroup(0, binds[this.parity], [0])

    // One workgroup, deliberately: the survey ends in a serial merge on a single thread, and
    // splitting it across workgroups would need a second pass to merge the merges.
    pass.setPipeline(this.surveyPipeline)
    pass.dispatchWorkgroups(1)

    if (frame.pointCount > 0) {
      pass.setPipeline(this.birthPipeline)
      pass.dispatchWorkgroups(Math.ceil(frame.pointCount / 64))
    }

    // Step and settle together, once per tick. The field decay and the three-tap blur in
    // `settle` are per-step quantities exactly as the drift and the starvation are, so running
    // the population twice against one settle would let the pheromone outlive its own clock.
    // The parity flips with each pair because `settle` reads the field it is not writing.
    for (let i = 0; i < steps; i++) {
      pass.setBindGroup(0, binds[this.parity], [i * PARAM_STRIDE])
      pass.setPipeline(this.stepPipeline)
      pass.dispatchWorkgroups(stepGroups)
      pass.setPipeline(this.settlePipeline)
      pass.dispatchWorkgroups(settleGroups)
      this.parity ^= 1
    }
    pass.end()

    return live
  }
}
