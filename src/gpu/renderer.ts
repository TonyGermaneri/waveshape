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

import type { Config, LifeBlend, Mode } from '../config.ts'
import { channelMix, VECTOR_MAX_POINTS } from '../config.ts'
import { hexToLinearRgb, paletteById, rasterisePalette } from './colormap.ts'
import type { Analyzer, FrameStats } from './analyzer.ts'
import type { GridLine } from '../ui/axes.ts'
import type { Rect } from '../ui/layout.ts'

import commonWgsl from './shaders/common.wgsl?raw'
import drawWaveWgsl from './shaders/draw_wave.wgsl?raw'
import drawSpectrumWgsl from './shaders/draw_spectrum.wgsl?raw'
import drawVectorWgsl from './shaders/draw_vector.wgsl?raw'
import gridWgsl from './shaders/grid.wgsl?raw'
import splatWgsl from './shaders/spectrogram_splat.wgsl?raw'
import sgPresentWgsl from './shaders/spectrogram_present.wgsl?raw'
import lifeDrawWgsl from './shaders/life_draw.wgsl?raw'
import postWgsl from './shaders/post.wgsl?raw'

import { BLOOM_DIVISOR, SCENE_BYTES_PER_TEXEL, SCENE_FORMAT } from './limits.ts'

export { BLOOM_DIVISOR, SCENE_BYTES_PER_TEXEL, SCENE_FORMAT }

const MAX_GRID_LINES = 512

/** Uniform buffer slot stride; must be a multiple of minUniformBufferOffsetAlignment. */
const POST_SLOT = 256
/** Style is written once per pane, into its own slot of one buffer. */
const STYLE_SLOT = 256
const STYLE_BYTES = 160

const ADDITIVE: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
}

/**
 * How the population merges with what is already on the target.
 *
 * Additive is right for an instrument: density becomes brightness, and two things in the same
 * place are twice as bright as one. It is wrong for a population of tens of thousands of
 * differently-coloured organisms, because summing enough hues gets you white however saturated
 * each one was, and a crowded pane bleaches out.
 *
 * Screen sums the same way at low levels and rolls off toward one instead of past it, so
 * density still reads as brightness but never as paper. Lighten keeps whichever of the two is
 * brighter and does not sum at all: colours stay exactly as saturated as they were born, at the
 * cost of density being invisible. All three are useful and none is a default for everything,
 * which is why it is a knob.
 */
const LIFE_BLEND_MODES = ['add', 'screen', 'lighten'] as const

/** Builds one of a thing per blend mode. */
/**
 * The history texture's dimensions for a given configuration and pane height.
 *
 * Exported because the budget has to size this allocation before the renderer makes it, and two
 * copies of the arithmetic would be two chances to disagree about a quarter of a gigabyte.
 */
export function historySize(
  config: Config,
  sampleRate: number,
  hop: number,
  height: number,
): { columns: number; rows: number } {
  return {
    columns: Math.max(
      64,
      Math.min(8192, Math.ceil((config.spectrogram.historySeconds * sampleRate) / hop) + 8),
    ),
    rows: Math.max(512, Math.min(4096, 1 << Math.ceil(Math.log2(Math.max(height, 512))))),
  }
}

/** Whether the organism actually has a population this frame. */
function living(frame: RenderFrame): boolean {
  return (frame.particleCount ?? 0) > 0
}

function byBlend<T>(make: (blend: LifeBlend) => T): Record<LifeBlend, T> {
  return Object.fromEntries(LIFE_BLEND_MODES.map((b) => [b, make(b)])) as Record<LifeBlend, T>
}

const LIFE_BLENDS: Record<LifeBlend, GPUBlendState> = {
  add: ADDITIVE,
  screen: {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src', operation: 'add' },
  },
  lighten: {
    color: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
    alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
  },
}

/** result = 0 * src + constant * dst — a multiply, driven by setBlendConstant. */
const DECAY_BLEND: GPUBlendState = {
  color: { srcFactor: 'zero', dstFactor: 'constant', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'constant', operation: 'add' },
}

