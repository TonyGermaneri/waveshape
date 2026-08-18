# Waveshape

Real-time audio waveform and spectral analysis on WebGPU compute shaders. Full-screen canvas,
dismissable overlay, everything configurable, nothing between the converter and the pixel that
you did not choose.

```
npm install
npm run dev
```

Requires WebGPU: Chrome/Edge 113+, Safari 26+, Firefox 141+.

Installs as a PWA and keeps working with the network gone — see
[Installing it](#installing-it).

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
| **Spectrum** | FFT magnitude with per-pixel bin reduction, peak hold, Welch averaging, eleven windows. Frequency axis or keyboard axis, in fifteen tunings. |
| **Spectrogram** | Scrolling waterfall with time-frequency reassignment. |
| **Vectorscope** | Mid/side goniometer or raw Lissajous, as a trace or a sample cloud, with broadband correlation. |

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

**The panel is a window as well as a panel.** Drag it by its title bar to move it, drop it
against any edge to dock it there, and pull any edge or corner to resize it — `⇧H` steps through
the same five placements without the mouse. Docked, it takes its room out of the canvas rather
than covering it, and every pane is re-laid-out into what is left; the analyser finds out through
the same resize observer that already watches for the window changing shape, so a dock costs the
render path nothing. Dismissing the panel gives that room straight back, which is what makes it
safe to have a dock on by default: the whole viewport is always one keystroke away. Floating, it
takes nothing and behaves as it always did. Both are remembered with the rest of the profile.

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
| `⇧H` | Panel placement — right, bottom, left, top, floating |
| `f` · `?` `F1` · `` ` `` `~` | Full screen · keyboard reference · next / previous tab |
| `1` `2` `3` `4` · `\` | Switch a visualisation on or off · reset the layout |
| `-` `=` · `[` `]` · `q` `w` · `a` `s` | FFT size · hop · window · averaging |
| `c` `e` `m` | Channels analysed · reassignment · magnitude scale |
| `↑` `↓` | Vertical gain — oscilloscope and vectorscope together, each keeping its own value |
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

## Tunings

Both frequency axes can be ruled in notes instead of hertz — **Appearance ▸ Graticule ▸ Scale
mode** — which puts a line on every degree of the scale, a brighter one on every root, and the
name of the note on the axis. A partial then reads against the note it belongs to instead of
being converted in your head, and the pitch in the readout bar comes back as `A4 +3¢` rather
than `442.55 Hz`.

Fifteen tunings ship with it, and every one is **computed from its definition rather than copied
from a table of cents**. A well temperament is not twelve numbers, it is a rule about how far
each fifth in the chain falls short of pure; the numbers are what that rule produces, and a
table of them is the same thing with the reasoning thrown away and a transcription error waiting
to happen. Werckmeister said *narrow four of the fifths by a quarter of the Pythagorean comma* —
that is what `dsp/tunings.ts` says, and `tuning.test.ts` checks the twelve cents that come out of
it against the values Kyle Gann and Wikipedia publish, to the last figure they quote.

| | |
| --- | --- |
| **Equal** | 12-tone equal temperament |
| **Historical** | Pythagorean · quarter-comma and sixth-comma meantone · Werckmeister III · Kirnberger III · Vallotti · Young II |
| **Just** | 5-limit just intonation · the 8th to 16th harmonics as a scale |
| **Equal divisions** | 19 · 24 · 31 · 53 |
| **No octave at all** | Bohlen-Pierce: thirteen equal steps of a *twelfth* |

Concert pitch is a slider, and the root note is a menu — equal temperament does not care which
key it starts on and every historical temperament does, because the point of one is that the
keys are *not* alike.

**AnaMark tuning files import**, to version 2.00 of the specification: `[Exact Tuning]` where
there is one and `[Tuning]` otherwise, the file's own base frequency folded in, and the
specification's completion rule, which is what lets a file stop at the top of one period and have
every key above it repeat. A file's concert pitch comes with it, unrounded. A periodic tuning is
recognised as its period — twelve degrees to the octave rather than a hundred and twenty-eight
numbers — and one that repeats nowhere, a stretched piano curve being the everyday example, keeps
its table key by key and is continued past the ends of the keyboard at the stretch it finishes
with. Imported tunings are saved with the profile.

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

## Harmonic life

*Branch `harmonic-life`, and the reason it exists.*

The reassignment pass produces a cloud of points: energy, located precisely in time and
frequency, existing for exactly one frame. Turn **Life ▸ Harmonic life** on and each of those
points becomes an organism instead — with a birth, a lineage, a behaviour and a death.

A particle is 32 bytes. Twenty-four bits are its colour; fifty-eight more are what it was born
knowing about its own harmonic situation:

| | |
| --- | --- |
| **harmonic** | which harmonic of the inferred fundamental it is, or 0 for none |
| **detune** | signed cents from the exact multiple |
| **support** | how much of its series was present in that frame — a property of the series, so every particle born from the same fundamental shares the number, and a partial with no siblings still counts itself |
| **flatness** | how noise-like *the whole frame* was, sampled every thirty-seventh bin. One number the entire generation shares, not a local measurement |
| **vacancy** | how empty the frequency it was born on already was — pheromone field occupancy, inverted. Not spectral flux, and not an attack detector |
| **register** | which octave it lives in |
| **coherence** | how far reassignment had to move it, which is the best available measure of how real it is. Zero — unknown — when reassignment is switched off |
| **age · vitality** | how long it has lived and how much of its birth energy is left. Age is sixteen bits: a particle should be able to outlive the window it is drawn in |
| **cohort · generation** | which note it belongs to, and how many times new energy has renewed it |

The loop is Physarum's — sense, rotate, move, deposit, decay — with one substitution that
changes what it means. A slime mould's sensors are placed *spatially*, a fixed distance ahead
and to either side. These are placed at **small integer ratios** of the particle's own
frequency. A particle does not ask "is there more of it slightly to my left"; it asks "is there
anything an octave above me, a fifth below me, a twelfth above me" — and it migrates to bring
itself into exact ratio with whatever answers. An organism made of these does just intonation
for a living.

Its life is its identity acting on it. Noise dies quickly because it was never a thing; a
partial with a large family persists because a note is persisting. A coherent partial trusts its
own frequency and is pulled only gently, while an incoherent one has little to lose and snaps to
whatever it can find. The colour is the identity made visible: hue is chroma, so every octave of
a note is one colour and a harmonic series reads as a repeating sequence rather than a ramp;
saturation is how sure the organism is that this is a note at all.

Fed a 220 Hz sawtooth, the census recovers a fundamental of 219.99 Hz and the particles born at
1540 Hz report themselves as the seventh harmonic, zero cents out, with thirty siblings.

### One organism, four windows

The spectrogram is where the particles live; the other three scopes show what that means in the
coordinates each already speaks, in the same colours, so a partial can be followed by eye from
one pane to the next.

| Pane | What the population looks like there |
| --- | --- |
| **Spectrum** | Each particle at its own frequency and level — the domain it was born in. The cloud sits on the curve it came from and drifts off it as the population migrates. |
| **Vectorscope** | The chromatic circle. Angle is pitch class, so every octave of a note lies on one spoke and a harmonic series fans into a fixed figure. A chord is a constellation; a glissando is a rotation. |
| **Waveform** | Each living partial drawn as the sine it claims to be. Not a reconstruction — the organism never measured phase and is not entitled to one — but its own account of what it is hearing, laid over the trace of what is actually there. |

### What keeps it moving

The first version of this stood perfectly still, and the reason is worth recording. A particle
deposits at its own frequency and then reads its own trail back from both sensors at once, so it
sits in a pheromone well of its own making with nothing to tell it which way to go. The harmonic
pull is a spring, and a sawtooth is *already* in exact ratio everywhere, so it had nothing to
correct. Nothing pushed back against anything.

What makes it live is that company is not always wanted: a particle alone at a frequency seeks
the crowd, and one in the middle of a crowd makes room — in proportion to how little family it
has, so a partial with siblings holds station while a lone one has no reason to stay put. That
tension never settles. A partial becomes a band that keeps rearranging itself rather than a
thousand organisms stacked in single file pretending to be a spectrogram.

Four compute passes — `survey`, `birth`, `step`, `settle` — in `gpu/life.ts` and
`gpu/shaders/life.wgsl`. The first two run once per paint; the last two run once per tick of a
fixed clock counted in **audio** rather than in painted frames, so the same signal grows the
same organism on a 60 Hz display, a 144 Hz display and a throttled background tab. The bit
layout lives in `gpu/particle.ts` and is duplicated by hand in the shader; `particle.test.ts`
pins the TypeScript side, because a packing that disagreed between the two would not crash, it
would produce particles that behave plausibly and mean nothing.

### What it is not

Harmonic life is seeded by measurement and is not itself one. Four things are worth knowing
before reading anything off it:

- **A trail is not a partial's trajectory.** A particle is born at a measured frequency and then
  moves under forces — the surface, the crowd, the intervals, its own itinerary. Where it is now
  is its own doing.
- **Its identity is fixed at birth, from the newest frame of that paint's batch.** A batch spans
  every analysis frame that arrived since the last paint, so a point measured at the start of a
  filter sweep is named by the fundamental at the end of it.
- **Only the first thirty-one harmonics are named.** For an A1 fundamental that stops at about
  1.7 kHz; everything above it is harmonic 0, "fits no series".
- **`support` and `flatness` are frame-wide, and `vacancy` is crowding.** See the table above.

For measurement, read the spectrogram and the spectrum. Those are the instrument; this is what
grows on it.

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

**The canvas is inset by one number, and only when something is holding it.** A docked panel
takes its room through four custom properties on the root, and the stylesheet insets the canvas,
the axis labels, the divider layer and the readout from the same four — so the instrument moves
out of the way as one thing, or not at all. Nothing in the render path knows that docking exists:
the canvas box changes, the observer already watching it fires, and the next frame is drawn at
the new size, exactly as it would be for a window resize. One trap in doing it that way is worth
naming, because it does not look like a CSS problem: a canvas is a *replaced* element, so with
`width: auto` it takes its intrinsic size — the bitmap's — and the `right` inset is dropped as
over-constrained. The box then sets the framebuffer, the framebuffer sets the box, and the two
grow into each other until they hit the device's maximum texture size. It is sized, not inset.

**The vectorscope's divisions are amplitudes, not fractions of the pane.** A goniometer figure
is scaled by the *shorter* side of its pane, because anything else turns a circle into an
ellipse — so on a pane that is not square the ±1 division is not at the pane's edge, and drawing
it there would mean the graticule and the trace disagreed about what full scale is. The
horizontal divisions are squared up against the aspect ratio instead, which is what lets the
gain be read off the picture: turn it up and the figure grows past its own reference, exactly as
it does on a scope whose graticule is painted on the glass.

Both modes are scaled so that a full-scale signal lands on the ±1 division and one channel at
full scale lands on ±0.5, which means mid/side is `(L±R)/2` rather than the energy-preserving
`(L±R)/√2`. The energy-preserving form is the right one for summing power and the wrong one for
a picture with a graticule on it: it sends a full-scale mono signal to √2, off the top of the
pane and past every ruling drawn for it.

**The correlation meter is broadband and zero-lag.** It is a normalised dot product of the two
channels over a ~300 ms exponential window: +1 identical, −1 inverted, 0 uncorrelated. It is not
a phase measurement. It says nothing about phase per harmonic, filter phase rotation, group
delay or input/output coherence — measuring any of those needs a coherent reference channel and
a complex transfer estimate `H(f) = Y(f)/X(f)`, which this analyser does not have. The
reassignment pass uses the phase derivatives and discards absolute phase.

**A readout that resizes itself is a readout that slides under the eye.** Every field in the bar
along the bottom carries the width of the widest reading it can produce and holds it whatever it
is currently showing, because the numbers that move most are exactly the ones being watched —
and a figure gaining a digit should not shove the eleven fields after it sideways. Slots are kept
rather than removed for the same reason: the pitch of a silent signal reads as a dash, where
dropping the pair would shunt half the bar left every time the room went quiet.

**A hairline is only whole where it is centred.** Multisampling evaluates a fragment at the
pixel's centre, so a one-pixel graticule line lying exactly on the boundary between two pixels
is evaluated at both their centres — which are precisely its own two edges, where its analytic
coverage falls to zero. The line disappears, and only at the sizes where the arithmetic lands on
a whole number, which is what makes it read as a bug in whatever computed the position rather
than in how it was drawn. Grid lines are snapped to pixel centres, which fixes it and makes the
whole graticule crisper besides.

**Rendering is additive and linear.** Everything is drawn into `rgba16float` with additive
blending, so overlapping traces sum and density becomes brightness the way it does on a
phosphor screen — and there is headroom above 1.0 for the tone mapper to work with. Clipping to
8-bit sRGB before tone mapping would throw that away.

**Metering is standards-compliant at every rate.** BS.1770-4 tabulates K-weighting coefficients
only for 48 kHz. These are re-derived from the analog prototype at the working rate, so the
measurement stays correct at 96 and 192 kHz. True peak uses a 4× polyphase oversampler with 32
taps per phase, and its zeroth phase is the identity, so the original sample grid is part of
the candidate set and a true peak can never read below the sample peak. Loudness is accumulated
in exact 100 ms slices regardless of how the audio is chunked into the meter.

**A file's rate is read from its container, not from the decoder.** `decodeAudioData` resamples
to the context's rate and the AudioBuffer then reports *that* — so asking the decoded buffer
what rate the file was is asking the resampler what it resampled to. The header is parsed first,
for WAV, FLAC, AIFF and Ogg, and the context is opened at the file's own rate. A container that
does not state one is reported as unknown rather than as agreement.

**Colour maps rise monotonically in lightness.** A spectrogram encodes a scalar in colour, and a
map whose lightness is not monotonic invents features that are not in the signal — the classic
rainbow puts a bright band in the middle of a smooth ramp and you read it as a peak.

---

## Verification

Two independent layers, because a GPU FFT can be subtly wrong — a flipped sign in a butterfly, a
twiddle indexed off by a stride — and still produce a plausible-looking spectrum.

`npm test` runs 101 checks. Forty-seven are numerical, against `dsp/` and `gpu/particle.ts`: the
packed real FFT versus a naive DFT at every shipped size, Parseval, exact window sums,
K-weighting against the coefficients tabulated in BS.1770-4, NSDF octave robustness on a
harmonic stack, reassignment placing an impulse on its exact sample and an off-bin sinusoid
within 0.01 Hz, every tuning system's cent table, and the particle bit layout in both
directions.

Seven of those are the loudness meter, and they pin the two properties that are easiest to lose
and hardest to notice: that the reading does not depend on how the caller chunks the stream —
the same eight seconds fed in 1-, 128-, 777-, 4799-, 4801- and 8192-frame blocks must agree to
a nanobel — and that true peak never reads below sample peak at any supported rate, while still
finding an inter-sample crest the sample peak misses. Four more pin the windows: that no window
has an impulse at the start of its derivative table, that a Kaiser at β=0 really is rectangular,
and that a window which does not taper is refused for frequency reassignment rather than
silently correcting by zero.

The remaining checks cover the keyboard map, the dock and the MIDI binding layer. The keymap is
the one part of the UI that fails silently — a duplicate token does not throw, it just makes the
second binding unreachable in whichever mode shadows it. They enumerate every reachable mode and
trigger combination and assert that no two bindings answer to the same keystroke, that tokens
are canonical, and that driving every numeric binding two hundred steps into its rail leaves the
config finite and its ranges non-inverted.

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
all**, so `public/sw.js` supplies them from a service worker instead: it sits in front of every
same-origin request and re-issues the response with the headers attached. The first load is not
yet isolated, so it registers, reloads once, and comes back isolated. It no-ops when the server
already sends the headers, and it is guarded against reload loops.

Verified against a static server sending no headers at all, at a `/waveshape/` subpath:

```
crossOriginIsolated: true    SharedArrayBuffer: available
System ▸ Shared memory: "SharedArrayBuffer ring (lock-free)"
```

Without any of this the app still runs — the capture path degrades to a pooled `postMessage`
transfer and the System tab says so — but the audio thread is no longer allocation-free.

### Installing it

The app is a PWA: `public/manifest.webmanifest` names it and sizes its icons, and the same
worker that supplies the isolation headers holds the build offline. **System ▸ Installation**
reports which of the two it is running as and what is actually in Cache Storage, and offers the
install prompt on browsers that expose one.

One worker, not two, because a scope can only have one — and because anything that served a
cached response *without* re-attaching COOP and COEP would hand back a document that is no
longer isolated. The app would then quietly lose the lock-free ring the moment it went offline,
which is the kind of regression that never shows up until it matters. Every response leaving
`sw.js`, from network or from cache, goes through the same header pass.

Two caching rules, decided by the shape of the URL:

| URL | Rule | Why |
| --- | --- | --- |
| `assets/name-HASH.ext` | cache first | Vite's hash is of the contents. A hit can never be stale. |
| everything else | network first, cache as fallback | The document, the manifest and the icons keep their names across builds. |

Source maps are never cached — they are large and only devtools asks for them.

The list of files to hold, and the version keying the cache, are stamped into `dist/sw.js` by
the `precache` plugin in `vite.config.ts` once the build is on disk. The version is a digest of
every precached byte, which buys three things at once: a build that changed nothing keeps its
cache, a build that changed anything gets a fresh one and drops the old on activation, and
`sw.js` itself differs on every real deploy — which is what makes the browser notice there is an
update to install. In the source the stamp is left `null`, and that is the worker's signal that
it is running against a dev server and should not cache at all.

Verified at that same `/waveshape/` subpath, with the server then refusing every connection:

```
offline reload         app loads from cache, all four panes render
crossOriginIsolated    true      SharedArrayBuffer: available
deep link with query   falls back to the cached shell
redeploy               one reload onto the new build, old cache dropped
```

---

## Layout

```
src/
  audio/    ring buffer, AudioWorklet producer, capture engine
  dsp/      windows, reference FFT, biquads, BS.1770-4 loudness, tunings, tests
  gpu/      device init, compute orchestration, render passes
    shaders/  WGSL: prepare, fft, unpack, analyze, envelope, nsdf, speccols, draw_*, post
  ui/       tabbed overlay, quad layout, panel placement, controls, keyboard map, themes, graticule
  workers/  loudness metering
public/
  sw.js     isolation headers and the offline cache, in one worker
  manifest.webmanifest, icons/
```

Zero runtime dependencies. TypeScript, Vite, `@webgpu/types` and `@types/node` — the last only
so the build plugin in `vite.config.ts` can read what it just wrote — are the only
devDependencies.

## References

- Heinzel, Rüdiger & Schilling, *Spectrum and spectral density estimation by the DFT* (2002) — window table, ENBW, overlap
- Auger & Flandrin (1995); Fulop & Fitz (2006) — time-frequency reassignment
- McLeod & Wyvill, *A smarter way to find pitch* (2005) — NSDF
- ITU-R BS.1770-4 and EBU R 128 / Tech 3341 / Tech 3342 — loudness and true peak
- Adenot, *A wait-free SPSC ring buffer for the web* — ring design
