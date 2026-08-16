// Harmonic life.
//
// The reassignment pass produces a cloud of points: energy, located precisely in time and
// frequency, existing for exactly one frame. Here each of those points becomes an organism with
// a birth, a lineage, a behaviour and a death, and the language it lives in is harmonic ratio.
//
// The loop is Physarum's — sense, rotate, move, deposit, decay — with one substitution that
// changes everything about what it means. A slime mould's sensors are placed *spatially*, a
// fixed distance ahead and to either side, so it follows gradients in the plane it lives in.
// These sensors are placed at *small integer ratios* of the particle's own frequency. A
// particle does not ask "is there more of it slightly to my left"; it asks "is there anything
// an octave above me, a fifth below me, a twelfth above me" — and it moves to bring itself into
// exact ratio with whatever answers. An organism made of these does just intonation for a
// living. Point it at a chord and the particles migrate onto the ratios; point it at noise and
// they find nothing to lock to and disperse.
//
// Four passes per frame:
//
//   census   one workgroup surveys the spectrum: the loudest partials, the fundamental they
//            imply, and how noise-like the whole frame is
//   birth    one thread per reassigned point, turning it into a particle that knows what it is
//   step     one thread per particle: sense at harmonic ratios, steer, move, age, deposit
//   settle   the pheromone field decays and diffuses, and the atomic accumulator is drained
//
// The bit layout of a particle is defined in gpu/particle.ts and duplicated here. The two must
// agree; particle.test.ts pins the TypeScript side and this file's field offsets are written
// out longhand so the correspondence can be read rather than trusted.

// ---------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------

struct Particle {
  time: f32,
  freq: f32,
  energy: f32,
  drift: f32,
  colour: u32,
  life0: u32,
  life1: u32,
  birthFreq: f32,
}

struct Params {
  // x: pointCount   y: particleCapacity   z: fieldBins   w: frameCounter
  a: vec4<u32>,
  // x: sampleRate   y: fieldMinHz   z: fieldOctaves   w: hop
  b: vec4<f32>,
  // x: sensorCents   y: turnCents   z: harmonicPull   w: damping
  c: vec4<f32>,
  // x: decay   y: diffuse   z: depositScale   w: lifespan (steps)
  d: vec4<f32>,
  // x: birthThreshold   y: noiseMortality   z: supportBonus   w: driftLimitCents
  e: vec4<f32>,
  // x: spectrumBins   y: peakFloorDb   z: view low Hz   w: view high Hz
  f: vec4<f32>,
  // x: wrap (0/1)   y: population cap   z: crowding   w: settling rate
  g: vec4<f32>,
  // x: feed rate   y: occupancy a frequency may hold before births are suppressed
  // z: roam   w: vibrato cents
  h: vec4<f32>,
  // x: stamina (steps unfed)   y: dissonance   z: surface pull   w: wheel turns per octave
  i: vec4<f32>,
}

