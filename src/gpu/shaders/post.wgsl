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
  let sceneA = textureSampleLevel(texA, samp, in.uv, 0.0);
  let sceneB = textureSampleLevel(texB, samp, in.uv, 0.0);
  var color = sceneA.rgb + sceneB.rgb * P.b.x;
  color = color * P.a.z;
  // Coverage, kept apart from colour. Every scene shader writes premultiplied `vec4(rgb * a, a)`
  // and the accumulator adds alpha along with colour, so this says how much trace is present
  // here without saying anything about what colour it was — which is what the ink model below
  // needs and what the additive path has never had to ask.
  //
  // From the scene only. The bloom chain writes alpha 1 everywhere because nothing has ever read
  // it, so counting it here would lay down a flat sheet of ink over the entire page. Bloom still
  // reaches the ink's *colour* through `color` above, which is the right half of it anyway: a
  // halo round a bright mark pales the ink near it rather than covering more of the paper.
  let coverage = sceneA.a * P.a.z;

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

  // Light and ink are two different things, and the compositing has to know which one it is.
  //
  // Additive is right for a phosphor: a dark screen, and a trace that adds light to it. On paper
  // it is not merely wrong, it is arithmetically incapable. A light background sits near one
  // already, so adding anything can only climb toward white — every mark, whatever colour the
  // theme asked for, arrives as the same blown-out near-white line. And a theme that specifies
  // dark ink suffers the opposite half of the same problem: black primary emits nothing, so
  // there is nothing to add and the trace does not appear at all. That is why Paper, Ink and
  // Solarized had white lines and no traces.
  //
  // On paper the trace is ink: it takes light away rather than adding it, and its own colour is
  // what the paper becomes where it is dense. Coverage says how dense, the accumulated colour
  // divided by that coverage says what shade — un-premultiplying recovers the ink's real colour
  // even when it is near black and contributed almost no light to sum.
  //
  // Which model applies is a property of the background, not a setting: crossfaded across the
  // midtones so that dragging a background from black to white passes through the changeover
  // smoothly instead of snapping between two very different pictures at some exact grey.
  let paper = smoothstep(0.32, 0.62, dot(P.c.rgb, vec3<f32>(0.2126, 0.7152, 0.0722)));
  let lit = P.c.rgb + color;
  // Ink accumulates the way absorption does, not the way a counter does.
  //
  // Coverage is a sum: a thousand faint marks in one pixel add up to a thousand, and clamping
  // that to one makes every busy region the same flat slab. The additive path never has this
  // problem because tone mapping compresses its sum; this is the same compression for the same
  // reason, in the form absorption actually takes. One mark still prints nearly solid, and a
  // hundred print solid rather than a hundred times solid.
  //
  // Paper has less range than a screen and always will — past a certain density everything is
  // just black, and no curve here can invent a distinction the medium cannot hold.
  let density = 1.0 - exp(-1.8 * max(coverage, 0.0));
  // Un-premultiplied, and clamped because it is a colour rather than a radiance: bloom adds to
  // the numerator without adding to the coverage, so a faint mark inside a bright halo would
  // otherwise divide out to a value far past white.
  //
  // Then darkened, because a colour chosen to glow does not print. Every palette and every
  // pitch-class wheel in this program was drawn for a dark screen, where mid-lightness reads as
  // vivid; the same colour laid on white paper is a pale wash with nothing to distinguish it.
  // Scaling is uniform across the channels, so the hue and the saturation survive exactly and
  // only the lightness moves — a particle's colour still says which pitch class it is, it just
  // says it in ink instead of in light.
  let ink = clamp(color / max(coverage, 1e-6), vec3<f32>(0.0), vec3<f32>(1.0)) * mix(1.0, 0.38, paper);
  color = mix(lit, mix(P.c.rgb, ink, density), paper);

  if (P.c.w > 0.0) {
    let d = distance(in.uv, vec2<f32>(0.5, 0.5)) * 1.41421356;
    color = color * (1.0 - P.c.w * d * d);
  }

  color = pow(max(color, vec3<f32>(0.0)), vec3<f32>(P.a.w));
  return vec4<f32>(linearToSrgb(color), 1.0);
}
