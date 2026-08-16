/**
 * Render side of the pipeline.
 *
 * Everything is drawn additively into a linear rgba16float target. That single decision drives
 * most of the visual quality: overlapping traces sum instead of overwriting, so density
 * becomes brightness the way it does on a phosphor screen, and there is enough range above
 * 1.0 for the tone mapper to have something to do. Clipping to 8-bit sRGB before tone mapping
 * would throw all of that away.
 *
 * Pass order per frame:
 *   spectrogram history (splat)  -> only in spectrogram mode
 *   scene (MSAA, cleared)        -> graticule + mode geometry, resolved to a sampleable texture
 *   accumulator                  -> decayed by the persistence constant, then scene added
 *   bloom                        -> bright pass at quarter resolution, separable blur
 *   present                      -> tone map, composite over the background, encode sRGB
 *
 * One rule governs every uniform write here: `queue.writeBuffer` is ordered ahead of the whole
 * command buffer, not interleaved with the draws inside it. Two draws in one submission can
 * therefore never see two different values of the same uniform range. Where that is needed,
 * the data goes in separate buffers or is selected by instance index.
 */

import type { Config, Mode } from '../config.ts'
import { channelMix } from '../config.ts'
import { hexToLinearRgb, paletteById, rasterisePalette } from './colormap.ts'
import type { Analyzer, FrameStats } from './analyzer.ts'
import type { GridLine } from '../ui/axes.ts'

import commonWgsl from './shaders/common.wgsl?raw'
import drawWaveWgsl from './shaders/draw_wave.wgsl?raw'
import drawSpectrumWgsl from './shaders/draw_spectrum.wgsl?raw'
import drawVectorWgsl from './shaders/draw_vector.wgsl?raw'
import gridWgsl from './shaders/grid.wgsl?raw'
import splatWgsl from './shaders/spectrogram_splat.wgsl?raw'
import sgPresentWgsl from './shaders/spectrogram_present.wgsl?raw'
import postWgsl from './shaders/post.wgsl?raw'

const SCENE_FORMAT: GPUTextureFormat = 'rgba16float'
const MAX_GRID_LINES = 256
const BLOOM_DIVISOR = 4
/** Uniform buffer slot stride; must be a multiple of minUniformBufferOffsetAlignment. */
const POST_SLOT = 256

const ADDITIVE: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
}

/** result = 0 * src + constant * dst — a multiply, driven by setBlendConstant. */
const DECAY_BLEND: GPUBlendState = {
  color: { srcFactor: 'zero', dstFactor: 'constant', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'constant', operation: 'add' },
}

export interface RenderFrame {
  config: Config
  stats: FrameStats
  graticule: GridLine[]
  width: number
  height: number
  nyquist: number
  channelCount: number
}

export class Renderer {
  private readonly device: GPUDevice
  private readonly context: GPUCanvasContext
  private readonly analyzer: Analyzer
  readonly sampleCount: number

  private width = 0
  private height = 0

  private sceneMs: GPUTexture | null = null
  private scene: GPUTexture | null = null
  private accum: GPUTexture | null = null
  private bloomA: GPUTexture | null = null
  private bloomB: GPUTexture | null = null

  private history: GPUTexture | null = null
  private historyColumns = 0
  private historyRows = 0
  private historyHead = 0
  private clearedThrough = 0
  private historyKey = ''

  private readonly styleBuf: GPUBuffer
  private readonly gridBuf: GPUBuffer
  private readonly waveParams: GPUBuffer[]
  private readonly spectrumParams: GPUBuffer[]
  private readonly vectorParams: GPUBuffer
  private readonly splatParams: GPUBuffer
  private readonly sgPresentParams: GPUBuffer
  private readonly postParams: GPUBuffer

  private readonly sampler: GPUSampler
  private readonly paletteTexture: GPUTexture
  private paletteId = ''

  private readonly waveLayout: GPUBindGroupLayout
  private readonly splatLayout: GPUBindGroupLayout
  private readonly postLayout: GPUBindGroupLayout

  private readonly gridPipeline: GPURenderPipeline
  private readonly envelopePipeline: GPURenderPipeline
  private readonly tracePipeline: GPURenderPipeline
  private readonly spectrumPipeline: GPURenderPipeline
  private readonly vectorPipeline: GPURenderPipeline
  private readonly splatPipeline: GPURenderPipeline
  private readonly historyClearPipeline: GPURenderPipeline
  private readonly sgPresentPipeline: GPURenderPipeline

