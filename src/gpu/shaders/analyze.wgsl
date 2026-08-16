// Stage 4: turn complex bins into the two things the display actually consumes —
// a magnitude spectrum (with peak hold and Welch averaging) and a cloud of reassigned
// time-frequency points.
//
// ---------------------------------------------------------------------------------------
// Time-frequency reassignment
// ---------------------------------------------------------------------------------------
// A spectrogram smears energy over the whole support of the analysis window. Reassignment
// moves each bin's energy to the *centre of gravity* of the energy it represents, which is
// computed from the phase of the transform rather than from its magnitude. The result is
// close to the sharpness of a Wigner-Ville distribution without any of its cross terms.
//
// With the STFT defined as X_w[k] = sum_m x[t0+m] w[m] e^(-2*pi*i*k*m/N):
//
//   dt   =  Re( X_tw[k] / X_w[k] )                 group delay, in samples from window centre
//   dw   = -Im( X_dw[k] / X_w[k] )                 frequency offset, in radians per sample
//
//   t_hat = t0 + N/2 + dt
//   f_hat = (k/N - Im(X_dw/X_w) / (2*pi)) * fs
//
// Sanity check on the signs: for an impulse at m0 the ratio X_tw/X_w collapses to
// (m0 - N/2), so t_hat lands exactly on the impulse. For a sinusoid at w0, integration by
// parts gives X_dw/X_w = -i*delta with delta = w0 - 2*pi*k/N, so f_hat lands exactly on w0.
//
// Points whose correction is implausibly large are dropped rather than trusted: a large
// displacement means |X_w| was near a spectral null, where the phase derivative is noise.
// This is the standard practical gate on reassignment and it is what keeps the display from
// filling with confetti during noise-like passages. How much of that budget a surviving point
// spent is kept rather than thrown away — it is the best available measure of how tone-like the
// point is, and the harmonic life pass is built on it.

struct Params {
  // x: l   y: channelCount   z: frameCount   w: variantCount
  a: vec4<u32>,
  // x: displayChannel   y: reassign (0/1)   z: totalThreads   w: n
  b: vec4<u32>,
  // x: ampScale   y: peakDecayPerBatch   z: avgAlpha   w: floorDb
  c: vec4<f32>,
  // x: sampleRate   y: hop   z: maxTimeShiftSamples   w: maxFreqShiftHz
  d: vec4<f32>,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> bins: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> spectrum: array<f32>;
@group(0) @binding(3) var<storage, read_write> peaks: array<f32>;
@group(0) @binding(4) var<storage, read_write> average: array<f32>;
@group(0) @binding(5) var<storage, read_write> points: array<vec4<f32>>;

const TWO_PI: f32 = 6.283185307179586;

fn binIndex(frame: u32, variant: u32, channel: u32) -> u32 {
  let channelCount = P.a.y;
  let variantCount = P.a.w;
  return (frame * variantCount + variant) * channelCount + channel;
}

fn amplitudeAt(frame: u32, channel: u32, k: u32) -> f32 {
  let stride = P.a.x + 1u;
  let z = bins[binIndex(frame, 0u, channel) * stride + k];
  var mag = length(z) * P.c.x;
  // DC and Nyquist appear once in the two-sided spectrum, every other bin appears twice;
  // ampScale carries the factor of two, so undo it at the endpoints.
  if (k == 0u || k == P.a.x) {
    mag = mag * 0.5;
  }
  return mag;
}

fn toDb(v: f32) -> f32 {
  return 20.0 * log2(max(v, 1e-12)) * 0.30102999566;
}

// One thread per (channel, bin). Loops over every pending analysis frame so that averaging
// and peak hold run at the true analysis rate rather than at the display rate.
@compute @workgroup_size(64)
fn spectra(@builtin(global_invocation_id) gid: vec3<u32>) {
  let tid = gid.x;
  if (tid >= P.b.z) {
    return;
  }
  let stride = P.a.x + 1u;
  let k = tid % stride;
  let channel = tid / stride;
  let frameCount = P.a.z;
  let floorDb = P.c.w;

  var avg = average[tid];
  var peak = peaks[tid];
  let alpha = P.c.z;
  var latest = 0.0;

  for (var f = 0u; f < frameCount; f = f + 1u) {
    let amp = amplitudeAt(f, channel, k);
    let power = amp * amp;
    avg = avg + alpha * (power - avg);
    latest = amp;
  }

  let latestDb = max(toDb(latest), floorDb);
  peak = max(peak - P.c.y, floorDb);
  if (latestDb > peak) {
    peak = latestDb;
  }

  spectrum[tid] = latestDb;
  peaks[tid] = peak;
  average[tid] = avg;
}

// One thread per (frame, bin) for the display channel. Emits a reassigned point.
@compute @workgroup_size(64)
fn reassign(@builtin(global_invocation_id) gid: vec3<u32>) {
  let tid = gid.x;
  if (tid >= P.b.z) {
    return;
  }
  let l = P.a.x;
  let stride = l + 1u;
  let n = f32(P.b.w);
  let k = tid % stride;
  let frame = tid / stride;
  let channel = P.b.x;
  let fs = P.d.x;
  let hop = P.d.y;

  let xw = bins[binIndex(frame, 0u, channel) * stride + k];
  let power = dot(xw, xw);

  var amp = sqrt(power) * P.c.x;
  if (k == 0u || k == l) {
    amp = amp * 0.5;
  }

  // Time of this frame's window centre, expressed in samples relative to the newest frame.
  var tRel = (f32(frame) - f32(P.a.z - 1u)) * hop;
  var freq = (f32(k) / n) * fs;
  var valid = 1.0;

  if (P.b.y == 1u && P.a.w >= 3u) {
    if (power < 1e-24) {
      valid = 0.0;
    } else {
      let xtw = bins[binIndex(frame, 1u, channel) * stride + k];
      let xdw = bins[binIndex(frame, 2u, channel) * stride + k];

      // Complex division by X_w, done as multiplication by its conjugate over |X_w|^2.
      let invPower = 1.0 / power;
      let dt = (xtw.x * xw.x + xtw.y * xw.y) * invPower;
      let dwIm = (xdw.y * xw.x - xdw.x * xw.y) * invPower;

      let dFreq = -dwIm / TWO_PI * fs;

      if (abs(dt) > P.d.z || abs(dFreq) > P.d.w) {
        valid = 0.0;
      } else {
        tRel = tRel + dt;
        freq = freq + dFreq;
        // How far the point had to be moved is itself a measurement: a stable partial barely
        // moves, and phase noise moves a long way before the gate above rejects it. The
        // remaining range of the validity slot carries that, from 0.5 (moved as far as the
        // gate allows) to 1.0 (did not need moving). Consumers that only ask "is this point
        // real" still test `< 0.5` and are unaffected; life.wgsl reads it as coherence.
        let spent = max(abs(dt) / max(P.d.z, 1e-6), abs(dFreq) / max(P.d.w, 1e-6));
        valid = 0.5 + 0.5 * clamp(1.0 - spent, 0.0, 1.0);
      }
    }
  }

  if (freq < 0.0 || freq > fs * 0.5) {
    valid = 0.0;
  }

  points[tid] = vec4<f32>(tRel, freq, amp, valid);
}
