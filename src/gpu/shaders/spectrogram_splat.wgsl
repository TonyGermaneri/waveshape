// Scatters reassigned time-frequency points into the scrolling history texture.
//
// A conventional spectrogram writes one column per analysis frame: bin k always lands on row
// k of the current column. Reassignment breaks that assumption — a point's corrected time can
// fall a fraction of a window *before* the frame that produced it, and its corrected frequency
// lands between rows. So the history is filled by scattering rather than by blitting, with
// each point splatted through a small Gaussian kernel and summed with additive blending.
//
// Because energy can move backwards in time, the display lags the write head by a margin of
// half an analysis window (see `margin` in the present pass). Without that, the newest column
// would still be receiving corrections after it had already been shown, and the right-hand
// edge of the display would visibly rewrite itself.
//
// The buffer accumulates *energy*, which is the quantity reassignment conserves. Converting to
// dB happens at present time.

struct Params {
  // x: pointCount   y: historyColumns   z: historyRows   w: headColumn
  a: vec4<u32>,
  // x: hop (samples)   y: freqMin   z: freqMax   w: logAxis
  b: vec4<f32>,
  // x: splatRadius px   y: gain   z: clear range 0 start   w: clear range 0 count
  c: vec4<f32>,
  // x: clear range 1 start   y: clear range 1 count   z: columns advanced this frame
  // w: life point size px
  // Two ranges rather than two draws: the clear span can wrap around the end of the ring, and
  // queue.writeBuffer is ordered ahead of the entire command buffer, so re-writing the uniform
  // between two draws in the same pass would give both draws the second value.
  d: vec4<f32>,
  // x: life brightness   y: base opacity   z: amplitude lead in columns   w: dbFloor
  e: vec4<f32>,
  // xyz: the ink the underlying measurement is drawn in when the organism is present
  // w: dbCeil
  f: vec4<f32>,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> points: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> particles: array<Particle>;

// Mirrors gpu/particle.ts. Only the four words this pass needs are read.
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

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) offset: vec2<f32>,
  @location(1) @interpolate(flat) energy: f32,
}

struct LifeOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) offset: vec2<f32>,
  @location(1) @interpolate(flat) tint: vec3<f32>,
  @location(2) @interpolate(flat) energy: f32,
}

fn freqAxis(f: f32) -> f32 {
  if (P.b.w > 0.5) {
    let lo = log2(max(P.b.y, 1.0));
    let hi = log2(max(P.b.z, lo + 1.0));
    return (log2(max(f, 1.0)) - lo) / (hi - lo);
  }
  return (f - P.b.y) / max(P.b.z - P.b.y, 1.0);
}

/// Triangle-list corners in [0, 1]^2.
fn unitCorner(i: u32) -> vec2<f32> {
  var xs = array<f32, 6>(0.0, 1.0, 0.0, 0.0, 1.0, 1.0);
  var ys = array<f32, 6>(0.0, 0.0, 1.0, 1.0, 0.0, 1.0);
  return vec2<f32>(xs[i], ys[i]);
}

/// The same corners remapped to [-1, 1]^2, for splat quads centred on a point.
fn corner(i: u32) -> vec2<f32> {
  return unitCorner(i) * 2.0 - 1.0;
}

