/**
 * Compute-side of the pipeline. Owns every GPU buffer that holds analysis data and records
 * the compute passes for one rendered frame.
 *
 * Frame shape
 * -----------
 * Audio arrives at the render-quantum rate and analysis frames are produced at
 * sampleRate / hop — 187.5 Hz for the default 48 kHz / 256-sample hop, up to 1.5 kHz at
 * 192 kHz with a 128-sample hop. The display runs at the monitor's refresh rate, typically
 * 60-120 Hz. Those rates are deliberately decoupled: every analysis frame that has arrived
 * since the last paint is processed in a single batched dispatch chain, so the spectrogram
 * keeps full time resolution and the averaging/peak-hold integrators see every frame, while
 * the number of GPU dispatches stays proportional to the *display* rate rather than the
 * analysis rate. Batching is the whole trick — an unbatched implementation spends all its
 * time in dispatch overhead long before it runs out of arithmetic.
 *
 * Buffers are allocated once at the maximum configured size and re-interpreted as settings
 * change, so changing the FFT size does not stall the pipeline on reallocation.
 */

import { AudioRing, COUNTER_MASK } from '../audio/ring.ts'
import {
  REASSIGN_ENDPOINT_LIMIT,
  buildWindowTables,
  type WindowId,
  type WindowTables,
} from '../dsp/windows.ts'
import { fftReal } from '../dsp/fft.ts'
import { COMPLEX_BUDGET, MAX_COLUMNS, MAX_FFT_SIZE, MAX_LAGS, POINT_BUDGET } from './limits.ts'

import prepareWgsl from './shaders/prepare.wgsl?raw'
import fftWgsl from './shaders/fft.wgsl?raw'
import unpackWgsl from './shaders/unpack.wgsl?raw'
import analyzeWgsl from './shaders/analyze.wgsl?raw'
import envelopeWgsl from './shaders/envelope.wgsl?raw'
import speccolsWgsl from './shaders/speccols.wgsl?raw'
import nsdfWgsl from './shaders/nsdf.wgsl?raw'

// Re-exported so callers keep asking the analyser how big the analyser's buffers are.
export { COMPLEX_BUDGET, MAX_COLUMNS, MAX_FFT_SIZE, MAX_LAGS, POINT_BUDGET }

const WORKGROUP = 64
const UNIFORM_STRIDE = 256

export interface AnalyzerSettings {
  fftSize: number
  window: WindowId
  windowParam: number
  hop: number
  /** [ch0<-L, ch0<-R, ch1<-L, ch1<-R] */
  mix: [number, number, number, number]
  channelCount: number
  reassign: boolean
  maxTimeShift: number
  maxFreqShiftBins: number
  averaging: number
  peakDecayDbPerSecond: number
  floorDb: number
  scale: 'amplitude' | 'density'
  displayChannel: number
}

export interface TriggerSettings {
  mode: 'free' | 'level' | 'pitch'
  level: number
  edge: 1 | -1
  cycles: number
  clarityThreshold: number
  pitchMinHz: number
  pitchMaxHz: number
  spanSamples: number
}

export interface SpectrumAxis {
  columns: number
  logFrequency: boolean
  freqMin: number
  freqMax: number
  source: 'live' | 'average'
}

export interface RecordOptions {
  settings: AnalyzerSettings
  trigger: TriggerSettings
  axis: SpectrumAxis
  /** Pixel columns for the waveform envelope reduction; 0 skips the waveform path entirely. */
  waveColumns: number
  maxFramesPerRender: number
  /** False in modes that need no transform, so a 64k FFT is not run to feed nothing. */
  spectral: boolean
}

export interface FrameStats {
  /** Analysis frames processed this render frame. */
  frames: number
  /** Analysis frames dropped because the render loop could not keep up. */
  dropped: number
  /** Frames the audio thread overwrote before we uploaded them. */
  lapped: number
  head: number
  sampleRate: number
  binCount: number
  hopHz: number
  pointCount: number
  /**
   * Whether reassignment actually ran. False when it is switched off, and false when the
   * chosen window has no usable derivative for it — see REASSIGN_ENDPOINT_LIMIT.
   */
  reassigned: boolean
}

export class Analyzer {
  private readonly device: GPUDevice
  private ring: AudioRing | null = null

  // --- persistent buffers -------------------------------------------------------------
  private audioBuf: GPUBuffer | null = null
  private readonly windowBuf: GPUBuffer
  private readonly twiddleBuf: GPUBuffer
  private readonly fftA: GPUBuffer
  private readonly fftB: GPUBuffer
  private readonly binsBuf: GPUBuffer
  readonly spectrumBuf: GPUBuffer
  readonly peaksBuf: GPUBuffer
  readonly averageBuf: GPUBuffer
  readonly pointsBuf: GPUBuffer
  readonly specColsBuf: GPUBuffer
  readonly envBuf: GPUBuffer
  readonly timebaseBuf: GPUBuffer
  private readonly nsdfBuf: GPUBuffer

  // --- uniforms -----------------------------------------------------------------------
  private readonly prepareUniform: GPUBuffer
  private readonly fftUniform: GPUBuffer
  private readonly unpackUniform: GPUBuffer
  private readonly analyzeUniform: GPUBuffer
  private readonly envUniform: GPUBuffer
  private readonly specColsUniform: GPUBuffer
  private readonly nsdfUniform: GPUBuffer

