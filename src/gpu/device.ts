export interface GpuContext {
  adapter: GPUAdapter
  device: GPUDevice
  context: GPUCanvasContext
  format: GPUTextureFormat
  /** Optional features that were actually granted. */
  features: Set<string>
  /** True when the canvas was configured for extended-range (HDR) output. */
  hdr: boolean
  info: GpuInfo
}

export interface GpuInfo {
  vendor: string
  architecture: string
  description: string
  maxBufferSize: number
  maxStorageBufferBindingSize: number
  maxComputeWorkgroupStorageSize: number
  maxTextureDimension2D: number
  subgroups: boolean
  timestampQuery: boolean
  shaderF16: boolean
}

export class WebGpuUnavailableError extends Error {}

const WANTED_FEATURES = ['timestamp-query', 'shader-f16', 'subgroups', 'float32-filterable']

export async function initGpu(canvas: HTMLCanvasElement): Promise<GpuContext> {
  if (!navigator.gpu) {
    throw new WebGpuUnavailableError(
      'This browser does not expose WebGPU. Waveshape runs its FFT and reductions as compute shaders, which WebGL cannot do.',
    )
  }

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) {
    throw new WebGpuUnavailableError(
      'No WebGPU adapter was available. On Linux you may need to enable Vulkan; in a VM, GPU passthrough.',
    )
  }

  const granted = WANTED_FEATURES.filter((f) => adapter.features.has(f))
  const limits: Record<string, number> = {}
  const wantLimits: [keyof GPUSupportedLimits, number][] = [
    ['maxBufferSize', 512 * 1024 * 1024],
    ['maxStorageBufferBindingSize', 512 * 1024 * 1024],
    ['maxComputeWorkgroupStorageSize', 32768],
    ['maxComputeInvocationsPerWorkgroup', 256],
  ]
  for (const [name, want] of wantLimits) {
    const available = adapter.limits[name] as number | undefined
    if (typeof available === 'number') limits[name] = Math.min(want, available)
  }

  const device = await adapter.requestDevice({
    requiredFeatures: granted as GPUFeatureName[],
    requiredLimits: limits,
  })

  const context = canvas.getContext('webgpu')
  if (!context) throw new WebGpuUnavailableError('Could not acquire a WebGPU canvas context.')

  const format = navigator.gpu.getPreferredCanvasFormat()

  // Try for extended-range output first: an additive trace with real highlights is the whole
  // point of rendering in HDR, and on a capable display it is a visible difference. Falls back
  // silently — `toneMapping` is still new enough that not every build accepts it.
  let hdr = false
  try {
    context.configure({
      device,
      format,
      alphaMode: 'opaque',
      colorSpace: 'display-p3',
      toneMapping: { mode: 'extended' },
    } as GPUCanvasConfiguration)
    hdr = true
  } catch {
    context.configure({ device, format, alphaMode: 'opaque' })
  }

  const adapterInfo = adapter.info ?? ({} as GPUAdapterInfo)

  return {
    adapter,
    device,
    context,
    format,
    features: new Set(granted),
    hdr,
    info: {
      vendor: adapterInfo.vendor || 'unknown',
      architecture: adapterInfo.architecture || 'unknown',
      description: adapterInfo.description || adapterInfo.device || '',
      maxBufferSize: device.limits.maxBufferSize,
      maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
      maxComputeWorkgroupStorageSize: device.limits.maxComputeWorkgroupStorageSize,
      maxTextureDimension2D: device.limits.maxTextureDimension2D,
      subgroups: granted.includes('subgroups'),
      timestampQuery: granted.includes('timestamp-query'),
      shaderF16: granted.includes('shader-f16'),
    },
  }
}

/** Rounds a byte length up to the alignment WebGPU requires for the given usage. */
export function align(bytes: number, to = 4): number {
  return Math.ceil(bytes / to) * to
}
