/** Ambient declarations for the AudioWorkletGlobalScope, which lib.dom does not describe. */

interface AudioWorkletProcessorBase {
  readonly port: MessagePort
}

declare const AudioWorkletProcessor: {
  new (options?: AudioWorkletNodeOptions): AudioWorkletProcessorBase
  prototype: AudioWorkletProcessorBase
}

declare function registerProcessor(
  name: string,
  ctor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessorBase,
): void

/** Sample rate of the AudioContext driving this worklet. */
declare const sampleRate: number

/** Frames elapsed since the context started. */
declare const currentFrame: number