  // --- pipelines ----------------------------------------------------------------------
  private readonly preparePipeline: GPUComputePipeline
  private readonly radix2Pipeline: GPUComputePipeline
  private readonly radix4Pipeline: GPUComputePipeline
  private readonly unpackPipeline: GPUComputePipeline
  private readonly spectraPipeline: GPUComputePipeline
  private readonly reassignPipeline: GPUComputePipeline
  private readonly envelopePipeline: GPUComputePipeline
  private readonly specColsPipeline: GPUComputePipeline
  private readonly correlatePipeline: GPUComputePipeline
  private readonly pickPipeline: GPUComputePipeline

  private readonly prepareLayout: GPUBindGroupLayout
  private readonly fftLayout: GPUBindGroupLayout
  private readonly unpackLayout: GPUBindGroupLayout
  private readonly analyzeLayout: GPUBindGroupLayout
  private readonly envLayout: GPUBindGroupLayout
  private readonly specColsLayout: GPUBindGroupLayout
  private readonly nsdfLayout: GPUBindGroupLayout

  // --- bind groups (rebuilt only when the audio buffer changes) -----------------------
  private prepareBind: GPUBindGroup | null = null
  private fftBindAB: GPUBindGroup | null = null
  private fftBindBA: GPUBindGroup | null = null
  private unpackBindA: GPUBindGroup | null = null
  private unpackBindB: GPUBindGroup | null = null
  private analyzeBind: GPUBindGroup | null = null
  private envBind: GPUBindGroup | null = null
  private specColsBind: GPUBindGroup | null = null
  private nsdfBind: GPUBindGroup | null = null

  // --- state --------------------------------------------------------------------------
  private uploadCursor = 0
  private analysisCursor = -1
  private gpuHead = 0
  private tables: WindowTables | null = null
  private tableKey = ''
  /** Everything that changes what a stored spectrum bin *means*. */
  private spectraKey = ''
  private twiddleSize = 0
  private droppedFrames = 0
  private lappedFrames = 0
  private timebaseStaging: GPUBuffer | null = null
  private timebasePending = false
  private readonly timebaseValue = new Float32Array([1024, 1024, 0, 0])

  private readonly scratch = new ArrayBuffer(256)
  private readonly scratchU32 = new Uint32Array(this.scratch)
  private readonly scratchF32 = new Float32Array(this.scratch)

