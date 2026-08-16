# Waveshape

Real-time audio waveform and spectral analysis on WebGPU compute shaders. Full-screen canvas,
dismissable overlay, everything configurable, nothing between the converter and the pixel that
you did not choose.

```
npm install
npm run dev
```

Requires WebGPU: Chrome/Edge 113+, Safari 26+, Firefox 141+.

---

## What it does

Four modes, one capture and transform core, switchable with `1`–`4`:

| Mode | What it shows |
| --- | --- |
| **Waveform** | Pitch-locked oscilloscope. GPU min/max/RMS envelope when zoomed out, band-limited sinc reconstruction when zoomed in. |
| **Spectrum** | FFT magnitude with per-pixel bin reduction, peak hold, Welch averaging, eleven windows. |
| **Spectrogram** | Scrolling waterfall with time-frequency reassignment. |
| **Vectorscope** | Mid/side goniometer with phase correlation. |

Press `space`, `esc` or `h` to toggle the overlay; `f` for full screen.

---

## Signal path

```
                         audio render thread
  device ─► getUserMedia ─► AudioWorklet ─► lock-free SPSC ring (SharedArrayBuffer)
   all browser DSP off        128 frames         planar, overwriting
                                                        │
                              ┌─────────────────────────┴──────────────┐
                              ▼                                        ▼
                        main thread                              meters worker
                     GPU ring mirror                        ITU-R BS.1770-4 (f64)
                              │                             sees every sample
        ┌─────────────────────┼──────────────────────┐
        ▼                     ▼                      ▼
  window + real-pack    min/max/RMS reduce      NSDF pitch + trigger
        │               one WG per column       one WG per lag
        ▼                     │                      │
  Stockham FFT                │                      ▼
  radix-4 / radix-2           │                 timebase buffer ──┐
  batched, ping-pong          │                                   │
        ▼                     │                                   │
  real-FFT unpack             │                                   │
        ▼                     │                                   │
  magnitude + reassign        │                                   │
        └────────────┬────────┴───────────────────────────────────┘
                     ▼
       render: rgba16float, additive, MSAA 4×
       persistence ─► bloom ─► tone map ─► sRGB
```

Analysis frames are produced at `sampleRate / hop` — 187.5 Hz by default, up to 1.5 kHz at
192 kHz with a 128-sample hop. The display runs at the monitor's refresh rate. Every analysis
frame that arrived since the last paint is processed in a **single batched dispatch chain**, so
the spectrogram keeps full time resolution and the integrators see every frame while the number
of GPU dispatches stays proportional to the *display* rate. Batching is the whole trick: an
unbatched implementation spends all its time in dispatch overhead long before it runs out of
arithmetic.

---

## Decisions worth explaining

**Capture is undefended.** `echoCancellation`, `noiseSuppression` and `autoGainControl` are all
forced off. Chrome enables all three by default and AGC alone makes level measurement
meaningless. The `AudioContext` is opened at the rate the *device* reports, so no resampler you
did not choose sits in the path. The System tab tells you if that failed.

**The ring is wait-free and overwriting.** The producer runs on the audio render thread and
never allocates, never locks, and never branches on consumer state. Consumers hold private
cursors and detect being lapped. For a visualiser, dropping old audio is strictly better than
stalling the render thread. The frame counter is published modulo 2³⁰ rather than as a plain
`Int32`, which would overflow into negative territory after about three hours at 192 kHz.

**Not `AnalyserNode`.** It caps at 32768 points, hard-codes a Blackman window, applies a
smoothing constant you cannot bypass, and its time-domain data is not guaranteed contiguous.
None of that is acceptable for measurement.

**Stockham, not Cooley-Tukey.** The autosort formulation produces naturally ordered output with
no bit-reversal permutation — a scatter with terrible locality, and the worst thing you can ask
a GPU to do in an otherwise coalesced kernel. It pays for this by being out-of-place, which
costs one extra buffer and nothing else.

**Twiddles come from a table computed in f64.** Evaluating `sin`/`cos` in the shader is a ULP or
two worse at N = 65536, and twiddle error dominates the error budget of a large FFT.

**Real input uses N/2 packing.** Two real samples per complex slot, one half-length transform,
then a split. Half the work of zero-padding the imaginary part.

**Reassignment is the point of the spectrogram.** A conventional spectrogram smears energy over
the entire support of the analysis window. Reassignment moves each bin's energy to the centre of
gravity of the energy it represents, computed from the *phase* rather than the magnitude:

```
dt = Re( X_tw / X_w )              group delay, samples from window centre
dw = −Im( X_dw / X_w )             frequency offset, radians per sample
```

It costs two extra transforms per frame (windows `t·w` and `dw/dn`) and buys resolution far
beyond the window's nominal limit. Corrections larger than a configurable bound are discarded —
a large displacement means the bin sat in a spectral null where the phase derivative is noise.
Because energy can move *backwards* in time, the display lags the write head by half a window;
without that, the newest column would keep rewriting itself after being shown.

