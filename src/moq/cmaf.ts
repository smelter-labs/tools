// Thin wrappers over @moq/hang's CMAF (fMP4) helpers.
//
// IMPORTANT findings from reading @moq/hang/container/cmaf/encode.js:
//  - `description` passed to the init-segment builders must be a *hex string*
//    (it is run through Hex.toBytes), NOT a Uint8Array.
//  - The builders hardcode the mdhd timescale to 1_000_000 (microseconds), and
//    the consumer (decode.js -> decodeInitSegment) reads the timescale from the
//    init segment's mdhd. Therefore data-segment timestamps/durations must be in
//    microsecond units. WebCodecs already reports timestamp/duration in µs, so we
//    pass them through unchanged — no 90kHz/48kHz conversion.
import { Cmaf } from "@moq/hang/container";

/** Timescale baked into the init segments by @moq/hang (microseconds). */
export const TIMESCALE = 1_000_000;

/** Default track id used inside every CMAF fragment we emit. */
export const TRACK_ID = 1;

/** Normalize a WebCodecs buffer source (ArrayBuffer or view) to a Uint8Array copy. */
export function toUint8(src: AllowSharedBufferSource): Uint8Array {
  if (src instanceof ArrayBuffer) return new Uint8Array(src.slice(0));
  const view = src as ArrayBufferView;
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Build the H.264 init segment (ftyp+moov) and return it base64-encoded. */
export function videoInitBase64(opts: {
  codedWidth: number;
  codedHeight: number;
  /** Raw avcC bytes from VideoEncoder metadata.decoderConfig.description. */
  avcC: Uint8Array;
}): string {
  const init = Cmaf.createVideoInitSegment({
    codec: "avc1",
    codedWidth: opts.codedWidth,
    codedHeight: opts.codedHeight,
    description: bytesToHex(opts.avcC),
    // Only the fields above are read by the builder; the rest satisfy the type.
    container: { kind: "cmaf", init: "" },
  } as Parameters<typeof Cmaf.createVideoInitSegment>[0]);
  return bytesToBase64(init);
}

/** Build the AAC init segment (ftyp+moov) and return it base64-encoded. */
export function audioInitBase64(opts: {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  /** Raw AudioSpecificConfig from AudioEncoder metadata (optional; generated if absent). */
  asc?: Uint8Array;
}): string {
  const init = Cmaf.createAudioInitSegment({
    codec: opts.codec,
    sampleRate: opts.sampleRate,
    numberOfChannels: opts.numberOfChannels,
    description: opts.asc ? bytesToHex(opts.asc) : undefined,
    container: { kind: "cmaf", init: "" },
  } as Parameters<typeof Cmaf.createAudioInitSegment>[0]);
  return bytesToBase64(init);
}

/** Wrap one encoded chunk into a single moof+mdat CMAF fragment. */
export function dataSegment(opts: {
  data: Uint8Array;
  /** WebCodecs timestamp in microseconds. */
  timestampUs: number;
  /** WebCodecs duration in microseconds. */
  durationUs: number;
  keyframe: boolean;
  sequence: number;
}): Uint8Array {
  return Cmaf.encodeDataSegment({
    data: opts.data,
    timestamp: Math.max(0, Math.round(opts.timestampUs)),
    duration: Math.max(0, Math.round(opts.durationUs)),
    keyframe: opts.keyframe,
    sequence: opts.sequence,
    trackId: TRACK_ID,
  });
}