struct Census {
  fundamental: f32,
  flatness: f32,
  peakCount: u32,
  cohort: u32,
  peaks: array<vec2<f32>, 32>,  // (frequency, linear amplitude)
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> points: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> particles: array<Particle>;
// The field is ping-ponged. `settle` blurs each bin with its neighbours, which it cannot do in
// place: bin i would read a neighbour that another workgroup had already overwritten, and the
// smoothing would turn into a race whose result depends on scheduling.
@group(0) @binding(3) var<storage, read> field: array<f32>;
@group(0) @binding(4) var<storage, read_write> deposit: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> census: Census;
@group(0) @binding(6) var<storage, read> spectrum: array<f32>;
@group(0) @binding(7) var<storage, read_write> allocator: array<atomic<u32>>;
@group(0) @binding(8) var<storage, read_write> fieldOut: array<f32>;
/**
 * The pitch-class wheel, rasterised to 256 entries. See gpu/colormap.ts.
 *
 * Uniform rather than storage, and not for style. The other eight bindings here are already
 * storage buffers, and a device is only required to offer eight per stage — this one would be
 * the ninth, and the whole pass fails to build. The adapter this was written on would have
 * granted ten had they been asked for, which is exactly the trap: raising the requested limit
 * fixes it here and breaks it on hardware that only meets the floor. Four kilobytes of
 * read-only lookup is what a uniform buffer is for, and eleven of the twelve slots are free.
 */
@group(0) @binding(9) var<uniform> wheel: array<vec4<f32>, 256>;

const FLAG_ALIVE: u32 = 1u;
const FLAG_HARMONIC: u32 = 2u;
const FLAG_ONSET: u32 = 4u;
const FLAG_NOISE: u32 = 8u;
/** Currently standing somewhere the spectrum still has energy. Set every step, not at birth. */
const FLAG_FED: u32 = 16u;

const MAX_HARMONIC: u32 = 31u;
const DEPOSIT_SCALE: f32 = 65536.0;

// ---------------------------------------------------------------------------------------
// Packing — mirrors gpu/particle.ts field by field
// ---------------------------------------------------------------------------------------

fn packField(word: u32, value: u32, shift: u32, bits: u32) -> u32 {
  let mask = (1u << bits) - 1u;
  return word | ((min(value, mask)) << shift);
}

fn readField(word: u32, shift: u32, bits: u32) -> u32 {
  return (word >> shift) & ((1u << bits) - 1u);
}

//  life0: harmonic 0..4, detune 5..10, support 11..15, flatness 16..19,
//         onset 20..23, register 24..27, coherence 28..31
fn packLife0(harmonic: u32, detuneCents: f32, support: u32, flatness: f32, onset: f32, freq: f32, coherence: f32) -> u32 {
  var w = 0u;
  w = packField(w, harmonic, 0u, 5u);
  w = packField(w, u32(clamp(round(detuneCents) + 32.0, 0.0, 63.0)), 5u, 6u);
  w = packField(w, support, 11u, 5u);
  w = packField(w, u32(clamp(flatness, 0.0, 1.0) * 15.0 + 0.5), 16u, 4u);
  w = packField(w, u32(clamp(round(onset * 7.0) + 8.0, 0.0, 15.0)), 20u, 4u);
  w = packField(w, u32(clamp(floor(log2(max(freq, 20.0) / 20.0)), 0.0, 15.0)), 24u, 4u);
  w = packField(w, u32(clamp(coherence, 0.0, 1.0) * 15.0 + 0.5), 28u, 4u);
  return w;
}

//  life1: age 0..15, vitality 16..21, cohort 22..27, generation 28..31
//
// `dither` is the fractional part added before the vitality quantiser rounds down, and it is
// not a cosmetic detail. Vitality has six bits, so a level is 1/63; a starvation rate slower
// than half of that per step rounds back to the value it started from and the particle becomes
// immortal — which is exactly the range any usable stamina puts it in. Dithering with a
// per-particle hash makes the rounding unbiased instead: a drain of a third of a level takes a
// level away one step in three, so the population starves at the rate the knob says rather than
// not at all. Pass 0.5 for plain rounding.
fn packLife1(age: u32, vitality: f32, cohort: u32, generation: u32, dither: f32) -> u32 {
  var w = 0u;
  w = packField(w, min(age, 65535u), 0u, 16u);
  w = packField(w, u32(clamp(vitality, 0.0, 1.0) * 63.0 + clamp(dither, 0.0, 0.999)), 16u, 6u);
  w = packField(w, cohort & 63u, 22u, 6u);
  w = packField(w, min(generation, 15u), 28u, 4u);
  return w;
}

/// A stable 0..1 number for a slot, so a particle has a personality that does not change under
/// it from one step to the next — unlike the per-frame hash the wander uses.
fn slotHash(tid: u32) -> f32 {
  var h = tid * 2654435761u + 0x9e3779b9u;
  h = (h ^ (h >> 16u)) * 2246822519u;
  h = (h ^ (h >> 13u)) * 3266489917u;
  return f32(h >> 8u) / 16777216.0;
}

fn lifeAge(w: u32) -> u32 { return readField(w, 0u, 16u); }
fn lifeVitality(w: u32) -> f32 { return f32(readField(w, 16u, 6u)) / 63.0; }
fn lifeCohort(w: u32) -> u32 { return readField(w, 22u, 6u); }
fn lifeGeneration(w: u32) -> u32 { return readField(w, 28u, 4u); }

fn life0Harmonic(w: u32) -> u32 { return readField(w, 0u, 5u); }
fn life0Support(w: u32) -> f32 { return f32(readField(w, 11u, 5u)); }
fn life0Flatness(w: u32) -> f32 { return f32(readField(w, 16u, 4u)) / 15.0; }
fn life0Coherence(w: u32) -> f32 { return f32(readField(w, 28u, 4u)) / 15.0; }

fn packColour(rgb: vec3<f32>, flags: u32) -> u32 {
  let q = vec3<u32>(clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0)) * 255.0 + 0.5);
  return (q.r << 16u) | (q.g << 8u) | q.b | ((flags & 255u) << 24u);
}

fn unpackRgb(word: u32) -> vec3<f32> {
  return vec3<f32>(f32((word >> 16u) & 255u), f32((word >> 8u) & 255u), f32(word & 255u)) / 255.0;
}

fn colourFlags(word: u32) -> u32 { return (word >> 24u) & 255u; }

// ---------------------------------------------------------------------------------------
// Colour: where a particle sits in the octave, through the wheel
// ---------------------------------------------------------------------------------------

/// Position in the octave, measured from C, in turns of the wheel.
///
/// One turn per octave is the chromatic ordering. Seven turns walks the circle of fifths
/// instead: a fifth becomes a small step in hue rather than most of the way round, so notes
/// that agree look like they agree. Seven and twelve share no factor, so every pitch class
/// still keeps a colour of its own.
fn wheelPhase(freq: f32) -> f32 {
  return fract(log2(max(freq, 1.0) / 16.3516) * P.i.w);
}

fn wheelAt(phase: f32) -> vec3<f32> {
  let t = fract(phase) * 256.0;
  let i0 = u32(t) % 256u;
  // Wrapping rather than clamping at the top: the wheel closes, and pinning the last entry
  // would put a flat spot of one two-hundred-and-fifty-sixth of an octave at B.
  let i1 = (i0 + 1u) % 256u;
  return mix(wheel[i0].rgb, wheel[i1].rgb, fract(t));
}

/// The colour a particle should be right now, given where it is and what it has turned out to
/// be. Saturation is how sure the organism is that this is a note at all; brightness leans on
/// which harmonic it is, so a fundamental reads stronger than its own twentieth partial.
fn particleColour(freq: f32, harmonic: u32, support: f32, flatness: f32) -> vec3<f32> {
  let base = wheelAt(wheelPhase(freq));
  let supportF = min(1.0, support / 8.0);
  let saturation = clamp((1.0 - flatness) * (0.35 + 0.65 * supportF), 0.0, 1.0);
  var depth = 0.5;
  if (harmonic > 0u) { depth = 1.0 / sqrt(f32(harmonic)); }
  // Desaturating toward the wheel entry's own grey rather than toward a fixed one, so a washed
  // out particle stays in the family it came from instead of sliding to neutral.
  let grey = dot(base, vec3<f32>(0.2126, 0.7152, 0.0722));
  return mix(vec3<f32>(grey), base, saturation) * (0.62 + 0.66 * depth);
}

