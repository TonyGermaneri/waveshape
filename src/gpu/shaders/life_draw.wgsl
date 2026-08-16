// The living population, drawn in the other three scopes.
//
// One organism, four windows onto it. The spectrogram shows where the particles have been, over
// the reassigned energy they left; these three show what that means in the coordinates each
// scope already speaks, using the same colours — chroma for pitch class, saturation for how sure
// the organism is that this is a note — so a partial can be followed by eye from one pane to the
// next. Point size, brightness and the opacity of the instrument underneath mean the same thing
// in all four, which they did not used to.
//
//   spectrum     a particle at its own frequency and its own level, which is the domain it was
//                born in: the cloud sits over the curve it came from and drifts off it as the
//                population migrates
//
//   waveform     each living partial drawn as the sine it claims to be. This is not a
//                reconstruction of the signal — the organism never measured phase, and it is
//                not entitled to one — it is the organism's own account of what it is hearing,
//                laid over the trace of what is actually there
//
//   vectorscope  the chromatic circle. Angle is pitch class, so every octave of a note lies on
//                one spoke and a harmonic series fans out into a fixed figure; radius is level.
//                A chord is a constellation, and a glissando is a rotation
//
// Additive blending throughout, as everywhere else in this renderer: density becomes brightness
// and a hundred particles agreeing about a pitch class make a bright spoke.

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

struct LifeDraw {
  // x: traces drawn   y: segments per trace   z: population cap   w: trail steps (0 = off)
  a: vec4<u32>,
  // x: view low Hz   y: view high Hz   z: log axis (0/1)   w: seconds across the pane
  b: vec4<f32>,
  // x: dbMin   y: dbMax   z: point size px   w: brightness
  c: vec4<f32>,
  // x: trail fade per step   y: trail modulation   z: vibrato cents   w: colour saturation
  d: vec4<f32>,
}

@group(0) @binding(0) var<uniform> S: Style;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;
@group(0) @binding(2) var<uniform> L: LifeDraw;
// The birth counter, so the traces can be taken from the newest end of the ring.
@group(0) @binding(3) var<storage, read> allocator: array<u32>;

const TAU: f32 = 6.283185307179586;

struct Out {
  @builtin(position) pos: vec4<f32>,
  @location(0) offset: vec2<f32>,
  @location(1) @interpolate(flat) tint: vec3<f32>,
  @location(2) @interpolate(flat) level: f32,
}

fn tintOf(q: Particle) -> vec3<f32> {
  let rgb = vec3<f32>(
    f32((q.colour >> 16u) & 255u),
    f32((q.colour >> 8u) & 255u),
    f32(q.colour & 255u),
  ) / 255.0;
  // Saturation is applied here rather than in post, so turning the organism vivid leaves the
  // instrument underneath exactly as the theme drew it.
  return withSaturation(rgb, L.d.w);
}

fn vitalityOf(q: Particle) -> f32 {
  return f32((q.life1 >> 16u) & 63u) / 63.0;
}

fn isAlive(q: Particle) -> bool {
  return ((q.colour >> 24u) & 1u) != 0u && q.energy > 0.0;
}

fn offScreenQuad() -> Out {
  var out: Out;
  out.pos = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  out.offset = vec2<f32>(0.0, 0.0);
  out.tint = vec3<f32>(0.0);
  out.level = 0.0;
  return out;
}

fn axisX(f: f32) -> f32 {
  return freqToAxis(f, L.b.x, L.b.y, L.b.z);
}

// ---------------------------------------------------------------------------------------
// Phosphor
// ---------------------------------------------------------------------------------------
//
// The trail is not a stored path. Nothing anywhere records where a particle has been — with a
// population in the tens of thousands that would be the largest buffer in the program, and it
// would have to be written every step whether or not anybody was looking at it.
//
// It does not have to be stored, because the motion is reproducible. A particle's position is
// its carrier frequency plus an intrinsic wobble that is a pure function of its age, its
// harmonic number and a hash of its slot; its carrier moves at a velocity it is carrying in
// `drift`. Running both backwards from the particle's current state reconstructs the last few
// dozen steps to within the accuracy of the drift having changed slightly — which is exactly
// the error a phosphor's own persistence would blur out anyway.
//
// So the trail costs one quad per step and no memory, and because the wobble is reconstructed
// rather than smeared, its rate and its depth are visible in the phosphor: the trail of a
// clean low partial is a taut ribbon, and the trail of something born in noise high up is a
// fast scribble. That is what makes these trails the organism's and not the renderer's.
//
// The three functions below are duplicated from life.wgsl and must agree with it exactly. If
// they drift apart the trail stops lying along the path the particle actually took, which is a
// failure that looks like a rendering artefact and is not one.

const VIBRATO_RATE: f32 = 0.021;

fn slotHash(tid: u32) -> f32 {
  var h = tid * 2654435761u + 0x9e3779b9u;
  h = (h ^ (h >> 16u)) * 2246822519u;
  h = (h ^ (h >> 13u)) * 3266489917u;
  return f32(h >> 8u) / 16777216.0;
}

