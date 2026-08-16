/**
 * Audio capture engine.
 *
 * Responsibilities:
 *  - enumerate inputs and open them with *all* browser DSP defeated,
 *  - run the AudioContext at the device's native rate so no hidden resampler sits in the path,
 *  - own the AudioWorklet that fills the lock-free ring.
 *
 * The two things that most often silently ruin a "studio grade" web analyzer are
 * (a) leaving echoCancellation/noiseSuppression/autoGainControl on — Chrome enables all three
 * by default, and AGC in particular makes level measurement meaningless — and (b) letting the
 * AudioContext run at a different rate from the capture device, which inserts a resampler
 * whose response you do not control. Both are handled here.
 */

import { AudioRing } from './ring.ts'
import captureWorkletUrl from './capture-worklet.ts?worker&url'

export type SourceKind = 'microphone' | 'display' | 'file' | 'generator'

export type GeneratorKind =
  | 'sine'
  | 'sweep'
  | 'white'
  | 'pink'
  | 'impulse'
  | 'square'
  | 'sawtooth'

export interface SourceRequest {
  kind: SourceKind
  deviceId?: string
  /** Requested capture rate in Hz, or 'native' to accept whatever the device offers. */
  sampleRate: number | 'native'
  channels: number
  file?: File
  generator?: {
    kind: GeneratorKind
    frequency: number
    sweepStart: number
    sweepEnd: number
    sweepSeconds: number
    amplitude: number
  }
}

export interface EngineStatus {
  running: boolean
  /**
   * The graph is built but the AudioContext is not running. Autoplay policy holds a context
   * created without a user gesture in `suspended` until the page is interacted with, and a
   * suspended context pulls no audio at all — so this is the difference between "started" and
   * "actually capturing".
   */
  suspended: boolean
  sourceLabel: string
  sampleRate: number
  channels: number
  /** True when the AudioContext rate matches the capture device — no hidden resampling. */
  bitPerfectRate: boolean
  /** Rate the device reported, when it reported one. */
  deviceSampleRate: number | null
  baseLatencySec: number
  outputLatencySec: number
  sharedMemory: boolean
  message: string
}

export interface AudioDeviceInfo {
  deviceId: string
  label: string
}

const RING_CAPACITY = 1 << 19 // 524288 frames: 10.9 s at 48 kHz, 2.7 s at 192 kHz

/**
 * Resume a context without the possibility of hanging on it.
 *
 * When autoplay policy is blocking, Chrome does not reject `resume()` — it leaves the promise
 * *pending*, indefinitely, until the page receives a user gesture that may never come. Awaiting
 * it directly stalls whatever called it for the entire life of an untouched page, which is
 * precisely the situation an unattended start creates. So it is raced against a deadline: long
 * enough that a resume which followed a click has settled before the caller reports state,
 * short enough that one which never will does not hold anything up. The context's
 * `statechange` event carries the late answer.
 */
async function resumeWithin(ctx: AudioContext, ms: number): Promise<void> {
  if (ctx.state !== 'suspended') return
  await Promise.race([
    ctx.resume().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ])
}

export class AudioEngine {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null
  private sourceNode: AudioNode | null = null
  private monitorGain: GainNode | null = null
  private sinkGain: GainNode | null = null
  private fileBuffer: AudioBuffer | null = null
  private moduleLoadedFor: AudioContext | null = null

  ring: AudioRing | null = null
  status: EngineStatus = {
    running: false,
    suspended: false,
    sourceLabel: 'stopped',
    sampleRate: 0,
    channels: 0,
    bitPerfectRate: true,
    deviceSampleRate: null,
    baseLatencySec: 0,
    outputLatencySec: 0,
    sharedMemory: false,
    message: '',
  }

  onStatus: ((s: EngineStatus) => void) | null = null
  /** The capture track ended on its own — the device was unplugged or the share was revoked. */
  onSourceEnded: (() => void) | null = null

