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
  // x: clear range 1 start   y: clear range 1 count   z/w: unused
  // Two ranges rather than two draws: the clear span can wrap around the end of the ring, and
  // queue.writeBuffer is ordered ahead of the entire command buffer, so re-writing the uniform
  // between two draws in the same pass would give both draws the second value.
  d: vec4<f32>,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> points: array<vec4<f32>>;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) offset: vec2<f32>,
  @location(1) @interpolate(flat) energy: f32,
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