/** One visualisation, its rectangle in the framebuffer, and the graticule drawn inside it. */
export interface RenderPane {
  mode: Mode
  /** Index into the style buffer's slots; stable per mode, so bind groups can be cached. */
  slot: number
  rect: Rect
  graticule: GridLine[]
  /** Seconds across the pane, resolved on the GPU when the waveform is pitch-locked. */
  shownSeconds: number
}

export interface RenderFrame {
  config: Config
  stats: FrameStats
  /**
   * The particle pool. Always the same buffer, whether or not anything in it is alive —
   * `particleCount` is what says whether the organism ran this frame.
   *
   * It was optional, and the omission was load-bearing in the wrong direction: the spectrogram
   * bind group is built once and cached forever, so whichever buffer happened to be here on the
   * first painted frame was the one every later frame read. Starting with the organism off
   * bound the *points* buffer into the particle slot, and switching it on afterwards left the
   * life pass reading 16-byte reassigned points as 32-byte particles. A buffer that never
   * changes cannot be cached wrongly.
   */
  particles: GPUBuffer
  particleCount?: number
  /** The birth counter, so the newest particles can be found without a readback. */
  lifeAllocator?: GPUBuffer
  /** Visible panes only. An empty list paints the background and nothing else. */
  panes: RenderPane[]
  width: number
  height: number
  nyquist: number
  channelCount: number
  /**
   * Ceiling on the history's width, from the GPU budget. At the top of every range the history
   * alone is a quarter of a gigabyte, and nothing else that allocates knows about it — so the
   * one place that adds them all up is the one place allowed to say how wide it may be.
   */
  maxHistoryColumns: number
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
  /**
   * What is *in* the history, as opposed to how big it is.
   *
   * A history texel is an accumulated energy at a position, and the position bakes in the
   * frequency mapping it was written under. Nothing in a texel records which mapping that was,
   * so moving the axis, switching it between linear and log, or handing the texture over to the
   * organism (whose columns hold particle colour rather than spectrum energy) leaves the old
   * columns and the new ones in different coordinate systems, shown side by side as though they
   * agreed. The size key cannot cover this: the axis limits are sliders, and reallocating a
   * quarter of a gigabyte on every frame of a drag is not a fix. Clearing is.
   */
  private historyContentKey = ''
  private historyDirty = false

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
  // One pipeline per blend mode. Blend state is baked into a pipeline and cannot be changed at
  // draw time, so a switchable merge means a variant per mode — built once, chosen per frame.
  private readonly lifePipeline: Record<LifeBlend, GPURenderPipeline>
  private readonly historyBasePipeline: Record<LifeBlend, GPURenderPipeline>
  /** One per scope: spectrum points, vectorscope chroma, waveform sines. */
  private readonly lifeDrawPipelines: Record<
    'spectrum' | 'vector' | 'wave',
    Record<LifeBlend, GPURenderPipeline>
  >
  private readonly lifeDrawLayout: GPUBindGroupLayout
  private readonly lifeDrawParams: Record<'spectrum' | 'vector' | 'wave', GPUBuffer>
  private lifeDrawBinds: Partial<Record<'spectrum' | 'vector' | 'wave', GPUBindGroup>> = {}
  private readonly historyClearPipeline: GPURenderPipeline
  private readonly sgPresentPipeline: GPURenderPipeline

  private readonly decayPipeline: GPURenderPipeline
  private readonly copyPipeline: GPURenderPipeline
  private readonly thresholdPipeline: GPURenderPipeline
  private readonly blurPipeline: GPURenderPipeline
  private readonly presentPipeline: GPURenderPipeline

  private gridBinds: (GPUBindGroup | null)[] = [null, null, null, null]
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

