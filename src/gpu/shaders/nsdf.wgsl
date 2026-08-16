// Trigger and timebase resolution.
//
// A free-running waveform display is unreadable: every frame starts at a different phase and
// the trace shimmers. Hardware scopes solve this with a level trigger, which works for simple
// periodic signals and falls apart on anything harmonically rich — a level crossing is
// ambiguous when a waveform crosses the same level several times per cycle.
//
// The robust answer is to lock the timebase to the signal's actual period. We estimate it
// with the McLeod Pitch Method's Normalised Square Difference Function
//
//     n(tau) = 2 * sum_j x[j] x[j+tau] / sum_j (x[j]^2 + x[j+tau]^2)
//
// which is bounded in [-1, 1] regardless of level, and (unlike raw autocorrelation) does not
// bias towards tau = 0, so it does not need the taper correction that makes plain ACF pitch
// detection octave-error prone. n(tau) at the chosen peak doubles as a "clarity" figure: how
// periodic the signal actually is. Below a clarity threshold we fall back to level triggering.
//
// This runs entirely on the GPU and writes the timebase into a buffer that the envelope pass
// and the draw pass both read. Nothing is read back to the CPU, so there is no latency and no
// pipeline stall — the trace is locked on the same frame it is measured.

struct Params {
  // x: windowLen   y: minLag   z: maxLag   w: ringCapacity
  a: vec4<u32>,
  // x: head   y: ringChannels   z: lagCount   w: mode (1 = level, 2 = pitch-locked)
  b: vec4<u32>,
  // x: clarityThreshold   y: triggerLevel   z: edge (+1 rising, -1 falling)   w: defaultSpan
  c: vec4<f32>,
  // x: sampleRate   y: cyclesToShow   z: minSpan   w: maxSpan
  d: vec4<f32>,
  mix: vec4<f32>,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> audio: array<f32>;
@group(0) @binding(2) var<storage, read_write> nsdf: array<f32>;
@group(0) @binding(3) var<storage, read_write> timebase: array<f32>;

const WG: u32 = 64u;

var<workgroup> sR: array<f32, WG>;
var<workgroup> sM: array<f32, WG>;

fn fetch(frame: u32) -> f32 {
  let cap = P.a.w;
  let idx = frame & (cap - 1u);
  let a = audio[idx];
  var b = a;
  if (P.b.y > 1u) {
    b = audio[cap + idx];
  }
  return P.mix.x * a + P.mix.y * b;
}

// One workgroup per candidate lag.
@compute @workgroup_size(WG)
fn correlate(
  @builtin(workgroup_id) wg: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
) {
  let lagIndex = wg.x;
  if (lagIndex >= P.b.z) {
    return;
  }
  let lag = P.a.y + lagIndex;
  let w = P.a.x;
  let base = P.b.x - w;
  let t = lid.x;

  var r = 0.0;
  var m = 0.0;
  let limit = w - lag;
  for (var j = t; j < limit; j = j + WG) {
    let a = fetch(base + j);
    let b = fetch(base + j + lag);
    r = r + a * b;
    m = m + a * a + b * b;
  }
  sR[t] = r;
  sM[t] = m;
  workgroupBarrier();

  var stride = WG / 2u;
  loop {
    if (stride == 0u) { break; }
    if (t < stride) {
      sR[t] = sR[t] + sR[t + stride];
      sM[t] = sM[t] + sM[t + stride];
    }
    workgroupBarrier();
    stride = stride / 2u;
  }

  if (t == 0u) {
    var v = 0.0;
    if (sM[0] > 1e-20) {
      v = 2.0 * sR[0] / sM[0];
    }
    nsdf[lagIndex] = v;
  }
}

// Single-workgroup finaliser: pick the pitch peak, derive the span, then find the trigger edge.
// The scans here are serial but bounded by a few thousand iterations, which costs microseconds.
@compute @workgroup_size(1)
fn pick() {
  let fs = P.d.x;
  var period = 0.0;
  var clarity = 0.0;

  if (P.b.w == 2u) {
    let count = P.b.z;

    // McLeod peak picking: only consider maxima that follow a negative-going zero crossing,
    // which is what suppresses the octave-below errors plain autocorrelation makes.
    var globalMax = 0.0;
    var seenNegative = false;
    var bestIdx = -1;
    var i = 1u;
    loop {
      if (i + 1u >= count) { break; }
      let v = nsdf[i];
      if (!seenNegative) {
        if (v < 0.0) { seenNegative = true; }
      } else {
        if (v > nsdf[i - 1u] && v >= nsdf[i + 1u] && v > globalMax) {
          globalMax = v;
        }
      }
      i = i + 1u;
    }

    if (globalMax > 0.0) {
      let threshold = globalMax * 0.9;
      seenNegative = false;
      i = 1u;
      loop {
        if (i + 1u >= count) { break; }
        let v = nsdf[i];
        if (!seenNegative) {
          if (v < 0.0) { seenNegative = true; }
        } else if (v > nsdf[i - 1u] && v >= nsdf[i + 1u] && v >= threshold) {
          bestIdx = i32(i);
          break;
        }
        i = i + 1u;
      }
    }

    if (bestIdx > 0) {
      let bi = u32(bestIdx);
      // Parabolic interpolation through the three samples around the peak: without it the
      // period quantises to whole samples and the trace walks sideways by up to half a sample
      // per frame, which reads as a slow drift.
      let y0 = nsdf[bi - 1u];
      let y1 = nsdf[bi];
      let y2 = nsdf[bi + 1u];
      let denom = y0 - 2.0 * y1 + y2;
      var delta = 0.0;
      if (abs(denom) > 1e-12) {
        delta = 0.5 * (y0 - y2) / denom;
        delta = clamp(delta, -1.0, 1.0);
      }
      period = f32(P.a.y + bi) + delta;
      clarity = y1 - 0.25 * (y0 - y2) * delta;
    }
  }

  var span = P.c.w;
  if (clarity >= P.c.x && period > 1.0) {
    span = period * P.d.y;
  }
  span = clamp(span, P.d.z, P.d.w);

  // Search backwards from the nominal view start for the requested edge. Limiting the search
  // to one view width is the equivalent of a scope's trigger holdoff.
  let head = P.b.x;
  let nominalStart = head - u32(span);
  var searchLimit = u32(span);
  if (period > 1.0) {
    searchLimit = min(searchLimit, u32(period) + 2u);
  }
  searchLimit = min(searchLimit, 1u << 20u);

  let level = P.c.y;
  let edge = P.c.z;
  var found = -1.0;
  var k = 0u;
  loop {
    if (k >= searchLimit) { break; }
    let idx = nominalStart - k;
    let cur = fetch(idx) * edge;
    let prev = fetch(idx - 1u) * edge;
    let lv = level * edge;
    if (prev < lv && cur >= lv) {
      // Sub-sample crossing position by linear interpolation. This is what removes the
      // last visible frame-to-frame jitter.
      var frac = 0.0;
      let d = cur - prev;
      if (abs(d) > 1e-12) {
        frac = (lv - prev) / d;
      }
      found = f32(k) + 1.0 - frac;
      break;
    }
    k = k + 1u;
  }

  var offset = span;
  if (found >= 0.0) {
    offset = span + found;
  }

  timebase[0] = offset;
  timebase[1] = span;
  timebase[2] = clarity;
  if (period > 1.0) {
    timebase[3] = fs / period;
  } else {
    timebase[3] = 0.0;
  }
}