  constructor(device: GPUDevice) {
    this.device = device

    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    const mk = (label: string, size: number, usage = storage) =>
      device.createBuffer({ label, size, usage })

    this.windowBuf = mk('windows', MAX_FFT_SIZE * 3 * 4)
    this.twiddleBuf = mk('twiddles', MAX_FFT_SIZE * 8)
    this.fftA = mk('fft-a', COMPLEX_BUDGET * 8)
    this.fftB = mk('fft-b', COMPLEX_BUDGET * 8)
    this.binsBuf = mk('bins', (COMPLEX_BUDGET + 8192) * 8)
    this.spectrumBuf = mk('spectrum', 2 * (MAX_FFT_SIZE / 2 + 1) * 4)
    this.peaksBuf = mk('peaks', 2 * (MAX_FFT_SIZE / 2 + 1) * 4)
    this.averageBuf = mk('average', 2 * (MAX_FFT_SIZE / 2 + 1) * 4)
    this.pointsBuf = mk('points', POINT_BUDGET * 16)
    this.specColsBuf = mk('spectrum-columns', MAX_COLUMNS * 2 * 16)
    this.envBuf = mk('envelope', MAX_COLUMNS * 2 * 16)
    this.timebaseBuf = mk('timebase', 16)
    this.nsdfBuf = mk('nsdf', MAX_LAGS * 4)

    const uniform = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    this.prepareUniform = mk('u-prepare', 96, uniform)
    this.fftUniform = mk('u-fft', UNIFORM_STRIDE * 20, uniform)
    this.unpackUniform = mk('u-unpack', 16, uniform)
    this.analyzeUniform = mk('u-analyze', UNIFORM_STRIDE * 2, uniform)
    this.envUniform = mk('u-env', 80, uniform)
    this.specColsUniform = mk('u-speccols', 48, uniform)
    this.nsdfUniform = mk('u-nsdf', 80, uniform)

    this.resetSpectra()
    device.queue.writeBuffer(this.timebaseBuf, 0, new Float32Array([1024, 1024, 0, 0]))

    // --- layouts ---
    const ro: GPUBufferBindingLayout = { type: 'read-only-storage' }
    const rw: GPUBufferBindingLayout = { type: 'storage' }
    const un: GPUBufferBindingLayout = { type: 'uniform' }
    const C = GPUShaderStage.COMPUTE
    const entries = (list: GPUBufferBindingLayout[]): GPUBindGroupLayoutEntry[] =>
      list.map((buffer, binding) => ({ binding, visibility: C, buffer }))

    this.prepareLayout = device.createBindGroupLayout({
      label: 'prepare',
      entries: entries([un, ro, ro, rw]),
    })
    this.fftLayout = device.createBindGroupLayout({
      label: 'fft',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform', hasDynamicOffset: true } },
        { binding: 1, visibility: C, buffer: ro },
        { binding: 2, visibility: C, buffer: rw },
        { binding: 3, visibility: C, buffer: ro },
      ],
    })
    this.unpackLayout = device.createBindGroupLayout({
      label: 'unpack',
      entries: entries([un, ro, rw, ro]),
    })
    // The two analyze entry points run in the same submission with different thread counts.
    // queue.writeBuffer is ordered *before* the whole command buffer, so writing one uniform
    // twice would give both passes the second value. Dynamic offsets keep them independent.
    this.analyzeLayout = device.createBindGroupLayout({
      label: 'analyze',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform', hasDynamicOffset: true } },
        { binding: 1, visibility: C, buffer: ro },
        { binding: 2, visibility: C, buffer: rw },
        { binding: 3, visibility: C, buffer: rw },
        { binding: 4, visibility: C, buffer: rw },
        { binding: 5, visibility: C, buffer: rw },
      ],
    })
    this.envLayout = device.createBindGroupLayout({
      label: 'envelope',
      entries: entries([un, ro, rw, ro]),
    })
    this.specColsLayout = device.createBindGroupLayout({
      label: 'speccols',
      entries: entries([un, ro, ro, ro, rw]),
    })
    this.nsdfLayout = device.createBindGroupLayout({
      label: 'nsdf',
      entries: entries([un, ro, rw, rw]),
    })

    const pipeline = (
      label: string,
      layout: GPUBindGroupLayout,
      code: string,
      entryPoint: string,
    ): GPUComputePipeline =>
      device.createComputePipeline({
        label,
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module: device.createShaderModule({ label, code }), entryPoint },
      })

    this.preparePipeline = pipeline('prepare', this.prepareLayout, prepareWgsl, 'main')
    const fftModule = device.createShaderModule({ label: 'fft', code: fftWgsl })
    const fftPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.fftLayout] })
    this.radix2Pipeline = device.createComputePipeline({
      label: 'fft-radix2',
      layout: fftPipelineLayout,
      compute: { module: fftModule, entryPoint: 'radix2' },
    })
    this.radix4Pipeline = device.createComputePipeline({
      label: 'fft-radix4',
      layout: fftPipelineLayout,
      compute: { module: fftModule, entryPoint: 'radix4' },
    })
    this.unpackPipeline = pipeline('unpack', this.unpackLayout, unpackWgsl, 'main')

    const analyzeModule = device.createShaderModule({ label: 'analyze', code: analyzeWgsl })
    const analyzeLayoutPipeline = device.createPipelineLayout({
      bindGroupLayouts: [this.analyzeLayout],
    })
    this.spectraPipeline = device.createComputePipeline({
      label: 'analyze-spectra',
      layout: analyzeLayoutPipeline,
      compute: { module: analyzeModule, entryPoint: 'spectra' },
    })
    this.reassignPipeline = device.createComputePipeline({
      label: 'analyze-reassign',
      layout: analyzeLayoutPipeline,
      compute: { module: analyzeModule, entryPoint: 'reassign' },
    })

    this.envelopePipeline = pipeline('envelope', this.envLayout, envelopeWgsl, 'main')
    this.specColsPipeline = pipeline('speccols', this.specColsLayout, speccolsWgsl, 'main')

    const nsdfModule = device.createShaderModule({ label: 'nsdf', code: nsdfWgsl })
    const nsdfPipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.nsdfLayout],
    })
    this.correlatePipeline = device.createComputePipeline({
      label: 'nsdf-correlate',
      layout: nsdfPipelineLayout,
      compute: { module: nsdfModule, entryPoint: 'correlate' },
    })
    this.pickPipeline = device.createComputePipeline({
      label: 'nsdf-pick',
      layout: nsdfPipelineLayout,
      compute: { module: nsdfModule, entryPoint: 'pick' },
    })
  }

  get ringCapacity(): number {
    return this.ring?.capacity ?? 0
  }

  get ringChannels(): number {
    return this.ring?.channels ?? 0
  }

  get sampleRate(): number {
    return this.ring?.sampleRate ?? 48000
  }

  get audioBuffer(): GPUBuffer | null {
    return this.audioBuf
  }

  get head(): number {
    return this.gpuHead
  }

  attach(ring: AudioRing | null): void {
    this.ring = ring
    this.audioBuf?.destroy()
    this.audioBuf = null
    this.prepareBind = null
    this.envBind = null
    this.nsdfBind = null
    this.analysisCursor = -1
    this.droppedFrames = 0
    // Nothing the previous source deposited in the integrators describes this one.
    this.resetSpectra()
    if (!ring) return

    this.audioBuf = this.device.createBuffer({
      label: 'audio-ring-mirror',
      size: ring.capacity * ring.channels * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    this.uploadCursor = ring.writeIndex
    this.gpuHead = this.uploadCursor
    this.buildAudioBindGroups()
  }

  private buildAudioBindGroups(): void {
    const audio = this.audioBuf
    if (!audio) return
    const dev = this.device
    this.prepareBind = dev.createBindGroup({
      layout: this.prepareLayout,
      entries: [
        { binding: 0, resource: { buffer: this.prepareUniform } },
        { binding: 1, resource: { buffer: audio } },
        { binding: 2, resource: { buffer: this.windowBuf } },
        { binding: 3, resource: { buffer: this.fftA } },
      ],
    })
    this.envBind = dev.createBindGroup({
      layout: this.envLayout,
      entries: [
        { binding: 0, resource: { buffer: this.envUniform } },
        { binding: 1, resource: { buffer: audio } },
        { binding: 2, resource: { buffer: this.envBuf } },
        { binding: 3, resource: { buffer: this.timebaseBuf } },
      ],
    })
    this.nsdfBind = dev.createBindGroup({
      layout: this.nsdfLayout,
      entries: [
        { binding: 0, resource: { buffer: this.nsdfUniform } },
        { binding: 1, resource: { buffer: audio } },
        { binding: 2, resource: { buffer: this.nsdfBuf } },
        { binding: 3, resource: { buffer: this.timebaseBuf } },
      ],
    })

    if (this.fftBindAB) return
    const fftBind = (src: GPUBuffer, dst: GPUBuffer) =>
      dev.createBindGroup({
        layout: this.fftLayout,
        entries: [
          { binding: 0, resource: { buffer: this.fftUniform, size: 32 } },
          { binding: 1, resource: { buffer: src } },
          { binding: 2, resource: { buffer: dst } },
          { binding: 3, resource: { buffer: this.twiddleBuf } },
        ],
      })
    this.fftBindAB = fftBind(this.fftA, this.fftB)
    this.fftBindBA = fftBind(this.fftB, this.fftA)

    const unpackBind = (src: GPUBuffer) =>
      dev.createBindGroup({
        layout: this.unpackLayout,
        entries: [
          { binding: 0, resource: { buffer: this.unpackUniform } },
          { binding: 1, resource: { buffer: src } },
          { binding: 2, resource: { buffer: this.binsBuf } },
          { binding: 3, resource: { buffer: this.twiddleBuf } },
        ],
      })
    this.unpackBindA = unpackBind(this.fftA)
    this.unpackBindB = unpackBind(this.fftB)

    this.analyzeBind = dev.createBindGroup({
      layout: this.analyzeLayout,
      entries: [
        { binding: 0, resource: { buffer: this.analyzeUniform, size: 80 } },
        { binding: 1, resource: { buffer: this.binsBuf } },
        { binding: 2, resource: { buffer: this.spectrumBuf } },
        { binding: 3, resource: { buffer: this.peaksBuf } },
        { binding: 4, resource: { buffer: this.averageBuf } },
        { binding: 5, resource: { buffer: this.pointsBuf } },
      ],
    })
    this.specColsBind = dev.createBindGroup({
      layout: this.specColsLayout,
      entries: [
        { binding: 0, resource: { buffer: this.specColsUniform } },
        { binding: 1, resource: { buffer: this.spectrumBuf } },
        { binding: 2, resource: { buffer: this.peaksBuf } },
        { binding: 3, resource: { buffer: this.averageBuf } },
        { binding: 4, resource: { buffer: this.specColsBuf } },
      ],
    })
  }

  /** Rebuild the window and twiddle tables when the transform configuration changes. */
  /**
   * Clear the integrators that carry state from one frame to the next.
   *
   * Peak hold and the Welch average are indexed by `channel * (fftSize/2 + 1) + bin`, so a
   * change of FFT size does not merely leave them stale — it re-points every stored value at a
   * different frequency. A change of scale re-points them at a different *unit*, amplitude and
   * spectral density being orders of magnitude apart. Neither is something a decay can walk
   * out of: the old contents have to go, or two sources' measurements are read as one.
   *
   * Peak hold starts at the floor rather than at zero, otherwise the first frames show a
   * full-scale peak line while the decay walks it back down.
   */
  resetSpectra(): void {
    const count = 2 * (MAX_FFT_SIZE / 2 + 1)
    const floored = new Float32Array(count).fill(-200)
    this.device.queue.writeBuffer(this.spectrumBuf, 0, floored)
    this.device.queue.writeBuffer(this.peaksBuf, 0, floored)
    this.device.queue.writeBuffer(this.averageBuf, 0, new Float32Array(count))
  }

  private ensureTables(s: AnalyzerSettings): WindowTables {
    const key = `${s.fftSize}|${s.window}|${s.windowParam}`
    if (this.tables && this.tableKey === key) return this.tables

    const tables = buildWindowTables(s.window, s.fftSize, s.windowParam)
    const packed = new Float32Array(s.fftSize * 3)
    packed.set(tables.w, 0)
    packed.set(tables.tw, s.fftSize)
    packed.set(tables.dw, s.fftSize * 2)
    this.device.queue.writeBuffer(this.windowBuf, 0, packed)

    if (this.twiddleSize !== s.fftSize) {
      const table = new Float32Array(s.fftSize * 2)
      for (let m = 0; m < s.fftSize; m++) {
        const a = (-2 * Math.PI * m) / s.fftSize
        table[m * 2] = Math.cos(a)
        table[m * 2 + 1] = Math.sin(a)
      }
      this.device.queue.writeBuffer(this.twiddleBuf, 0, table)
      this.twiddleSize = s.fftSize
    }

    this.tables = tables
    this.tableKey = key
    return tables
  }

  /** Pull newly captured audio into the GPU mirror. Returns the frame index now on the GPU. */
  private upload(): number {
    const ring = this.ring
    const audio = this.audioBuf
    if (!ring || !audio) return this.gpuHead

    const head = ring.writeIndex
    let avail = (head - this.uploadCursor) & COUNTER_MASK
    if (avail === 0) {
      this.gpuHead = head
      return head
    }
    if (avail > ring.capacity) {
      // The audio thread lapped us: the oldest pending frames no longer exist.
      this.lappedFrames += avail - ring.capacity
      avail = ring.capacity
      this.uploadCursor = (head - ring.capacity) & COUNTER_MASK
    }

    const start = this.uploadCursor & ring.mask
    const firstRun = Math.min(avail, ring.capacity - start)
    for (let c = 0; c < ring.channels; c++) {
      const plane = ring.plane(c)
      const planeBase = c * ring.capacity
      this.device.queue.writeBuffer(
        audio,
        (planeBase + start) * 4,
        plane,
        start,
        firstRun,
      )
      if (firstRun < avail) {
        this.device.queue.writeBuffer(audio, planeBase * 4, plane, 0, avail - firstRun)
      }
    }

    this.uploadCursor = head
    this.gpuHead = head
    return head
  }

  /**
   * Records the analysis chain. Returns null when no new analysis frame is ready, in which
   * case the previous results remain valid and the renderer simply redraws them.
   */
  record(encoder: GPUCommandEncoder, opts: RecordOptions): FrameStats {
    const { settings, trigger, axis, waveColumns, maxFramesPerRender, spectral } = opts
    const ring = this.ring
    const head = this.upload()
    const stats: FrameStats = {
      frames: 0,
      dropped: this.droppedFrames,
      lapped: this.lappedFrames,
      head,
      sampleRate: this.sampleRate,
      binCount: settings.fftSize / 2 + 1,
      hopHz: this.sampleRate / Math.max(1, settings.hop),
      pointCount: 0,
      reassigned: false,
    }
    if (!ring || !this.audioBuf) return stats

    const tables = this.ensureTables(settings)
    const n = settings.fftSize
    const l = n >> 1
    const hop = Math.max(1, settings.hop)
    const channels = Math.max(1, Math.min(2, settings.channelCount))
    // A window that does not taper has no derivative for the frequency correction to read, and
    // running the two extra transforms to compute a correction that is identically zero is
    // worse than not running them: it looks like reassignment is on. Refuse instead, and say so
    // through the statistics so the readout can too.
    const reassign = settings.reassign && tables.endpointRatio <= REASSIGN_ENDPOINT_LIMIT
    const variants = reassign ? 3 : 1
    stats.reassigned = reassign

    // How many complete analysis windows are waiting?
    if (this.analysisCursor < 0) this.analysisCursor = (head - n) & COUNTER_MASK
    let span = (head - this.analysisCursor) & COUNTER_MASK
    if (span > ring.capacity) {
      // The render loop stalled long enough that the ring wrapped past us.
      this.analysisCursor = (head - n) & COUNTER_MASK
      span = n
    }
    let pending = span >= n ? Math.floor((span - n) / hop) + 1 : 0

    // Cap the batch by every budget it has to fit inside, not just the transform's: the point
    // cloud is written by the same dispatch and overflowing it loses measurements silently.
    // Frames shed here go through the drop counter, so the statistics say what happened.
    const perFrame = l * variants * channels
    const budgetFrames = Math.max(1, Math.floor(COMPLEX_BUDGET / perFrame))
    const pointFrames = Math.max(1, Math.floor(POINT_BUDGET / (l + 1)))
    const limit = Math.max(1, Math.min(maxFramesPerRender, budgetFrames, pointFrames))
    if (pending > limit) {
      const skip = pending - limit
      this.analysisCursor = (this.analysisCursor + skip * hop) & COUNTER_MASK
      this.droppedFrames += skip
      stats.dropped = this.droppedFrames
      pending = limit
    }

    // The waveform path is independent of the transform: it runs every rendered frame even
    // when no new analysis window has completed, so the trace never stutters.
    if (waveColumns > 0) {
      this.recordTrigger(encoder, trigger, head, settings)
      this.recordEnvelope(encoder, settings, waveColumns, head)
    }

    if (!spectral) {
      // Keep the cursor at the head so switching back into a spectral mode does not have to
      // chew through a backlog of stale windows.
      this.analysisCursor = (head - n) & COUNTER_MASK
      return stats
    }
    if (pending === 0) return stats

    const startFrame = this.analysisCursor
    this.analysisCursor = (this.analysisCursor + pending * hop) & COUNTER_MASK
    stats.frames = pending

    const batch = pending * variants * channels
    const ampScale =
      settings.scale === 'density'
        ? Math.sqrt(2 / (this.sampleRate * tables.s2))
        : tables.amplitudeScale

    const spectraKey = `${n}|${settings.window}|${settings.windowParam}|${settings.scale}|${channels}`
    if (this.spectraKey !== spectraKey) {
      this.spectraKey = spectraKey
      this.resetSpectra()
    }

    this.recordPrepare(encoder, settings, startFrame, pending, channels, variants)
    const finalBuffer = this.recordFft(encoder, l, n, batch)
    this.recordUnpack(encoder, l, n, batch, finalBuffer)
    this.recordAnalyze(encoder, settings, pending, channels, variants, ampScale, hop, reassign)
    if (axis.columns > 0) this.recordSpectrumColumns(encoder, settings, axis, channels)

    stats.pointCount = pending * (l + 1)
    return stats
  }

  private recordPrepare(
    encoder: GPUCommandEncoder,
    s: AnalyzerSettings,
    startFrame: number,
    frames: number,
    channels: number,
    variants: number,
  ): void {
    const ring = this.ring!
    const l = s.fftSize >> 1
    const total = l * frames * variants * channels
    const u = this.scratchU32
    const f = this.scratchF32
    u[0] = s.fftSize
    u[1] = l
    u[2] = s.hop
    u[3] = startFrame >>> 0
    u[4] = frames
    u[5] = channels
    u[6] = variants
    u[7] = ring.capacity
    u[8] = ring.channels
    u[9] = total
    u[10] = 0
    u[11] = 0
    f[12] = s.mix[0]
    f[13] = s.mix[1]
    f[14] = 0
    f[15] = 0
    f[16] = s.mix[2]
    f[17] = s.mix[3]
    f[18] = 0
    f[19] = 0
    this.device.queue.writeBuffer(this.prepareUniform, 0, this.scratch, 0, 80)

    const pass = encoder.beginComputePass({ label: 'prepare' })
    pass.setPipeline(this.preparePipeline)
    pass.setBindGroup(0, this.prepareBind!)
    pass.dispatchWorkgroups(Math.ceil(total / WORKGROUP))
    pass.end()
  }

  /** Records the Stockham stage chain and returns whichever buffer holds the result. */
  private recordFft(
    encoder: GPUCommandEncoder,
    l: number,
    n: number,
    batch: number,
  ): GPUBuffer {
    const stages: { pipeline: GPUComputePipeline; threads: number }[] = []
    const params = new Uint32Array(20 * (UNIFORM_STRIDE / 4))

    const push = (radix: 2 | 4, p: number) => {
      const threadsPerTransform = l / radix
      const threads = threadsPerTransform * batch
      const unit = radix === 2 ? l / p : l / (2 * p)
      const base = stages.length * (UNIFORM_STRIDE / 4)
      params[base + 0] = l
      params[base + 1] = p
      params[base + 2] = unit
      params[base + 3] = threadsPerTransform
      params[base + 4] = batch
      params[base + 5] = n - 1
      params[base + 6] = threads
      params[base + 7] = 0
      stages.push({
        pipeline: radix === 2 ? this.radix2Pipeline : this.radix4Pipeline,
        threads,
      })
    }

    let p = 1
    const bits = Math.log2(l)
    if (bits % 2 === 1) {
      push(2, 1)
      p = 2
    }
    while (p < l) {
      push(4, p)
      p *= 4
    }

    this.device.queue.writeBuffer(
      this.fftUniform,
      0,
      params.buffer,
      0,
      stages.length * UNIFORM_STRIDE,
    )

    const pass = encoder.beginComputePass({ label: 'fft' })
    let srcIsA = true
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i]
      pass.setPipeline(stage.pipeline)
      pass.setBindGroup(0, srcIsA ? this.fftBindAB! : this.fftBindBA!, [i * UNIFORM_STRIDE])
      pass.dispatchWorkgroups(Math.ceil(stage.threads / WORKGROUP))
      srcIsA = !srcIsA
    }
    pass.end()

    // After an even number of stages the data is back in A.
    return srcIsA ? this.fftA : this.fftB
  }

  private recordUnpack(
    encoder: GPUCommandEncoder,
    l: number,
    n: number,
    batch: number,
    src: GPUBuffer,
  ): void {
    const total = (l + 1) * batch
    const u = this.scratchU32
    u[0] = l
    u[1] = n
    u[2] = batch
    u[3] = total
    this.device.queue.writeBuffer(this.unpackUniform, 0, this.scratch, 0, 16)

    const pass = encoder.beginComputePass({ label: 'unpack' })
    pass.setPipeline(this.unpackPipeline)
    pass.setBindGroup(0, src === this.fftA ? this.unpackBindA! : this.unpackBindB!)
    pass.dispatchWorkgroups(Math.ceil(total / WORKGROUP))
    pass.end()
  }

  private recordAnalyze(
    encoder: GPUCommandEncoder,
    s: AnalyzerSettings,
    frames: number,
    channels: number,
    variants: number,
    ampScale: number,
    hop: number,
    reassign: boolean,
  ): void {
    const l = s.fftSize >> 1
    const binStride = l + 1
    const spectraThreads = binStride * channels
    const pointThreads = binStride * frames
    const displayChannel = Math.min(s.displayChannel, channels - 1)

    // Peak hold falls at a fixed rate per second; convert to per analysis frame so the visual
    // decay rate is independent of hop size, sample rate *and* display rate. The shader applies
    // it once per frame inside its loop, so this must not be multiplied up by the batch length.
    const framesPerSecond = this.sampleRate / hop
    const decayPerFrame = s.peakDecayDbPerSecond / framesPerSecond

    // The averaging coefficient is given per second of audio for the same reason.
    const alpha =
      s.averaging <= 0 ? 1 : Math.min(1, 1 - Math.exp(-1 / (s.averaging * framesPerSecond)))

    const binHz = this.sampleRate / s.fftSize
    const u = this.scratchU32
    const f = this.scratchF32
    u[0] = l
    u[1] = channels
    u[2] = frames
    u[3] = variants
    u[4] = displayChannel
    u[5] = reassign && variants >= 3 ? 1 : 0
    u[6] = spectraThreads
    u[7] = s.fftSize
    f[8] = ampScale
    f[9] = decayPerFrame
    f[10] = alpha
    f[11] = s.floorDb
    f[12] = this.sampleRate
    f[13] = hop
    f[14] = s.maxTimeShift * s.fftSize
    f[15] = s.maxFreqShiftBins * binHz
    // Half in amplitude, 1/sqrt(2) in density — see the note over `amplitudeAt`. Getting this
    // from the scale rather than hardcoding it is the difference between a correct DC reading
    // and one 3.01 dB low.
    f[16] = s.scale === 'density' ? Math.SQRT1_2 : 0.5
    f[17] = 0
    f[18] = 0
    f[19] = 0
    this.device.queue.writeBuffer(this.analyzeUniform, 0, this.scratch, 0, 80)
    u[6] = pointThreads
    this.device.queue.writeBuffer(this.analyzeUniform, UNIFORM_STRIDE, this.scratch, 0, 80)

    const pass = encoder.beginComputePass({ label: 'analyze' })
    pass.setPipeline(this.spectraPipeline)
    pass.setBindGroup(0, this.analyzeBind!, [0])
    pass.dispatchWorkgroups(Math.ceil(spectraThreads / WORKGROUP))
    pass.setPipeline(this.reassignPipeline)
    pass.setBindGroup(0, this.analyzeBind!, [UNIFORM_STRIDE])
    pass.dispatchWorkgroups(Math.ceil(pointThreads / WORKGROUP))
    pass.end()
  }

  private recordSpectrumColumns(
    encoder: GPUCommandEncoder,
    s: AnalyzerSettings,
    axis: SpectrumAxis,
    channels: number,
  ): void {
    const columns = Math.max(1, Math.min(MAX_COLUMNS, axis.columns))
    const u = this.scratchU32
    const f = this.scratchF32
    u[0] = columns
    u[1] = channels
    u[2] = s.fftSize / 2 + 1
    u[3] = axis.source === 'average' ? 1 : 0
    f[4] = this.sampleRate
    f[5] = s.fftSize
    f[6] = axis.freqMin
    f[7] = axis.freqMax
    f[8] = axis.logFrequency ? 1 : 0
    f[9] = s.floorDb
    f[10] = 0
    f[11] = 0
    this.device.queue.writeBuffer(this.specColsUniform, 0, this.scratch, 0, 48)

    const pass = encoder.beginComputePass({ label: 'spectrum-columns' })
    pass.setPipeline(this.specColsPipeline)
    pass.setBindGroup(0, this.specColsBind!)
    pass.dispatchWorkgroups(columns * channels)
    pass.end()
  }

  private recordEnvelope(
    encoder: GPUCommandEncoder,
    s: AnalyzerSettings,
    columns: number,
    head: number,
  ): void {
    const ring = this.ring!
    const cols = Math.max(1, Math.min(MAX_COLUMNS, columns))
    const channels = Math.max(1, Math.min(2, s.channelCount))
    const u = this.scratchU32
    const f = this.scratchF32
    u[0] = cols
    u[1] = channels
    u[2] = ring.capacity
    u[3] = ring.channels
    u[4] = head >>> 0
    u[5] = 0
    u[6] = 0
    u[7] = 0
    f[8] = s.mix[0]
    f[9] = s.mix[1]
    f[10] = 0
    f[11] = 0
    f[12] = s.mix[2]
    f[13] = s.mix[3]
    f[14] = 0
    f[15] = 0
    this.device.queue.writeBuffer(this.envUniform, 0, this.scratch, 0, 64)

    const pass = encoder.beginComputePass({ label: 'envelope' })
    pass.setPipeline(this.envelopePipeline)
    pass.setBindGroup(0, this.envBind!)
    pass.dispatchWorkgroups(cols * channels)
    pass.end()
  }

  private recordTrigger(
    encoder: GPUCommandEncoder,
    t: TriggerSettings,
    head: number,
    s: AnalyzerSettings,
  ): void {
    const ring = this.ring!
    const span = Math.max(16, Math.min(t.spanSamples, ring.capacity / 2))

    if (t.mode === 'free') {
      // Nothing to search for: the view simply ends at the write head.
      this.device.queue.writeBuffer(this.timebaseBuf, 0, new Float32Array([span, span, 0, 0]))
      return
    }

    const minLag = Math.max(2, Math.floor(this.sampleRate / Math.max(1, t.pitchMaxHz)))
    const maxLag = Math.min(
      MAX_LAGS + minLag,
      Math.ceil(this.sampleRate / Math.max(1, t.pitchMinHz)),
    )
    const lagCount = Math.max(1, Math.min(MAX_LAGS, maxLag - minLag))
    // The correlation window must comfortably contain a few periods of the lowest pitch we
    // claim to track, otherwise the NSDF has too few overlapping samples to be meaningful.
    const windowLen = Math.min(ring.capacity / 4, Math.max(2048, maxLag * 3))

    const u = this.scratchU32
    const f = this.scratchF32
    u[0] = windowLen
    u[1] = minLag
    u[2] = maxLag
    u[3] = ring.capacity
    u[4] = head >>> 0
    u[5] = ring.channels
    u[6] = lagCount
    u[7] = t.mode === 'pitch' ? 2 : 1
    f[8] = t.clarityThreshold
    f[9] = t.level
    f[10] = t.edge
    f[11] = span
    f[12] = this.sampleRate
    f[13] = Math.max(0.25, t.cycles)
    f[14] = 16
    f[15] = Math.min(ring.capacity / 2, 1 << 22)
    f[16] = s.mix[0]
    f[17] = s.mix[1]
    f[18] = 0
    f[19] = 0
    this.device.queue.writeBuffer(this.nsdfUniform, 0, this.scratch, 0, 80)

    const pass = encoder.beginComputePass({ label: 'trigger' })
    if (t.mode === 'pitch') {
      pass.setPipeline(this.correlatePipeline)
      pass.setBindGroup(0, this.nsdfBind!)
      pass.dispatchWorkgroups(lagCount)
    }
    pass.setPipeline(this.pickPipeline)
    pass.setBindGroup(0, this.nsdfBind!)
    pass.dispatchWorkgroups(1)
    pass.end()
  }

  /**
   * Latest GPU-resolved timebase: [view offset behind head, view width, clarity, pitch Hz].
   *
   * The waveform path never needs this on the CPU — the trigger, the envelope reduction and
   * the draw call all read the buffer directly on the GPU, which is what keeps the trace
   * latency-free. It is copied back only so the readout can display the detected pitch, and
   * only when a previous copy is not still in flight, so a slow map never stalls the frame.
   */
  get timebase(): Float32Array {
    return this.timebaseValue
  }

  requestTimebaseReadback(): void {
    if (this.timebasePending) return
    if (!this.timebaseStaging) {
      this.timebaseStaging = this.device.createBuffer({
        label: 'timebase-readback',
        size: 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      })
    }
    const staging = this.timebaseStaging
    this.timebasePending = true
    const encoder = this.device.createCommandEncoder({ label: 'timebase-readback' })
    encoder.copyBufferToBuffer(this.timebaseBuf, 0, staging, 0, 16)
    this.device.queue.submit([encoder.finish()])
    staging
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        this.timebaseValue.set(new Float32Array(staging.getMappedRange()))
        staging.unmap()
        this.timebasePending = false
      })
      .catch(() => {
        this.timebasePending = false
      })
  }

  /**
   * Numerical self-check: pushes a synthetic signal through the real GPU pipeline and compares
   * the result against the f64 CPU reference in dsp/fft.ts. A GPU FFT is exactly the kind of
   * code that can be subtly wrong — a sign flipped in a butterfly, a twiddle indexed off by a
   * stride — and still produce a plausible-looking spectrum. This turns "looks right" into a
   * number.
   */
  async selfTest(size = 4096): Promise<{ maxError: number; rmsError: number; peakBinHz: number }> {
    const dev = this.device
    const l = size >> 1
    const n = size

    const tables = buildWindowTables('hann', size, 0)
    const packed = new Float32Array(size * 3)
    packed.set(tables.w, 0)
    packed.set(tables.tw, size)
    packed.set(tables.dw, size * 2)
    dev.queue.writeBuffer(this.windowBuf, 0, packed)

    const twiddle = new Float32Array(size * 2)
    for (let m = 0; m < size; m++) {
      const a = (-2 * Math.PI * m) / size
      twiddle[m * 2] = Math.cos(a)
      twiddle[m * 2 + 1] = Math.sin(a)
    }
    dev.queue.writeBuffer(this.twiddleBuf, 0, twiddle)
    this.tableKey = ''
    this.twiddleSize = 0

    // Two tones plus noise: an exact-bin tone to check scaling, an off-bin tone to exercise
    // leakage, and noise so cancellation errors cannot hide.
    const signal = new Float32Array(size)
    for (let i = 0; i < size; i++) {
      signal[i] =
        0.5 * Math.sin((2 * Math.PI * 64 * i) / size) +
        0.25 * Math.sin((2 * Math.PI * (200.37 * i)) / size) +
        0.01 * (Math.random() * 2 - 1)
    }

    const scratchAudio = dev.createBuffer({
      size: size * 4 * 2,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    dev.queue.writeBuffer(scratchAudio, 0, signal)
    dev.queue.writeBuffer(scratchAudio, size * 4, signal)

    const bind = dev.createBindGroup({
      layout: this.prepareLayout,
      entries: [
        { binding: 0, resource: { buffer: this.prepareUniform } },
        { binding: 1, resource: { buffer: scratchAudio } },
        { binding: 2, resource: { buffer: this.windowBuf } },
        { binding: 3, resource: { buffer: this.fftA } },
      ],
    })

    const u = this.scratchU32
    const f = this.scratchF32
    u[0] = size
    u[1] = l
    u[2] = size
    u[3] = 0
    u[4] = 1
    u[5] = 1
    u[6] = 1
    u[7] = size // capacity == the scratch length, so the mask works out
    u[8] = 1
    u[9] = l
    u[10] = 0
    u[11] = 0
    f[12] = 1
    f[13] = 0
    f[14] = 0
    f[15] = 0
    f[16] = 0
    f[17] = 0
    f[18] = 0
    f[19] = 0
    dev.queue.writeBuffer(this.prepareUniform, 0, this.scratch, 0, 80)

    const encoder = dev.createCommandEncoder({ label: 'selftest' })
    const pass = encoder.beginComputePass()
    pass.setPipeline(this.preparePipeline)
    pass.setBindGroup(0, bind)
    pass.dispatchWorkgroups(Math.ceil(l / WORKGROUP))
    pass.end()

    const finalBuffer = this.recordFft(encoder, l, n, 1)
    this.recordUnpack(encoder, l, n, 1, finalBuffer)

    const readback = dev.createBuffer({
      size: (l + 1) * 8,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    encoder.copyBufferToBuffer(this.binsBuf, 0, readback, 0, (l + 1) * 8)
    dev.queue.submit([encoder.finish()])

    await readback.mapAsync(GPUMapMode.READ)
    const gpu = new Float32Array(readback.getMappedRange().slice(0))
    readback.unmap()
    readback.destroy()
    scratchAudio.destroy()

    const windowed = new Float64Array(size)
    for (let i = 0; i < size; i++) windowed[i] = signal[i] * tables.w[i]
    const cpu = fftReal(windowed, size)

    let maxError = 0
    let sumSq = 0
    let scale = 0
    for (let k = 0; k <= l; k++) scale = Math.max(scale, Math.hypot(cpu[k * 2], cpu[k * 2 + 1]))
    for (let k = 0; k <= l; k++) {
      const dr = gpu[k * 2] - cpu[k * 2]
      const di = gpu[k * 2 + 1] - cpu[k * 2 + 1]
      const e = Math.hypot(dr, di) / Math.max(scale, 1e-12)
      maxError = Math.max(maxError, e)
      sumSq += e * e
    }

    let peakBin = 0
    let peakMag = 0
    for (let k = 0; k <= l; k++) {
      const m = Math.hypot(gpu[k * 2], gpu[k * 2 + 1])
      if (m > peakMag) {
        peakMag = m
        peakBin = k
      }
    }

    // Restore the live configuration; the test clobbered the shared tables.
    this.tables = null
    return {
      maxError,
      rmsError: Math.sqrt(sumSq / (l + 1)),
      peakBinHz: peakBin,
    }
  }
}
