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

// ---- VP8 CMAF init segment (hand-built) ----------------------------------
//
// @moq/hang's createVideoInitSegment is hardcoded to emit an avc1 box and
// requires a non-empty `description`, so it cannot build a VP8 init segment,
// and its sub-box writers are not exported. WebCodecs VP8 is self-describing
// (no decoderConfig.description / avcC equivalent), so the only codec-specific
// part is the sample entry: a `vp08` VisualSampleEntry carrying a `vpcC`
// VPCodecConfigurationBox. We build the whole ftyp+moov here with DataView,
// modeled on the box layout in @moq/hang/container/cmaf/encode.js.

const IDENTITY_MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

/** Write a 4-char box type into `bytes` at `offset`. */
function writeType(bytes: Uint8Array, offset: number, type: string): void {
  bytes[offset] = type.charCodeAt(0);
  bytes[offset + 1] = type.charCodeAt(1);
  bytes[offset + 2] = type.charCodeAt(2);
  bytes[offset + 3] = type.charCodeAt(3);
}

/** Concatenate a list of box byte arrays into one buffer. */
function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Wrap child-box payloads in a plain (non-full) container box of `type`. */
function box(type: string, ...children: Uint8Array[]): Uint8Array {
  const body = concatBytes(children);
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length, false);
  writeType(out, 4, type);
  out.set(body, 8);
  return out;
}

/** Build a FullBox (version + flags header) of `type` from raw content bytes. */
function fullBox(type: string, version: number, flags: number, content: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + content.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length, false);
  writeType(out, 4, type);
  view.setUint32(8, (version << 24) | flags, false);
  out.set(content, 12);
  return out;
}

/**
 * VPCodecConfigurationBox (`vpcC`), FullBox version 1. All color fields are
 * hardcoded "unspecified" (the VP8 bitstream is self-describing): profile 0,
 * level 0, 8-bit depth, 4:2:0 chroma, limited range, primaries/transfer/matrix
 * all 2 (unspecified), and an empty codecInitializationData (required empty for
 * VP8). See the VP Codec ISO Media File Format Binding.
 */
function createVpcCBox(): Uint8Array {
  const content = new Uint8Array(8);
  content[0] = 0; // profile
  content[1] = 0; // level
  // bitDepth(4)=8 | chromaSubsampling(3)=1 (4:2:0 colocated) | videoFullRangeFlag(1)=0
  content[2] = (8 << 4) | (1 << 1) | 0;
  content[3] = 2; // colourPrimaries = unspecified
  content[4] = 2; // transferCharacteristics = unspecified
  content[5] = 2; // matrixCoefficients = unspecified
  // codecInitializationDataSize = 0 (uint16), no trailing data
  content[6] = 0;
  content[7] = 0;
  return fullBox("vpcC", 1, 0, content);
}

/**
 * `vp08` VisualSampleEntry. Same layout as createAvc1Box in encode.js, but the
 * type is `vp08` and the child config box is `vpcC` instead of `avcC`.
 */
function createVp08Box(width: number, height: number): Uint8Array {
  const vpcC = createVpcCBox();
  const contentSize = 6 + 2 + 2 + 2 + 12 + 2 + 2 + 4 + 4 + 4 + 2 + 32 + 2 + 2 + vpcC.length;
  const out = new Uint8Array(8 + contentSize);
  const view = new DataView(out.buffer);
  let offset = 0;
  view.setUint32(offset, out.length, false);
  offset += 4;
  writeType(out, offset, "vp08");
  offset += 4;
  // SampleEntry fields
  offset += 6; // reserved
  view.setUint16(offset, 1, false);
  offset += 2; // data_reference_index = 1
  // VisualSampleEntry fields
  view.setUint16(offset, 0, false);
  offset += 2; // pre_defined
  view.setUint16(offset, 0, false);
  offset += 2; // reserved
  offset += 12; // pre_defined
  view.setUint16(offset, width, false);
  offset += 2;
  view.setUint16(offset, height, false);
  offset += 2;
  view.setUint32(offset, 0x00480000, false);
  offset += 4; // horizresolution (72 dpi)
  view.setUint32(offset, 0x00480000, false);
  offset += 4; // vertresolution (72 dpi)
  view.setUint32(offset, 0, false);
  offset += 4; // reserved
  view.setUint16(offset, 1, false);
  offset += 2; // frame_count = 1
  offset += 32; // compressorname
  view.setUint16(offset, 0x0018, false);
  offset += 2; // depth = 24
  view.setUint16(offset, 0xffff, false);
  offset += 2; // pre_defined = -1
  out.set(vpcC, offset);
  return out;
}

/**
 * Build a CMAF (ftyp+moov) init segment for VP8 video and return it
 * base64-encoded. Mirrors the box tree built by @moq/hang's
 * createVideoInitSegment (encode.js:166), but with a `vp08`/`vpcC` sample entry
 * and no avcC/`description` requirement.
 */
