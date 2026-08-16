// Graticule. Line positions are computed on the CPU (the same numbers drive the DOM labels,
// so the ticks and their text can never disagree) and drawn here as instanced segments.

@group(0) @binding(0) var<uniform> S: Style;
@group(0) @binding(1) var<storage, read> lines: array<vec4<f32>>;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) s: f32,
  @location(1) @interpolate(flat) weight: f32,
  @location(2) @interpolate(flat) width: f32,
}

// lines[i] = (position 0..1 along its axis, orientation 0 = vertical / 1 = horizontal,
//             brightness multiplier, line width in px)
@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> VSOut {
  let line = lines[inst];
  var p0: vec2<f32>;
  var p1: vec2<f32>;
  if (line.y < 0.5) {
    let x = line.x * S.resolution.x;
    p0 = vec2<f32>(x, 0.0);
    p1 = vec2<f32>(x, S.resolution.y);
  } else {
    let y = line.x * S.resolution.y;
    p0 = vec2<f32>(0.0, y);
    p1 = vec2<f32>(S.resolution.x, y);
  }
  let sv = segmentVertex(p0, p1, line.w, vi, S.resolution.xy);

  var out: VSOut;
  out.pos = sv.pos;
  out.s = sv.s;
  out.weight = line.z;
  out.width = line.w;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let cov = lineCoverage(in.s, in.width);
  let a = S.accent.a * S.axis.y * in.weight * cov * 0.5;
  return vec4<f32>(S.accent.rgb * a, a);
}