// ---------------------------------------------------------------------------------------
// The pheromone field — one axis, log frequency, because that is the axis ratios live on
// ---------------------------------------------------------------------------------------

fn freqToBin(f: f32) -> f32 {
  return (log2(max(f, 1.0) / P.b.y) / P.b.z) * f32(P.a.z);
}

fn binToFreq(bin: f32) -> f32 {
  return P.b.y * exp2((bin / f32(P.a.z)) * P.b.z);
}

fn fieldAt(f: f32) -> f32 {
  let bin = freqToBin(f);
  if (bin < 0.0 || bin >= f32(P.a.z) - 1.0) {
    return 0.0;
  }
  // Linear interpolation: the sensors land between bins constantly, and a nearest-neighbour
  // read would quantise every ratio to the bin grid and stop the tuning behaviour dead.
  let i = u32(floor(bin));
  let t = bin - floor(bin);
  return mix(field[i], field[i + 1u], t);
}

/// Amplitude-weighted centroid of the field near `f`, so a sensor can report *where* the
/// energy it found actually is rather than only that it is nearby.
fn fieldCentroid(f: f32, spanBins: i32) -> vec2<f32> {
  let centre = freqToBin(f);
  var weight = 0.0;
  var moment = 0.0;
  for (var d = -spanBins; d <= spanBins; d = d + 1) {
    let bin = centre + f32(d);
    if (bin < 0.0 || bin >= f32(P.a.z)) { continue; }
    let w = field[u32(bin)];
    weight = weight + w;
    moment = moment + w * bin;
  }
  if (weight <= 1e-9) {
    return vec2<f32>(f, 0.0);
  }
  return vec2<f32>(binToFreq(moment / weight), weight);
}

/// Linear amplitude of the live spectrum at a frequency: what there is to eat here, now.
fn foodAt(f: f32) -> f32 {
  let bins = u32(P.f.x);
  let bin = f * 2.0 * f32(bins - 1u) / max(P.b.x, 1.0);
  if (bin < 0.0 || bin >= f32(bins)) {
    return 0.0;
  }
  return exp2(spectrum[u32(bin)] / 6.02059991328);
}

/// Which way is uphill between two sensor readings, and how confidently, in -1..1.
///
/// Saturating rather than a bare `sign`, and the difference matters more than it looks. A sign
/// is full strength in whatever direction the readings differ, however slightly they differ —
/// so a particle standing in a stretch of spectrum with nothing in it gets a full-strength shove
/// from whichever sensor happened to catch a rounding error, and a sated one being pushed away
/// from its partial would keep going at that speed until it left the display. Normalising by the
/// total means the same direction and the same maximum where there really is a slope, and
/// nothing at all where there is nothing to react to.
fn slope(up: f32, down: f32) -> f32 {
  return (up - down) / max(up + down, 1e-12);
}

/// Roughly how many particles are already sustaining the field at this frequency.
///
/// A particle of amplitude `a` holds up `a * deposit / (1 - decay)` of field once it has
/// settled, so dividing the standing field by that gives an occupancy in units of particles —
/// scale-free, and still meaning the same thing after the deposit and decay knobs are moved.
fn occupancy(f: f32, amp: f32) -> f32 {
  let unit = max(amp, 1e-12) * P.d.z / max(1.0 - P.d.x, 1e-3);
  return fieldAt(f) / max(unit, 1e-12);
}

// ---------------------------------------------------------------------------------------
// Consonance: how an organism tells its own kind from somebody else's
// ---------------------------------------------------------------------------------------
//
// A particle cannot read another particle's mind, and the field it senses through is a single
// scalar over log frequency — there is nothing in it that says which note a neighbour came from.
// It does not need one. The interval between two partials is the whole story: two members of the
// same harmonic system always meet at a simple ratio, and members of two different systems
// sounding at once meet, over and over, at sevenths and tritones and semitones.
//
// So the organism probes a fixed set of intervals and reacts by what it finds there. At a simple
// ratio it pulls itself into exact tune with whatever answered; at a rough one it moves away.
// Sound a G major triad and an A minor triad into it and the two do not average into a cloud —
// each one's partials tighten onto their own series and the two series push each other apart,
// because every cross-pair between them is one of the negative rows below.
//
// The affinities are ordered the way the intervals actually behave: octave and fifth are the
// strongest agreements, thirds and sixths weaker ones, and the semitone is the strongest
// disagreement there is — two partials a semitone apart beat at a rate the ear hears as
// roughness, which is the physical fact this whole table stands on.
const INTERVAL_COUNT: u32 = 16u;

fn intervalRatio(i: u32) -> f32 {
  var r = array<f32, 16>(
    2.0, 0.5,              // octave
    1.5, 0.6666667,        // perfect fifth
    1.3333333, 0.75,       // perfect fourth
    1.25, 0.8,             // major third
    1.2, 0.8333333,        // minor third
    1.0594631, 0.9438743,  // semitone
    1.4142136, 0.7071068,  // tritone
    1.8877486, 0.5297315,  // major seventh
  );
  return r[i];
}