fn unsureness(coherence: f32, flatness: f32) -> f32 {
  return clamp(1.0 - coherence * 0.7 + flatness * 0.5, 0.0, 1.6);
}

fn vibratoAt(age: f32, harmonic: u32, phase: f32, depth: f32) -> f32 {
  let rate = VIBRATO_RATE * f32(clamp(harmonic, 1u, 8u));
  return depth * sin(age * rate + phase);
}

fn ageOf(q: Particle) -> u32 { return q.life1 & 65535u; }
fn harmonicOf(q: Particle) -> u32 { return q.life0 & 31u; }
fn coherenceOf(q: Particle) -> f32 { return f32((q.life0 >> 28u) & 15u) / 15.0; }
fn flatnessOf(q: Particle) -> f32 { return f32((q.life0 >> 16u) & 15u) / 15.0; }

/// Where the particle was `back` steps ago, in Hz. `back == 0` is where it is now.
fn trailFreq(q: Particle, slot: u32, back: f32) -> f32 {
  if (back <= 0.0) {
    return q.freq;
  }
  let age = f32(ageOf(q));
  let harmonic = harmonicOf(q);
  let phase = slotHash(slot) * 6.283185307179586;
  // Modulation dials the wobble's contribution to the trail without touching the path itself:
  // at zero the trail is the carrier alone, a plain streak; at one it carries every ripple the
  // particle actually made.
  let depth = L.d.z * unsureness(coherenceOf(q), flatnessOf(q)) * L.d.y;
  let wobble = vibratoAt(age, harmonic, phase, depth) - vibratoAt(age - back, harmonic, phase, depth);
  return q.freq * exp2(-(q.drift * back + wobble) / 1200.0);
}

// ---------------------------------------------------------------------------------------
// Spectrum: the domain the particles were born in
// ---------------------------------------------------------------------------------------

/// One mark of a particle's phosphor: the head when `k` is zero, and `k` steps back along its
/// own path after that. Returns a level of zero for a mark that should not be drawn.
struct Mark {
  freq: f32,
  level: f32,
  radius: f32,
}

fn markOf(q: Particle, slot: u32, k: u32) -> Mark {
  var m: Mark;
  m.freq = q.freq;
  m.radius = max(L.c.z, 0.5);
  m.level = vitalityOf(q) * L.c.w;
  if (k == 0u) {
    return m;
  }
  // A particle cannot have a trail older than it is.
  if (k > ageOf(q)) {
    m.level = 0.0;
    return m;
  }
  let back = f32(k);
  m.freq = trailFreq(q, slot, back);
  // How long a phosphor holds is a property of whatever excited it. A particle with vitality to
  // spare leaves a long trail; a starving one barely marks the screen at all. This is the
  // amplitude half of the modulation — the rate half is the wobble in `trailFreq`, which runs
  // at the harmonic number the particle was born as.
  let fade = clamp(L.d.x * mix(1.0, 0.55 + 0.6 * vitalityOf(q), L.d.y), 0.0, 0.999);
  m.level = m.level * pow(fade, back);
  m.radius = max(m.radius * (0.45 + 0.55 * pow(fade, back)), 0.4);
  return m;
}

