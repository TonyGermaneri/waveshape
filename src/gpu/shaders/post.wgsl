// Post chain: phosphor persistence, bloom, tone mapping, sRGB encode.
//
// Everything upstream renders into a linear rgba16float target with additive blending, which
// is what makes a dense trace correctly *brighter* rather than merely opaque — the same
// reason a real CRT scope shows you where the signal spends its time. That only reads as
// intended if the accumulated radiance is tone mapped rather than clipped, so this is where
// the analytical pipeline stops and the display pipeline begins.
//
// Passes, in order:
//   1. decay      accumulator *= decayConstant       (blend: zero / constant)
//   2. accumulate accumulator += resolved scene      (blend: one / one)
//   3. threshold  bright pass into a quarter-size target
//   4. blurH/V    separable Gaussian on the bright pass
//   5. present    tonemap(accumulator + bloom), composite over the background, encode sRGB

struct PostParams {
  // x: 1/width   y: 1/height   z: exposure   w: gamma
  a: vec4<f32>,
  // x: bloomStrength   y: bloomThreshold   z: tonemap mode   w: saturation
  b: vec4<f32>,
  // rgb: background colour (linear)   w: vignette strength
  c: vec4<f32>,
  // x/y: blur direction in texels   z: unused   w: unused
  d: vec4<f32>,
}

@group(0) @binding(0) var<uniform> P: PostParams;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var texA: texture_2d<f32>;
@group(0) @binding(3) var texB: texture_2d<f32>;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vsFull(@builtin(vertex_index) vi: u32) -> VSOut {
  var xs = array<f32, 3>(-1.0, 3.0, -1.0);
  var ys = array<f32, 3>(-1.0, -1.0, 3.0);
  var out: VSOut;
  out.pos = vec4<f32>(xs[vi], ys[vi], 0.0, 1.0);
  out.uv = vec2<f32>((xs[vi] + 1.0) * 0.5, 1.0 - (ys[vi] + 1.0) * 0.5);
  return out;
}

/// Output is irrelevant: the pipeline's blend state is (src = zero, dst = constant), so this
/// draw multiplies the accumulator by the blend constant and nothing else.
@fragment
fn fsDecay() -> @location(0) vec4<f32> {
  return vec4<f32>(0.0, 0.0, 0.0, 0.0);
}

@fragment
fn fsCopy(in: VSOut) -> @location(0) vec4<f32> {
  return textureSampleLevel(texA, samp, in.uv, 0.0);
}

@fragment
fn fsThreshold(in: VSOut) -> @location(0) vec4<f32> {
  let c = textureSampleLevel(texA, samp, in.uv, 0.0).rgb;
  let luma = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
  let excess = max(luma - P.b.y, 0.0);
  let scale = select(0.0, excess / max(luma, 1e-6), luma > 1e-6);
  return vec4<f32>(c * scale, 1.0);
}

@fragment
fn fsBlur(in: VSOut) -> @location(0) vec4<f32> {
  // Nine-tap Gaussian collapsed to five bilinear fetches.
  let offsets = array<f32, 3>(0.0, 1.3846153846, 3.2307692308);
  let weights = array<f32, 3>(0.2270270270, 0.3162162162, 0.0702702703);
  let dir = P.d.xy;
  var acc = textureSampleLevel(texA, samp, in.uv, 0.0).rgb * weights[0];
  for (var i = 1; i < 3; i = i + 1) {
    let o = dir * offsets[i];
    acc = acc + textureSampleLevel(texA, samp, in.uv + o, 0.0).rgb * weights[i];
    acc = acc + textureSampleLevel(texA, samp, in.uv - o, 0.0).rgb * weights[i];
  }
  return vec4<f32>(acc, 1.0);
}

fn tonemapReinhard(c: vec3<f32>) -> vec3<f32> {
  return c / (1.0 + c);
}

/// Narkowicz's ACES approximation — a filmic shoulder that keeps saturated highlights from
/// stampeding to white the way a plain Reinhard curve does.
fn tonemapAces(x: vec3<f32>) -> vec3<f32> {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn linearToSrgb(c: vec3<f32>) -> vec3<f32> {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3<f32>(0.0031308));
}

@fragment
fn fsPresent(in: VSOut) -> @location(0) vec4<f32> {
  var color = textureSampleLevel(texA, samp, in.uv, 0.0).rgb;
  color = color + textureSampleLevel(texB, samp, in.uv, 0.0).rgb * P.b.x;
  color = color * P.a.z;

  let mode = P.b.z;
  if (mode > 1.5) {
    color = tonemapAces(color);
  } else if (mode > 0.5) {
    color = tonemapReinhard(color);
  } else {
    color = clamp(color, vec3<f32>(0.0), vec3<f32>(1.0));
  }

  let luma = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
  color = mix(vec3<f32>(luma), color, P.b.w);

  // The trace is additive over the background rather than alpha-blended, so a dark background
  // never dims it and a light background still reads as "behind".
  color = P.c.rgb + color;

  if (P.c.w > 0.0) {
    let d = distance(in.uv, vec2<f32>(0.5, 0.5)) * 1.41421356;
    color = color * (1.0 - P.c.w * d * d);
  }

  color = pow(max(color, vec3<f32>(0.0)), vec3<f32>(P.a.w));
  return vec4<f32>(linearToSrgb(color), 1.0);
}
