/**
 * Every fixed allocation size in the program, in one place.
 *
 * These were each declared beside the code that allocates them, which is the natural place for
 * a number until something has to reason about all of them at once. `gpu/budget.ts` does, and
 * it cannot import the modules that own them: those pull in WGSL and worklet URLs through
 * Vite-specific specifiers, so anything downstream of them stops being testable outside a
 * browser build. Inverting the dependency — the sizes here, the allocators importing them —
 * makes the budget a leaf that can be checked with plain arithmetic, and makes it impossible
 * for the budget's idea of a buffer's size to drift from the buffer's.
 */

/** Largest transform the analyser will run. Window and twiddle tables are sized for it. */
export const MAX_FFT_SIZE = 65536

/** Ceiling on complex elements per FFT ping-pong buffer (2^21 -> 16 MB each). */
export const COMPLEX_BUDGET = 1 << 21

/**
 * Ceiling on reassigned points per batch (2^20 -> 16 MB of vec4<f32>).
 *
 * A *separate* budget from the one above, and it has to be, because the two scale differently:
 * the FFT cost is `bins * variants * channels` per frame while the point cost is `bins` per
 * frame flat. Turning reassignment off divides the transform work by three and leaves the point
 * count untouched — so the configuration that overruns this buffer is a mono 64k analysis with
 * reassignment *disabled*, which is also the cheapest one to run. Sixty-four frames of it wants
 * 2,097,216 points. Sizing the batch against the FFT budget alone let those writes fall off the
 * end of the buffer, where WebGPU's robust access silently discards them and reads return zero,
 * while the statistics went on reporting every point as analysed.
 */
export const POINT_BUDGET = 1 << 20

/** Pixel columns the spectrum and waveform reductions will produce. */
export const MAX_COLUMNS = 4096

/** Lags in the NSDF pitch estimate. */
export const MAX_LAGS = 8192

/** Every offscreen surface in the renderer. */
export const SCENE_FORMAT: GPUTextureFormat = 'rgba16float'

/** Bytes per texel of SCENE_FORMAT. */
export const SCENE_BYTES_PER_TEXEL = 8

/** The bloom chain runs at this fraction of the scene's linear dimensions. */
export const BLOOM_DIVISOR = 4

/** Bins across the pheromone field. About 100 to the octave — a shade over a tenth of a semitone. */
export const FIELD_BINS = 1024

/** The field spans ten octaves from here: 20 Hz to 20.48 kHz. */
export const FIELD_MIN_HZ = 20
export const FIELD_OCTAVES = 10

/** Particle slots. 32 bytes each; 256k of them is 8 MB, and a busy frame births a few thousand. */
export const PARTICLE_CAPACITY = 1 << 18

/** Frames in the capture ring: 524288, which is 10.9 s at 48 kHz and 2.7 s at 192 kHz. */
export const RING_CAPACITY = 1 << 19