@vertex
fn vsPoint(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> Out {
  let stride = L.a.w + 1u;
  let slot = inst / stride;
  let k = inst % stride;
  let q = particles[slot];
  if (slot >= L.a.x || !isAlive(q)) {
    return offScreenQuad();
  }
  let m = markOf(q, slot, k);
  if (m.level <= 0.0) {
    return offScreenQuad();
  }
  let x = axisX(m.freq);
  if (x < 0.0 || x > 1.0) {
    return offScreenQuad();
  }
  let db = amplitudeToDb(q.energy);
  let y = 1.0 - dbToAxis(db, L.c.x, L.c.y);

  let c = quadCorner(vi) * 2.0 - 1.0;
  let px = vec2<f32>(x * S.resolution.x, y * S.resolution.y) + c * m.radius;

  var out: Out;
  out.pos = toNdc(px, S.resolution.xy);
  // Normalised to the unit disc rather than carried in pixels: a trail's marks shrink as they
  // age, and the fragment shader has no other way to know how big the one it is shading was.
  out.offset = c;
  out.tint = tintOf(q);
  out.level = m.level;
  return out;
}

// ---------------------------------------------------------------------------------------
// Vectorscope: the chromatic circle
// ---------------------------------------------------------------------------------------

@vertex
fn vsChroma(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> Out {
  let stride = L.a.w + 1u;
  let slot = inst / stride;
  let k = inst % stride;
  let q = particles[slot];
  if (slot >= L.a.x || !isAlive(q)) {
    return offScreenQuad();
  }
  let m = markOf(q, slot, k);
  if (m.level <= 0.0) {
    return offScreenQuad();
  }
  // Pitch class, measured from C, is the angle. Octaves therefore stack on one spoke and the
  // figure a sound makes is a property of its harmony rather than of its register. A trail here
  // is an arc: a particle walking its own series sweeps the circle, and one holding a partial
  // draws a comma-sized smudge on its spoke.
  let chroma = fract(log2(max(m.freq, 1.0) / 16.3516));
  let angle = chroma * TAU - TAU * 0.25;
  // Radius is level, floored so that a quiet partial is a faint mark near the centre rather
  // than a point exactly on it, where every pitch class would overlap.
  let db = amplitudeToDb(q.energy);
  let radius = 0.12 + 0.88 * dbToAxis(db, L.c.x, L.c.y);

  let centre = S.resolution.xy * 0.5;
  let scale = min(S.resolution.x, S.resolution.y) * 0.5;
  let c = quadCorner(vi) * 2.0 - 1.0;
  let px = centre + vec2<f32>(cos(angle), sin(angle)) * radius * scale + c * m.radius;

  var out: Out;
  out.pos = toNdc(px, S.resolution.xy);
  out.offset = c;
  out.tint = tintOf(q);
  out.level = m.level;
  return out;
}

@fragment
fn fsPoint(in: Out) -> @location(0) vec4<f32> {
  let d2 = dot(in.offset, in.offset);
  if (d2 > 1.0) {
    discard;
  }
  let k = exp(-3.0 * d2) * in.level;
  return vec4<f32>(in.tint * k, k);
}

// ---------------------------------------------------------------------------------------
// Waveform: what the organism claims it is hearing
// ---------------------------------------------------------------------------------------

@vertex
fn vsSine(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> Out {
  let segments = max(L.a.y, 2u);
  let stride = L.a.w + 1u;
  let segment = (inst / stride) % segments;
  // The phosphor in this pane is a chorus. Each step back is the same partial drawn at the
  // frequency it was at then, so a particle that is holding still draws one clean sine and one
  // that is travelling draws a sheaf of them beating against each other — which is what the
  // travelling actually sounds like.
  let back = inst % stride;
  // The front of the pool, which is the right sample now and was not before.
  //
  // This selector has been wrong twice, and each time for a reason that had changed underneath
  // it. A uniform stride draws mostly high harmonics, which are culled below for having more
  // cycles than there are segments to resolve them. Walking back from the birth counter was
  // right while the ring churned, because then the newest births *were* the population — but
  // births are suppressed where somebody already lives, so the newest are now only the newest
  // *arrivals*, and the long-lived residents that make up the cast never appear among them.
  //
  // With a stable population the earliest slots hold the oldest survivors, which is exactly
  // the cast worth drawing.
  let particle = inst / (segments * stride);
  if (particle >= L.a.z) {
    return offScreenQuad();
  }
  let q = particles[particle];

  if (!isAlive(q)) {
    return offScreenQuad();
  }
  let m = markOf(q, particle, back);
  if (m.level <= 0.0) {
    return offScreenQuad();
  }

  let seconds = max(L.b.w, 1e-6);
  let cycles = m.freq * seconds;
  // A partial with more cycles than there are segments to draw them cannot be resolved, and
  // drawing it anyway produces aliasing that looks like a different, slower partial — a lie
  // about the signal rather than a limitation of the picture.
  if (cycles > f32(segments) * 0.4 || cycles < 0.02) {
    return offScreenQuad();
  }

  let amplitude = clamp(q.energy * S.geom.z * 4.0, 0.0, 1.0) * vitalityOf(q);
  if (amplitude < 0.002) {
    return offScreenQuad();
  }

  // Phase runs from the particle's birth, which is the only clock it has. The organism never
  // measured phase and is not entitled to one, so this is its own account rather than a
  // reconstruction — the shapes are right, their alignment is invented.
  let phase = TAU * m.freq * (q.time / max(S.misc.x, 1.0));
  let t0 = f32(segment) / f32(segments);
  let t1 = f32(segment + 1u) / f32(segments);
  let y0 = sin(TAU * cycles * t0 + phase) * amplitude;
  let y1 = sin(TAU * cycles * t1 + phase) * amplitude;

  // Point size is the organism's size in every scope: a splat radius in the spectrogram and the
  // spectrum, and the width of the line here.
  let width = max(L.c.z, 0.4);
  let p0 = vec2<f32>(t0 * S.resolution.x, (0.5 - y0 * 0.5) * S.resolution.y);
  let p1 = vec2<f32>(t1 * S.resolution.x, (0.5 - y1 * 0.5) * S.resolution.y);
  let sv = segmentVertex(p0, p1, width, vi % 6u, S.resolution.xy);

  var out: Out;
  out.pos = sv.pos;
  // The width travels with the vertex because the organism sets it, not the theme, and the
  // fragment has no other way to reach it. Interpolating a per-instance constant is a constant.
  out.offset = vec2<f32>(sv.s, width);
  out.tint = tintOf(q);
  out.level = m.level * 0.35;
  return out;
}

@fragment
fn fsSine(in: Out) -> @location(0) vec4<f32> {
  let cov = lineCoverage(in.offset.x, in.offset.y);
  let a = in.level * cov;
  return vec4<f32>(in.tint * a, a);
}
