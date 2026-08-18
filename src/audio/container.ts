/**
 * Reads the sample rate out of a media file's own header.
 *
 * `BaseAudioContext.decodeAudioData` resamples whatever it decodes to the context's rate, and
 * the AudioBuffer it hands back reports that rate rather than the file's. So the one question a
 * "no hidden resampling" indicator has to answer — is the audio arriving at the rate it was
 * written at — cannot be answered after decoding. It has to be answered before, from the
 * container, so the context can be opened at the file's own rate in the first place.
 *
 * The lossless containers are covered, because those are the ones where the claim means
 * anything, plus Ogg. For everything else this returns null, which the caller must report as
 * *unknown* rather than as agreement: a meter that says "bit perfect" because it could not
 * check is worse than one that says nothing.
 */

/** A plausible audio sample rate. Rejects the values a misparse produces. */
function plausible(rate: number): number | null {
  return Number.isFinite(rate) && rate >= 4000 && rate <= 768000 ? Math.round(rate) : null
}

function fourCC(view: DataView, at: number): string {
  if (at + 4 > view.byteLength) return ''
  return String.fromCharCode(
    view.getUint8(at),
    view.getUint8(at + 1),
    view.getUint8(at + 2),
    view.getUint8(at + 3),
  )
}

/**
 * RIFF/WAVE and RF64. The `fmt ` chunk is not required to be first, so the chunk list is
 * walked; chunks are padded to even lengths and a size field that would run past the end of the
 * buffer ends the walk rather than looping on a bad value.
 */
function riffRate(view: DataView): number | null {
  const little = fourCC(view, 0) !== 'RIFX'
  if (fourCC(view, 8) !== 'WAVE') return null
  let at = 12
  while (at + 8 <= view.byteLength) {
    const id = fourCC(view, at)
    const size = view.getUint32(at + 4, little)
    const body = at + 8
    if (id === 'fmt ' && body + 8 <= view.byteLength) {
      // wFormatTag u16, nChannels u16, nSamplesPerSec u32.
      return plausible(view.getUint32(body + 4, little))
    }
    if (size === 0 || body + size > view.byteLength) break
    at = body + size + (size & 1)
  }
  return null
}

/** FLAC's STREAMINFO is always the first metadata block, and the rate is 20 bits into it. */
function flacRate(view: DataView): number | null {
  // 4 bytes magic, then a block header: 1 byte (last-block flag + type), 3 bytes length.
  if (view.byteLength < 4 + 4 + 18) return null
  if ((view.getUint8(4) & 0x7f) !== 0) return null
  const body = 8
  // min/max block size (2+2), min/max frame size (3+3), then 20 bits of sample rate.
  const bits = view.getUint32(body + 10, false)
  return plausible(bits >>> 12)
}

/**
 * AIFF and AIFC. The rate is an 80-bit IEEE 754 extended float, which no JavaScript numeric
 * type holds, so it is assembled from the sign/exponent word and the 64-bit mantissa.
 */
function aiffRate(view: DataView): number | null {
  const form = fourCC(view, 8)
  if (form !== 'AIFF' && form !== 'AIFC') return null
  let at = 12
  while (at + 8 <= view.byteLength) {
    const id = fourCC(view, at)
    const size = view.getUint32(at + 4, false)
    const body = at + 8
    if (id === 'COMM' && body + 18 <= view.byteLength) {
      // numChannels u16, numSampleFrames u32, sampleSize u16, then the extended float.
      const at80 = body + 8
      const head = view.getUint16(at80, false)
      const exponent = (head & 0x7fff) - 16383
      const hi = view.getUint32(at80 + 2, false)
      const lo = view.getUint32(at80 + 6, false)
      const mantissa = hi * 2 ** 32 + lo
      const value = mantissa * 2 ** (exponent - 63)
      return plausible(head & 0x8000 ? -value : value)
    }
    if (size === 0 || body + size > view.byteLength) break
    at = body + size + (size & 1)
  }
  return null
}

/**
 * Ogg. The first page carries the codec's identification header.
 *
 * Vorbis states the rate it was encoded at. Opus states the rate of the audio that went *in*,
 * but always decodes at 48 kHz — so for Opus the honest answer to "what rate is this file" is
 * 48000, which is what any decoder will produce and what the context should therefore run at.
 */
function oggRate(view: DataView): number | null {
  if (view.byteLength < 64) return null
  const segments = view.getUint8(26)
  const packet = 27 + segments
  if (packet + 32 > view.byteLength) return null
  const magic = (at: number, text: string): boolean => {
    for (let i = 0; i < text.length; i++) {
      if (view.getUint8(at + i) !== text.charCodeAt(i)) return false
    }
    return true
  }
  // \x01vorbis, then version u32, channels u8, sample rate u32 LE.
  if (magic(packet + 1, 'vorbis')) return plausible(view.getUint32(packet + 12, true))
  if (magic(packet, 'OpusHead')) return 48000
  return null
}

/**
 * The rate a file's audio was written at, or null when the container does not say so in a form
 * this reads. Never throws: a truncated or malformed header is an unknown rate, not an error.
 */
export function containerSampleRate(bytes: ArrayBuffer): number | null {
  try {
    const view = new DataView(bytes)
    if (view.byteLength < 16) return null
    switch (fourCC(view, 0)) {
      case 'RIFF':
      case 'RIFX':
      case 'RF64':
        return riffRate(view)
      case 'fLaC':
        return flacRate(view)
      case 'FORM':
        return aiffRate(view)
      case 'OggS':
        return oggRate(view)
      default:
        return null
    }
  } catch {
    return null
  }
}
