// Presents the scrolling history texture. The texture is a ring in the time axis, so the
// scroll is a texture-coordinate offset rather than a copy — nothing is ever memmoved.

@group(0) @binding(0) var<uniform> S: Style;
@group(0) @binding(1) var<uniform> V: PresentParams;
@group(0) @binding(2) var history: texture_2d<f32>;
@group(0) @binding(3) var historySampler: sampler;
@group(0) @binding(4) var palette: texture_2d<f32>;
@group(0) @binding(5) var paletteSampler: sampler;

struct PresentParams {
  // x: historyColumns   y: historyRows   z: headColumn   w: margin (columns held back)
  a: vec4<u32>,
  // x: visibleColumns   y: dbFloor   z: dbCeil   w: gain
  b: vec4<f32>,
  // x: normalise by coverage (0/1)   y: unused   z: unused   w: unused
  c: vec4<f32>,
}

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  // Single oversized triangle: no diagonal seam, one fewer vertex than a quad.
  var xs = array<f32, 3>(-1.0, 3.0, -1.0);
  var ys = array<f32, 3>(-1.0, -1.0, 3.0);
  var out: VSOut;
  out.pos = vec4<f32>(xs[vi], ys[vi], 0.0, 1.0);
  out.uv = vec2<f32>((xs[vi] + 1.0) * 0.5, (ys[vi] + 1.0) * 0.5);
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let cols = f32(V.a.x);
  let newest = f32(V.a.z) - f32(V.a.w);
  // uv.x = 0 at the left edge (oldest visible), 1 at the right (newest committed).
  let col = newest - (1.0 - in.uv.x) * V.b.x;
  let u = fract(col / cols);
  // uv.y = 0 is the top of the screen, which is the high-frequency end.
  let v = 1.0 - in.uv.y;

  let texel = textureSampleLevel(history, historySampler, vec2<f32>(u, v), 0.0);
  var energy = texel.r * V.b.w;
  if (V.c.x > 0.5 && texel.g > 1e-6) {
    energy = energy / texel.g;
  }

  let db = 10.0 * log2(max(energy, 1e-20)) * 0.30102999566;
  let t = clamp((db - V.b.y) / max(V.b.z - V.b.y, 1e-6), 0.0, 1.0);

  let rgb = textureSampleLevel(palette, paletteSampler, vec2<f32>(t, 0.5), 0.0).rgb;
  let a = S.geom.y;
  return vec4<f32>(rgb * a, a);
}
