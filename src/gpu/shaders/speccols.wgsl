// Bin-to-pixel reduction for the spectrum display.
//
// A 65536-point FFT at 48 kHz puts 32769 bins on maybe 3000 pixels. Drawing one polyline
// vertex per bin aliases badly: whether a narrow peak survives depends on where it happens to
// land relative to a pixel boundary, so peaks flicker as the signal drifts. Reducing each
// pixel column to the min/max/mean of the bins inside it makes narrow peaks always visible
// and always the right height.
//
// The opposite regime matters too. On a log frequency axis the bottom two octaves have fewer
// than one bin per pixel; there we interpolate between neighbouring bins instead of
// point-sampling, so the low end is a smooth curve rather than a staircase.

struct Params {
  // x: columns   y: channelCount   z: binCount (= n/2 + 1)   w: source (0 = live, 1 = averaged)
  a: vec4<u32>,
  // x: sampleRate   y: n   z: freqMin   w: freqMax
  b: vec4<f32>,
  // x: logAxis   y: dbFloor   z: unused   w: unused
  c: vec4<f32>,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> spectrum: array<f32>;
@group(0) @binding(2) var<storage, read> peaks: array<f32>;
@group(0) @binding(3) var<storage, read> average: array<f32>;
@group(0) @binding(4) var<storage, read_write> columns: array<vec4<f32>>;

const WG: u32 = 64u;

var<workgroup> sMin: array<f32, WG>;
var<workgroup> sMax: array<f32, WG>;
var<workgroup> sSum: array<f32, WG>;
var<workgroup> sPeak: array<f32, WG>;

fn axisToFreqLocal(u: f32) -> f32 {
  let fMin = P.b.z;
  let fMax = P.b.w;
  if (P.c.x > 0.5) {
    let lo = log2(max(fMin, 1.0));
    let hi = log2(max(fMax, lo + 1.0));
    return exp2(lo + u * (hi - lo));
  }
  return fMin + u * (fMax - fMin);
}

fn valueAt(base: u32, bin: u32) -> f32 {
  if (P.a.w == 1u) {
    return 10.0 * log2(max(average[base + bin], 1e-24)) * 0.30102999566;
  }
  return spectrum[base + bin];
}

@compute @workgroup_size(WG)
fn main(
  @builtin(workgroup_id) wg: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
) {
  let colCount = P.a.x;
  let column = wg.x % colCount;
  let channel = wg.x / colCount;
  let t = lid.x;
  let base = channel * P.a.z;
  let floorDb = P.c.y;

  let binsPerHz = P.b.y / P.b.x;
  let f0 = axisToFreqLocal(f32(column) / f32(colCount));
  let f1 = axisToFreqLocal(f32(column + 1u) / f32(colCount));
  let b0 = f0 * binsPerHz;
  let b1 = f1 * binsPerHz;
  let maxBin = P.a.z - 1u;

  if (b1 - b0 < 1.0) {
    // Fewer than one bin per pixel: interpolate rather than point sample.
    if (t == 0u) {
      let centre = clamp((b0 + b1) * 0.5, 0.0, f32(maxBin));
      let i0 = u32(floor(centre));
      let i1 = min(i0 + 1u, maxBin);
      let f = centre - floor(centre);
      let v = mix(valueAt(base, i0), valueAt(base, i1), f);
      let p = max(peaks[base + i0], peaks[base + i1]);
      columns[channel * colCount + column] = vec4<f32>(v, v, v, p);
    }
    return;
  }

  let start = min(u32(floor(b0)), maxBin);
  let end = min(u32(ceil(b1)), maxBin);
  let count = max(1u, end - start + 1u);

  var lo = 1e30;
  var hi = -1e30;
  var sum = 0.0;
  var pk = -1e30;
  for (var i = t; i < count; i = i + WG) {
    let v = valueAt(base, start + i);
    lo = min(lo, v);
    hi = max(hi, v);
    sum = sum + v;
    pk = max(pk, peaks[base + start + i]);
  }
  sMin[t] = lo;
  sMax[t] = hi;
  sSum[t] = sum;
  sPeak[t] = pk;
  workgroupBarrier();

  var stride = WG / 2u;
  loop {
    if (stride == 0u) { break; }
    if (t < stride) {
      sMin[t] = min(sMin[t], sMin[t + stride]);
      sMax[t] = max(sMax[t], sMax[t + stride]);
      sSum[t] = sSum[t] + sSum[t + stride];
      sPeak[t] = max(sPeak[t], sPeak[t + stride]);
    }
    workgroupBarrier();
    stride = stride / 2u;
  }

  if (t == 0u) {
    columns[channel * colCount + column] = vec4<f32>(
      max(sMin[0], floorDb),
      max(sMax[0], floorDb),
      max(sSum[0] / f32(count), floorDb),
      max(sPeak[0], floorDb),
    );
  }
}
