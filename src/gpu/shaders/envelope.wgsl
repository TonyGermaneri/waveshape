// Waveform envelope reduction.
//
// At 192 kHz a 4-second view is 768,000 samples competing for maybe 3,000 pixel columns.
// Point-sampling that is not decimation, it is aliasing: a 20 kHz tone drawn every 256th
// sample becomes an arbitrary low-frequency squiggle. Every serious scope and audio editor
// instead reduces each column to the min/max pair actually present in it, so the drawn
// envelope is the true peak excursion.
//
// One workgroup per (channel, column); threads stride through the column's samples and then
// tree-reduce in workgroup memory. RMS is accumulated alongside for the optional density fill.
//
// The timebase (where the view starts and how wide it is) comes from a buffer rather than a
// uniform, so a GPU-computed trigger can steer it with no CPU round-trip.

struct Params {
  // x: columns   y: channelCount   z: ringCapacity   w: ringChannels
  a: vec4<u32>,
  // x: head (absolute frame index, masked to 2^30)   y: unused   z: unused   w: unused
  b: vec4<u32>,
  mix0: vec4<f32>,
  mix1: vec4<f32>,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> audio: array<f32>;
@group(0) @binding(2) var<storage, read_write> env: array<vec4<f32>>;
// [0] offset of the view start behind the head, in samples (fractional)
// [1] view width in samples   [2] trigger clarity 0..1   [3] detected frequency, Hz
@group(0) @binding(3) var<storage, read> timebase: array<f32>;

const WG: u32 = 64u;

var<workgroup> sMin: array<f32, WG>;
var<workgroup> sMax: array<f32, WG>;
var<workgroup> sSum: array<f32, WG>;

fn fetch(channel: u32, frame: u32) -> f32 {
  let cap = P.a.z;
  let idx = frame & (cap - 1u);
  let a = audio[idx];
  var b = a;
  if (P.a.w > 1u) {
    b = audio[cap + idx];
  }
  var mix = P.mix0;
  if (channel == 1u) {
    mix = P.mix1;
  }
  return mix.x * a + mix.y * b;
}

@compute @workgroup_size(WG)
fn main(
  @builtin(workgroup_id) wg: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
) {
  let columns = P.a.x;
  let column = wg.x % columns;
  let channel = wg.x / columns;
  let t = lid.x;

  let span = max(timebase[1], 1.0);
  let startOffset = timebase[0];
  let perColumn = span / f32(columns);

  // Absolute frame index of this column's first sample. Computed in integer space to stay
  // exact: f32 runs out of mantissa well before a 2^30 frame counter does.
  let viewStart = P.b.x - u32(startOffset);
  let first = viewStart + u32(f32(column) * perColumn);
  let count = max(1u, u32(perColumn));

  var lo = 1e30;
  var hi = -1e30;
  var sum = 0.0;
  for (var i = t; i < count; i = i + WG) {
    let v = fetch(channel, first + i);
    lo = min(lo, v);
    hi = max(hi, v);
    sum = sum + v * v;
  }
  sMin[t] = lo;
  sMax[t] = hi;
  sSum[t] = sum;
  workgroupBarrier();

  var stride = WG / 2u;
  loop {
    if (stride == 0u) { break; }
    if (t < stride) {
      sMin[t] = min(sMin[t], sMin[t + stride]);
      sMax[t] = max(sMax[t], sMax[t + stride]);
      sSum[t] = sSum[t] + sSum[t + stride];
    }
    workgroupBarrier();
    stride = stride / 2u;
  }

  if (t == 0u) {
    let rms = sqrt(sSum[0] / f32(count));
    env[channel * columns + column] = vec4<f32>(sMin[0], sMax[0], rms, f32(count));
  }
}
