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
  // x: feed rate   y: occupancy a frequency may hold before births are suppressed   z/w: unused
  h: vec4<f32>,
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
fn packLife1(age: u32, vitality: f32, cohort: u32, generation: u32) -> u32 {
  var w = 0u;
  w = packField(w, min(age, 65535u), 0u, 16u);
  w = packField(w, u32(clamp(vitality, 0.0, 1.0) * 63.0 + 0.5), 16u, 6u);
  w = packField(w, cohort & 63u, 22u, 6u);
  w = packField(w, min(generation, 15u), 28u, 4u);
  return w;
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

fn hslToRgb(h: f32, s: f32, l: f32) -> vec3<f32> {
  let a = s * min(l, 1.0 - l);
  var out = vec3<f32>(0.0);
  for (var i = 0u; i < 3u; i = i + 1u) {
    let n = array<f32, 3>(0.0, 8.0, 4.0)[i];
    let k = (n + h * 12.0) % 12.0;
    out[i] = l - a * max(-1.0, min(min(k - 3.0, 9.0 - k), 1.0));
  }
  return out;
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

  // Chroma: position within the octave, so every octave of a note is one colour and a harmonic
  // series reads as a repeating sequence instead of a ramp.
  let chroma = fract(log2(max(freq, 1.0) / 16.3516));
  let supportF = min(1.0, f32(support) / 8.0);
  let saturation = clamp((1.0 - flatness) * (0.35 + 0.65 * supportF), 0.0, 1.0);
  var depth = 0.5;
  if (harmonic > 0u) { depth = 1.0 / sqrt(f32(harmonic)); }
  let rgb = hslToRgb(chroma, saturation, 0.35 + 0.45 * depth);

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
  q.life1 = packLife1(0u, 1.0, census.cohort, generation);
  q.birthFreq = freq;
  particles[slot] = q;
}

// ---------------------------------------------------------------------------------------
// Step: sense at ratios, steer, move, age, deposit
// ---------------------------------------------------------------------------------------

@compute @workgroup_size(64)
fn step(@builtin(global_invocation_id) gid: vec3<u32>) {
  let tid = gid.x;
  if (tid >= P.a.y) { return; }

  var q = particles[tid];
  let flags = colourFlags(q.colour);
  if ((flags & FLAG_ALIVE) == 0u) { return; }

  let age = lifeAge(q.life1);
  let coherence = life0Coherence(q.life0);
  let flatness = life0Flatness(q.life0);
  let support = life0Support(q.life0);
  let vitalityNow = lifeVitality(q.life1);

  // ---- sense ----------------------------------------------------------------------
  //
  // Spatial sensors, as Physarum has them: a little above and a little below. But a slime
  // mould crawls away from where it deposited a moment ago, and a particle here does not — it
  // deposits at its own frequency every step and then reads its own trail back, symmetrically,
  // from both sensors at once. Left like that it sits in a pheromone well of its own making
  // with nothing to tell it which way to go, and the population is a set of straight lines.
  //
  // What breaks the symmetry is that company is not always wanted. A particle alone at a
  // frequency seeks the crowd; a particle in the middle of one makes room. The two together
  // never settle: a partial becomes a band that keeps rearranging itself, rather than a
  // thousand organisms stacked in a single file pretending to be a spectrogram.
  let spread = exp2(P.c.x / 1200.0);
  var turn = 0.0;

  // Two signals, pulling opposite ways — which is the whole reason anything moves.
  //
  // The first is food: the live spectrum, sensed a little above and a little below. A particle
  // climbs toward it in proportion to how hungry it is, so a fed one holds its partial and a
  // starving one hunts. This is the term that was missing. Sensing only the pheromone field
  // meant sensing only where the particles already were, and a population that follows itself
  // does not go anywhere; a population that follows the *signal* crawls onto every partial and
  // keeps crawling as the partials move.
  //
  // The second is kin: the field, which each particle contributes to. Where it is dense the
  // particle is pushed out — less so the more family it has, since a partial with siblings is
  // part of something and holds station while a lone one has no reason to stay.
  //
  // Together they make an ecology rather than a picture. A partial gathers particles until it
  // is crowded, the crowd pushes some out, the ones pushed out are hungry, and hunger sends
  // them looking for somewhere else to be.
  let hunger = clamp(1.0 - vitalityNow, 0.0, 1.0);
  let foodGradient = foodAt(q.freq * spread) - foodAt(q.freq / spread);
  turn = turn + sign(foodGradient) * P.c.y * (0.25 + 0.75 * hunger);

  let kinUp = fieldAt(q.freq * spread);
  let kinDown = fieldAt(q.freq / spread);
  let sociability = clamp(support / 8.0, 0.0, 1.0);
  turn = turn - sign(kinUp - kinDown) * P.c.y * P.g.z * (1.0 - sociability);

  // Harmonic sensors. Each ratio is a question: is there anything an octave above me, a fifth
  // below me? The strongest answer becomes a pull toward the frequency that would make the
  // relationship exact — which is the entire behaviour this organism exists to have.
  //
  // Unison is excluded — it is where the particle already is — and the set is deliberately
  // small and low: these are the ratios a sustained tone actually produces, and adding more
  // only makes everything attract everything.
  var ratios = array<f32, 8>(2.0, 0.5, 1.5, 0.6666667, 3.0, 0.3333333, 4.0, 0.25);
  var bestWeight = 0.0;
  var bestTarget = q.freq;
  for (var i = 0u; i < 8u; i = i + 1u) {
    let ratio = ratios[i];
    let probe = fieldCentroid(q.freq * ratio, 2);
    // Prefer simple ratios: an octave partner should outrank a distant twelfth.
    let simplicity = 1.0 / (1.0 + abs(log2(ratio)));
    let weight = probe.y * simplicity;
    if (weight > bestWeight) {
      bestWeight = weight;
      bestTarget = probe.x / ratio;
    }
  }
  if (bestWeight > 0.0) {
    let pullCents = clamp(1200.0 * log2(max(bestTarget, 1.0) / max(q.freq, 1.0)), -60.0, 60.0);
    // A coherent partial trusts its own frequency and is pulled only gently; an incoherent one
    // has little to lose and snaps to whatever it can find.
    turn = turn + pullCents * P.c.z * (1.0 - 0.6 * coherence);
  }

  // Wander. A particle born incoherent into a flat spectrum has no frequency worth holding and
  // boils; a clean partial barely moves. The floor matters as much as the scaling, though —
  // a perfectly symmetric density peak offers no direction at all, and without a little noise
  // to break the tie the crowding tension above would freeze at its own fixed point.
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

  // Age reaches the motion, not only the mortality. A particle that has just arrived has no
  // stake in where it is and casts about; one that has been holding a frequency for a long
  // time has, by having survived there, earned the right to be left alone. Every onset
  // therefore throws up a burst of searching that settles — which is what an attack looks
  // like — and the floor keeps the settled ones from becoming furniture.
  let settled = 1.0 / (1.0 + f32(age) * P.g.w);
  // Tenure quietens a particle, but hunger overrides it: an established resident whose partial
  // has stopped sounding is exactly the one that should be up and looking.
  turn = turn * mix(0.3 + 0.7 * settled, 1.0, hunger);

  // ---- move -----------------------------------------------------------------------
  q.drift = clamp(q.drift * P.c.w + turn, -P.e.w, P.e.w);
  var freq = q.freq * exp2(q.drift / 1200.0);

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
  // Brightness follows the real level rather than a decaying memory of the birth level.
  q.energy = mix(q.energy, food, 0.3);

  // ---- age ------------------------------------------------------------------------
  // Mortality is a statement about what the particle is. Noise starves quickly because it was
  // never a thing; a partial with a large family holds on because a note is persisting.
  let noisePenalty = 1.0 + flatness * P.e.y;
  let familyBonus = 1.0 + min(support, 12.0) * P.e.z;
  let decay = pow(P.d.x, noisePenalty / familyBonus);

  var vitality = vitalityNow;
  if (fed) {
    vitality = vitality + (1.0 - vitality) * P.h.x;
  } else {
    vitality = vitality * decay;
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
  q.life1 = packLife1(nextAge, vitality, lifeCohort(q.life1), lifeGeneration(q.life1));
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
