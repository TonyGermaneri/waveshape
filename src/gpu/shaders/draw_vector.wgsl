// Goniometer / vectorscope.
//
// The studio convention rotates the L/R plane 45 degrees so the axes become mid and side:
// vertical is (L+R)/2, horizontal is (L-R)/2. A mono source therefore draws a vertical line, a
// wide source spreads horizontally, and a polarity-inverted channel collapses to a horizontal
// line — the three things an engineer is actually looking for. Turning the rotation off plots
// the channels raw, X against Y, which is the Lissajous figure an oscilloscope in X-Y mode
// draws and the form the classic patterns are quoted in.
//
// Halved rather than divided by sqrt(2), and the difference is what the graticule means.
// ---------------------------------------------------------------------------------------
// The energy-preserving rotation divides by sqrt(2), which sends a full-scale correlated signal
// to sqrt(2) — off the top of a pane whose outer reference is 1, and twice the +/-0.707 line the
// graticule and the config comment both described as where it lands. Halving instead puts the
// three readings an engineer looks for exactly on the rulings, in both modes at once:
//
//   full-scale mono          (0, 1)        the outer ring, top
//   full-scale out of phase  (1, 0)        the outer ring, side
//   one channel at full scale (0.5, 0.5)   the inner rulings
//
// The whole figure now lives inside its own graticule, and mid/side and Lissajous read on the
// same scale so switching between them does not resize the picture. See ui/axes.ts.
//
// Samples are drawn with alpha rising towards the newest, which gives the phosphor-decay look a
// hardware goniometer has and makes the direction of travel legible. Joined up they are a trace;
// left as dots they are the sample cloud itself, which is what the density of the figure — and
// therefore its distribution — actually looks like.

@group(0) @binding(0) var<uniform> S: Style;
@group(0) @binding(1) var<storage, read> audio: array<f32>;
@group(0) @binding(2) var<uniform> V: VectorParams;

struct VectorParams {
  // x: sampleCount   y: ringCapacity   z: ringChannels   w: head
  a: vec4<u32>,
  // x: gain   y: ageFade   z: mode (0 = mid/side, 1 = raw X/Y)   w: decimation
  b: vec4<f32>,
  // x: dots (0/1)   y: dot diameter px   z: brightness   w: unused
  c: vec4<f32>,
}

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  // Trace: x runs -1..1 across the segment's width. Dots: both run -1..1 across the quad.
  @location(0) uv: vec2<f32>,
  @location(1) age: f32,
}

fn samplePoint(index: u32) -> vec2<f32> {
  let cap = V.a.y;
  let idx = index & (cap - 1u);
  let l = audio[idx];
  var r = l;
  if (V.a.z > 1u) {
    r = audio[cap + idx];
  }
  if (V.b.z > 0.5) {
    return vec2<f32>(l, r);
  }
  return vec2<f32>((l - r) * 0.5, (l + r) * 0.5);
}

fn toScreen(p: vec2<f32>) -> vec2<f32> {
  let centre = S.resolution.xy * 0.5;
  let scale = min(S.resolution.x, S.resolution.y) * 0.5 * S.geom.z * V.b.x;
  return vec2<f32>(centre.x + p.x * scale, centre.y - p.y * scale);
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) seg: u32) -> VSOut {
  let count = V.a.x;
  let stride = max(1u, u32(V.b.w));
  let start = V.a.w - count * stride;
  let i0 = start + seg * stride;

  let p0 = toScreen(samplePoint(i0));

  var out: VSOut;
  if (V.c.x > 0.5) {
    // One square quad per sample, centred on the point; the fragment stage rounds it off.
    let corner = (quadCorner(vi) - 0.5) * 2.0;
    let radius = max(V.c.y, 1.0) * 0.5;
    out.pos = toNdc(p0 + corner * radius, S.resolution.xy);
    out.uv = corner;
  } else {
    let p1 = toScreen(samplePoint(i0 + stride));
    let sv = segmentVertex(p0, p1, S.geom.x, vi, S.resolution.xy);
    out.pos = sv.pos;
    out.uv = vec2<f32>(sv.s, sv.t);
  }
  out.age = f32(seg) / f32(max(count - 1u, 1u));
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  var cov: f32;
  if (V.c.x > 0.5) {
    // Radial falloff over the outermost pixel, so a dot is a disc rather than the square it
    // was drawn as, and a one-pixel dot is a point rather than nothing.
    let radius = max(V.c.y, 1.0) * 0.5;
    cov = clamp((1.0 - length(in.uv)) * radius, 0.0, 1.0);
  } else {
    cov = lineCoverage(in.uv.x, S.geom.x);
  }
  // Newest samples are brightest; V.b.y controls how quickly the tail falls away.
  let fade = pow(in.age, max(V.b.y, 0.0001));
  let a = S.primary.a * S.geom.y * V.c.z * cov * fade;
  return vec4<f32>(S.primary.rgb * a, a);
}
