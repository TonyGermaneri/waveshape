// Spectrum analyzer: filled bin-range band, mean curve, and peak-hold trace.

@group(0) @binding(0) var<uniform> S: Style;
@group(0) @binding(1) var<storage, read> cols: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> V: SpectrumView;

struct SpectrumView {
  // x: columns   y: channelIndex   z: laneTop px   w: laneHeight px
  a: vec4<u32>,
}

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) s: f32,
  @location(1) @interpolate(flat) kind: u32,
}

fn laneY(db: f32) -> f32 {
  let top = f32(V.a.z);
  let height = f32(V.a.w);
  return top + height * (1.0 - dbToAxis(db, S.range.x, S.range.y));
}

fn columnAt(i: u32) -> vec4<f32> {
  let n = V.a.x;
  return cols[V.a.y * n + min(i, n - 1u)];
}

// Instance layout: [0, n)      -> the min/max band and its fill
//                  [n, 2n)     -> the mean curve
//                  [2n, 3n)    -> the peak-hold curve
@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> VSOut {
  let n = V.a.x;
  let kind = inst / n;
  let i = inst % n;
  let w = S.resolution.x / f32(n);
  let c = quadCorner(vi);

  var out: VSOut;
  out.kind = kind;

  if (kind == 0u) {
    let e = columnAt(i);
    let x0 = f32(i) * w;
    let x1 = x0 + w + 0.5;
    var yTop = laneY(e.y);
    var yBottom = f32(V.a.z) + f32(V.a.w);
    if (S.geom.w < 0.5) {
      // Not filling to the floor: just show the min..max spread.
      yBottom = laneY(e.x);
      if (yBottom - yTop < S.geom.x) {
        yBottom = yTop + S.geom.x;
      }
    }
    let px = vec2<f32>(mix(x0, x1, c.x), mix(yTop, yBottom, c.y));
    out.pos = toNdc(px, S.resolution.xy);
    out.s = c.y;
    return out;
  }

  let a = columnAt(i);
  let b = columnAt(i + 1u);
  var dbA = a.z;
  var dbB = b.z;
  if (kind == 2u) {
    dbA = a.w;
    dbB = b.w;
  }
  let p0 = vec2<f32>((f32(i) + 0.5) * w, laneY(dbA));
  let p1 = vec2<f32>((f32(i) + 1.5) * w, laneY(dbB));
  let width = select(S.geom.x, max(S.geom.x * 0.6, 1.0), kind == 2u);
  let sv = segmentVertex(p0, p1, width, vi, S.resolution.xy);
  out.pos = sv.pos;
  out.s = sv.s;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  if (in.kind == 0u) {
    // Fade the fill downwards so the curve stays the dominant feature.
    let fade = mix(1.0, 0.15, clamp(in.s, 0.0, 1.0));
    let a = S.secondary.a * S.geom.y * S.geom.w * fade;
    return vec4<f32>(S.secondary.rgb * a, a);
  }
  var color = S.primary;
  var width = S.geom.x;
  if (in.kind == 2u) {
    color = S.accent;
    width = max(S.geom.x * 0.6, 1.0);
  }
  let cov = lineCoverage(in.s, width);
  let a = color.a * S.geom.y * cov;
  return vec4<f32>(color.rgb * a, a);
}