@vertex
fn vsSplat(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> VSOut {
  var out: VSOut;
  let p = points[inst];

  if (p.w < 0.5 || inst >= P.a.x) {
    // Cull by collapsing the quad off-screen; cheaper than an indirect draw compaction pass
    // for the point counts we deal with.
    out.pos = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    out.offset = vec2<f32>(0.0, 0.0);
    out.energy = 0.0;
    return out;
  }

  let cols = f32(P.a.y);
  let rows = f32(P.a.z);

  let colOffset = p.x / max(P.b.x, 1.0);
  var colF = f32(P.a.w) + colOffset;
  colF = colF - floor(colF / cols) * cols;

  let v = freqAxis(p.y);
  let rowF = v * rows;

  let c = corner(vi);
  let r = max(P.c.x, 0.5);
  let px = colF + 0.5 + c.x * r;
  let py = rowF + 0.5 + c.y * r;

  out.pos = vec4<f32>((px / cols) * 2.0 - 1.0, (py / rows) * 2.0 - 1.0, 0.0, 1.0);
  out.offset = c * r;
  out.energy = p.z * p.z * P.c.y;
  return out;
}

@fragment
fn fsSplat(in: VSOut) -> @location(0) vec4<f32> {
  let r = max(P.c.x, 0.5);
  let d2 = dot(in.offset, in.offset) / (r * r);
  // Gaussian falling to ~2% at the quad edge, normalised so the kernel's total weight is
  // independent of the radius — otherwise changing the splat size would change the level.
  let k = exp(-3.5 * d2);
  let norm = 1.0 / (1.12 * r * r);
  return vec4<f32>(in.energy * k * norm, k * norm, 0.0, 0.0);
}

// The same measurement, written in the encoding the living present pass reads.
//
// The history texture holds one of two things depending on whether the organism is running. Dead,
// it is (energy, coverage) in the red and green channels and the palette colours it at present
// time. Alive, it is (tint × energy, energy) — the particles brought their own colours and a
// palette would throw the harmonic identity in them away.
//
// Those two encodings cannot share a texture, which is why turning the organism on used to
// replace the spectrogram outright and why `baseOpacity` did nothing in this pane. Writing the
// underlying measurement in the *living* encoding, in the instrument's own ink, lets both be
// present at once: the reassigned energy reads as a monochrome ground and the population reads
// as colour over it, and the knob between them means what it means everywhere else.
@fragment
fn fsSplatBase(in: VSOut) -> @location(0) vec4<f32> {
  let r = max(P.c.x, 0.5);
  let d2 = dot(in.offset, in.offset) / (r * r);
  let k = exp(-3.5 * d2);
  let norm = 1.0 / (1.12 * r * r);
  let e = in.energy * k * norm * P.e.y;
  return vec4<f32>(P.f.rgb * e, e);
}

// ---------------------------------------------------------------------------------------
// Living particles
// ---------------------------------------------------------------------------------------
//
// A reassigned point is splatted where and when it was measured. A particle is splatted where
// it is *now*: it was born somewhere, it has been migrating since, and it is still alive at the
// head of the ring. That is the whole difference between a spectrogram and an organism living
// in one — the trail a particle leaves across the columns is its own history, not the signal's.
//
// The quad is stretched across however many columns the head advanced this frame, because the
// display runs at the monitor's refresh rate and the analysis does not. Without that a particle
// would deposit one column in every twenty-four and its trail would be a dotted line.

@vertex
fn vsLife(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> LifeOut {
  var out: LifeOut;
  let q = particles[inst];
  let alive = (q.colour >> 24u) & 1u;

  if (alive == 0u || q.energy <= 0.0) {
    out.pos = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    out.offset = vec2<f32>(0.0, 0.0);
    out.tint = vec3<f32>(0.0);
    out.energy = 0.0;
    return out;
  }

  let cols = f32(P.a.y);
  let rows = f32(P.a.z);
  let advanced = max(P.d.z, 1.0);

  // Where along the time axis this particle lays itself down.
  //
  // The base is the write head, as it must be — a particle is painted where it is *now*, and
  // the column being written now is the column it goes in. What moves it off that is its own
  // amplitude: a full-scale particle lands on the head, and a quiet one hangs back by up to the
  // amplitude lead. The leading edge stops being a ruled vertical line and becomes a contour of
  // how loud the frame is at each frequency — a picture of the present rather than a cut
  // through it.
  //
  // Hanging back rather than reaching forward, and the direction is not arbitrary. The display
  // shows nothing past the head, so a particle written ahead of it is written off the end of
  // the pane and only appears once the head catches up — which would hide exactly the loud
  // partials the contour exists to show. Everything stays inside the window this way, and the
  // loudest thing in the frame is what touches the edge.
  let db = 10.0 * log2(max(q.energy * q.energy, 1e-20)) * 0.30102999566;
  let loudness = clamp((db - P.e.w) / max(P.f.w - P.e.w, 1e-6), 0.0, 1.0);
  let colOffset = q.time / max(P.b.x, 1.0) - (1.0 - loudness) * P.e.z;
  var colF = f32(P.a.w) + colOffset - advanced * 0.5;
  colF = colF - floor(colF / cols) * cols;

  let rowF = freqAxis(q.freq) * rows;

  let c = corner(vi);
  // The organism's own size, not the analyser's splat radius. Point size means the same thing
  // in all four scopes: how big a particle draws.
  let r = max(P.d.w, 0.5);
  let px = colF + 0.5 + c.x * (r + advanced * 0.5);
  let py = rowF + 0.5 + c.y * r;

  out.pos = vec4<f32>((px / cols) * 2.0 - 1.0, (py / rows) * 2.0 - 1.0, 0.0, 1.0);
  // Only the frequency axis gets the Gaussian: stretching the kernel along time would make a
  // long trail dimmer than a short one for no reason anybody could see.
  out.offset = vec2<f32>(0.0, c.y * r);
  out.tint = vec3<f32>(
    f32((q.colour >> 16u) & 255u),
    f32((q.colour >> 8u) & 255u),
    f32(q.colour & 255u),
  ) / 255.0;
  // Vitality lives in bits 16..21 of life1, and is what makes a dying particle fade rather than
  // vanish between one frame and the next.
  let vitality = f32((q.life1 >> 16u) & 63u) / 63.0;
  out.energy = q.energy * q.energy * vitality * P.c.y * P.e.x;
  return out;
}

@fragment
fn fsLife(in: LifeOut) -> @location(0) vec4<f32> {
  let r = max(P.d.w, 0.5);
  let d2 = dot(in.offset, in.offset) / (r * r);
  let k = exp(-3.5 * d2);
  let norm = 1.0 / (1.12 * r);
  let e = in.energy * k * norm;
  return vec4<f32>(in.tint * e, e);
}

// Wipes the columns that are about to be reused by the ring. Blending is disabled for this
// pipeline so it writes zeroes rather than adding them.
@vertex
fn vsClear(
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) inst: u32,
) -> @builtin(position) vec4<f32> {
  var start = P.c.z;
  var count = P.c.w;
  if (inst == 1u) {
    start = P.d.x;
    count = P.d.y;
  }
  if (count <= 0.0) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }
  let c = unitCorner(vi);
  let cols = f32(P.a.y);
  let px = mix(start, start + count, c.x);
  return vec4<f32>((px / cols) * 2.0 - 1.0, c.y * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fsClear() -> @location(0) vec4<f32> {
  return vec4<f32>(0.0, 0.0, 0.0, 0.0);
}
