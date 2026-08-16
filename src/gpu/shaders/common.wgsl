// Shared prelude, textually prepended to every render shader (WGSL has no include mechanism,
// so src/gpu/renderer.ts concatenates this in front of each module).

struct Style {
  // x: width px   y: height px   z: 1/width   w: 1/height
  resolution: vec4<f32>,
  primary: vec4<f32>,
  secondary: vec4<f32>,
  accent: vec4<f32>,
  background: vec4<f32>,
  // x: lineWidth px   y: intensity   z: gain   w: fillOpacity
  geom: vec4<f32>,
  // x: dbMin   y: dbMax   z: freqMin Hz   w: freqMax Hz
  range: vec4<f32>,
  // x: logFrequency (0/1)   y: gridAlpha   z: exposure   w: gamma
  axis: vec4<f32>,
  // x: sampleRate   y: fftSize   z: columns   w: time
  misc: vec4<f32>,
  // x: mode   y: channelCount   z: showPeak   w: showRms
  flags: vec4<u32>,
}

fn quadCorner(i: u32) -> vec2<f32> {
  var xs = array<f32, 6>(0.0, 1.0, 0.0, 0.0, 1.0, 1.0);
  var ys = array<f32, 6>(0.0, 0.0, 1.0, 1.0, 0.0, 1.0);
  return vec2<f32>(xs[i], ys[i]);
}

/// Pixel coordinates (origin top-left) to normalised device coordinates.
fn toNdc(px: vec2<f32>, res: vec2<f32>) -> vec4<f32> {
  return vec4<f32>(px.x / res.x * 2.0 - 1.0, 1.0 - px.y / res.y * 2.0, 0.0, 1.0);
}

/// Position along the horizontal frequency axis, 0..1, honouring the log/linear switch.
fn freqToAxis(f: f32, fMin: f32, fMax: f32, logAxis: f32) -> f32 {
  if (logAxis > 0.5) {
    let lo = log2(max(fMin, 1.0));
    let hi = log2(max(fMax, lo + 1.0));
    return (log2(max(f, 1.0)) - lo) / (hi - lo);
  }
  return (f - fMin) / max(fMax - fMin, 1.0);
}

fn axisToFreq(u: f32, fMin: f32, fMax: f32, logAxis: f32) -> f32 {
  if (logAxis > 0.5) {
    let lo = log2(max(fMin, 1.0));
    let hi = log2(max(fMax, lo + 1.0));
    return exp2(lo + u * (hi - lo));
  }
  return fMin + u * (fMax - fMin);
}

fn dbToAxis(db: f32, dbMin: f32, dbMax: f32) -> f32 {
  return clamp((db - dbMin) / max(dbMax - dbMin, 1e-6), 0.0, 1.0);
}

fn amplitudeToDb(a: f32) -> f32 {
  return 20.0 * log2(max(a, 1e-12)) * 0.30102999566;
}

/// Builds a thick, analytically antialiased segment quad between two pixel-space points.
/// `corner` is one of the six triangle-list corners; `t` runs 0..1 along the segment and
/// `s` runs -1..1 across its width, which the fragment stage uses for the edge falloff.
struct SegmentVertex {
  pos: vec4<f32>,
  s: f32,
  t: f32,
}

fn segmentVertex(p0: vec2<f32>, p1: vec2<f32>, width: f32, corner: u32, res: vec2<f32>) -> SegmentVertex {
  let c = quadCorner(corner);
  var dir = p1 - p0;
  let len = length(dir);
  if (len < 1e-6) {
    dir = vec2<f32>(1.0, 0.0);
  } else {
    dir = dir / len;
  }
  let normal = vec2<f32>(-dir.y, dir.x);
  let half = max(width, 1.0) * 0.5;
  // Extend the ends by half a width so consecutive segments join without a notch.
  let along = mix(p0 - dir * half, p1 + dir * half, c.x);
  let across = normal * (c.y * 2.0 - 1.0) * half;

  var out: SegmentVertex;
  out.pos = toNdc(along + across, res);
  out.s = c.y * 2.0 - 1.0;
  out.t = c.x;
  return out;
}

/// Coverage for a line fragment: 1 at the centre, falling to 0 across the last pixel of width.
fn lineCoverage(s: f32, width: f32) -> f32 {
  let half = max(width, 1.0) * 0.5;
  let dist = abs(s) * half;
  return clamp(half - dist, 0.0, 1.0);
}
