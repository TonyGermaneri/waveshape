// Waveform rendering, two paths chosen by zoom level.
//
// Zoomed out (more than ~2 samples per pixel column) we draw the min/max envelope computed by
// envelope.wgsl as a filled band, with an optional RMS band inside it. This is the only
// honest way to show more samples than you have pixels.
//
// Zoomed in (fewer than ~2 samples per pixel) drawing straight lines between samples is
// wrong — it shows a shape the signal never had. A sampled signal has exactly one
// band-limited interpolant, and this path evaluates it: Whittaker-Shannon reconstruction with
// a Lanczos-windowed sinc kernel. What you see is the analog waveform the samples represent,
// which is also what a converter will actually produce. This is why a "square wave" correctly
// shows Gibbs overshoot here instead of perfect corners.

@group(0) @binding(0) var<uniform> S: Style;
@group(0) @binding(1) var<storage, read> env: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> audio: array<f32>;
@group(0) @binding(3) var<storage, read> timebase: array<f32>;
@group(0) @binding(4) var<uniform> W: WaveParams;

struct WaveParams {
  // x: columns   y: ringCapacity   z: ringChannels   w: head
  a: vec4<u32>,
  // x: channelIndex   y: channelCount   z: laneTop px   w: laneHeight px
  b: vec4<u32>,
  mix: vec4<f32>,
}

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) s: f32,
  @location(1) @interpolate(flat) kind: u32,
  @location(2) shade: f32,
}

fn laneY(v: f32) -> f32 {
  let top = f32(W.b.z);
  let height = f32(W.b.w);
  return top + height * 0.5 * (1.0 - clamp(v * S.geom.z, -1.0, 1.0));
}

// ---------------------------------------------------------------------------------------
// Envelope band
// ---------------------------------------------------------------------------------------

@vertex
fn vsEnvelope(
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) inst: u32,
) -> VSOut {
  let columns = W.a.x;
  // Instances 0..columns-1 draw the peak band; the next block draws the RMS band.
  let isRms = inst >= columns;
  let column = select(inst, inst - columns, isRms);
  let e = env[W.b.x * columns + column];

  let w = S.resolution.x / f32(columns);
  let x0 = f32(column) * w;
  let x1 = x0 + w + 0.5;

  var lo = e.x;
  var hi = e.y;
  if (isRms) {
    lo = -e.z;
    hi = e.z;
  }

  var yA = laneY(hi);
  var yB = laneY(lo);
  // Guarantee the trace stays visible when the signal is tiny.
  let minThickness = max(S.geom.x, 1.0);
  if (yB - yA < minThickness) {
    let mid = (yA + yB) * 0.5;
    yA = mid - minThickness * 0.5;
    yB = mid + minThickness * 0.5;
  }

  let c = quadCorner(vi);
  let px = vec2<f32>(mix(x0, x1, c.x), mix(yA, yB, c.y));

  var out: VSOut;
  out.pos = toNdc(px, S.resolution.xy);
  // Distance from the band centre, in units of half-thickness, for edge softening.
  out.s = c.y * 2.0 - 1.0;
  out.kind = select(0u, 1u, isRms);
  out.shade = clamp((yB - yA) / max(S.resolution.y * 0.5, 1.0), 0.0, 1.0);
  return out;
}

@fragment
fn fsEnvelope(in: VSOut) -> @location(0) vec4<f32> {
  var color = S.primary;
  if (in.kind == 1u) {
    color = S.secondary;
  }
  // Soften only the outer edge; the interior stays solid.
  let edge = 1.0 - smoothstep(0.85, 1.0, abs(in.s));
  let a = color.a * S.geom.y * mix(0.35, 1.0, edge);
  return vec4<f32>(color.rgb * a, a);
}

// ---------------------------------------------------------------------------------------
// Band-limited trace
// ---------------------------------------------------------------------------------------

const TAPS: i32 = 8;

fn fetch(frame: u32) -> f32 {
  let cap = W.a.y;
  let idx = frame & (cap - 1u);
  let a = audio[idx];
  var b = a;
  if (W.a.z > 1u) {
    b = audio[cap + idx];
  }
  return W.mix.x * a + W.mix.y * b;
}

fn sinc(x: f32) -> f32 {
  if (abs(x) < 1e-6) {
    return 1.0;
  }
  let p = 3.14159265359 * x;
  return sin(p) / p;
}

/// Whittaker-Shannon reconstruction at fractional sample position `t` (absolute frame index
/// plus fraction), windowed by a Lanczos kernel of half-width TAPS.
fn reconstruct(base: u32, t: f32) -> f32 {
  let i0 = i32(floor(t));
  let frac = t - f32(i0);
  var acc = 0.0;
  var norm = 0.0;
  for (var k = -TAPS + 1; k <= TAPS; k = k + 1) {
    let d = f32(k) - frac;
    let w = sinc(d) * sinc(d / f32(TAPS));
    let index = u32(i32(base) + i0 + k);
    acc = acc + fetch(index) * w;
    norm = norm + w;
  }
  if (abs(norm) < 1e-6) {
    return acc;
  }
  return acc / norm;
}

@vertex
fn vsTrace(
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) segment: u32,
) -> VSOut {
  let segments = W.a.x;
  let span = max(timebase[1], 1.0);
  let startOffset = timebase[0];
  let viewStart = W.a.w - u32(startOffset);
  let frac = startOffset - floor(startOffset);

  let step = span / f32(segments);
  let t0 = f32(segment) * step - frac;
  let t1 = t0 + step;

  let v0 = reconstruct(viewStart, t0);
  let v1 = reconstruct(viewStart, t1);

  let xScale = S.resolution.x / span;
  let p0 = vec2<f32>((t0 + frac) * xScale, laneY(v0));
  let p1 = vec2<f32>((t1 + frac) * xScale, laneY(v1));

  let sv = segmentVertex(p0, p1, S.geom.x, vi, S.resolution.xy);

  var out: VSOut;
  out.pos = sv.pos;
  out.s = sv.s;
  out.kind = 2u;
  out.shade = 1.0;
  return out;
}

@fragment
fn fsTrace(in: VSOut) -> @location(0) vec4<f32> {
  let cov = lineCoverage(in.s, S.geom.x);
  let a = S.primary.a * S.geom.y * cov;
  return vec4<f32>(S.primary.rgb * a, a);
}
