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

Four visualisations, one capture and transform core, all on screen at once:

```
   ┌─────────┬─────────┐   ┌─────────┬─────────┐   ┌───────────────────┐
   │ Wavefm  │ Spectrm │   │ Wavefm  │ Spectrm │   │                   │
   ├─────────◉─────────┤   ├─────────┴────◉────┤   │      Waveform     │
   │ Spectgm │ Vectors │   │     Vectorscope   │   │                   │
   └─────────┴─────────┘   └───────────────────┘   └───────────────────┘
          four                     three                     one
```

| Pane | What it shows |
| --- | --- |
| **Waveform** | Pitch-locked oscilloscope. GPU min/max/RMS envelope when zoomed out, band-limited sinc reconstruction when zoomed in. |
| **Spectrum** | FFT magnitude with per-pixel bin reduction, peak hold, Welch averaging, eleven windows. |
| **Spectrogram** | Scrolling waterfall with time-frequency reassignment. |
| **Vectorscope** | Mid/side goniometer with phase correlation. |

`1`–`4` switch a visualisation on and off, and the grid collapses around whatever is left by
one rule applied twice: **a row with no panes takes no height, and a row with one pane gives it
the full width.** Three panes therefore leave one spanning the width; two side by side split a
row; two stacked, or two diagonal, become halves of the screen; one fills it. Nothing here is a
special case — they all fall out of the same two lines.

The cross that divides the panes has one degree of freedom per axis, so they always tile the
viewport exactly. Its handle is invisible until the pointer is over it — a permanent disc in the
middle of the picture is a permanent blemish on the thing being measured — and it grows when the
split is parked in a corner, where it would otherwise be sharing its pixels with the window
manager's own resize grip. With a single pane there is no divider left to move and the handle is
taken away entirely. Dragging a divider to its rail collapses a pane without switching it off,
and a pane with no room to draw in is skipped by the analyzer as well as the renderer — closing
both spectral panes stops the FFT chain running at all. The split is remembered between
sessions; ↺ in the panel header puts it back in the middle.

Capture starts on its own — there is no button to find before the first trace appears. Press
`space`, `esc` or `h` to toggle the overlay, `f` for full screen, `?` for the keyboard
reference. Transport (▶ / ❚❚ / ↺) sits at the top of the panel, on `r` and `shift R`.

---

## Controls

**Every key means one thing, everywhere.** All four visualisations are on screen at once, so a
binding that depended on which one was "focused" would be a binding you had to aim before you
could use it — and aiming is a step that exists only to work around an ambiguity. Where two
panes share a concept the key moves both: the frequency keys pan the spectrum and the
spectrogram together, because both have a frequency axis and neither is the one you meant.

Pairs are physically adjacent, left decreasing and right increasing. Shift on a pair reaches the
related quantity — `o` `p` is the oscilloscope's span, `⇧O` `⇧P` the spectrogram's.

| | |
| --- | --- |
| `space` `esc` `h` | Show or hide the control panel |
| `f` · `?` `F1` · `` ` `` `~` | Full screen · keyboard reference · next / previous tab |
| `1` `2` `3` `4` · `\` | Switch a visualisation on or off · reset the layout |
| `-` `=` · `[` `]` · `q` `w` · `a` `s` | FFT size · hop · window · averaging |
| `c` `e` `m` | Channels analysed · reassignment · magnitude scale |
| `↑` `↓` | Vertical gain (oscilloscope and vectorscope) |
| `⇧↑` `⇧↓` | Level window — spectrum and spectrogram together |
| `←` `→` · `⇧←` `⇧→` | Pan · zoom the frequency range, both panes together |
| `o` `p` · `⇧O` `⇧P` | Oscilloscope span · spectrogram span |
| `j` `k` | Split channels · logarithmic frequency axis, wherever they apply |
| `v` `⇧V` · `d` `⇧D` · `n` `⇧N` | Peak hold · RMS band, trigger · curve source, colour map |
| `t` `⇧T` | Next / previous theme |
| `z` `x` · `.` `/` · `;` `'` · `<` `>` · `9` `0` | Persistence · exposure · bloom · intensity · line width |
| `b` `g` `l` `y` | Tone curve · graticule · labels · readout bar |
| `r` `⇧R` · `⇧M` · `u` `i` | Restart · stop capture, reset loudness, monitor gain |

The reference dialog, the dispatcher and the key caps printed beside each control are all
generated from one table in `ui/keymap.ts`, so a binding cannot exist without being documented.
`keymap.test.ts` proves no two of them answer to the same keystroke, and that the whole table is
live at once — the property that makes focus unnecessary. Shortcuts are ignored while a control
has focus, so a slider still takes the arrow keys.

---

## Themes

Eighteen built in, from **Studio** through **Phosphor CRT**, **Blueprint**, **Matrix** and
**Vaporwave** to **Paper** and **Solarized**. A theme is a complete look rather than a colour
pair: the four canvas colours, the whole post chain (persistence, bloom, tone curve, exposure,
gamma, saturation, vignette), the graticule, the spectrogram colour map, **and the overlay's own
chrome** — panel colour, opacity, text, accent, radius and backdrop blur. The panel restyles
itself along with the trace and switches to a light colour scheme when its background is light,
so a light theme does not leave a dark control surface floating over a white waveform.

The tick labels and the readout bar take their ink from the *scene* background rather than the
panel, because they sit on the canvas: a light canvas under a dark panel is a reasonable theme,
and white labels on white paper are not.