fn intervalAffinity(i: u32) -> f32 {
  var a = array<f32, 16>(
    1.00, 1.00,
    0.85, 0.85,
    0.70, 0.70,
    0.55, 0.55,
    0.45, 0.45,
    -1.00, -1.00,
    -0.75, -0.75,
    -0.60, -0.60,
  );
  return a[i];
}

// ---------------------------------------------------------------------------------------
// The intrinsic wobble
// ---------------------------------------------------------------------------------------
//
// Duplicated in life_draw.wgsl, which draws the phosphor trail by integrating this backwards.
// The two must agree exactly or the trail will not lie on the path the particle took.

/** Radians per step for a fundamental. A harmonic n wobbles n times as fast. */
const VIBRATO_RATE: f32 = 0.021;
/** Radians per step of the slow walk up and down the particle's own series. */
const ROAM_RATE: f32 = 0.0165;

/// How unsure a particle is that it is a note at all. Sets the depth of the wobble: a clean
/// partial holds a taut line, one born into a flat spectrum shivers.
fn unsureness(coherence: f32, flatness: f32) -> f32 {
  return clamp(1.0 - coherence * 0.7 + flatness * 0.5, 0.0, 1.6);
}

/// Displacement in cents from the carrier, at a given age.
fn vibratoAt(age: f32, harmonic: u32, phase: f32, depth: f32) -> f32 {
  // The rate is the harmonic number, capped at the eighth: beyond that the flutter would be
  // faster than the display can resolve and would read as noise rather than as shimmer.
  let rate = VIBRATO_RATE * f32(clamp(harmonic, 1u, 8u));
  return depth * sin(age * rate + phase);
}

// ---------------------------------------------------------------------------------------
// Census: what is in the spectrum this frame
// ---------------------------------------------------------------------------------------

var<workgroup> peakFreq: array<f32, 64>;
var<workgroup> peakAmp: array<f32, 64>;

fn harmonicNumber(freq: f32, fundamental: f32) -> vec2<f32> {
  if (freq <= 0.0 || fundamental <= 0.0) { return vec2<f32>(0.0, 0.0); }
  let ratio = freq / fundamental;
  let n = round(ratio);
  if (n < 1.0 || n > f32(MAX_HARMONIC)) { return vec2<f32>(0.0, 0.0); }
  let detune = 1200.0 * log2(freq / (n * fundamental));
  // The gate widens with harmonic number for string stiffness, but never past half the gap to
  // the neighbour — see dsp/harmonics.ts, which this mirrors.
  let halfSpacing = 600.0 * log2((n + 1.0) / n);
  let tolerance = min(35.0 * (1.0 + log2(n) * 0.35), halfSpacing * 0.5);
  if (abs(detune) > tolerance) { return vec2<f32>(0.0, 0.0); }
  return vec2<f32>(n, 1.0 - abs(detune) / tolerance);
}

@compute @workgroup_size(64)
fn survey(@builtin(local_invocation_id) lid: vec3<u32>) {
  let tid = lid.x;
  let bins = u32(P.f.x);
  let fs = P.b.x;

  // Each thread takes a stripe and keeps the strongest local maximum in it. Sixty-four
  // candidates is more than enough to describe a frame: a spectrum with more than sixty-four
  // meaningful partials is one where the identity of any single partial is not the point.
  var bestF = 0.0;
  var bestA = 0.0;

  var k = tid + 1u;
  loop {
    if (k + 1u >= bins) { break; }
    let db = spectrum[k];
    let amp = exp2(db / 6.02059991328);
    if (db > P.f.y && spectrum[k] > spectrum[k - 1u] && spectrum[k] >= spectrum[k + 1u]) {
      if (amp > bestA) {
        // Parabolic interpolation on the log magnitudes: the true peak almost never lands on
        // a bin centre, and a whole-bin frequency would make every harmonic ratio wrong.
        let y0 = spectrum[k - 1u];
        let y1 = spectrum[k];
        let y2 = spectrum[k + 1u];
        let denom = y0 - 2.0 * y1 + y2;
        var offset = 0.0;
        if (abs(denom) > 1e-9) { offset = 0.5 * (y0 - y2) / denom; }
        bestF = (f32(k) + clamp(offset, -0.5, 0.5)) * fs / (2.0 * f32(bins - 1u));
        bestA = amp;
      }
    }
    k = k + 64u;
  }

  peakFreq[tid] = bestF;
  peakAmp[tid] = bestA;
  workgroupBarrier();

  if (tid != 0u) { return; }

  // Serial merge on one thread: sixty-four candidates into the strongest thirty-two, and the
  // fundamental they imply. This is small enough that the simplest thing is also the fastest.
  var chosen = 0u;
  var used = array<bool, 64>();
  loop {
    if (chosen >= 32u) { break; }
    var bi = 64u;
    var ba = 0.0;
    for (var i = 0u; i < 64u; i = i + 1u) {
      if (!used[i] && peakAmp[i] > ba) { ba = peakAmp[i]; bi = i; }
    }
    if (bi == 64u || ba <= 0.0) { break; }
    used[bi] = true;
    census.peaks[chosen] = vec2<f32>(peakFreq[bi], peakAmp[bi]);
    chosen = chosen + 1u;
  }
  census.peakCount = chosen;

  // Try every peak as a fundamental, and as though it were the 2nd, 3rd or 4th harmonic of
  // something lower — a spectrum whose fundamental is missing would otherwise hand every one
  // of its particles the wrong identity. The 1/sqrt(n) weighting is what stops the search
  // running away down the octaves.
  var bestScore = 0.0;
  var fundamental = 0.0;
  for (var i = 0u; i < chosen; i = i + 1u) {
    for (var d = 1u; d <= 4u; d = d + 1u) {
      let candidate = census.peaks[i].x / f32(d);
      if (candidate < 10.0) { continue; }
      var score = 0.0;
      for (var j = 0u; j < chosen; j = j + 1u) {
        let id = harmonicNumber(census.peaks[j].x, candidate);
        if (id.x < 1.0) { continue; }
        score = score + census.peaks[j].y * id.y / sqrt(id.x);
      }
      if (score > bestScore) { bestScore = score; fundamental = candidate; }
    }
  }
  census.fundamental = fundamental;

  // Wiener entropy over the whole frame, as the exponential of a mean log rather than a
  // product that would underflow long before it finished.
  var glog = 0.0;
  var asum = 0.0;
  var n = 0.0;
  for (var i = 1u; i < bins; i = i + 37u) {
    let amp = exp2(spectrum[i] / 6.02059991328);
    glog = glog + log2(max(amp, 1e-12));
    asum = asum + amp;
    n = n + 1.0;
  }
  var flatness = 0.0;
  if (n > 0.0 && asum > 0.0) {
    flatness = clamp(exp2(glog / n) / (asum / n), 0.0, 1.0);
  }
  census.flatness = flatness;
  // A cohort id that changes when the fundamental does, so the particles of one note share an
  // identity and the particles of the next note do not inherit it.
  census.cohort = u32(max(fundamental, 0.0) * 0.37) & 63u;
}