    // One slot per pane. `queue.writeBuffer` is ordered ahead of the whole command buffer, so
    // four draws in one submission cannot see four different values of the same range — each
    // pane's resolution and mode therefore need a range of their own.
    this.styleBuf = device.createBuffer({ label: 'style', size: STYLE_SLOT * 4, usage: uni })
    this.gridBuf = device.createBuffer({ label: 'grid', size: MAX_GRID_LINES * 16, usage: stor })
    this.waveParams = [0, 1].map((i) =>
      device.createBuffer({ label: `wave-${i}`, size: 48, usage: uni }),
    )
    this.spectrumParams = [0, 1].map((i) =>
      device.createBuffer({ label: `spectrum-${i}`, size: 16, usage: uni }),
    )
    this.vectorParams = device.createBuffer({ label: 'vector', size: 48, usage: uni })
    // A buffer per scope rather than one reused three times: all three draws are in the same
    // submission, and writeBuffer is ordered ahead of the whole command buffer.
    this.lifeDrawParams = {
      spectrum: device.createBuffer({ label: 'life-draw-spectrum', size: 64, usage: uni }),
      vector: device.createBuffer({ label: 'life-draw-vector', size: 64, usage: uni }),
      wave: device.createBuffer({ label: 'life-draw-wave', size: 64, usage: uni }),
    }
    this.splatParams = device.createBuffer({ label: 'splat', size: 96, usage: uni })
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
        { binding: 2, visibility: V, buffer: { type: 'read-only-storage' } },
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
      blend: GPUBlendState = ADDITIVE,
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
          targets: [{ format: SCENE_FORMAT, blend }],
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
    const historyPipeline = (label: string, vs: string, fs: string) =>
      byBlend((blend) =>
        device.createRenderPipeline({
          label,
          layout: splatPipelineLayout,
          vertex: { module: splatModule, entryPoint: vs },
          fragment: {
            module: splatModule,
            entryPoint: fs,
            targets: [{ format: SCENE_FORMAT, blend: LIFE_BLENDS[blend] }],
          },
          primitive: { topology: 'triangle-list' },
        }),
      )
    this.lifePipeline = historyPipeline('sg-life', 'vsLife', 'fsLife')
    // The same geometry as `splatPipeline`, written in the encoding the living present pass
    // reads, so the measurement and the organism can share one history texture.
    this.historyBasePipeline = historyPipeline('sg-base', 'vsSplat', 'fsSplatBase')
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