**The waveform is pitch-locked, not level-triggered.** A level crossing is ambiguous when a
waveform crosses the same level several times per cycle, which is every interesting sound. The
period is estimated with the McLeod Pitch Method's Normalised Square Difference Function,
parabolically interpolated so the trace does not walk sideways by half a sample per frame. The
trigger, the envelope reduction and the draw call all read the resulting timebase **directly on
the GPU** — nothing is read back, so there is no latency and no pipeline stall.

**Two ways to draw a waveform, both necessary.** At 192 kHz a four-second view is 768,000
samples competing for maybe 3,000 pixel columns; point-sampling that is not decimation, it is
aliasing. Zoomed out, each column shows the true min/max of every sample inside it. Zoomed in,
straight lines between samples show a shape the signal never had — so the trace becomes the
Whittaker-Shannon interpolant, which is why a square wave correctly shows Gibbs overshoot
instead of perfect corners.

**Rendering is additive and linear.** Everything is drawn into `rgba16float` with additive
blending, so overlapping traces sum and density becomes brightness the way it does on a
phosphor screen — and there is headroom above 1.0 for the tone mapper to work with. Clipping to
8-bit sRGB before tone mapping would throw that away.

**Metering is standards-compliant at every rate.** BS.1770-4 tabulates K-weighting coefficients
only for 48 kHz. These are re-derived from the analog prototype at the working rate, so the
measurement stays correct at 96 and 192 kHz. True peak uses a 4× polyphase oversampler with 32
taps per phase; the Recommendation's reference filter uses 12.

**Colour maps rise monotonically in lightness.** A spectrogram encodes a scalar in colour, and a
map whose lightness is not monotonic invents features that are not in the signal — the classic
rainbow puts a bright band in the middle of a smooth ramp and you read it as a peak.

---

## Verification

Two independent layers, because a GPU FFT can be subtly wrong — a flipped sign in a butterfly, a
twiddle indexed off by a stride — and still produce a plausible-looking spectrum.

`npm test` runs 16 checks against `dsp/`, including the packed real FFT versus a naive DFT at
every shipped size, Parseval, exact window sums, K-weighting against the coefficients tabulated
in BS.1770-4, NSDF octave robustness on a harmonic stack, and reassignment placing an impulse on
its exact sample and an off-bin sinusoid within 0.01 Hz.

The **System ▸ Run FFT self-test** button pushes a synthetic two-tone signal through the real
GPU pipeline and compares the result against the f64 CPU reference. Measured on this machine:

```
max error 3.2e-6 %   rms error 3.3e-7 %   of peak magnitude
```

End-to-end, against a 997 Hz tone at amplitude 0.5, FFT size 4096, 48 kHz:

| Quantity | Expected | Measured |
| --- | --- | --- |
| Peak magnitude | −6.02 dBFS | −6.04 dB |
| Nearest FFT bin | 996.094 Hz | 996.094 Hz |
| **Reassigned frequency** | **997 Hz** | **997.0000 Hz** |
| Integrated loudness | −6.71 LUFS | −6.7 LUFS |
| True peak | −6.02 dBTP | −6.0 dBTP |
| Correlation | 1.00 | 1.00 |

The reassigned estimate resolves to a small fraction of a hertz against an 11.72 Hz bin grid.

---

## Cross-origin isolation

The lock-free ring needs `SharedArrayBuffer`, which is only exposed to cross-origin-isolated
documents. The dev and preview servers already send the required headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Serve the production build the same way. Without them the app still runs — the capture path
degrades to a pooled `postMessage` transfer, and the System tab says so — but the audio thread
is no longer allocation-free.

---

## Layout

```
src/
  audio/    ring buffer, AudioWorklet producer, capture engine
  dsp/      windows, reference FFT, biquads, BS.1770-4 loudness, tests
  gpu/      device init, compute orchestration, render passes
    shaders/  WGSL: prepare, fft, unpack, analyze, envelope, nsdf, speccols, draw_*, post
  ui/       tabbed overlay, controls, graticule
  workers/  loudness metering
```

Zero runtime dependencies. TypeScript, Vite and `@webgpu/types` are the only devDependencies.

## References

- Heinzel, Rüdiger & Schilling, *Spectrum and spectral density estimation by the DFT* (2002) — window table, ENBW, overlap
- Auger & Flandrin (1995); Fulop & Fitz (2006) — time-frequency reassignment
- McLeod & Wyvill, *A smarter way to find pitch* (2005) — NSDF
- ITU-R BS.1770-4 and EBU R 128 / Tech 3341 / Tech 3342 — loudness and true peak
- Adenot, *A wait-free SPSC ring buffer for the web* — ring design