// ---------------------------------------------------------------------------------------
// Birth
// ---------------------------------------------------------------------------------------

@compute @workgroup_size(64)
fn birth(@builtin(global_invocation_id) gid: vec3<u32>) {
  let tid = gid.x;
  if (tid >= P.a.x) { return; }

  let p = points[tid];
  let valid = p.w;
  let freq = p.y;
  let amp = p.z;
  if (valid < 0.5 || amp < P.e.x || freq < P.b.y) { return; }

  // A particle is a *partial*, not a bin.
  //
  // Reassignment emits one point per bin per analysis frame, which at 4096 points and 24 frames
  // to a paint is fifty thousand births in a sixtieth of a second — the pool turns over
  // completely in five frames and nothing lives long enough to go anywhere. That was not a
  // missing tick; it was a population with no life expectancy.
  //
  // Only the local maxima of the magnitude spectrum become organisms. The bins on the flanks of
  // a peak are the same partial seen through the window's skirts; they carry no separate
  // identity, and a peak that a particle can be born on is the smallest thing in a spectrum
  // that it is meaningful to call a thing.
  let bins = u32(P.f.x);
  let k = tid % bins;
  if (k == 0u || k + 1u >= bins) { return; }
  if (!(spectrum[k] > spectrum[k - 1u] && spectrum[k] >= spectrum[k + 1u])) { return; }

  let fundamental = census.fundamental;
  let id = harmonicNumber(freq, fundamental);
  let harmonic = u32(id.x);

  // How much family it has: partials of the same series present in this frame.
  var support = 0u;
  var seen = 0u;
  for (var i = 0u; i < census.peakCount; i = i + 1u) {
    let other = harmonicNumber(census.peaks[i].x, fundamental);
    let n = u32(other.x);
    if (n == 0u || n > 31u) { continue; }
    let bit = 1u << (n - 1u);
    if ((seen & bit) != 0u) { continue; }
    seen = seen | bit;
    support = support + 1u;
  }

  // Coherence: reassignment barely has to move a stable partial and has to move phase noise a
  // long way, so the size of the correction is a direct measure of how real the partial is.
  // The analyze pass carries it in the validity slot — see analyze.wgsl.
  let coherence = clamp((valid - 0.5) * 2.0, 0.0, 1.0);

  // Do not clone onto a frequency somebody already lives at.
  //
  // Without this the population is not a population, it is a fountain. Every analysis frame
  // re-emits the same ninety partials, so ninety organisms are born on the spot, sixty times a
  // second, and the ring overwrites the whole cast every eleven frames — each one dying a fifth
  // of a semitone from where it started, having had no life to speak of. Suppressing the birth
  // hands that energy to the residents instead, through the feeding step below, and what was a
  // stream of identical newborns becomes a cast of individuals that persist and travel.
  let crowd = occupancy(freq, amp);
  let generation = u32(clamp(crowd * 4.0, 0.0, 15.0));
  let onset = clamp(1.0 - crowd, -1.0, 1.0);
  if (crowd > P.h.y) { return; }

  let flatness = census.flatness;
  var flags = FLAG_ALIVE;
  if (harmonic > 0u) { flags = flags | FLAG_HARMONIC; }
  if (onset > 0.4) { flags = flags | FLAG_ONSET; }
  if (flatness > 0.5) { flags = flags | FLAG_NOISE; }

  let rgb = particleColour(freq, harmonic, f32(support), flatness);

  // Ring allocation, wrapping at the population cap rather than at the pool size. Because
  // slots are handed out in birth order, the slot the ring comes back to always holds the
  // oldest particle — so "cull the oldest when the cap is reached" is not a policy that needs
  // implementing, it is what a ring already does. Lowering the cap simply makes the population
  // smaller and the turnover faster.
  let cap = max(1u, min(u32(P.g.y), P.a.y));
  let slot = atomicAdd(&allocator[0], 1u) % cap;

  var q: Particle;
  q.time = p.x;
  q.freq = freq;
  q.energy = amp;
  q.drift = 0.0;
  q.colour = packColour(rgb, flags);
  var detune = 0.0;
  if (harmonic > 0u && fundamental > 0.0) {
    detune = 1200.0 * log2(freq / (f32(harmonic) * fundamental));
  }
  q.life0 = packLife0(harmonic, detune, support, flatness, onset, freq, coherence);
  q.life1 = packLife1(0u, 1.0, census.cohort, generation, 0.5);
  q.birthFreq = freq;
  particles[slot] = q;
}