    const lifeDrawModule = module('life-draw', lifeDrawWgsl)
    this.lifeDrawLayout = device.createBindGroupLayout({
      label: 'life-draw',
      entries: [
        { binding: 0, visibility: VF, buffer: { type: 'uniform' } },
        { binding: 1, visibility: V, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: VF, buffer: { type: 'uniform' } },
        { binding: 3, visibility: V, buffer: { type: 'read-only-storage' } },
      ],
    })
    const lifeDraw = (label: string, vs: string, fs: string) =>
      byBlend((blend) =>
        scenePipeline(label, lifeDrawModule, vs, fs, this.lifeDrawLayout, LIFE_BLENDS[blend]),
      )
    this.lifeDrawPipelines = {
      spectrum: lifeDraw('life-spectrum', 'vsPoint', 'fsPoint'),
      vector: lifeDraw('life-chroma', 'vsChroma', 'fsPoint'),
      wave: lifeDraw('life-sine', 'vsSine', 'fsSine'),
    }

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
    this.lifeDrawBinds = {}
    this.splatBind = null
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
  private ensureHistory(
    config: Config,
    sampleRate: number,
    hop: number,
    height: number,
    living: boolean,
    maxColumns: number,
  ): void {
    const size = historySize(config, sampleRate, hop, height)
    const columns = Math.max(64, Math.min(size.columns, Math.floor(maxColumns) || size.columns))
    const rows = size.rows
    const key = `${columns}x${rows}`
    if (this.historyKey !== key || !this.history) {
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
      this.splatBind = null
    }

    const sg = config.spectrogram
    const content = `${sg.freqMin}|${sg.freqMax}|${sg.logFrequency}|${living}`
    if (this.historyContentKey !== content) {
      this.historyContentKey = content
      this.historyDirty = true
      this.historyHead = 0
      this.clearedThrough = 0
    }
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

  /**
   * Writes one pane's style block. The resolution is the *pane's*, not the framebuffer's: every
   * shader works in pixels and converts with `toNdc`, so giving it the pane size and then
   * pointing the viewport at the pane rectangle relocates the whole visualisation without a
   * line of shader code knowing that it moved.
   */
  private writeStyle(frame: RenderFrame, pane: RenderPane): void {
    const mode = pane.mode
    const s = frame.config.style
    const f = this.f32
    const u = this.u32
    const [pr, pg, pb] = hexToLinearRgb(s.primary)
    const [sr, sg, sb] = hexToLinearRgb(s.secondary)
    const [ar, ag, ab] = hexToLinearRgb(s.accent)
    const [br, bg, bb] = hexToLinearRgb(s.background)
    const width = Math.max(1, pane.rect.width)
    const height = Math.max(1, pane.rect.height)

    f[0] = width
    f[1] = height
    f[2] = 1 / width
    f[3] = 1 / height
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
    // Intensity is the one alpha every base draw multiplies by, so fading the instrument out
    // from under the organism happens here rather than in four shaders.
    //
    // The spectrogram is excluded here, and has to be: it is one textured quad carrying both
    // the measurement and the population, so dimming it would dim the life along with it. That
    // pane honours the same knob a layer down instead, by scaling what the measurement deposits
    // into the history — see `fsSplatBase`.
    const fadeBase =
      frame.config.life.enabled && living(frame) && mode !== 'spectrogram'
        ? frame.config.life.baseOpacity
        : 1
    f[21] = s.intensity * fadeBase
    // The vectorscope's own gain rides in its parameter block instead, where the rest of its
    // geometry already is; this slot stays at unity for it.
    f[22] = mode === 'wave' ? frame.config.wave.gain : 1
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
    f[34] = width
    f[35] = performance.now() / 1000
    u[36] = mode === 'wave' ? 0 : mode === 'spectrum' ? 1 : mode === 'spectrogram' ? 2 : 3
    u[37] = frame.channelCount
    u[38] = frame.config.spectrum.showPeak ? 1 : 0
    u[39] = frame.config.wave.showRms ? 1 : 0

    this.device.queue.writeBuffer(this.styleBuf, pane.slot * STYLE_SLOT, this.scratch, 0, STYLE_BYTES)
  }

  private styleBinding(slot: number): GPUBufferBinding {
    return { buffer: this.styleBuf, offset: slot * STYLE_SLOT, size: STYLE_BYTES }
  }

  /**
   * Packs every pane's graticule into one buffer, returning each pane's range. The ranges are
   * selected at draw time with `firstInstance`, which keeps one storage buffer and one bind
   * group per pane rather than one buffer per pane.
   */
  private writeGrid(panes: readonly RenderPane[]): { first: number; count: number }[] {
    const ranges: { first: number; count: number }[] = []
    const total = panes.reduce((n, p) => n + p.graticule.length, 0)
    const data = new Float32Array(Math.min(total, MAX_GRID_LINES) * 4)
    let cursor = 0
    for (const pane of panes) {
      const first = cursor
      for (const line of pane.graticule) {
        if (cursor >= MAX_GRID_LINES) break
        data[cursor * 4 + 0] = line.pos
        data[cursor * 4 + 1] = line.horizontal ? 1 : 0
        data[cursor * 4 + 2] = line.weight
        data[cursor * 4 + 3] = line.width
        cursor++
      }
      ranges.push({ first, count: cursor - first })
    }
    if (cursor > 0) this.device.queue.writeBuffer(this.gridBuf, 0, data, 0, cursor * 4)
    return ranges
  }

  private gridBind(slot: number): GPUBindGroup {
    const existing = this.gridBinds[slot]
    if (existing) return existing
    const bind = this.device.createBindGroup({
      layout: this.gridPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.styleBinding(slot) },
        { binding: 1, resource: { buffer: this.gridBuf } },
      ],
    })
    this.gridBinds[slot] = bind
    return bind
  }

  /** Records this frame's render passes. The caller owns the encoder and its submission. */
  render(encoder: GPUCommandEncoder, frame: RenderFrame): void {
    const cfg = frame.config
    this.ensureTargets(frame.width, frame.height)
    this.ensurePalette(cfg.spectrogram.palette)
    for (const pane of frame.panes) this.writeStyle(frame, pane)
    const gridRanges = cfg.style.showGrid
      ? this.writeGrid(frame.panes)
      : frame.panes.map(() => ({ first: 0, count: 0 }))

    const spectrogram = frame.panes.find((p) => p.mode === 'spectrogram')
    if (spectrogram) {
      this.ensureHistory(
        cfg,
        frame.stats.sampleRate,
        cfg.analysis.hop,
        spectrogram.rect.height,
        living(frame) && cfg.life.enabled,
        frame.maxHistoryColumns,
      )
      this.clearHistoryIfDirty(encoder)
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

    frame.panes.forEach((pane, i) => {
      const { x, y, width, height } = pane.rect
      // The viewport maps each shader's own [-1,1] onto the pane; the scissor guarantees that
      // nothing a shader draws outside its own clip volume — the spectrogram's oversized
      // triangle, a trace overshooting its lane — can reach a neighbouring pane.
      scenePass.setViewport(x, y, width, height, 0, 1)
      scenePass.setScissorRect(x, y, width, height)

      const grid = gridRanges[i]
      if (grid.count > 0) {
        scenePass.setPipeline(this.gridPipeline)
        scenePass.setBindGroup(0, this.gridBind(pane.slot))
        scenePass.draw(6, grid.count, 0, grid.first)
      }

      switch (pane.mode) {
        case 'wave':
          this.drawWave(scenePass, frame, pane)
          break
        case 'spectrum':
          this.drawSpectrum(scenePass, frame, pane)
          break
        case 'spectrogram':
          this.drawSpectrogram(scenePass, frame, pane)
          break
        case 'vector':
          this.drawVector(scenePass, frame, pane)
          break
      }
      // The population, drawn over whatever the scope was already showing. The spectrogram is
      // excluded because there the particles *are* the picture rather than a layer on it.
      if (living(frame) && cfg.life.enabled && pane.mode !== 'spectrogram') {
        this.drawLifeLayer(scenePass, frame, pane)
      }
    })
    scenePass.end()

    this.recordPost(encoder, frame)
  }

  // -------------------------------------------------------------------------------------
  // Mode geometry
  // -------------------------------------------------------------------------------------

  private waveBind(index: number, slot: number): GPUBindGroup {
    const existing = this.waveBinds[index]
    if (existing) return existing
    const bind = this.device.createBindGroup({
      layout: this.waveLayout,
      entries: [
        { binding: 0, resource: this.styleBinding(slot) },
        { binding: 1, resource: { buffer: this.analyzer.envBuf } },
        { binding: 2, resource: { buffer: this.analyzer.audioBuffer! } },
        { binding: 3, resource: { buffer: this.analyzer.timebaseBuf } },
        { binding: 4, resource: { buffer: this.waveParams[index] } },
      ],
    })
    this.waveBinds[index] = bind
    return bind
  }

  private drawWave(pass: GPURenderPassEncoder, frame: RenderFrame, pane: RenderPane): void {
    if (!this.analyzer.audioBuffer) return
    const cfg = frame.config
    const { mix } = channelMix(cfg.analysis.channelMode)
    const split = cfg.wave.splitChannels && frame.channelCount > 1
    const lanes = split ? frame.channelCount : 1
    const columns = Math.min(4096, Math.max(2, Math.round(pane.rect.width)))

    const spanSamples = (cfg.wave.timebaseMs / 1000) * frame.stats.sampleRate
    const samplesPerPixel = spanSamples / Math.max(1, pane.rect.width)
    // Below ~2 samples per pixel a straight-line join between samples is visibly not the
    // signal, so switch to band-limited reconstruction.
    const bandlimited =
      cfg.wave.trace === 'bandlimited' || (cfg.wave.trace === 'auto' && samplesPerPixel < 2)

    for (let i = 0; i < lanes; i++) {
      const laneHeight = pane.rect.height / lanes
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

      const bind = this.waveBind(i, pane.slot)
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

  private drawSpectrum(pass: GPURenderPassEncoder, frame: RenderFrame, pane: RenderPane): void {
    const cfg = frame.config
    const columns = Math.min(4096, Math.max(2, Math.round(pane.rect.width)))
    const split = cfg.spectrum.splitChannels && frame.channelCount > 1
    const lanes = split ? frame.channelCount : 1

    for (let i = 0; i < lanes; i++) {
      const height = pane.rect.height / lanes
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
            { binding: 0, resource: this.styleBinding(pane.slot) },
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

  private drawVector(pass: GPURenderPassEncoder, frame: RenderFrame, pane: RenderPane): void {
    const audio = this.analyzer.audioBuffer
    if (!audio) return
    const v = frame.config.vector
    // A longer trace than the cap is thinned rather than cut short: the figure a goniometer
    // draws is a shape, and half a shape is a different one. Every nth sample keeps the whole
    // of it and gives up only the detail between the points.
    const dots = v.trace === 'dots'
    const wanted = Math.max(2, Math.round((frame.stats.sampleRate * v.traceMs) / 1000))
    const decimation = Math.max(1, Math.ceil(wanted / VECTOR_MAX_POINTS))
    const count = Math.min(VECTOR_MAX_POINTS, Math.floor(wanted / decimation))

    const u = this.u32
    const f = this.f32
    u[0] = count
    u[1] = this.analyzer.ringCapacity
    u[2] = this.analyzer.ringChannels
    u[3] = frame.stats.head >>> 0
    f[4] = v.gain
    f[5] = v.fade
    f[6] = v.mode === 'lissajous' ? 1 : 0
    f[7] = decimation
    f[8] = dots ? 1 : 0
    f[9] = v.dotSize
    f[10] = v.brightness
    f[11] = 0
    this.device.queue.writeBuffer(this.vectorParams, 0, this.scratch, 0, 48)

    if (!this.vectorBind) {
      this.vectorBind = this.device.createBindGroup({
        layout: this.vectorPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.styleBinding(pane.slot) },
          { binding: 1, resource: { buffer: audio } },
          { binding: 2, resource: { buffer: this.vectorParams } },
        ],
      })
    }
    pass.setPipeline(this.vectorPipeline)
    pass.setBindGroup(0, this.vectorBind)
    // A dot per sample; a segment per pair of them, so one fewer.
    pass.draw(6, Math.max(1, dots ? count : count - 1))
  }

  /**
   * Draws the living population in one of the three scopes that is not the spectrogram.
   *
   * Same particles, same colours, three coordinate systems: the spectrum shows them at their
   * own frequency and level, the vectorscope arranges them by pitch class around a circle, and
   * the waveform draws each partial as the sine it claims to be.
   */
  private drawLifeLayer(pass: GPURenderPassEncoder, frame: RenderFrame, pane: RenderPane): void {
    const kind = pane.mode as 'spectrum' | 'vector' | 'wave'
    if (kind !== 'spectrum' && kind !== 'vector' && kind !== 'wave') return
    const cfg = frame.config
    const count = frame.particleCount ?? 0
    if (count <= 0 || !frame.lifeAllocator) return

    // The waveform draws a polyline per particle, so its instance count is multiplied by the
    // segments. Capping the number of traces is the difference between a hundred thousand
    // instances and three million.
    const segments = kind === 'wave' ? 96 : 1
    const traces = kind === 'wave' ? Math.min(count, cfg.life.traces) : count
    // Each step of phosphor is another quad per particle. In the waveform that multiplies an
    // already-multiplied instance count, so the trail is capped there — four sines beating
    // against each other is the whole effect anyway, and forty is a frame-rate cliff.
    const trail = Math.max(0, Math.round(cfg.life.trail))
    const steps = kind === 'wave' ? Math.min(trail, 4) : trail

    const u = this.u32
    const f = this.f32
    u[0] = traces
    u[1] = segments
    u[2] = count
    u[3] = steps
    if (kind === 'spectrum') {
      f[4] = cfg.spectrum.freqMin
      f[5] = Math.min(cfg.spectrum.freqMax, frame.nyquist)
      f[6] = cfg.spectrum.logFrequency ? 1 : 0
      f[7] = pane.shownSeconds
      f[8] = cfg.spectrum.dbMin
      f[9] = cfg.spectrum.dbMax
    } else {
      f[4] = cfg.spectrogram.freqMin
      f[5] = Math.min(cfg.spectrogram.freqMax, frame.nyquist)
      f[6] = cfg.spectrogram.logFrequency ? 1 : 0
      f[7] = pane.shownSeconds
      f[8] = cfg.spectrogram.dbFloor
      f[9] = cfg.spectrogram.dbCeil
    }
    f[10] = cfg.life.pointSize
    f[11] = cfg.life.brightness
    f[12] = cfg.life.trailFade
    f[13] = cfg.life.trailModulation
    f[14] = cfg.life.vibrato
    f[15] = cfg.life.saturation
    this.device.queue.writeBuffer(this.lifeDrawParams[kind], 0, this.scratch, 0, 64)

    if (!this.lifeDrawBinds[kind]) {
      this.lifeDrawBinds[kind] = this.device.createBindGroup({
        layout: this.lifeDrawLayout,
        entries: [
          { binding: 0, resource: this.styleBinding(pane.slot) },
          { binding: 1, resource: { buffer: frame.particles } },
          { binding: 2, resource: { buffer: this.lifeDrawParams[kind] } },
          { binding: 3, resource: { buffer: frame.lifeAllocator! } },
        ],
      })
    }
    pass.setPipeline(this.lifeDrawPipelines[kind][cfg.life.blend])
    pass.setBindGroup(0, this.lifeDrawBinds[kind]!)
    pass.draw(6, traces * segments * (steps + 1))
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

  /**
   * How far the *display* lags the head, as opposed to how far ahead the clear runs.
   *
   * These were one number, and they are two things. The clear has to stay a full margin ahead
   * because a reassigned point can still land in a column after the frame that produced it. The
   * display only has to lag by as much as is still going to change — and once the organism is
   * running, most of what is in those columns is particles, which are painted where they are now
   * and are not going to be corrected. Holding the picture back for them means the live edge,
   * the one place anything is actually happening, sits off the end of the pane where it cannot
   * be seen. `lead` is how much of that lag to give back.
   *
   * The cost of giving all of it back is that the measurement underneath, which *is* still
   * being corrected, visibly settles in the last few columns. That is a fair trade for being
   * able to watch the edge, and it is a knob rather than a decision.
   */
  private presentMargin(frame: RenderFrame): number {
    const margin = this.spectrogramMargin(frame.config)
    if (!living(frame) || !frame.config.life.enabled) return margin
    const lead = Math.max(0, Math.min(1, frame.config.life.lead))
    return Math.max(0, Math.round(margin * (1 - lead)))
  }

  /**
   * Wipe the whole ring in one pass. Separate from `recordSpectrogramHistory` because that one
   * returns early on a frame with no new analysis, and a stale picture would then be presented
   * under a new axis for as long as the signal stayed quiet.
   */
  private clearHistoryIfDirty(encoder: GPUCommandEncoder): void {
    if (!this.historyDirty || !this.history) return
    this.historyDirty = false
    encoder
      .beginRenderPass({
        label: 'spectrogram-history-reset',
        colorAttachments: [
          {
            view: this.history.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      })
      .end()
  }

  private recordSpectrogramHistory(encoder: GPUCommandEncoder, frame: RenderFrame): void {
    const history = this.history
    const alive = living(frame) && frame.config.life.enabled
    // A living population keeps painting through silence — that is the point of it — so the
    // history advances whenever analysis frames arrived, not only when they carried points.
    if (!history || frame.stats.frames === 0) return
    if (!alive && frame.stats.pointCount === 0) return
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
    // Gain is a display control and lives only in the present pass. It used to be applied here
    // as well, which meant it was baked into every column at the moment it was written: moving
    // the knob left a permanent step in the picture where the old columns met the new ones, and
    // multiplied twice over on everything after it.
    f[9] = 0
    f[10] = startCol
    f[11] = firstRun
    f[12] = 0
    f[13] = wrapRun
    // How many columns the head moved this frame: the living splat stretches its quad across
    // them so a trail is continuous rather than dotted at the display rate.
    f[14] = frame.stats.frames
    f[15] = cfg.life.pointSize
    f[16] = cfg.life.brightness
    f[17] = cfg.life.baseOpacity
    // Amplitude lead, in columns, and the range it is measured over — the same floor and
    // ceiling the pane is displayed with, so "loud" means what the picture says it means.
    f[18] = cfg.life.amplitudeLead
    f[19] = cfg.spectrogram.dbFloor
    // The instrument's own ink, for the measurement drawn underneath the population. The
    // secondary colour rather than the primary: it is the ground here, not the subject.
    const [ir, ig, ib] = hexToLinearRgb(cfg.style.secondary)
    f[20] = ir
    f[21] = ig
    f[22] = ib
    f[23] = cfg.spectrogram.dbCeil
    this.device.queue.writeBuffer(this.splatParams, 0, this.scratch, 0, 96)

    if (!this.splatBind) {
      this.splatBind = this.device.createBindGroup({
        layout: this.splatLayout,
        entries: [
          { binding: 0, resource: { buffer: this.splatParams } },
          { binding: 1, resource: { buffer: this.analyzer.pointsBuf } },
          { binding: 2, resource: { buffer: frame.particles } },
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
    if (alive) {
      // Both, and the knob between them. The measurement goes down first as a monochrome ground
      // — where the energy actually is — and the population goes over it in its own colours,
      // wherever it has migrated to. Seeing the two at once is the only way to tell that a
      // particle has left the track it was born on, which is the entire point of it moving.
      const blend = cfg.life.blend
      if (cfg.life.baseOpacity > 0 && frame.stats.pointCount > 0) {
        pass.setPipeline(this.historyBasePipeline[blend])
        pass.setBindGroup(0, this.splatBind)
        pass.draw(6, frame.stats.pointCount)
      }
      pass.setPipeline(this.lifePipeline[blend])
      pass.setBindGroup(0, this.splatBind)
      pass.draw(6, frame.particleCount)
    } else {
      pass.setPipeline(this.splatPipeline)
      pass.setBindGroup(0, this.splatBind)
      pass.draw(6, frame.stats.pointCount)
    }
    pass.end()

    this.historyHead += frame.stats.frames
  }

  private drawSpectrogram(pass: GPURenderPassEncoder, frame: RenderFrame, pane: RenderPane): void {
    const history = this.history
    if (!history) return
    const cfg = frame.config
    const margin = this.presentMargin(frame)
    const visible = Math.max(
      16,
      Math.min(
        this.historyColumns - this.spectrogramMargin(cfg) - 2,
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
    f[9] = living(frame) && cfg.life.enabled ? 1 : 0
    f[10] = cfg.life.saturation
    f[11] = 0
    this.device.queue.writeBuffer(this.sgPresentParams, 0, this.scratch, 0, 48)

    if (!this.sgPresentBind) {
      this.sgPresentBind = this.device.createBindGroup({
        layout: this.sgPresentPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.styleBinding(pane.slot) },
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
    const persistence = s.persistence
    // The spectrogram already encodes time, so phosphor persistence over it would only smear
    // an axis that is already the time axis. It is the one pane exempted, which is possible
    // because the decay is a full-screen draw and a scissor can carve a rectangle out of it.
    const spectrogram = frame.panes.find((p) => p.mode === 'spectrogram')
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
    if (persistence > 0 && spectrogram) {
      const { x, y, width, height } = spectrogram.rect
      accumPass.setScissorRect(x, y, width, height)
      accumPass.setBlendConstant({ r: 0, g: 0, b: 0, a: 0 })
      accumPass.draw(3)
      accumPass.setScissorRect(0, 0, frame.width, frame.height)
    }
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
