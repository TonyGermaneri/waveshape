// Goniometer / vectorscope.
//
// The studio convention rotates the L/R plane 45 degrees so the axes become mid and side:
// vertical is (L+R)/sqrt(2), horizontal is (L-R)/sqrt(2). A mono source therefore draws a
// vertical line, a wide source spreads horizontally, and a polarity-inverted channel collapses
// to a horizontal line — the three things an engineer is actually looking for.
//
// Samples are drawn as a connected trace with alpha rising towards the newest sample, which
// gives the phosphor-decay look a hardware goniometer has and makes the direction of travel
// legible.

@group(0) @binding(0) var<uniform> S: Style;
@group(0) @binding(1) var<storage, read> audio: array<f32>;
@group(0) @binding(2) var<uniform> V: VectorParams;

struct VectorParams {
  // x: sampleCount   y: ringCapacity   z: ringChannels   w: head
  a: vec4<u32>,
  // x: gain   y: ageFade   z: mode (0 = mid/side, 1 = raw X/Y)   w: decimation
  b: vec4<f32>,
}

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) s: f32,
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
  let inv = 0.70710678;
  return vec2<f32>((l - r) * inv, (l + r) * inv);
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
  let p1 = toScreen(samplePoint(i0 + stride));
  let sv = segmentVertex(p0, p1, S.geom.x, vi, S.resolution.xy);

  var out: VSOut;
  out.pos = sv.pos;
  out.s = sv.s;
  out.age = f32(seg) / f32(max(count - 1u, 1u));
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let cov = lineCoverage(in.s, S.geom.x);
  // Newest samples are brightest; V.b.y controls how quickly the tail falls away.
  let fade = pow(in.age, max(V.b.y, 0.0001));
  let a = S.primary.a * S.geom.y * cov * fade;
  return vec4<f32>(S.primary.rgb * a, a);
}