  private readonly decayPipeline: GPURenderPipeline
  private readonly copyPipeline: GPURenderPipeline
  private readonly thresholdPipeline: GPURenderPipeline
  private readonly blurPipeline: GPURenderPipeline
  private readonly presentPipeline: GPURenderPipeline

  private gridBind: GPUBindGroup | null = null
  private waveBinds: GPUBindGroup[] = []
  private spectrumBinds: GPUBindGroup[] = []
  private vectorBind: GPUBindGroup | null = null
  private splatBind: GPUBindGroup | null = null
  private sgPresentBind: GPUBindGroup | null = null
  private postBinds: Record<string, GPUBindGroup> = {}

  private readonly scratch = new ArrayBuffer(256)
  private readonly u32 = new Uint32Array(this.scratch)
  private readonly f32 = new Float32Array(this.scratch)

  constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    analyzer: Analyzer,
    sampleCount = 4,
  ) {
    this.device = device
    this.context = context
    this.analyzer = analyzer
    this.sampleCount = sampleCount

    const uni = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    const stor = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST

    this.styleBuf = device.createBuffer({ label: 'style', size: 160, usage: uni })
    this.gridBuf = device.createBuffer({ label: 'grid', size: MAX_GRID_LINES * 16, usage: stor })
    this.waveParams = [0, 1].map((i) =>
      device.createBuffer({ label: `wave-${i}`, size: 48, usage: uni }),
    )
    this.spectrumParams = [0, 1].map((i) =>
      device.createBuffer({ label: `spectrum-${i}`, size: 16, usage: uni }),
    )
    this.vectorParams = device.createBuffer({ label: 'vector', size: 32, usage: uni })
    this.splatParams = device.createBuffer({ label: 'splat', size: 64, usage: uni })
    this.sgPresentParams = device.createBuffer({ label: 'sg-present', size: 48, usage: uni })
    // Three 256-byte-aligned slots: [0] the shared parameters, [1] horizontal blur,
    // [2] vertical blur. The blur direction is the only field that differs between the two
    // blur passes, and both run in the same submission, so they cannot share a range.
    this.postParams = device.createBuffer({ label: 'post', size: POST_SLOT * 3, usage: uni })

    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })
    this.paletteTexture = device.createTexture({
      label: 'palette',
      size: [256, 1],
      format: 'rgba8unorm-srgb',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })

    const module = (label: string, code: string) =>
      device.createShaderModule({ label, code: `${commonWgsl}\n${code}` })

    const waveModule = module('draw-wave', drawWaveWgsl)
    const gridModule = module('grid', gridWgsl)
    const spectrumModule = module('draw-spectrum', drawSpectrumWgsl)
    const vectorModule = module('draw-vector', drawVectorWgsl)
    const sgPresentModule = module('sg-present', sgPresentWgsl)
    // The splat shaders never reference Style, so they compile without the prelude.
    const splatModule = device.createShaderModule({ label: 'sg-splat', code: splatWgsl })
    const postModule = device.createShaderModule({ label: 'post', code: postWgsl })

    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
    const V = GPUShaderStage.VERTEX

    // The envelope and band-limited-trace pipelines read different subsets of these bindings.
    // `layout: 'auto'` would derive a *different* layout for each, and a bind group built for
    // one would then be rejected by the other. An explicit shared layout keeps one bind group
    // valid for both.
    this.waveLayout = device.createBindGroupLayout({
      label: 'wave',
      entries: [
        { binding: 0, visibility: VF, buffer: { type: 'uniform' } },
        { binding: 1, visibility: V, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: V, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: V, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: V, buffer: { type: 'uniform' } },
      ],
    })
    // Same reasoning: the clear entry point ignores the point buffer.
    this.splatLayout = device.createBindGroupLayout({
      label: 'splat',
      entries: [
        { binding: 0, visibility: VF, buffer: { type: 'uniform' } },
        { binding: 1, visibility: V, buffer: { type: 'read-only-storage' } },
      ],
    })
    this.postLayout = device.createBindGroupLayout({
      label: 'post',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    })

    const scenePipeline = (
      label: string,
      mod: GPUShaderModule,
      vs: string,
      fs: string,
      layout: GPUBindGroupLayout | 'auto' = 'auto',
    ): GPURenderPipeline =>
      device.createRenderPipeline({
        label,
        layout:
          layout === 'auto'
            ? 'auto'
            : device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module: mod, entryPoint: vs },
        fragment: {
          module: mod,
          entryPoint: fs,
          targets: [{ format: SCENE_FORMAT, blend: ADDITIVE }],
        },
        primitive: { topology: 'triangle-list' },
        multisample: { count: sampleCount },
      })

    this.gridPipeline = scenePipeline('grid', gridModule, 'vs', 'fs')
    this.envelopePipeline = scenePipeline(
      'wave-envelope',
      waveModule,
      'vsEnvelope',
      'fsEnvelope',
      this.waveLayout,
    )
    this.tracePipeline = scenePipeline(
      'wave-trace',
      waveModule,
      'vsTrace',
      'fsTrace',
      this.waveLayout,
    )
    this.spectrumPipeline = scenePipeline('spectrum', spectrumModule, 'vs', 'fs')
    this.vectorPipeline = scenePipeline('vector', vectorModule, 'vs', 'fs')
    this.sgPresentPipeline = scenePipeline('sg-present', sgPresentModule, 'vs', 'fs')

    const splatPipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.splatLayout],
    })
    this.splatPipeline = device.createRenderPipeline({
      label: 'sg-splat',
      layout: splatPipelineLayout,
      vertex: { module: splatModule, entryPoint: 'vsSplat' },
      fragment: {
        module: splatModule,
        entryPoint: 'fsSplat',
        targets: [{ format: SCENE_FORMAT, blend: ADDITIVE }],
      },
      primitive: { topology: 'triangle-list' },
    })
    this.historyClearPipeline = device.createRenderPipeline({
      label: 'sg-clear',
      layout: splatPipelineLayout,
      vertex: { module: splatModule, entryPoint: 'vsClear' },
      fragment: {
        module: splatModule,
        entryPoint: 'fsClear',
        targets: [{ format: SCENE_FORMAT }],
      },
      primitive: { topology: 'triangle-list' },
    })

    const postPipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.postLayout],
    })
    const post = (
      label: string,
      fs: string,
      target: GPUTextureFormat,
      blend?: GPUBlendState,
    ): GPURenderPipeline =>
      device.createRenderPipeline({
        label,
        layout: postPipelineLayout,
        vertex: { module: postModule, entryPoint: 'vsFull' },
        fragment: { module: postModule, entryPoint: fs, targets: [{ format: target, blend }] },
        primitive: { topology: 'triangle-list' },
      })

    this.decayPipeline = post('decay', 'fsDecay', SCENE_FORMAT, DECAY_BLEND)
    this.copyPipeline = post('accumulate', 'fsCopy', SCENE_FORMAT, ADDITIVE)
    this.thresholdPipeline = post('bloom-threshold', 'fsThreshold', SCENE_FORMAT)
    this.blurPipeline = post('bloom-blur', 'fsBlur', SCENE_FORMAT)
    this.presentPipeline = post('present', 'fsPresent', format)
  }

  /** Called when the audio source changes and the GPU-side ring mirror is replaced. */
  invalidate(): void {
    // These two bind groups reference the ring mirror, which the analyzer has just replaced.
    this.waveBinds = []
    this.vectorBind = null
    this.historyHead = 0
    this.clearedThrough = 0
    // Force the history texture to be recreated so the previous source's spectrogram does not
    // linger on screen next to the new one's.
    this.historyKey = ''
  }

  private ensureTargets(width: number, height: number): void {
    if (this.width === width && this.height === height && this.scene) return
    this.width = width
    this.height = height

    for (const t of [this.sceneMs, this.scene, this.accum, this.bloomA, this.bloomB]) t?.destroy()

    const dev = this.device
    const target = GPUTextureUsage.RENDER_ATTACHMENT
    const sample = target | GPUTextureUsage.TEXTURE_BINDING

    this.sceneMs = dev.createTexture({
      label: 'scene-msaa',
      size: [width, height],
      format: SCENE_FORMAT,
      sampleCount: this.sampleCount,
      usage: target,
    })
    this.scene = dev.createTexture({
      label: 'scene',
      size: [width, height],
      format: SCENE_FORMAT,
      usage: sample,
    })
    this.accum = dev.createTexture({
      label: 'accumulator',
      size: [width, height],
      format: SCENE_FORMAT,
      usage: sample,
    })
    const bw = Math.max(1, Math.floor(width / BLOOM_DIVISOR))
    const bh = Math.max(1, Math.floor(height / BLOOM_DIVISOR))
    this.bloomA = dev.createTexture({
      label: 'bloom-a',
      size: [bw, bh],
      format: SCENE_FORMAT,
      usage: sample,
    })
    this.bloomB = dev.createTexture({
      label: 'bloom-b',
      size: [bw, bh],
      format: SCENE_FORMAT,
      usage: sample,
    })

    const bind = (a: GPUTexture, b: GPUTexture, slot = 0): GPUBindGroup =>
      dev.createBindGroup({
        layout: this.postLayout,
        entries: [
          { binding: 0, resource: { buffer: this.postParams, offset: slot * POST_SLOT, size: 64 } },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: a.createView() },
          { binding: 3, resource: b.createView() },
        ],
      })
    this.postBinds = {
      decay: bind(this.scene, this.scene),
      copy: bind(this.scene, this.scene),
      threshold: bind(this.accum, this.accum),
      blurH: bind(this.bloomA, this.bloomA, 1),
      blurV: bind(this.bloomB, this.bloomB, 2),
      present: bind(this.accum, this.bloomA),
    }
  }

  /** The spectrogram history is sized in analysis columns, so it is rebuilt on hop/length changes. */
  private ensureHistory(config: Config, sampleRate: number, hop: number, height: number): void {
    const columns = Math.max(
      64,
      Math.min(8192, Math.ceil((config.spectrogram.historySeconds * sampleRate) / hop) + 8),
    )
    const rows = Math.max(512, Math.min(4096, 1 << Math.ceil(Math.log2(Math.max(height, 512)))))
    const key = `${columns}x${rows}`
    if (this.historyKey === key && this.history) return

    this.history?.destroy()
    this.history = this.device.createTexture({
      label: 'spectrogram-history',
      size: [columns, rows],
      format: SCENE_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.historyColumns = columns
    this.historyRows = rows
    this.historyKey = key
    this.historyHead = 0
    this.clearedThrough = 0
    this.sgPresentBind = null
  }

  private ensurePalette(id: string): void {
    if (this.paletteId === id) return
    const data = rasterisePalette(paletteById(id).stops)
    this.device.queue.writeTexture(
      { texture: this.paletteTexture },
      data,
      { bytesPerRow: 256 * 4 },
      { width: 256, height: 1 },
    )
    this.paletteId = id
    this.sgPresentBind = null
  }

  private writeStyle(frame: RenderFrame, mode: Mode): void {
    const s = frame.config.style
    const f = this.f32
    const u = this.u32
    const [pr, pg, pb] = hexToLinearRgb(s.primary)
    const [sr, sg, sb] = hexToLinearRgb(s.secondary)
    const [ar, ag, ab] = hexToLinearRgb(s.accent)
    const [br, bg, bb] = hexToLinearRgb(s.background)

    f[0] = frame.width
    f[1] = frame.height
    f[2] = 1 / frame.width
    f[3] = 1 / frame.height
    f[4] = pr
    f[5] = pg
    f[6] = pb
    f[7] = 1
    f[8] = sr
    f[9] = sg
    f[10] = sb
    f[11] = 1
    f[12] = ar
    f[13] = ag
    f[14] = ab
    f[15] = 1
    f[16] = br
    f[17] = bg
    f[18] = bb
    f[19] = 1
    f[20] = s.lineWidth
    f[21] = s.intensity
    f[22] = mode === 'wave' || mode === 'vector' ? frame.config.wave.gain : 1
    f[23] = mode === 'spectrum' ? frame.config.spectrum.fill : 1

    if (mode === 'spectrum') {
      f[24] = frame.config.spectrum.dbMin
      f[25] = frame.config.spectrum.dbMax
      f[26] = frame.config.spectrum.freqMin
      f[27] = Math.min(frame.config.spectrum.freqMax, frame.nyquist)
      f[28] = frame.config.spectrum.logFrequency ? 1 : 0
    } else {
      f[24] = frame.config.spectrogram.dbFloor
      f[25] = frame.config.spectrogram.dbCeil
      f[26] = frame.config.spectrogram.freqMin
      f[27] = Math.min(frame.config.spectrogram.freqMax, frame.nyquist)
      f[28] = frame.config.spectrogram.logFrequency ? 1 : 0
    }
    f[29] = s.gridAlpha
    f[30] = s.exposure
    f[31] = s.gamma
    f[32] = frame.stats.sampleRate
    f[33] = frame.config.analysis.fftSize
    f[34] = frame.width
    f[35] = performance.now() / 1000
    u[36] = mode === 'wave' ? 0 : mode === 'spectrum' ? 1 : mode === 'spectrogram' ? 2 : 3
    u[37] = frame.channelCount
    u[38] = frame.config.spectrum.showPeak ? 1 : 0
    u[39] = frame.config.wave.showRms ? 1 : 0

    this.device.queue.writeBuffer(this.styleBuf, 0, this.scratch, 0, 160)
  }

  private writeGrid(lines: GridLine[]): number {
    const count = Math.min(lines.length, MAX_GRID_LINES)
    if (count === 0) return 0
    const data = new Float32Array(count * 4)
    for (let i = 0; i < count; i++) {
      data[i * 4 + 0] = lines[i].pos
      data[i * 4 + 1] = lines[i].horizontal ? 1 : 0
      data[i * 4 + 2] = lines[i].weight
      data[i * 4 + 3] = lines[i].width
    }
    this.device.queue.writeBuffer(this.gridBuf, 0, data)
    return count
  }

  /** Records this frame's render passes. The caller owns the encoder and its submission. */
  render(encoder: GPUCommandEncoder, frame: RenderFrame): void {
    const cfg = frame.config
    const mode = cfg.mode
    this.ensureTargets(frame.width, frame.height)
    this.ensurePalette(cfg.spectrogram.palette)
    this.writeStyle(frame, mode)
    const gridCount = cfg.style.showGrid ? this.writeGrid(frame.graticule) : 0

    if (mode === 'spectrogram') {
      this.ensureHistory(cfg, frame.stats.sampleRate, cfg.analysis.hop, frame.height)
      this.recordSpectrogramHistory(encoder, frame)
    }

    const scenePass = encoder.beginRenderPass({
      label: 'scene',
      colorAttachments: [
        {
          view: this.sceneMs!.createView(),
          resolveTarget: this.scene!.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })

    if (gridCount > 0) {
      if (!this.gridBind) {
        this.gridBind = this.device.createBindGroup({
          layout: this.gridPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.styleBuf } },
            { binding: 1, resource: { buffer: this.gridBuf } },
          ],
        })
      }
      scenePass.setPipeline(this.gridPipeline)
      scenePass.setBindGroup(0, this.gridBind)
      scenePass.draw(6, gridCount)
    }

    switch (mode) {
      case 'wave':
        this.drawWave(scenePass, frame)
        break
      case 'spectrum':
        this.drawSpectrum(scenePass, frame)
        break
      case 'spectrogram':
        this.drawSpectrogram(scenePass, frame)
        break
      case 'vector':
        this.drawVector(scenePass, frame)
        break
    }
    scenePass.end()

    this.recordPost(encoder, frame)
  }

  // -------------------------------------------------------------------------------------
  // Mode geometry
  // -------------------------------------------------------------------------------------

  private waveBind(index: number): GPUBindGroup {
    const existing = this.waveBinds[index]
    if (existing) return existing
    const bind = this.device.createBindGroup({
      layout: this.waveLayout,
      entries: [
        { binding: 0, resource: { buffer: this.styleBuf } },
        { binding: 1, resource: { buffer: this.analyzer.envBuf } },
        { binding: 2, resource: { buffer: this.analyzer.audioBuffer! } },
        { binding: 3, resource: { buffer: this.analyzer.timebaseBuf } },
        { binding: 4, resource: { buffer: this.waveParams[index] } },
      ],
    })
    this.waveBinds[index] = bind
    return bind
  }

  private drawWave(pass: GPURenderPassEncoder, frame: RenderFrame): void {
    if (!this.analyzer.audioBuffer) return
    const cfg = frame.config
    const { mix } = channelMix(cfg.analysis.channelMode)
    const split = cfg.wave.splitChannels && frame.channelCount > 1
    const lanes = split ? frame.channelCount : 1
    const columns = Math.min(4096, Math.max(2, Math.round(frame.width)))

    const spanSamples = (cfg.wave.timebaseMs / 1000) * frame.stats.sampleRate
    const samplesPerPixel = spanSamples / Math.max(1, frame.width)
    // Below ~2 samples per pixel a straight-line join between samples is visibly not the
    // signal, so switch to band-limited reconstruction.
    const bandlimited =
      cfg.wave.trace === 'bandlimited' || (cfg.wave.trace === 'auto' && samplesPerPixel < 2)

    for (let i = 0; i < lanes; i++) {
      const laneHeight = frame.height / lanes
      const u = this.u32
      const f = this.f32
      u[0] = columns
      u[1] = this.analyzer.ringCapacity
      u[2] = this.analyzer.ringChannels
      u[3] = frame.stats.head >>> 0
      u[4] = split ? i : 0
      u[5] = frame.channelCount
      u[6] = Math.round(i * laneHeight)
      u[7] = Math.round(laneHeight)
      f[8] = mix[(split ? i : 0) * 2]
      f[9] = mix[(split ? i : 0) * 2 + 1]
      f[10] = 0
      f[11] = 0
      this.device.queue.writeBuffer(this.waveParams[i], 0, this.scratch, 0, 48)

      const bind = this.waveBind(i)
      if (bandlimited) {
        pass.setPipeline(this.tracePipeline)
        pass.setBindGroup(0, bind)
        pass.draw(6, columns)
      } else {
        pass.setPipeline(this.envelopePipeline)
        pass.setBindGroup(0, bind)
        // Instances [0, columns) draw the peak band; [columns, 2*columns) the RMS band.
        pass.draw(6, cfg.wave.showRms ? columns * 2 : columns)
      }
    }
  }

  private drawSpectrum(pass: GPURenderPassEncoder, frame: RenderFrame): void {
    const cfg = frame.config
    const columns = Math.min(4096, Math.max(2, Math.round(frame.width)))
    const split = cfg.spectrum.splitChannels && frame.channelCount > 1
    const lanes = split ? frame.channelCount : 1

    for (let i = 0; i < lanes; i++) {
      const height = frame.height / lanes
      const u = this.u32
      u[0] = columns
      u[1] = split ? i : 0
      u[2] = Math.round(i * height)
      u[3] = Math.round(height)
      this.device.queue.writeBuffer(this.spectrumParams[i], 0, this.scratch, 0, 16)

      if (!this.spectrumBinds[i]) {
        this.spectrumBinds[i] = this.device.createBindGroup({
          layout: this.spectrumPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.styleBuf } },
            { binding: 1, resource: { buffer: this.analyzer.specColsBuf } },
            { binding: 2, resource: { buffer: this.spectrumParams[i] } },
          ],
        })
      }
      pass.setPipeline(this.spectrumPipeline)
      pass.setBindGroup(0, this.spectrumBinds[i])
      // [0,n) band + fill, [n,2n) mean curve, [2n,3n) peak hold.
      pass.draw(6, columns * (cfg.spectrum.showPeak ? 3 : 2))
    }
  }

  private drawVector(pass: GPURenderPassEncoder, frame: RenderFrame): void {
    const audio = this.analyzer.audioBuffer
    if (!audio) return
    // 40 ms of trace: long enough to close the figure on low-frequency material without
    // drawing more segments than the display can resolve.
    const wanted = Math.round(frame.stats.sampleRate * 0.04)
    const decimation = Math.max(1, Math.ceil(wanted / 8192))
    const count = Math.min(8192, Math.floor(wanted / decimation))

    const u = this.u32
    const f = this.f32
    u[0] = count
    u[1] = this.analyzer.ringCapacity
    u[2] = this.analyzer.ringChannels
    u[3] = frame.stats.head >>> 0
    f[4] = 1
    f[5] = 0.6
    f[6] = 0
    f[7] = decimation
    this.device.queue.writeBuffer(this.vectorParams, 0, this.scratch, 0, 32)

    if (!this.vectorBind) {
      this.vectorBind = this.device.createBindGroup({
        layout: this.vectorPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.styleBuf } },
          { binding: 1, resource: { buffer: audio } },
          { binding: 2, resource: { buffer: this.vectorParams } },
        ],
      })
    }
    pass.setPipeline(this.vectorPipeline)
    pass.setBindGroup(0, this.vectorBind)
    pass.draw(6, Math.max(1, count - 1))
  }

  /**
   * How far the display lags the write head, in columns. Reassignment can move energy
   * backwards in time by up to half the analysis window; showing a column before those
   * corrections have landed would make the right edge visibly rewrite itself.
   */
  private spectrogramMargin(cfg: Config): number {
    const shiftSamples = cfg.analysis.maxTimeShift * cfg.analysis.fftSize
    return Math.max(1, Math.min(64, Math.ceil(shiftSamples / Math.max(1, cfg.analysis.hop)) + 1))
  }

  private recordSpectrogramHistory(encoder: GPUCommandEncoder, frame: RenderFrame): void {
    const history = this.history
    if (!history || frame.stats.frames === 0 || frame.stats.pointCount === 0) return
    const cfg = frame.config
    const cols = this.historyColumns
    const margin = this.spectrogramMargin(cfg)

    const newestColumn = this.historyHead + frame.stats.frames - 1
    // Wipe each column exactly once, `margin` columns before anything can be written into it.
    const clearTarget = newestColumn + margin + 1
    const clearFrom = this.clearedThrough
    const clearCount = Math.min(cols, Math.max(0, clearTarget - clearFrom))
    this.clearedThrough = clearTarget

    const startCol = ((clearFrom % cols) + cols) % cols
    const firstRun = Math.min(clearCount, cols - startCol)
    const wrapRun = clearCount - firstRun

    const u = this.u32
    const f = this.f32
    u[0] = frame.stats.pointCount
    u[1] = cols
    u[2] = this.historyRows
    u[3] = ((newestColumn % cols) + cols) % cols
    f[4] = cfg.analysis.hop
    f[5] = cfg.spectrogram.freqMin
    f[6] = Math.min(cfg.spectrogram.freqMax, frame.nyquist)
    f[7] = cfg.spectrogram.logFrequency ? 1 : 0
    f[8] = cfg.spectrogram.splatRadius
    f[9] = cfg.spectrogram.gain
    f[10] = startCol
    f[11] = firstRun
    f[12] = 0
    f[13] = wrapRun
    f[14] = 0
    f[15] = 0
    this.device.queue.writeBuffer(this.splatParams, 0, this.scratch, 0, 64)

    if (!this.splatBind) {
      this.splatBind = this.device.createBindGroup({
        layout: this.splatLayout,
        entries: [
          { binding: 0, resource: { buffer: this.splatParams } },
          { binding: 1, resource: { buffer: this.analyzer.pointsBuf } },
        ],
      })
    }

    const pass = encoder.beginRenderPass({
      label: 'spectrogram-history',
      colorAttachments: [{ view: history.createView(), loadOp: 'load', storeOp: 'store' }],
    })
    if (clearCount > 0) {
      pass.setPipeline(this.historyClearPipeline)
      pass.setBindGroup(0, this.splatBind)
      pass.draw(6, 2)
    }
    pass.setPipeline(this.splatPipeline)
    pass.setBindGroup(0, this.splatBind)
    pass.draw(6, frame.stats.pointCount)
    pass.end()

    this.historyHead += frame.stats.frames
  }

  private drawSpectrogram(pass: GPURenderPassEncoder, frame: RenderFrame): void {
    const history = this.history
    if (!history) return
    const cfg = frame.config
    const margin = this.spectrogramMargin(cfg)
    const visible = Math.max(
      16,
      Math.min(
        this.historyColumns - margin - 2,
        Math.ceil((cfg.spectrogram.historySeconds * frame.stats.sampleRate) / cfg.analysis.hop),
      ),
    )

    const u = this.u32
    const f = this.f32
    u[0] = this.historyColumns
    u[1] = this.historyRows
    u[2] = ((this.historyHead - 1) % this.historyColumns + this.historyColumns) % this.historyColumns
    u[3] = margin
    f[4] = visible
    f[5] = cfg.spectrogram.dbFloor
    f[6] = cfg.spectrogram.dbCeil
    f[7] = cfg.spectrogram.gain
    f[8] = cfg.spectrogram.normalise ? 1 : 0
    f[9] = 0
    f[10] = 0
    f[11] = 0
    this.device.queue.writeBuffer(this.sgPresentParams, 0, this.scratch, 0, 48)

    if (!this.sgPresentBind) {
      this.sgPresentBind = this.device.createBindGroup({
        layout: this.sgPresentPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.styleBuf } },
          { binding: 1, resource: { buffer: this.sgPresentParams } },
          { binding: 2, resource: history.createView() },
          { binding: 3, resource: this.sampler },
          { binding: 4, resource: this.paletteTexture.createView() },
          { binding: 5, resource: this.sampler },
        ],
      })
    }
    pass.setPipeline(this.sgPresentPipeline)
    pass.setBindGroup(0, this.sgPresentBind)
    pass.draw(3)
  }

  // -------------------------------------------------------------------------------------
  // Post chain
  // -------------------------------------------------------------------------------------

  private recordPost(encoder: GPUCommandEncoder, frame: RenderFrame): void {
    const s = frame.config.style
    const [br, bg, bb] = hexToLinearRgb(s.background)
    // The spectrogram already encodes time; phosphor persistence on top would only smear it.
    const persistence = frame.config.mode === 'spectrogram' ? 0 : s.persistence
    const bw = Math.max(1, Math.floor(frame.width / BLOOM_DIVISOR))
    const bh = Math.max(1, Math.floor(frame.height / BLOOM_DIVISOR))

    const f = this.f32
    f[0] = 1 / frame.width
    f[1] = 1 / frame.height
    f[2] = s.exposure
    f[3] = s.gamma
    f[4] = s.bloom
    f[5] = s.bloomThreshold
    f[6] = s.tonemap === 'aces' ? 2 : s.tonemap === 'reinhard' ? 1 : 0
    f[7] = s.saturation
    f[8] = br
    f[9] = bg
    f[10] = bb
    f[11] = s.vignette
    f[12] = 0
    f[13] = 0
    f[14] = 0
    f[15] = 0
    this.device.queue.writeBuffer(this.postParams, 0, this.scratch, 0, 64)
    f[12] = 1 / bw
    f[13] = 0
    this.device.queue.writeBuffer(this.postParams, POST_SLOT, this.scratch, 0, 64)
    f[12] = 0
    f[13] = 1 / bh
    this.device.queue.writeBuffer(this.postParams, POST_SLOT * 2, this.scratch, 0, 64)

    const accumPass = encoder.beginRenderPass({
      label: 'accumulate',
      colorAttachments: [{ view: this.accum!.createView(), loadOp: 'load', storeOp: 'store' }],
    })
    accumPass.setBlendConstant({ r: persistence, g: persistence, b: persistence, a: persistence })
    accumPass.setPipeline(this.decayPipeline)
    accumPass.setBindGroup(0, this.postBinds.decay)
    accumPass.draw(3)
    accumPass.setPipeline(this.copyPipeline)
    accumPass.setBindGroup(0, this.postBinds.copy)
    accumPass.draw(3)
    accumPass.end()

    if (s.bloom > 0) {
      const clear = { r: 0, g: 0, b: 0, a: 1 }
      const bright = encoder.beginRenderPass({
        label: 'bloom-threshold',
        colorAttachments: [
          {
            view: this.bloomA!.createView(),
            loadOp: 'clear',
            clearValue: clear,
            storeOp: 'store',
          },
        ],
      })
      bright.setPipeline(this.thresholdPipeline)
      bright.setBindGroup(0, this.postBinds.threshold)
      bright.draw(3)
      bright.end()

      // Separable Gaussian: horizontal into B, vertical back into A. 2N taps instead of N^2.
      this.blurPass(encoder, 'blurH', this.bloomB!)
      this.blurPass(encoder, 'blurV', this.bloomA!)
    }

    const presentPass = encoder.beginRenderPass({
      label: 'present',
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })
    presentPass.setPipeline(this.presentPipeline)
    presentPass.setBindGroup(0, this.postBinds.present)
    presentPass.draw(3)
    presentPass.end()
  }

  private blurPass(
    encoder: GPUCommandEncoder,
    bind: 'blurH' | 'blurV',
    target: GPUTexture,
  ): void {
    const pass = encoder.beginRenderPass({
      label: `bloom-${bind}`,
      colorAttachments: [
        {
          view: target.createView(),
          loadOp: 'clear',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          storeOp: 'store',
        },
      ],
    })
    pass.setPipeline(this.blurPipeline)
    pass.setBindGroup(0, this.postBinds[bind])
    pass.draw(3)
    pass.end()
  }
}
