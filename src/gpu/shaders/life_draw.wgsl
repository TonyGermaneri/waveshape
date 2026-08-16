// The living population, drawn in the other three scopes.
//
// One organism, four windows onto it. The spectrogram shows where the particles are; these
// three show what that means in the coordinates each scope already speaks, using the same
// colours — chroma for pitch class, saturation for how sure the organism is that this is a note
// — so a partial can be followed by eye from one pane to the next.
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
  // x: traces drawn   y: segments per trace   z: population cap   w: unused
  a: vec4<u32>,
  // x: view low Hz   y: view high Hz   z: log axis (0/1)   w: seconds across the pane
  b: vec4<f32>,
  // x: dbMin   y: dbMax   z: point size px   w: brightness
  c: vec4<f32>,
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
  return vec3<f32>(
    f32((q.colour >> 16u) & 255u),
    f32((q.colour >> 8u) & 255u),
    f32(q.colour & 255u),
  ) / 255.0;
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
// Spectrum: the domain the particles were born in
// ---------------------------------------------------------------------------------------

@vertex
fn vsPoint(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> Out {
  let q = particles[inst];
  if (inst >= L.a.x || !isAlive(q)) {
    return offScreenQuad();
  }
  let x = axisX(q.freq);
  if (x < 0.0 || x > 1.0) {
    return offScreenQuad();
  }
  let db = amplitudeToDb(q.energy);
  let y = 1.0 - dbToAxis(db, L.c.x, L.c.y);

  let c = quadCorner(vi) * 2.0 - 1.0;
  let r = max(L.c.z, 0.5);
  let px = vec2<f32>(x * S.resolution.x, y * S.resolution.y) + c * r;

  var out: Out;
  out.pos = toNdc(px, S.resolution.xy);
  out.offset = c * r;
  out.tint = tintOf(q);
  out.level = vitalityOf(q) * L.c.w;
  return out;
}

// ---------------------------------------------------------------------------------------
// Vectorscope: the chromatic circle
// ---------------------------------------------------------------------------------------

@vertex
fn vsChroma(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> Out {
  let q = particles[inst];
  if (inst >= L.a.x || !isAlive(q)) {
    return offScreenQuad();
  }
  // Pitch class, measured from C, is the angle. Octaves therefore stack on one spoke and the
  // figure a sound makes is a property of its harmony rather than of its register.
  let chroma = fract(log2(max(q.freq, 1.0) / 16.3516));
  let angle = chroma * TAU - TAU * 0.25;
  // Radius is level, floored so that a quiet partial is a faint mark near the centre rather
  // than a point exactly on it, where every pitch class would overlap.
  let db = amplitudeToDb(q.energy);
  let radius = 0.12 + 0.88 * dbToAxis(db, L.c.x, L.c.y);

  let centre = S.resolution.xy * 0.5;
  let scale = min(S.resolution.x, S.resolution.y) * 0.5;
  let c = quadCorner(vi) * 2.0 - 1.0;
  let r = max(L.c.z, 0.5);
  let px = centre + vec2<f32>(cos(angle), sin(angle)) * radius * scale + c * r;

  var out: Out;
  out.pos = toNdc(px, S.resolution.xy);
  out.offset = c * r;
  out.tint = tintOf(q);
  out.level = vitalityOf(q) * L.c.w;
  return out;
}

@fragment
fn fsPoint(in: Out) -> @location(0) vec4<f32> {
  let r = max(L.c.z, 0.5);
  let d2 = dot(in.offset, in.offset) / (r * r);
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
  let segment = inst % segments;
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
  let particle = inst / segments;
  if (particle >= L.a.z) {
    return offScreenQuad();
  }
  let q = particles[particle];

  if (!isAlive(q)) {
    return offScreenQuad();
  }

  let seconds = max(L.b.w, 1e-6);
  let cycles = q.freq * seconds;
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
  let phase = TAU * q.freq * (q.time / max(S.misc.x, 1.0));
  let t0 = f32(segment) / f32(segments);
  let t1 = f32(segment + 1u) / f32(segments);
  let y0 = sin(TAU * cycles * t0 + phase) * amplitude;
  let y1 = sin(TAU * cycles * t1 + phase) * amplitude;

  let p0 = vec2<f32>(t0 * S.resolution.x, (0.5 - y0 * 0.5) * S.resolution.y);
  let p1 = vec2<f32>(t1 * S.resolution.x, (0.5 - y1 * 0.5) * S.resolution.y);
  let sv = segmentVertex(p0, p1, S.geom.x, vi % 6u, S.resolution.xy);

  var out: Out;
  out.pos = sv.pos;
  out.offset = vec2<f32>(sv.s, 0.0);
  out.tint = tintOf(q);
  out.level = vitalityOf(q) * L.c.w * 0.35;
  return out;
}

@fragment
fn fsSine(in: Out) -> @location(0) vec4<f32> {
  let cov = lineCoverage(in.offset.x, S.geom.x);
  let a = in.level * cov;
  return vec4<f32>(in.tint * a, a);
}