  /**
   * Device labels are redacted until the page holds a media permission, so callers should
   * enumerate again after the first successful `start`.
   */
  async listInputs(): Promise<AudioDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return []
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `Input ${i + 1}`,
      }))
  }

  /**
   * Whether an input can be opened right now without putting a permission prompt on screen.
   *
   * A populated label is the tell: the browser redacts device names until the page holds a
   * microphone permission, so a name we can read means the grant already exists. Naming a
   * specific device narrows the question to that device, because opening a `deviceId: exact`
   * constraint for hardware that has been unplugged fails rather than falling back.
   */
  async isInputBound(deviceId?: string): Promise<boolean> {
    if (!navigator.mediaDevices?.enumerateDevices) return false
    try {
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === 'audioinput',
      )
      if (deviceId) return inputs.some((d) => d.deviceId === deviceId && d.label !== '')
      return inputs.some((d) => d.label !== '')
    } catch {
      return false
    }
  }

  /** Lets a context that autoplay policy parked in `suspended` through, once there is a gesture. */
  async resume(): Promise<boolean> {
    const ctx = this.context
    if (!ctx) return false
    await resumeWithin(ctx, 400)
    const running = ctx.state === 'running'
    this.setStatus({ ...this.status, suspended: this.status.running && !running })
    return running
  }

  async start(request: SourceRequest): Promise<void> {
    await this.stop()

    let deviceRate: number | null = null
    let label = ''

    if (request.kind === 'microphone' || request.kind === 'display') {
      const audioConstraints: MediaTrackConstraints = {
        // Defeat every browser-side "improvement". These are not optional for measurement.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: request.channels },
      }
      if (request.deviceId && request.kind === 'microphone') {
        audioConstraints.deviceId = { exact: request.deviceId }
      }
      if (request.sampleRate !== 'native') {
        audioConstraints.sampleRate = { ideal: request.sampleRate }
      }

      this.stream =
        request.kind === 'display'
          ? await navigator.mediaDevices.getDisplayMedia({
              // Chrome will not hand over tab audio unless video is also requested.
              video: true,
              audio: audioConstraints,
            })
          : await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })

      for (const track of this.stream.getVideoTracks()) track.stop()

      const track = this.stream.getAudioTracks()[0]
      if (!track) throw new Error('the selected source produced no audio track')
      // Unplugging the interface, or ending a tab share, ends the track rather than raising
      // anything. Without this the graph stays wired to a dead source and simply goes quiet.
      track.addEventListener('ended', () => void this.handleSourceEnded(track))
      const settings = track.getSettings()
      deviceRate = settings.sampleRate ?? null
      label = track.label || (request.kind === 'display' ? 'Tab / system audio' : 'Microphone')
    }

    // Match the context to the device so no resampler is inserted.
    const desired =
      deviceRate ?? (request.sampleRate === 'native' ? undefined : request.sampleRate)
    this.context = await this.createContext(desired)
    const ctx = this.context

    let channels = request.channels

    if (this.stream) {
      const src = ctx.createMediaStreamSource(this.stream)
      channels = Math.min(request.channels, Math.max(1, src.channelCount))
      this.sourceNode = src
    } else if (request.kind === 'file' && request.file) {
      const bytes = await request.file.arrayBuffer()
      this.fileBuffer = await ctx.decodeAudioData(bytes)
      const player = ctx.createBufferSource()
      player.buffer = this.fileBuffer
      player.loop = true
      player.start()
      this.sourceNode = player
      channels = this.fileBuffer.numberOfChannels
      deviceRate = this.fileBuffer.sampleRate
      label = `${request.file.name}`
    } else if (request.kind === 'generator' && request.generator) {
      const { node, description } = this.buildGenerator(ctx, request.generator)
      this.sourceNode = node
      // The generator feeds both channels, but honour the requested count so the mono path
      // can actually be exercised with a test signal.
      channels = request.channels
      label = description
    } else {
      throw new Error('no source specified')
    }

    channels = Math.max(1, Math.min(2, channels))

    this.ring = AudioRing.create(RING_CAPACITY, channels, ctx.sampleRate)

    if (this.moduleLoadedFor !== ctx) {
      await ctx.audioWorklet.addModule(captureWorkletUrl)
      this.moduleLoadedFor = ctx
    }

    const usingSharedMemory = this.ring.shared
    this.node = new AudioWorkletNode(ctx, 'waveshape-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: channels,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
      processorOptions: {
        ring: usingSharedMemory ? this.ring.layout : null,
        channels,
        chunkFrames: 1024,
      },
    })

    if (!usingSharedMemory) this.wireTransferFallback()

    // A worklet whose output goes nowhere is not guaranteed to be pulled. Route it into a
    // muted gain so the graph keeps it alive without it reaching the speakers.
    this.sinkGain = ctx.createGain()
    this.sinkGain.gain.value = 0
    this.node.connect(this.sinkGain).connect(ctx.destination)

    // Separate, user-controlled monitor path. Off by default — a live mic routed to the
    // speakers is a feedback loop waiting to happen.
    this.monitorGain = ctx.createGain()
    this.monitorGain.gain.value = 0
    this.sourceNode.connect(this.monitorGain).connect(ctx.destination)

    this.sourceNode.connect(this.node)
    this.ring.setRunning(true)

    await resumeWithin(ctx, 150)
    // A context started without a user gesture can be parked in `suspended` and stay there.
    // Report the state it actually reached rather than the one that was asked for.
    ctx.onstatechange = () => {
      if (this.context !== ctx || !this.status.running) return
      this.setStatus({ ...this.status, suspended: ctx.state !== 'running' })
    }

    const bitPerfect = deviceRate === null || Math.abs(deviceRate - ctx.sampleRate) < 1
    this.setStatus({
      running: true,
      suspended: ctx.state !== 'running',
      sourceLabel: label,
      sampleRate: ctx.sampleRate,
      channels,
      bitPerfectRate: bitPerfect,
      deviceSampleRate: deviceRate,
      baseLatencySec: ctx.baseLatency ?? 0,
      outputLatencySec: ctx.outputLatency ?? 0,
      sharedMemory: usingSharedMemory,
      message: bitPerfect
        ? ''
        : `Device runs at ${deviceRate} Hz but the AudioContext is at ${ctx.sampleRate} Hz — the browser is resampling.`,
    })
  }

  private async createContext(desiredRate: number | undefined): Promise<AudioContext> {
    if (desiredRate) {
      try {
        return new AudioContext({ sampleRate: desiredRate, latencyHint: 'interactive' })
      } catch {
        // Some platforms refuse rates the hardware cannot do natively; fall through.
      }
    }
    return new AudioContext({ latencyHint: 'interactive' })
  }

  private wireTransferFallback(): void {
    const node = this.node
    const ring = this.ring
    if (!node || !ring) return
    node.port.onmessage = (event: MessageEvent) => {
      const msg = event.data as { type: string; planes?: Float32Array[]; frames?: number }
      if (msg.type !== 'audio' || !msg.planes || !msg.frames) return
      ring.write(msg.planes, msg.frames)
      const transfer: Transferable[] = []
      for (const p of msg.planes) transfer.push(p.buffer as ArrayBuffer)
      node.port.postMessage({ type: 'recycle', planes: msg.planes }, transfer)
    }
  }

  private buildGenerator(
    ctx: AudioContext,
    gen: NonNullable<SourceRequest['generator']>,
  ): { node: AudioNode; description: string } {
    const out = ctx.createGain()
    out.gain.value = gen.amplitude
    // Oscillators and buffer sources here are mono. The capture node uses discrete channel
    // interpretation — deliberately, so a real stereo source keeps L and R independent — and
    // discrete up-mixing pads with silence rather than duplicating. Without an explicit merge
    // the right channel of every test signal would be dead, which quietly halves the measured
    // loudness and pins the correlation meter at zero.
    const stereo = ctx.createChannelMerger(2)
    out.connect(stereo, 0, 0)
    out.connect(stereo, 0, 1)

    if (gen.kind === 'white' || gen.kind === 'pink' || gen.kind === 'impulse') {
      const seconds = 4
      const length = Math.round(ctx.sampleRate * seconds)
      const buffer = ctx.createBuffer(2, length, ctx.sampleRate)
      for (let c = 0; c < 2; c++) {
        const data = buffer.getChannelData(c)
        if (gen.kind === 'white') {
          for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1
        } else if (gen.kind === 'pink') {
          // Voss-McCartney: 1/f noise with flat energy per octave.
          let b0 = 0,
            b1 = 0,
            b2 = 0,
            b3 = 0,
            b4 = 0,
            b5 = 0,
            b6 = 0
          for (let i = 0; i < length; i++) {
            const w = Math.random() * 2 - 1
            b0 = 0.99886 * b0 + w * 0.0555179
            b1 = 0.99332 * b1 + w * 0.0750759
            b2 = 0.969 * b2 + w * 0.153852
            b3 = 0.8665 * b3 + w * 0.3104856
            b4 = 0.55 * b4 + w * 0.5329522
            b5 = -0.7616 * b5 - w * 0.016898
            data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11
            b6 = w * 0.115926
          }
        } else {
          const period = Math.round(ctx.sampleRate / Math.max(1, gen.frequency))
          for (let i = 0; i < length; i++) data[i] = i % period === 0 ? 1 : 0
        }
      }
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.loop = true
      src.start()
      src.connect(out)
      return { node: stereo, description: `${gen.kind} generator` }
    }

    const osc = ctx.createOscillator()
    osc.type =
      gen.kind === 'square' ? 'square' : gen.kind === 'sawtooth' ? 'sawtooth' : 'sine'

    if (gen.kind === 'sweep') {
      const now = ctx.currentTime
      const start = Math.max(1, gen.sweepStart)
      const end = Math.max(start + 1, gen.sweepEnd)
      const dur = Math.max(0.5, gen.sweepSeconds)
      // Repeat the log sweep for a few minutes; long enough for any measurement session.
      for (let k = 0; k < Math.ceil(600 / dur); k++) {
        osc.frequency.setValueAtTime(start, now + k * dur)
        osc.frequency.exponentialRampToValueAtTime(end, now + (k + 1) * dur)
      }
      osc.start(now)
      osc.connect(out)
      return { node: stereo, description: `log sweep ${start}-${end} Hz` }
    }

    osc.frequency.value = gen.frequency
    osc.start()
    osc.connect(out)
    return { node: stereo, description: `${gen.kind} ${gen.frequency.toFixed(2)} Hz` }
  }

  private async handleSourceEnded(track: MediaStreamTrack): Promise<void> {
    // Ignore the `ended` that our own teardown provokes; only a spontaneous one is news.
    if (!this.stream || !this.stream.getAudioTracks().includes(track)) return
    const label = track.label || 'the capture device'
    await this.stop()
    this.setStatus({
      ...this.status,
      sourceLabel: 'disconnected',
      message: `${label} went away.`,
    })
    this.onSourceEnded?.()
  }

  setMonitorGain(value: number): void {
    if (this.monitorGain && this.context) {
      this.monitorGain.gain.setTargetAtTime(value, this.context.currentTime, 0.02)
    }
  }

  async stop(): Promise<void> {
    this.ring?.setRunning(false)
    if (this.node) {
      this.node.port.onmessage = null
      this.node.disconnect()
      this.node = null
    }
    this.sourceNode?.disconnect()
    this.sourceNode = null
    this.monitorGain?.disconnect()
    this.monitorGain = null
    this.sinkGain?.disconnect()
    this.sinkGain = null
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop()
      this.stream = null
    }
    if (this.context) {
      this.moduleLoadedFor = null
      this.context.onstatechange = null
      await this.context.close().catch(() => undefined)
      this.context = null
    }
    this.ring = null
    this.setStatus({ ...this.status, running: false, suspended: false, sourceLabel: 'stopped' })
  }

  private setStatus(next: EngineStatus): void {
    this.status = next
    this.onStatus?.(next)
  }
}