export function videoInitBase64Vp8(opts: { codedWidth: number; codedHeight: number }): string {
  const { codedWidth, codedHeight } = opts;
  const timescale = TIMESCALE;
  const trackId = TRACK_ID;

  // ftyp: major brand 'isom', minor 0x200, compatible brands isom/iso6/mp41
  const compatibleBrands = ["isom", "iso6", "mp41"];
  const ftypContent = new Uint8Array(8 + compatibleBrands.length * 4);
  {
    const view = new DataView(ftypContent.buffer);
    writeType(ftypContent, 0, "isom"); // major brand
    view.setUint32(4, 0x200, false); // minor version
    compatibleBrands.forEach((b, i) => writeType(ftypContent, 8 + i * 4, b));
  }
  const ftyp = box("ftyp", ftypContent);

  // mvhd (version 0)
  const mvhdContent = new Uint8Array(96);
  {
    const view = new DataView(mvhdContent.buffer);
    let o = 0;
    view.setUint32(o, 0, false); o += 4; // creationTime
    view.setUint32(o, 0, false); o += 4; // modificationTime
    view.setUint32(o, timescale, false); o += 4;
    view.setUint32(o, 0, false); o += 4; // duration
    view.setUint32(o, 0x00010000, false); o += 4; // rate
    view.setUint16(o, 0x0100, false); o += 2; // volume
    o += 2; // reserved
    o += 8; // reserved (2x uint32)
    for (const m of IDENTITY_MATRIX) { view.setUint32(o, m >>> 0, false); o += 4; }
    o += 24; // pre_defined (6x uint32)
    view.setUint32(o, trackId + 1, false); // nextTrackId
  }
  const mvhd = fullBox("mvhd", 0, 0, mvhdContent);

  // tkhd (version 0)
  const tkhdContent = new Uint8Array(80);
  {
    const view = new DataView(tkhdContent.buffer);
    let o = 0;
    view.setUint32(o, 0, false); o += 4; // creationTime
    view.setUint32(o, 0, false); o += 4; // modificationTime
    view.setUint32(o, trackId, false); o += 4;
    view.setUint32(o, 0, false); o += 4; // reserved
    view.setUint32(o, 0, false); o += 4; // duration
    o += 8; // reserved (2x uint32)
    view.setUint16(o, 0, false); o += 2; // layer
    view.setUint16(o, 0, false); o += 2; // alternateGroup
    view.setUint16(o, 0, false); o += 2; // volume (0 for video)
    o += 2; // reserved
    for (const m of IDENTITY_MATRIX) { view.setUint32(o, m >>> 0, false); o += 4; }
    view.setUint32(o, codedWidth * 0x10000, false); o += 4; // width 16.16
    view.setUint32(o, codedHeight * 0x10000, false); // height 16.16
  }
  const tkhd = fullBox("tkhd", 0, 0x000003, tkhdContent);

  // mdhd (version 0)
  const mdhdContent = new Uint8Array(20);
  {
    const view = new DataView(mdhdContent.buffer);
    let o = 0;
    view.setUint32(o, 0, false); o += 4; // creationTime
    view.setUint32(o, 0, false); o += 4; // modificationTime
    view.setUint32(o, timescale, false); o += 4;
    view.setUint32(o, 0, false); o += 4; // duration
    // language "und" = 0x55c4, pre_defined = 0
    view.setUint16(o, 0x55c4, false); o += 2;
    view.setUint16(o, 0, false);
  }
  const mdhd = fullBox("mdhd", 0, 0, mdhdContent);

  // hdlr
  const hdlrName = "VideoHandler";
  const hdlrContent = new Uint8Array(20 + hdlrName.length + 1);
  {
    writeType(hdlrContent, 4, "vide"); // handlerType (after pre_defined uint32 at 0)
    for (let i = 0; i < hdlrName.length; i++) hdlrContent[20 + i] = hdlrName.charCodeAt(i);
  }
  const hdlr = fullBox("hdlr", 0, 0, hdlrContent);

  // vmhd (flags = 1)
  const vmhdContent = new Uint8Array(8); // graphicsmode(2) + opcolor(3x2)
  const vmhd = fullBox("vmhd", 0, 1, vmhdContent);

  // dinf > dref (FullBox, entry_count = 1) > url (self-contained)
  const urlBox = fullBox("url ", 0, 0x000001, new Uint8Array(0));
  const drefEntryCount = new Uint8Array(4);
  new DataView(drefEntryCount.buffer).setUint32(0, 1, false);
  const dref = fullBox("dref", 0, 0, concatBytes([drefEntryCount, urlBox]));
  const dinf = box("dinf", dref);

  // stbl children
  const vp08 = createVp08Box(codedWidth, codedHeight);
  const stsdEntryCount = new Uint8Array(4);
  new DataView(stsdEntryCount.buffer).setUint32(0, 1, false);
  const stsd = fullBox("stsd", 0, 0, concatBytes([stsdEntryCount, vp08]));
  const stts = fullBox("stts", 0, 0, new Uint8Array(4)); // entry_count = 0
  const stsc = fullBox("stsc", 0, 0, new Uint8Array(4)); // entry_count = 0
  const stsz = fullBox("stsz", 0, 0, new Uint8Array(8)); // sample_size = 0, sample_count = 0
  const stco = fullBox("stco", 0, 0, new Uint8Array(4)); // entry_count = 0
  const stbl = box("stbl", stsd, stts, stsc, stsz, stco);

  const minf = box("minf", vmhd, dinf, stbl);
  const mdia = box("mdia", mdhd, hdlr, minf);
  const trak = box("trak", tkhd, mdia);

  // mvex > trex
  const trexContent = new Uint8Array(20);
  {
    const view = new DataView(trexContent.buffer);
    view.setUint32(0, trackId, false);
    view.setUint32(4, 1, false); // defaultSampleDescriptionIndex
    // remaining defaults are 0
  }
  const trex = fullBox("trex", 0, 0, trexContent);
  const mvex = box("mvex", trex);

  const moov = box("moov", mvhd, trak, mvex);

  return bytesToBase64(concatBytes([ftyp, moov]));
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