// ---------------------------------------------------------------------------------------
// Step: sense the surface, read the intervals, walk your own road, age, deposit
// ---------------------------------------------------------------------------------------
//
// Four things move a particle, and they are deliberately of different kinds:
//
//   the surface    the live spectrum underneath it, sensed a little above and a little below.
//                  Not a rail: a slope. It is felt, not followed
//   the crowd      the pheromone field — how many others are standing where it is standing
//   the intervals  what ratio the others are at, which is how an organism with no way to read
//                  a neighbour's mind still knows whether that neighbour is family
//   its own road   the harmonic series it was born on, walked on a clock of its own, past
//                  stations that may or may not have anything at them
//
// The last is the one that makes this a life rather than a rendering. The first three are all
// reactions to something the signal did, and a particle with only those traces the tracks it was
// measured from — a spectrogram with extra steps. The itinerary is nobody's business but the
// particle's, and it is why the population crosses the tracks instead of lying on them.

@compute @workgroup_size(64)
fn step(@builtin(global_invocation_id) gid: vec3<u32>) {
  let tid = gid.x;
  if (tid >= P.a.y) { return; }

  var q = particles[tid];
  let flags = colourFlags(q.colour);
  if ((flags & FLAG_ALIVE) == 0u) { return; }

  let age = lifeAge(q.life1);
  let harmonic = life0Harmonic(q.life0);
  let coherence = life0Coherence(q.life0);
  let flatness = life0Flatness(q.life0);
  let support = life0Support(q.life0);
  let vitalityNow = lifeVitality(q.life1);
  let hunger = clamp(1.0 - vitalityNow, 0.0, 1.0);
  // A number belonging to this slot that does not change under it. Everything that makes one
  // particle behave unlike a neighbour with identical birth properties comes from here.
  let character = slotHash(tid);
  let phase = character * 6.283185307;

  let spread = exp2(P.c.x / 1200.0);
  var turn = 0.0;

  // ---- the surface ------------------------------------------------------------------
  //
  // Hunger decides the sign, and that inversion is the difference between an organism and a
  // sediment. A starving particle climbs toward energy; a full one is pushed off it. Without
  // the second half every particle parks on the loudest thing within reach and stays there, and
  // the population settles into a picture of the spectrum — which is the picture the spectrum
  // already draws for free, and the reason the spectrogram looked dead.
  //
  // With it, a partial is somewhere particles *visit*. They arrive hungry, feed, fill up, are
  // pushed off, travel, run down, and come back. The traffic is the life.
  let appetite = hunger * 1.6 - 0.6;
  let uphill = slope(foodAt(q.freq * spread), foodAt(q.freq / spread));
  turn = turn + uphill * P.c.y * P.i.z * appetite;

  // ---- the crowd --------------------------------------------------------------------
  //
  // The field, which every particle contributes to. Where it is dense the particle is pushed
  // out — less so the more family it has, since a partial with siblings is part of something.
  // But never to nothing: a series with eight members used to switch this term off entirely,
  // which meant the richest and most interesting notes were the ones that stood stillest.
  let denser = slope(fieldAt(q.freq * spread), fieldAt(q.freq / spread));
  let sociability = clamp(support / 8.0, 0.0, 1.0);
  turn = turn - denser * P.c.y * P.g.z * (0.35 + 0.65 * (1.0 - sociability));

  // ---- the intervals ----------------------------------------------------------------
  //
  // Probe every interval in the table and let its affinity decide what to do with the answer.
  // A consonant partner is family: move until the ratio is exact. A dissonant one belongs to
  // some other harmonic system: move away from it. Two chords sounding at once are two
  // populations that will not mix, and this loop is the entire reason why — nothing anywhere
  // labels a particle with which chord it came from, and nothing needs to.
  var pullCents = 0.0;
  var pullWeight = 0.0;
  var pushCents = 0.0;
  var pushWeight = 0.0;
  for (var i = 0u; i < INTERVAL_COUNT; i = i + 1u) {
    let ratio = intervalRatio(i);
    let affinity = intervalAffinity(i);
    let probe = fieldCentroid(q.freq * ratio, 2);
    if (probe.y <= 1e-9) { continue; }
    if (affinity > 0.0) {
      // Where this particle would have to stand for the ratio to be exact.
      let want = 1200.0 * log2(max(probe.x / ratio, 1.0) / max(q.freq, 1.0));
      let w = probe.y * affinity;
      pullCents = pullCents + clamp(want, -120.0, 120.0) * w;
      pullWeight = pullWeight + w;
    } else {
      // Away from the offender. Direction only: how hard is the affinity's business.
      let offset = 1200.0 * log2(max(probe.x, 1.0) / max(q.freq, 1.0));
      let w = probe.y * (-affinity);
      pushCents = pushCents - sign(offset) * w;
      pushWeight = pushWeight + w;
    }
  }
  if (pullWeight > 0.0) {
    // A coherent partial trusts its own frequency and is drawn only gently; an incoherent one
    // has little to lose and snaps to whatever it can find.
    turn = turn + (pullCents / pullWeight) * P.c.z * (1.0 - 0.6 * coherence);
  }
  if (pushWeight > 0.0) {
    turn = turn + (pushCents / pushWeight) * P.c.y * P.i.y;
  }

  // ---- wander -------------------------------------------------------------------------
  //
  // A particle born incoherent into a flat spectrum has no frequency worth holding and boils;
  // a clean partial barely moves. The floor matters as much as the scaling, though — a
  // perfectly symmetric density peak offers no direction at all, and without a little noise to
  // break the tie the crowding tension above would freeze at its own fixed point.
  let restless = 0.12 + (1.0 - coherence) * (0.35 + 0.65 * flatness);
  if (restless > 0.01) {
    // Hashed from the slot and the frame counter: no RNG state to store, and two particles in
    // the same slot on successive frames get unrelated numbers.
    var h = tid * 747796405u + P.a.w * 2891336453u;
    h = (h ^ (h >> 15u)) * 2246822519u;
    h = (h ^ (h >> 13u)) * 3266489917u;
    let noise = f32(h >> 8u) / 8388608.0 - 1.0;
    turn = turn + noise * P.c.y * 4.0 * restless;
  }

  // ---- tenure ---------------------------------------------------------------------------
  //
  // Age reaches the motion, not only the mortality. A particle that has just arrived has no
  // stake in where it is and casts about; one that has been holding a frequency for a long time
  // has, by having survived there, earned the right to be left alone. Every onset therefore
  // throws up a burst of searching that settles, which is what an attack looks like.
  let settled = 1.0 / (1.0 + f32(age) * P.g.w);
  // Tenure quietens a particle, but hunger overrides it: an established resident whose partial
  // has stopped sounding is exactly the one that should be up and looking.
  turn = turn * mix(0.3 + 0.7 * settled, 1.0, hunger);

  // ---- its own road -----------------------------------------------------------------------
  //
  // Added after the tenure damping rather than before it, and the order is the point. Everything
  // above is a reaction, and a particle that has held its ground for a long time has earned the
  // right to react less. An itinerary is not a reaction, and age is no reason to abandon one: an
  // old organism is not a still one, it is one that has stopped being startled.
  //
  // A particle born as harmonic n walks up and down its own series on a clock of its own. One
  // born into noise — harmonic 0, no series to speak of — has no road, and glides freely
  // instead. A negative roam is a particle fleeing its own series rather than pacing it.
  //
  // The station is a *ratio* of the harmonic number, not an offset from it, and that is the
  // difference between a spectrogram that moves and one that only moves in the buffer. Stepping
  // n by a fixed count travels an interval that shrinks with register — from the first harmonic
  // to the third is an octave and a fifth, from the twentieth to the twenty-second is a hundred
  // and sixty cents — so a display whose upper two thirds are high partials sat perfectly still
  // while the arithmetic said the population had moved. A ratio travels the same interval
  // wherever it starts, and an interval is what a log-frequency axis is made of.
  let reach = abs(P.h.z);
  let sweep = sin(f32(age) * ROAM_RATE * (0.45 + 1.1 * character) + phase);
  var station = q.birthFreq * exp2(sweep * reach * 1.5);
  if (harmonic > 0u) {
    let fundamental = q.birthFreq / f32(harmonic);
    station = fundamental * max(0.25, f32(harmonic) * exp2(sweep * reach * 1.5));
  }
  let toStation = clamp(1200.0 * log2(max(station, 1.0) / max(q.freq, 1.0)), -1800.0, 1800.0);
  turn = turn + toStation * 0.035 * P.h.z;

  // ---- move -----------------------------------------------------------------------
  q.drift = clamp(q.drift * P.c.w + turn, -P.e.w, P.e.w);
  // The wobble is a displacement, not a force: what is added each step is its derivative, so
  // the accumulated position carries exactly the depth the knob asks for rather than whatever
  // the momentum term happens to integrate it into. life_draw.wgsl runs the same function
  // backwards to lay the phosphor trail along the path the particle actually took.
  let depth = P.h.w * unsureness(coherence, flatness);
  let wobble =
    vibratoAt(f32(age), harmonic, phase, depth) -
    vibratoAt(f32(age) - 1.0, harmonic, phase, depth);
  var freq = q.freq * exp2((q.drift + wobble) / 1200.0);

  // Leaving the screen is the natural end of a life here. A particle that has wandered above
  // the top of the display or below the bottom is no longer part of anything anyone can see,
  // and keeping it alive would mean paying for a population that exists only in the buffer.
  let viewLo = max(P.f.z, P.b.y);
  let viewHi = min(P.f.w, P.b.y * exp2(P.b.z));
  var offScreen = freq < viewLo || freq > viewHi;

  if (P.g.x > 0.5 && viewHi > viewLo) {
    // Wrapped: the frequency axis becomes a loop. Leave the top and you re-enter at the
    // bottom, an octave relationship away from where you were — which for an organism that
    // lives on ratios is not an arbitrary teleport but the same pitch class arriving from the
    // other end. Done in log space, because that is the axis the display and the ratios share.
    let lo = log2(viewLo);
    let hi = log2(viewHi);
    let span = hi - lo;
    let t = (log2(max(freq, 1.0)) - lo) / span;
    freq = exp2(lo + fract(fract(t) + 1.0) * span);
    offScreen = false;
  }
  q.freq = freq;

  // ---- feed -----------------------------------------------------------------------
  //
  // A particle grazes. If the spectrum still has energy where it is standing then its partial
  // is still sounding and it is sustained; if it has drifted into a gap, or the note has
  // stopped, it starves. This is what couples the organism to the signal moment by moment
  // instead of only at birth, and it is what gives the wandering a consequence: leave your
  // partial and you die of it.
  let food = foodAt(q.freq);
  let fed = food > P.e.x;
  // Rise to the level it is standing in quickly; fall away from it slowly.
  //
  // This was a symmetric mix toward the local level, and it hid every traveller. A particle
  // that stepped off its partial went dark within a few frames, so a moving population looked
  // exactly like a still one — the only particles bright enough to see were the ones that had
  // not gone anywhere. Brightness is the particle's own state now, and it keeps enough of it to
  // be watched crossing the gap.
  q.energy = mix(q.energy, food, select(0.02, 0.4, food > q.energy));

  // ---- age ------------------------------------------------------------------------
  //
  // Starvation has its own clock now. It used to borrow the pheromone field's decay, which
  // meant there was no way to give a particle the endurance to cross a gap without also making
  // the trail permanent — one knob doing two unrelated jobs, and the reason nothing ever
  // survived a journey. `stamina` is how many steps an unfed particle of ordinary constitution
  // lasts. Noise shortens it, because a click was never a thing; a large harmonic family
  // lengthens it, because a note is persisting.
  let noisePenalty = 1.0 + flatness * P.e.y;
  let familyBonus = 1.0 + min(support, 12.0) * P.e.z;
  let drain = (noisePenalty / familyBonus) / max(P.i.x, 1.0);

  var vitality = vitalityNow;
  if (fed) {
    vitality = min(1.0, vitality + (1.0 - vitality) * P.h.x);
  } else {
    vitality = vitality - drain;
  }
  let nextAge = min(age + 1u, 65535u);
  // A lifespan of zero means no clock at all: the particle lives until its energy is spent,
  // until it leaves the screen, or until the ring comes round and the cap claims it.
  let aged = P.d.w > 0.5 && f32(nextAge) > P.d.w;
  if (vitality < 0.004 || aged || offScreen) {
    // Death is a cleared flag. The slot stays where it is until the ring comes round again.
    q.colour = q.colour & 0x00ffffffu;
    particles[tid] = q;
    return;
  }
  // The dither is a low-discrepancy sequence per particle rather than a fresh hash: it advances
  // by the golden ratio every frame, so the rounding error over any run of steps is bounded
  // instead of merely zero-mean, and a long stamina drains at the rate it says even for the few
  // hundred steps a particle actually lives.
  let dither = fract(character + f32(P.a.w) * 0.6180339887);
  q.life1 = packLife1(nextAge, vitality, lifeCohort(q.life1), lifeGeneration(q.life1), dither);
  // ---- colour ----------------------------------------------------------------------
  //
  // Recomputed every step rather than kept from birth, for two reasons.
  //
  // A particle roams, and the vectorscope has always placed it by the pitch class it is at now.
  // Holding the birth colour meant the hue and the position disagreed the moment anything moved
  // — a particle drawn at F wearing the colour of the C it was born on. Now a particle walking
  // its own series sweeps the wheel as it goes, and all four panes agree about what it is.
  //
  // It also means changing the wheel repaints the whole population on the next frame instead of
  // waiting for the cast to turn over, which for long-lived residents is a wait with no end.
  //
  // Only the low twenty-four bits: the top byte is flags and does not belong to the colour.
  let tint = particleColour(q.freq, harmonic, support, flatness);
  q.colour = (q.colour & 0xff000000u) | (packColour(tint, 0u) & 0x00ffffffu);

  // Being fed is worth recording: the draw passes use it, and it is the difference between a
  // particle that is sustaining a partial and one that is on its way out.
  if (fed) {
    q.colour = q.colour | (FLAG_FED << 24u);
  } else {
    q.colour = q.colour & ~(FLAG_FED << 24u);
  }

  // ---- deposit --------------------------------------------------------------------
  let bin = freqToBin(q.freq);
  if (bin >= 0.0 && bin < f32(P.a.z)) {
    let amount = u32(clamp(q.energy * vitality * P.d.z, 0.0, 1e7) * DEPOSIT_SCALE);
    if (amount > 0u) {
      atomicAdd(&deposit[u32(bin)], amount);
    }
  }

  particles[tid] = q;
}

// ---------------------------------------------------------------------------------------
// Settle: drain the accumulator, diffuse, decay
// ---------------------------------------------------------------------------------------

@compute @workgroup_size(64)
fn settle(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.a.z) { return; }

  let fresh = f32(atomicExchange(&deposit[i], 0u)) / DEPOSIT_SCALE;

  // A three-tap blur in log frequency. Diffusion is what lets a particle sense a neighbour it
  // is not yet on top of; without it the field is a set of spikes and nothing ever finds
  // anything.
  let lo = field[select(i - 1u, i, i == 0u)];
  let hi = field[select(i + 1u, i, i + 1u >= P.a.z)];
  let blurred = mix(field[i], (lo + field[i] + hi) / 3.0, P.d.y);

  fieldOut[i] = (blurred + fresh) * P.d.x;
}