**Theme ▸ Save current look** captures everything above under a name and keeps it in
localStorage under its own key, so resetting the settings profile on the System tab leaves the
saved themes alone. Saving over a name replaces it. Themes also round-trip as JSON through the
transfer box for moving one between machines.

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

**The layout is derived, never stored.** There is no per-pane geometry in the profile — only
which panes are on and where the cross sits. Every rectangle is recomputed from those two facts
each frame, which is why switching a pane off and on again lands it back exactly where it was,
and why there is no state that can disagree with what is on screen.

**Four panes, four viewports, one uniform buffer with four slots.** Every shader works in
pixels and converts with `toNdc`, so handing one the *pane's* resolution and then pointing the
viewport at the pane's rectangle relocates a whole visualisation without a line of shader code
knowing that it moved. What makes that need care is the ordering rule above: `writeBuffer` is
ordered ahead of the entire command buffer, so four draws in one submission cannot see four
different values of the same uniform range. Each pane therefore gets its own 256-byte slot and
its own bind group, and the graticules for all four are packed into one storage buffer with
`firstInstance` selecting each pane's range. The one thing the post chain treats per-pane is
phosphor persistence, which the spectrogram is exempted from — its axis is already time — by
scissoring the decay draw to that rectangle and running it again with a blend constant of zero.

**Capture opens itself, but never prompts.** An analyzer that shows a flat line until you find
the start button is a broken analyzer, so capture opens on load, when a device is plugged in,
and when the capture settings change. The condition is that it can be done without putting
anything on screen the user did not ask for: a device counts as *bound* when its name is
readable, because the browser redacts device labels until the page already holds a microphone
permission. Naming a specific device narrows the test to that device, since `deviceId: exact`
fails rather than falling back. Screen share and file sources always wait for a click — one
needs a picker, the other a file.

**A context that starts unattended is a context that is suspended.** Autoplay policy parks an
`AudioContext` created without user activation, and Chrome does not *reject* `resume()` in that
state — it leaves the promise pending, indefinitely, until a gesture that may never come.
Awaiting it directly hangs the whole start on an untouched page, so the resume is raced against
a short deadline, the real state is published rather than the requested one, and the next click
or keystroke anywhere on the page is borrowed to let the audio through. The transport pulses
and the readout says `held` until it does.

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

`npm test` runs 22 checks. Sixteen are numerical, against `dsp/`: the packed real FFT versus a
naive DFT at every shipped size, Parseval, exact window sums, K-weighting against the
coefficients tabulated in BS.1770-4, NSDF octave robustness on a harmonic stack, and
reassignment placing an impulse on its exact sample and an off-bin sinusoid within 0.01 Hz.

The other six cover the keyboard map, which is the one part of the UI that fails silently — a
duplicate token does not throw, it just makes the second binding unreachable in whichever mode
shadows it. They enumerate every reachable mode and trigger combination and assert that no two
bindings answer to the same keystroke, that tokens are canonical, and that driving every numeric
binding two hundred steps into its rail leaves the config finite and its ranges non-inverted.

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

## Deploying

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every push to `main`.
It runs the DSP tests and `tsc --noEmit` first, so a numerical regression or a type error fails
the deploy rather than shipping.

Enable it under **Settings ▸ Pages ▸ Source ▸ GitHub Actions**. `vite.config.ts` uses a
relative `base`, so the build works at any subpath without configuration.

### Cross-origin isolation

The lock-free ring needs `SharedArrayBuffer`, which is only exposed to cross-origin-isolated
documents, and isolation requires two response headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The dev and preview servers set them directly. **GitHub Pages cannot set response headers at
all**, so `public/coi-serviceworker.js` supplies them from a service worker instead: it sits in
front of every same-origin request and re-issues the response with the headers attached. The
first load is not yet isolated, so it registers, reloads once, and comes back isolated. It
no-ops when the server already sends the headers, and it is guarded against reload loops.

Verified against a static server sending no headers at all, at a `/waveshape/` subpath:

```
crossOriginIsolated: true    SharedArrayBuffer: available
System ▸ Shared memory: "SharedArrayBuffer ring (lock-free)"
```

Without any of this the app still runs — the capture path degrades to a pooled `postMessage`
transfer and the System tab says so — but the audio thread is no longer allocation-free.

---

## Layout

```
src/
  audio/    ring buffer, AudioWorklet producer, capture engine
  dsp/      windows, reference FFT, biquads, BS.1770-4 loudness, tests
  gpu/      device init, compute orchestration, render passes
    shaders/  WGSL: prepare, fft, unpack, analyze, envelope, nsdf, speccols, draw_*, post
  ui/       tabbed overlay, quad layout, controls, keyboard map and reference, themes, graticule
  workers/  loudness metering
```

Zero runtime dependencies. TypeScript, Vite and `@webgpu/types` are the only devDependencies.

## References

- Heinzel, Rüdiger & Schilling, *Spectrum and spectral density estimation by the DFT* (2002) — window table, ENBW, overlap
- Auger & Flandrin (1995); Fulop & Fitz (2006) — time-frequency reassignment
- McLeod & Wyvill, *A smarter way to find pitch* (2005) — NSDF
- ITU-R BS.1770-4 and EBU R 128 / Tech 3341 / Tech 3342 — loudness and true peak
- Adenot, *A wait-free SPSC ring buffer for the web* — ring design
