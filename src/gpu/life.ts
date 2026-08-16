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
import type { Analyzer } from './analyzer.ts'

import lifeWgsl from './shaders/life.wgsl?raw'

/** Bins across the field. About 100 to the octave — a shade over a tenth of a semitone. */
export const FIELD_BINS = 1024
/** The field spans ten octaves from here: 20 Hz to 20.48 kHz. */
export const FIELD_MIN_HZ = 20
export const FIELD_OCTAVES = 10

/** 32 bytes each; 256k of them is 8 MB, and a busy frame births a few thousand. */
export const PARTICLE_CAPACITY = 1 << 18

const CENSUS_BYTES = 16 + 32 * 8
/** Nine vec4s. Kept in step with `Params` in life.wgsl. */
const PARAM_BYTES = 9 * 16

export interface LifeFrame {
  config: Config
  pointCount: number
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

  private readonly surveyPipeline: GPUComputePipeline
  private readonly birthPipeline: GPUComputePipeline
  private readonly stepPipeline: GPUComputePipeline
  private readonly settlePipeline: GPUComputePipeline
  private readonly layout: GPUBindGroupLayout

  /** Two bind groups, differing only in which field buffer is read and which is written. */
  private binds: [GPUBindGroup, GPUBindGroup] | null = null
  private parity = 0
  private frame = 0

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
    this.params = device.createBuffer({
      label: 'life-params',
      size: PARAM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    const C = GPUShaderStage.COMPUTE
    const entry = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: C,
      buffer: { type },
    })
    this.layout = device.createBindGroupLayout({
      label: 'life',
      entries: [
        entry(0, 'uniform'),
        entry(1, 'read-only-storage'),
        entry(2, 'storage'),
        entry(3, 'read-only-storage'),
        entry(4, 'storage'),
        entry(5, 'storage'),
        entry(6, 'read-only-storage'),
        entry(7, 'storage'),
        entry(8, 'storage'),
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

  /** Called when the source changes: the previous signal's organism has nothing to say here. */
  reset(): void {
    const zeros = new Uint32Array(FIELD_BINS)
    for (const field of this.fields) this.device.queue.writeBuffer(field, 0, zeros)
    this.device.queue.writeBuffer(this.deposit, 0, zeros)
    this.device.queue.writeBuffer(this.allocator, 0, new Uint32Array(4))
    // Particles are not cleared: the alive flag lives in the top byte of the colour word, and
    // writing 8 MB of zeroes to extinguish a population the ring will overwrite within a
    // second or two is not worth the bandwidth. What matters is that no *live* particle points
    // at the old signal's field, and zeroing the field achieves that.
    this.binds = null
  }

  private ensureBinds(): [GPUBindGroup, GPUBindGroup] {
    if (this.binds) return this.binds
    const make = (read: GPUBuffer, write: GPUBuffer): GPUBindGroup =>
      this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.params } },
          { binding: 1, resource: { buffer: this.analyzer.pointsBuf } },
          { binding: 2, resource: { buffer: this.particles } },
          { binding: 3, resource: { buffer: read } },
          { binding: 4, resource: { buffer: this.deposit } },
          { binding: 5, resource: { buffer: this.census } },
          { binding: 6, resource: { buffer: this.analyzer.spectrumBuf } },
          { binding: 7, resource: { buffer: this.allocator } },
          { binding: 8, resource: { buffer: write } },
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
   */
  record(encoder: GPUCommandEncoder, frame: LifeFrame): number {
    const life = frame.config.life
    const f = this.f32
    const u = this.u32

    u[0] = frame.pointCount
    u[1] = PARTICLE_CAPACITY
    u[2] = FIELD_BINS
    u[3] = this.frame++
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
    f[25] = Math.min(life.population, PARTICLE_CAPACITY)
    f[26] = life.crowding
    f[27] = life.settling
    f[28] = life.feed
    f[29] = life.occupancy
    f[30] = life.roam
    f[31] = life.vibrato
    f[32] = life.stamina
    f[33] = life.dissonance
    f[34] = life.surfacePull
    f[35] = 0
    this.device.queue.writeBuffer(this.params, 0, this.scratch, 0, PARAM_BYTES)

    const [a, b] = this.ensureBinds()
    const bind = this.parity === 0 ? a : b
    this.parity ^= 1

    const pass = encoder.beginComputePass({ label: 'life' })
    pass.setBindGroup(0, bind)

    // One workgroup, deliberately: the survey ends in a serial merge on a single thread, and
    // splitting it across workgroups would need a second pass to merge the merges.
    pass.setPipeline(this.surveyPipeline)
    pass.dispatchWorkgroups(1)

    if (frame.pointCount > 0) {
      pass.setPipeline(this.birthPipeline)
      pass.dispatchWorkgroups(Math.ceil(frame.pointCount / 64))
    }

    // Only the live part of the ring is stepped. With a cap of a few thousand there is no
    // reason to walk a quarter of a million dead slots to find them.
    const live = Math.min(life.population, PARTICLE_CAPACITY)
    pass.setPipeline(this.stepPipeline)
    pass.dispatchWorkgroups(Math.ceil(live / 64))

    pass.setPipeline(this.settlePipeline)
    pass.dispatchWorkgroups(Math.ceil(FIELD_BINS / 64))
    pass.end()

    return live
  }
}
