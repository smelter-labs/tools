// Hand-rolled MoQ publisher: capture -> WebCodecs encode -> CMAF/Legacy frame ->
// @moq/net track publish. We avoid the high-level @moq/publish API because it
// hardcodes a "legacy" container; we require H264 and want CMAF as the default.
// Audio codec is selectable (AAC or Opus); the video and audio containers are
// each selectable (CMAF or Legacy) and default to CMAF.
//
// Publish model (confirmed in @moq/net broadcast.js + the @moq/publish serve
// loop in screen-CAGDqnB8.js:1576): it is PULL-based. We create a Broadcast,
// call conn.publish(path, broadcast), then loop broadcast.requested() and serve
// the track matching each subscription by name.
import * as Net from "@moq/net";
import * as Catalog from "@moq/hang/catalog";
import * as Msf from "@moq/msf";
import { Legacy } from "@moq/hang/container";
import * as Loc from "@moq/loc";
import type { Time } from "@moq/net";
import * as Cmaf from "./cmaf";

export type SourceKind = "camera" | "screen" | "none";

export type AudioCodec = "aac-raw" | "aac-adts" | "opus";

export type VideoCodec = "avc1" | "annexb" | "vp8" | "vp9";

export type ContainerKind = "cmaf" | "legacy" | "loc";

// Maps each selectable audio codec to the single codec string that drives both
// WebCodecs (AudioEncoder.configure / isConfigSupported) and the CMAF init
// segment + catalog rendition.
const AUDIO_CODECS: Record<AudioCodec, string> = {
  "aac-raw": "mp4a.40.2", // AAC-LC, raw (MP4) bitstream
  "aac-adts": "mp4a.40.2", // AAC-LC, ADTS bitstream
  opus: "opus",
};

// Audio source constants. The audio source is a string: one of these sentinels
// or a concrete device id.
const NONE = "none";
const SCREEN = "screen";
const MICROPHONE = "microphone";

export type AudioProcessing = {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
};

// Plain shape of the catalog we publish. Mirrors @moq/hang's RootSchema but
// uses plain numbers (the schema's branded `u53` numbers reject plain literals
// at the type level; the JSON we emit is identical and re-validated on consume).
type Container =
  | { kind: "cmaf"; init: string; timescale: number; trackId: number }
  | { kind: "legacy" }
  | { kind: "loc" };
interface CatalogRoot {
  video?: {
    renditions: Record<
      string,
      {
        codec: string;
        container: Container;
        codedWidth: number;
        codedHeight: number;
        framerate: number;
        bitrate: number;
        description?: string;
      }
    >;
  };
  audio?: {
    renditions: Record<
      string,
      {
        codec: string;
        container: Container;
        sampleRate: number;
        numberOfChannels: number;
        bitrate: number;
        description?: string;
      }
    >;
  };
}

export interface PublishOptions {
  serverUrl: string;
  broadcastPath: string;
  /** Bearer token appended to the server URL as a `?token=` query param. */
  token?: string;
  /**
   * Video source. `"none"` publishes an audio-only broadcast (no video track,
   * encoder, or catalog rendition); an audio source must then be selected.
   */
  source: SourceKind;
  /** Audio source: NONE / SCREEN / MICROPHONE sentinel, or a concrete device id. */
  audioSource: string;
  audioProcessing: AudioProcessing;
  /** Audio codec to encode/publish. Defaults to `"aac-raw"` when unset. */
  audioCodec?: AudioCodec;
  /** Video codec/framing. Defaults to "avc1" (length-prefixed NALUs). */
  videoCodec?: VideoCodec;
  /**
   * Advertise the avc1 decoder config (avcC) out-of-band in the catalog —
   * hang `description` and the legacy MSF `initData`. Defaults to true. Ignored
   * for annexb (config is always in-band). For CMAF the init segment is
   * mandatory regardless; this only toggles the redundant `description` field.
   */
  includeDescription?: boolean;
  /**
   * Advertise the raw-AAC AudioSpecificConfig (ASC) out-of-band in the catalog
   * `description`. Defaults to true. Only meaningful for `aac-raw` (ADTS frames
   * are self-describing, Opus always carries its dOps). For CMAF the init
   * segment is mandatory regardless; this only toggles the redundant
   * `description` field.
   */
  audioIncludeDescription?: boolean;
  /** Video container. Defaults to "cmaf". */
  videoContainer?: ContainerKind;
  /** Audio container. Defaults to "cmaf". */
  audioContainer?: ContainerKind;
  wsFallback: boolean;
  /**
   * Reanchor WebCodecs timestamps so each track independently starts at ~0.
   * When on, every chunk has its own track's first timestamp subtracted,
   * normalizing baseMediaDecodeTime to near-zero. Because the audio and video
   * capture clocks have divergent absolute origins, per-track zeroing is what
   * makes two co-captured samples land on the same number. Defaults to false
   * (raw capture timestamps passed through unchanged).
   */
  reanchorTimestamps?: boolean;
  /**
   * Encoder/capture overrides. `undefined` means "auto" — fall back to the
   * hardcoded defaults below (and capture-derived dimensions).
   */
  videoBitrate?: number;
  audioBitrate?: number;
  framerate?: number;
  width?: number;
  height?: number;
  /**
   * Maximum interval between video keyframes, in microseconds. A keyframe is
   * forced on the first captured frame whose timestamp is at least this far past
   * the previous keyframe, so the encoded stream never goes longer than this
   * between keyframes (subscriber-arrival still forces an earlier one). Empty/
   * unset falls back to the hardcoded default (~2s).
   */
  keyframeIntervalUs?: number;
  /**
   * Buffer each complete GOP and publish it as a single burst (one group
   * written all at once) instead of streaming frames live as they encode.
   * Independent of `keyframeIntervalUs`. Defaults to false (stream live).
   */
  burstGroups?: boolean;
  /**
   * Target duration of each audio MoQ group, in milliseconds. The frame count
   * per group is derived from this and the encoder's per-frame duration (Opus
   * ~20ms, AAC ~21.3ms), so it lands as close to the requested duration as the
   * frame granularity allows. Nothing to do with audio encoding. Empty/unset
   * keeps the default of one group per audio frame (lowest latency).
   */
  audioGroupSizeMs?: number;
  /**
   * Buffer each complete audio group and publish it as a single burst (one
   * group written all at once) instead of streaming frames live as they encode.
   * Only meaningful when `audioGroupSizeMs` is set. Defaults to false.
   */
  burstAudioGroups?: boolean;
  /**
   * Capture-track content hint (`MediaStreamTrack.contentHint`). Biases the
   * encoder's quality trade-off: "motion" favors temporal (framerate) quality,
   * "detail"/"text" favor spatial (resolution) quality. Empty/unset leaves it
   * at the browser default. This is the WebCodecs-path analogue of WHIP's
   * WebRTC degradation preference.
   */
  contentHint?: MediaStreamTrack["contentHint"];
  /**
   * TESTING ONLY. The relay's self-signed cert sha-256 fingerprint as a raw
   * hex string. When set and valid, the fingerprint is pinned via
   * `serverCertificateHashes`, making WebTransport skip CA-chain verification
   * for that cert. If empty/unset, or the hex is invalid, connect falls back to
   * standard TLS verification. NEVER use in production.
   */
  certHash?: string;
  onStatus?: (status: PublishStatus) => void;
}

export interface PublishStatus {
  state: "connecting" | "publishing" | "stopped" | "error";
  message?: string;
  fps?: number;
}

export interface PublishHandle {
  /** The captured MediaStream, for local preview. */
  stream: MediaStream;
  stop: () => Promise<void>;
}

// Track names. The catalog rendition keys MUST match these.
const TRACK_CATALOG = "catalog.json";
const TRACK_CATALOG_MSF = "catalog";
const TRACK_VIDEO = "video/hd";
const TRACK_AUDIO = "audio/eng";

// Hardcoded encoder defaults.
const VIDEO_CODEC = "avc1.640028"; // H.264 High Profile, level 4.0 (fallback)

// H.264 levels: [hex level byte, MaxMBPS (MBs/sec), MaxFS (MBs/frame)] in
// ascending order. The codec string must advertise a level whose limits cover
// the actual resolution/framerate, otherwise the encoder rejects it (e.g. level
// 4.0 caps coded area at 8192 MBs = 2,097,152 px, too small for 2560x1440).
const AVC_LEVELS: [number, number, number][] = [
  [0x28, 245_760, 8_192], // 4.0
  [0x29, 245_760, 8_192], // 4.1
  [0x2a, 522_240, 8_704], // 4.2
  [0x32, 589_824, 22_080], // 5.0
  [0x33, 983_040, 36_864], // 5.1
  [0x34, 2_073_600, 36_864], // 5.2
  [0x3c, 4_177_920, 139_264], // 6.0
  [0x3d, 8_355_840, 139_264], // 6.1
  [0x3e, 16_711_680, 139_264], // 6.2
];

// Build an "avc1.6400LL" codec string whose level covers width×height@fps.
function avcCodecString(width: number, height: number, framerate: number): string {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const mbps = mbs * framerate;
  const match = AVC_LEVELS.find(([, maxMbps, maxFs]) => mbs <= maxFs && mbps <= maxMbps);
  const levelByte = match ? match[0] : AVC_LEVELS[AVC_LEVELS.length - 1][0];
  return `avc1.6400${levelByte.toString(16).padStart(2, "0")}`;
}

// VP9 levels: [byte (level*10), MaxLumaSampleRate (samples/s), MaxLumaPictureSize (samples)]
const VP9_LEVELS: [number, number, number][] = [
  [30, 41_943_040, 2_228_224], // 3.0
  [31, 83_886_080, 2_228_224], // 3.1
  [40, 167_772_160, 8_912_896], // 4.0
  [41, 335_544_320, 8_912_896], // 4.1
  [50, 671_088_640, 35_651_584], // 5.0
  [51, 1_342_177_280, 35_651_584], // 5.1
  [52, 2_684_354_560, 35_651_584], // 5.2
];

// Build a "vp09.00.LL.08" codec string (profile 0, 8-bit) whose level covers
// width×height@fps. VideoEncoder.configure rejects a bare "vp9".
function vp9CodecString(width: number, height: number, framerate: number): string {
  const samples = width * height;
  const rate = samples * framerate;
  const match = VP9_LEVELS.find(([, maxRate, maxPic]) => samples <= maxPic && rate <= maxRate);
  const levelByte = match ? match[0] : VP9_LEVELS[VP9_LEVELS.length - 1][0];
  return `vp09.00.${levelByte.toString(10).padStart(2, "0")}.08`;
}

const VIDEO_BITRATE = 5_000_000;
const AUDIO_BITRATE = 128_000;
const FRAMERATE = 30;
const KEYFRAME_INTERVAL_US = 2_000_000; // keyframe every ~2s

function audioConstraints(processing: AudioProcessing): MediaTrackConstraints {
  return {
    echoCancellation: processing.echoCancellation,
    noiseSuppression: processing.noiseSuppression,
    autoGainControl: processing.autoGainControl,
  };
}

async function getAudioTrack(
  source: string,
  processing: AudioProcessing,
): Promise<MediaStreamTrack | null> {
  if (source === NONE) return null;
  if (source === SCREEN) {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    s.getVideoTracks().forEach((t) => t.stop());
    return s.getAudioTracks()[0] ?? null;
  }
  const proc = audioConstraints(processing);
  const constraint: MediaTrackConstraints =
    source === MICROPHONE ? { ...proc } : { deviceId: { exact: source }, ...proc };
  const s = await navigator.mediaDevices.getUserMedia({ audio: constraint });
  return s.getAudioTracks()[0] ?? null;
}

export async function startPublishing(opts: PublishOptions): Promise<PublishHandle> {
  const status = (s: PublishStatus) => opts.onStatus?.(s);
  const audioCodec = AUDIO_CODECS[opts.audioCodec ?? "aac-raw"];
  const videoCodecKind = opts.videoCodec ?? "avc1";
  const includeDescription = opts.includeDescription ?? true;
  const audioIncludeDescription = opts.audioIncludeDescription ?? true;
  const videoContainer = opts.videoContainer ?? "cmaf";
  // Whether to advertise the avc1 avcC config out-of-band (hang `description`,
  // legacy MSF `initData`). CMAF still always builds its mandatory init segment.
  const advertiseConfig = videoCodecKind === "avc1" && includeDescription;
  const audioContainer = opts.audioContainer ?? "cmaf";
  const reanchorTimestamps = opts.reanchorTimestamps ?? false;
  const keyframeIntervalUs = opts.keyframeIntervalUs ?? KEYFRAME_INTERVAL_US;
  // When enabled, buffer each complete GOP and publish it as a single burst (one
  // group written all at once) instead of streaming frames live as they encode.
  // Independent of the keyframe interval. Defaults to false (stream live).
  const bufferByGroup = opts.burstGroups ?? false;
  // Target audio group duration (ms). Undefined => one group per audio frame.
  // The per-frame count is derived lazily from the first chunk's duration.
  const audioGroupSizeMs = opts.audioGroupSizeMs;
  const bufferAudioByGroup = opts.burstAudioGroups ?? false;

  // ---- 1. Capture ---------------------------------------------------------
  const videoConstraints: MediaTrackConstraints = {};
  if (opts.width !== undefined) videoConstraints.width = { ideal: opts.width };
  if (opts.height !== undefined) videoConstraints.height = { ideal: opts.height };
  if (opts.framerate !== undefined) videoConstraints.frameRate = { ideal: opts.framerate };
  const video: MediaTrackConstraints | boolean = Object.keys(videoConstraints).length
    ? videoConstraints
    : true;

  let videoTrackIn: MediaStreamTrack | undefined;
  let audioTrackIn: MediaStreamTrack | undefined;
  if (opts.source === "none") {
    // Audio-only broadcast: skip video capture entirely.
    audioTrackIn = (await getAudioTrack(opts.audioSource, opts.audioProcessing)) ?? undefined;
  } else if (opts.source === "screen" && opts.audioSource === SCREEN) {
    // Combined screen path: one getDisplayMedia prompt yields both tracks,
    // avoiding a second screen-share prompt for screen audio.
    const s = await navigator.mediaDevices.getDisplayMedia({ video, audio: true });
    videoTrackIn = s.getVideoTracks()[0];
    audioTrackIn = s.getAudioTracks()[0];
  } else {
    const [vTrack, aTrack] = await Promise.all([
      opts.source === "screen"
        ? navigator.mediaDevices.getDisplayMedia({ video }).then((s) => s.getVideoTracks()[0])
        : navigator.mediaDevices.getUserMedia({ video }).then((s) => s.getVideoTracks()[0]),
      getAudioTrack(opts.audioSource, opts.audioProcessing),
    ]);
    videoTrackIn = vTrack;
    audioTrackIn = aTrack ?? undefined;
  }

  // Naturally false when audioSource === NONE (getAudioTrack returns null), or
  // when the chosen source yielded no audio track.
  const audioEnabled = !!audioTrackIn;
  const videoEnabled = !!videoTrackIn;
  if (!videoEnabled && !audioEnabled) {
    throw new Error("No media captured. Select a video source, an audio source, or both.");
  }
  if (videoTrackIn && opts.contentHint) videoTrackIn.contentHint = opts.contentHint;

  // Held tracks, used for preview and cleanup (they may come from separate
  // source streams).
  const previewStream = new MediaStream();
  if (videoTrackIn) previewStream.addTrack(videoTrackIn);
  if (audioTrackIn) previewStream.addTrack(audioTrackIn);

  if (audioEnabled) {
    const support = await AudioEncoder.isConfigSupported({
      codec: audioCodec,
      sampleRate: 48000,
      numberOfChannels: 2,
      bitrate: opts.audioBitrate ?? AUDIO_BITRATE,
    });
    if (!support.supported) {
      previewStream.getTracks().forEach((t) => t.stop());
      throw new Error(
        `Audio encoding (${audioCodec}) is not supported in this browser. Use Chrome, or disable audio.`,
      );
    }
  }

  // ---- 2. Shared state ----------------------------------------------------
  let stopped = false;
  let fatal: Error | null = null;

  // Per-track output handles, set when a subscriber requests them.
  let videoOut: Net.Track | null = null;
  let audioOut: Net.Track | null = null;
  let videoGroup: Net.Group | null = null;
  // Buffered, container-encoded frames of the in-progress GOP (bufferByGroup
  // mode only). Always starts with a keyframe; flushed as one group when the
  // next keyframe closes the GOP.
  let pendingGroupFrames: Uint8Array[] = [];
  // Audio grouping (audioGroupSizeMs mode only). `audioGroup` is the open group
  // being filled; `audioGroupFrames` counts frames written into it;
  // `pendingAudioGroupFrames` buffers a whole group for burst mode.
  let audioGroup: Net.Group | null = null;
  let audioGroupFrames = 0;
  let pendingAudioGroupFrames: Uint8Array[] = [];
  // Frames per audio group, derived once from the group size and the encoder's
  // per-frame duration. 0 until the first chunk with a known duration arrives.
  let audioFramesPerGroup = 0;
  let videoLocProducer: Loc.Producer | null = null;
  let audioLocProducer: Loc.Producer | null = null;
  let videoLocStarted = false; // gate: drop inter-frames until first keyframe reaches producer

  let videoSeq = 0;
  let audioSeq = 0;
  let framesEncoded = 0;

  let firstVideoTsUs: number | null = null;
  let firstAudioTsUs: number | null = null;

  // Reanchor a raw WebCodecs timestamp by subtracting that track's OWN first
  // timestamp, so each track independently starts at ~0. The audio and video
  // capture clocks have divergent absolute origins (e.g. audio ~22s while video
  // ~17000s for the same wall-clock moment), so per-track zeroing is what lets
  // two co-captured samples land on the same number. Always >= 0 (a chunk's ts
  // is >= its own track's first ts). No-op when the toggle is off.
  const reanchor = (rawUs: number, kind: "video" | "audio"): number => {
    if (!reanchorTimestamps) return rawUs;
    if (kind === "video") {
      firstVideoTsUs ??= rawUs;
      return rawUs - firstVideoTsUs;
    }
    firstAudioTsUs ??= rawUs;
    return rawUs - firstAudioTsUs;
  };

  // Init-segment + dimension/format info, filled in from the first chunks.
  let videoInitB64: string | null = null;
  // Base64 avcC decoder config, used as the legacy-container MSF `initData` for
  // avc1 (CMAF carries the avcC inside its full MP4 init segment instead).
  let videoConfigB64: string | null = null;
  let audioInitB64: string | null = null;
  let videoDescHex: string | null = null;
  let audioDescHex: string | null = null;
  let videoCatalogReady = false;
  let audioCatalogReady = false;
  let videoW = 0;
  let videoH = 0;
  let videoCodec = VIDEO_CODEC;
  let audioSampleRate = 48000;
  let audioChannels = 2;

  let catalog: CatalogRoot | null = null;
  let msfCatalog: Msf.Catalog | null = null;
  let resolveCatalogReady!: () => void;
  const catalogReady = new Promise<void>((r) => (resolveCatalogReady = r));

  // When a (new) video subscriber arrives we want a keyframe ASAP so playback
  // can start without waiting up to KEYFRAME_INTERVAL_US.
  let forceKeyframe = true;
  let lastKeyframeUs = -1;

  const fail = (err: unknown) => {
    if (fatal) return;
    fatal = err instanceof Error ? err : new Error(String(err));
    status({ state: "error", message: fatal.message });
    void handle.stop();
  };

  const maybeBuildCatalog = () => {
    if (catalog) return;
    if (videoEnabled && !videoCatalogReady) return;
    if (audioEnabled && !audioCatalogReady) return;

    const root: CatalogRoot = {};
    if (videoEnabled) {
      root.video = {
        renditions: {
          [TRACK_VIDEO]: {
            codec: videoCodec,
            container:
              videoContainer === "cmaf"
                ? { kind: "cmaf", init: videoInitB64!, timescale: Cmaf.TIMESCALE, trackId: Cmaf.TRACK_ID }
                : videoContainer === "loc"
                  ? { kind: "loc" }
                  : { kind: "legacy" },
            codedWidth: videoW,
            codedHeight: videoH,
            framerate: FRAMERATE,
            bitrate: VIDEO_BITRATE,
            // avc1 advertises its avcC config out-of-band (any container) when
            // enabled; annexb keeps SPS/PPS in-band, so never a description.
            description: advertiseConfig ? (videoDescHex ?? undefined) : undefined,
          },
        },
      };
    }

    if (audioEnabled) {
      root.audio = {
        renditions: {
          [TRACK_AUDIO]: {
            codec: audioCodec,
            container:
              audioContainer === "cmaf"
                ? { kind: "cmaf", init: audioInitB64!, timescale: Cmaf.TIMESCALE, trackId: Cmaf.TRACK_ID }
                : audioContainer === "loc"
                  ? { kind: "loc" }
                  : { kind: "legacy" },
            sampleRate: audioSampleRate,
            numberOfChannels: audioChannels,
            bitrate: AUDIO_BITRATE,
            description: audioDescHex ?? undefined,
          },
        },
      };
    }

    // MSF catalog: the same track data as the hang catalog above, but as a flat
    // `tracks[]` array. For CMAF the init segment (videoInitB64/audioInitB64) is
    // the `initData`; legacy carries no init data in either catalog.
    const msfTracks: Msf.Track[] = [];
    if (videoEnabled) {
      msfTracks.push({
        name: TRACK_VIDEO,
        packaging: videoContainer,
        isLive: true,
        role: "video",
        codec: videoCodec,
        width: videoW,
        height: videoH,
        framerate: FRAMERATE,
        bitrate: VIDEO_BITRATE,
        // CMAF's init segment is mandatory (it carries the avcC); legacy carries
        // the raw avcC only when the description is enabled. annexb: in-band.
        initData:
          videoContainer === "cmaf"
            ? (videoCodecKind !== "annexb" ? videoInitB64! : undefined)
            : advertiseConfig
              ? (videoConfigB64 ?? undefined)
              : undefined,
      });
    }
    if (audioEnabled) {
      msfTracks.push({
        name: TRACK_AUDIO,
        packaging: audioContainer,
        isLive: true,
        role: "audio",
        codec: audioCodec,
        samplerate: audioSampleRate,
        channelConfig: String(audioChannels),
        bitrate: AUDIO_BITRATE,
        initData: audioContainer === "cmaf" ? audioInitB64! : undefined,
      });
    }

    catalog = root;
    msfCatalog = { version: 1, tracks: msfTracks };
    resolveCatalogReady();
  };

  // ---- 3. Encoders --------------------------------------------------------
  const videoEncoder = videoEnabled ? new VideoEncoder({
    output: (chunk, meta) => {
      try {
        if (!videoCatalogReady) {
          const dc = meta?.decoderConfig;
          videoW = dc?.codedWidth ?? videoW;
          videoH = dc?.codedHeight ?? videoH;
          // We need the avcC config when CMAF must build its mandatory init
          // segment, or when avc1 is advertising the config out-of-band. Both
          // arrive on the first keyframe's metadata, so wait for it.
          if (videoCodecKind === "vp8" && videoContainer === "cmaf") {
            // VP8 is self-describing (no decoderConfig.description). The CMAF
            // init segment is built from dimensions alone; the vpcC config box
            // lives inside it. Nothing to wait for.
            videoInitB64 = Cmaf.videoInitBase64Vp8({ codedWidth: videoW, codedHeight: videoH });
            videoCatalogReady = true;
            maybeBuildCatalog();
          } else if (videoCodecKind === "vp9" && videoContainer === "cmaf") {
            // VP9 is self-describing (no decoderConfig.description). The CMAF
            // init segment is built from dimensions alone; the vpcC config box
            // lives inside it. Nothing to wait for.
            videoInitB64 = Cmaf.videoInitBase64Vp9({ codedWidth: videoW, codedHeight: videoH });
            videoCatalogReady = true;
            maybeBuildCatalog();
          } else if (videoCodecKind === "avc1" && (videoContainer === "cmaf" || advertiseConfig)) {
            // avc1 signals SPS/PPS out-of-band via the avcC decoder config.
            // Capture it so the catalog can advertise it (hex in hang
            // `description`, base64 in legacy MSF `initData`). CMAF additionally
            // wraps the avcC in a full MP4 init segment.
            const desc = dc?.description;
            if (desc) {
              const avcC = Cmaf.toUint8(desc);
              videoDescHex = Cmaf.bytesToHex(avcC);
              videoConfigB64 = Cmaf.bytesToBase64(avcC);
              if (videoContainer === "cmaf") {
                videoInitB64 = Cmaf.videoInitBase64({ codedWidth: videoW, codedHeight: videoH, avcC });
              }
              videoCatalogReady = true;
              maybeBuildCatalog();
            }
            // else: keep waiting for the config before the catalog is valid.
          } else {
            // Annex B (config in-band), or avc1+legacy with the description
            // disabled: nothing to wait for, publish the catalog immediately.
            videoCatalogReady = true;
            maybeBuildCatalog();
          }
        }
        writeVideoChunk(chunk);
      } catch (e) {
        fail(e);
      }
    },
    error: fail,
  }) : null;

  const audioEncoder = audioEnabled
    ? new AudioEncoder({
      output: (chunk, meta) => {
        try {
          if (audioContainer === "cmaf") {
            if (!audioInitB64) {
              const desc = meta?.decoderConfig?.description;
              // Opus needs the WebCodecs OpusHead converted to dOps layout; AAC's
              // AudioSpecificConfig passes through unchanged (see helper). The init
              // segment always carries the ASC; whether it's also advertised in the
              // catalog `description` is gated below.
              const asc = desc ? audioDescriptionForCmaf(Cmaf.toUint8(desc), opts.audioCodec) : undefined;
              if (asc) {
                // opus: always advertise dOps (redundant with init). aac-raw: only
                // when the audio toggle is on. aac-adts never reaches here (blocked
                // upstream), but defensively leave the description null.
                if (opts.audioCodec === "opus" || (opts.audioCodec === "aac-raw" && audioIncludeDescription)) {
                  audioDescHex = Cmaf.bytesToHex(asc);
                }
              }
              audioInitB64 = Cmaf.audioInitBase64({
                codec: audioCodec,
                sampleRate: audioSampleRate,
                numberOfChannels: audioChannels,
                asc,
              });
              audioCatalogReady = true;
              maybeBuildCatalog();
            }
          } else if (!audioCatalogReady) {
            // Legacy: ADTS (AAC) and raw Opus packets are self-describing, so no
            // init segment is needed. For raw AAC, the ASC is advertised
            // out-of-band in the catalog `description` when the toggle is on.
            if (opts.audioCodec === "aac-raw" && audioIncludeDescription) {
              const desc = meta?.decoderConfig?.description;
              if (desc) audioDescHex = Cmaf.bytesToHex(Cmaf.toUint8(desc));
            }
            audioCatalogReady = true;
            maybeBuildCatalog();
          }
          writeAudioChunk(chunk);
        } catch (e) {
          fail(e);
        }
      },
      error: fail,
    })
    : null;

  function writeVideoChunk(chunk: EncodedVideoChunk) {
    const isKey = chunk.type === "key";
    const tsUs = reanchor(chunk.timestamp, "video");

    if (videoContainer === "loc") {
      const p = videoLocProducer;
      if (!p) return;
      if (!isKey && !videoLocStarted) return; // Producer throws on a non-key first frame
      if (isKey) videoLocStarted = true;
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      p.encode(data, tsUs as Time.Micro, isKey);
      return;
    }

    const out = videoOut;
    if (!out || out.state.closed.peek()) return;

    if (bufferByGroup) {
      // A keyframe closes the previous GOP (now complete) and opens a new one.
      if (isKey) flushBufferedGroup(out);
    } else if (isKey) {
      // GOP == group. Close the previous group and open a new one.
      videoGroup?.close();
      videoGroup = out.appendGroup();
    }
    // A group/GOP must start with a keyframe; until we've seen one, drop frames.
    const started = bufferByGroup ? isKey || pendingGroupFrames.length > 0 : videoGroup !== null;
    if (!started) return;

    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const frameBytes =
      videoContainer === "cmaf"
        ? Cmaf.dataSegment({
          data,
          timestampUs: tsUs,
          durationUs: chunk.duration ?? 1_000_000 / FRAMERATE,
          keyframe: isKey,
          sequence: videoSeq++,
        })
        : Legacy.encodeFrame(data, tsUs as Time.Micro);

    if (bufferByGroup) {
      // Accumulate the whole GOP; it is published as one burst when the next
      // keyframe closes it (flushBufferedGroup above).
      pendingGroupFrames.push(frameBytes);
    } else {
      videoGroup!.writeFrame(frameBytes);
    }
  }

  // Publish the buffered GOP as a single group written all at once, then reset
  // the buffer. No-op when nothing is buffered (bufferByGroup mode only).
  function flushBufferedGroup(out: Net.Track) {
    if (pendingGroupFrames.length === 0) return;
    const group = out.appendGroup();
    for (const frame of pendingGroupFrames) group.writeFrame(frame);
    group.close();
    pendingGroupFrames = [];
  }

  function writeAudioChunk(chunk: EncodedAudioChunk) {
    const tsUs = reanchor(chunk.timestamp, "audio");
    if (audioContainer === "loc") {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      audioLocProducer?.encode(data, tsUs as Time.Micro, true);
      return;
    }

    const out = audioOut;
    if (!out || out.state.closed.peek()) return;

    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const frameBytes =
      audioContainer === "cmaf"
        ? Cmaf.dataSegment({
          data,
          timestampUs: tsUs,
          durationUs: chunk.duration ?? 0,
          keyframe: true, // every AAC frame is independently decodable
          sequence: audioSeq++,
        })
        : Legacy.encodeFrame(data, tsUs as Time.Micro);

    // Default (no group size requested): one group per audio frame keeps
    // latency low and the consumer happy.
    if (audioGroupSizeMs === undefined) {
      out.writeFrame(frameBytes);
      return;
    }

    // Group `audioFramesPerGroup` frames into each MoQ group. Derive that count
    // once from the requested group duration and the encoder's per-frame
    // duration (Opus ~20ms, AAC ~21.3ms). We compute the per-frame duration
    // deterministically from the codec and sample rate rather than trusting
    // `chunk.duration`, which Chrome frequently reports as null for encoded
    // audio — a null there would collapse the count to 1, flushing a group per
    // frame and defeating grouping/bursting entirely. `chunk.duration` is only
    // used when it actually carries a positive value.
    if (audioFramesPerGroup === 0) {
      const frameDurUs =
        chunk.duration && chunk.duration > 0
          ? chunk.duration
          : audioFrameDurationUs(opts.audioCodec, audioSampleRate);
      audioFramesPerGroup =
        frameDurUs > 0 ? Math.max(1, Math.round((audioGroupSizeMs * 1000) / frameDurUs)) : 1;
    }

    if (bufferAudioByGroup) {
      // Accumulate the whole group; publish it as one burst once full.
      pendingAudioGroupFrames.push(frameBytes);
      if (pendingAudioGroupFrames.length >= audioFramesPerGroup) flushBufferedAudioGroup(out);
      return;
    }

    // Live: open a group, stream frames into it, close it when it fills up.
    if (!audioGroup || audioGroupFrames >= audioFramesPerGroup) {
      audioGroup?.close();
      audioGroup = out.appendGroup();
      audioGroupFrames = 0;
    }
    audioGroup.writeFrame(frameBytes);
    audioGroupFrames++;
  }

  // Publish the buffered audio group as a single group written all at once, then
  // reset the buffer. No-op when nothing is buffered (burst audio mode only).
  function flushBufferedAudioGroup(out: Net.Track) {
    if (pendingAudioGroupFrames.length === 0) return;
    const group = out.appendGroup();
    for (const frame of pendingAudioGroupFrames) group.writeFrame(frame);
    group.close();
    pendingAudioGroupFrames = [];
  }

  // ---- 4. Capture -> encode loops ----------------------------------------
  const readers: ReadableStreamDefaultReader<VideoFrame | AudioData>[] = [];

  // Honor the requested resolution by scaling each captured frame. The
  // getUserMedia/getDisplayMedia width/height above are only `ideal` hints, and
  // cameras routinely ignore them — a webcam emits its native mode, and a
  // virtual camera (OBS) exposes a single fixed mode — so without an explicit
  // resize the selected resolution would never take effect. We key off the
  // requested height and derive the width from the source aspect ratio so the
  // image is never distorted.
  const targetH = opts.height;
  let scaleCanvas: OffscreenCanvas | null = null;
  let scaleCtx: OffscreenCanvasRenderingContext2D | null = null;
  let scaleW = 0;
  let scaleH = 0;
  const sizeFrame = (frame: VideoFrame): VideoFrame => {
    if (!targetH || frame.codedHeight === 0) return frame;
    if (scaleH === 0) {
      scaleH = targetH % 2 ? targetH + 1 : targetH;
      const w = Math.round((frame.codedWidth * scaleH) / frame.codedHeight);
      scaleW = w % 2 ? w + 1 : w;
    }
    if (frame.codedWidth === scaleW && frame.codedHeight === scaleH) return frame;
    if (!scaleCanvas) {
      scaleCanvas = new OffscreenCanvas(scaleW, scaleH);
      scaleCtx = scaleCanvas.getContext("2d");
    }
    if (!scaleCtx) return frame;
    scaleCtx.drawImage(frame, 0, 0, scaleW, scaleH);
    const resized = new VideoFrame(scaleCanvas, {
      timestamp: frame.timestamp,
      duration: frame.duration ?? undefined,
    });
    frame.close();
    return resized;
  };

  if (videoEnabled && videoTrackIn && videoEncoder) {
    const videoReader = new MediaStreamTrackProcessor<VideoFrame>({ track: videoTrackIn }).readable.getReader();
    readers.push(videoReader);
    void (async () => {
    try {
      for (; ;) {
        const { done, value } = await videoReader.read();
        if (done || stopped) {
          value?.close();
          break;
        }
        const frame = sizeFrame(value);
        try {
          if (videoEncoder.state === "unconfigured") {
            const fps = opts.framerate ?? FRAMERATE;
            videoW = frame.codedWidth;
            videoH = frame.codedHeight;
            videoCodec =
              videoCodecKind === "vp8"
                ? "vp8"
                : videoCodecKind === "vp9"
                  ? vp9CodecString(videoW, videoH, fps)
                  : avcCodecString(videoW, videoH, fps);
            videoEncoder.configure({
              codec: videoCodec,
              width: frame.codedWidth,
              height: frame.codedHeight,
              bitrate: opts.videoBitrate ?? VIDEO_BITRATE,
              framerate: fps,
              latencyMode: "realtime",
              // H.264 selects an avc/annexb bitstream format; VP8/VP9 are
              // self-describing and take no codec-specific option.
              ...(videoCodecKind === "vp8" || videoCodecKind === "vp9"
                ? {}
                : { avc: { format: videoCodecKind === "annexb" ? "annexb" : "avc" } as const }),
            });
          }
          const ts = frame.timestamp;
          const key = forceKeyframe || lastKeyframeUs < 0 || ts - lastKeyframeUs >= keyframeIntervalUs;
          if (key) {
            lastKeyframeUs = ts;
            forceKeyframe = false;
          }
          if (videoEncoder.state === "configured") {
            videoEncoder.encode(frame, { keyFrame: key });
            framesEncoded++;
          }
        } finally {
          frame.close();
        }
      }
    } catch (e) {
      if (!stopped) fail(e);
    }
    })();
  }

  if (audioEnabled && audioTrackIn && audioEncoder) {
    const audioReader = new MediaStreamTrackProcessor<AudioData>({ track: audioTrackIn }).readable.getReader();
    readers.push(audioReader);
    void (async () => {
      try {
        for (; ;) {
          const { done, value } = await audioReader.read();
          if (done || stopped) {
            value?.close();
            break;
          }
          const sample = value;
          try {
            if (audioEncoder.state === "unconfigured") {
              audioSampleRate = sample.sampleRate;
              audioChannels = sample.numberOfChannels;
              audioEncoder.configure({
                codec: audioCodec,
                sampleRate: audioSampleRate,
                numberOfChannels: audioChannels,
                bitrate: opts.audioBitrate ?? AUDIO_BITRATE,
                ...(opts.audioCodec === "aac-adts"
                  ? { aac: { format: "adts" } }
                  : {}),
              });
            }
            if (audioEncoder.state === "configured") {
              audioEncoder.encode(sample);
            }
          } finally {
            sample.close();
          }
        }
      } catch (e) {
        if (!stopped) fail(e);
      }
    })();
  }

  // ---- 5. Connect + publish ----------------------------------------------
  status({ state: "connecting" });

  let conn: Net.Connection.Established;
  let certHashPinned = false;
  try {
    const serverUrl = new URL(opts.serverUrl);
    if (opts.token) serverUrl.searchParams.set("token", opts.token);
    const props: Net.Connection.ConnectProps = {};
    if (!opts.wsFallback) props.websocket = { enabled: false };
    if (opts.certHash) {
      // TESTING ONLY: bypass CA verification by pinning the relay's cert hash.
      // On invalid hex we leave props untouched -> standard TLS verification.
      const certHashes = parseCertHashes(opts.certHash);
      if (certHashes) {
        props.webtransport = { serverCertificateHashes: certHashes };
        certHashPinned = true;
      }
    }
    conn = await Net.Connection.connect(
      serverUrl,
      Object.keys(props).length ? props : undefined,
    );
  } catch (e) {
    previewStream.getTracks().forEach((t) => t.stop());
    if (videoEncoder) closeEncoder(videoEncoder);
    if (audioEncoder) closeEncoder(audioEncoder);
    const err = e instanceof Error ? e : new Error(String(e));
    // `Net.Connection.connect` races transports with `Promise.any`, so a failed
    // handshake surfaces as an AggregateError whose own message is useless ("All
    // promises were rejected"); the real WebTransportError (carrying the QUIC/TLS
    // cert text) is in `.errors`. Flatten it so detection and the surfaced
    // message see the actual cause.
    const detail = errorDetail(err);
    // WebTransport rejects a failed handshake with an opaque error, so spell out
    // the likely cause depending on whether the user pinned a cert hash.
    if (isCertHashError(err)) {
      if (certHashPinned) {
        // A pinned hash that doesn't match the relay's actual certificate.
        throw new Error(
          `Connection failed: the self-signed cert SHA-256 fingerprint does not match the relay's certificate. ` +
          `Re-copy the fingerprint, or clear it to use standard TLS verification. (${detail})`,
          { cause: e },
        );
      }
      // No hash pinned: standard TLS verification failed. Most often the relay
      // uses a self-signed certificate the browser won't trust.
      throw new Error(
        `Connection failed: TLS verification failed. If the relay uses a self-signed certificate, ` +
        `paste its SHA-256 fingerprint into the cert field. (${detail})`,
        { cause: e },
      );
    }
    throw new Error(`Connection failed: ${detail}`, { cause: e });
  }

  const broadcast = new Net.Broadcast();
  conn.publish(Net.Path.from(opts.broadcastPath), broadcast);
  status({ state: "publishing" });

  // ---- 6. Serve loop (pull-based) ----------------------------------------
  // Both catalog tracks are pull-based: await the single catalogReady promise,
  // then encode the requested flavor. `encodeBytes` is only called after the
  // catalog state is populated, so its (non-null) reads are safe.
  const serveCatalogTrack = (track: Net.Track, encodeBytes: () => Uint8Array) => {
    void (async () => {
      try {
        await catalogReady;
        if (stopped || track.state.closed.peek() || !catalog || !msfCatalog) return;
        track.writeFrame(encodeBytes());
      } catch (e) {
        if (!stopped) fail(e);
      }
    })();
  };

  const serveCatalog = (track: Net.Track) =>
    serveCatalogTrack(track, () => Catalog.encode(catalog as unknown as Catalog.Root));

  const serveMsfCatalog = (track: Net.Track) =>
    serveCatalogTrack(track, () => Msf.encode(msfCatalog!));

  void (async () => {
    try {
      for (; ;) {
        const req = await broadcast.requested();
        if (!req || stopped) break;
        const track = req.track;
        switch (track.name) {
          case TRACK_CATALOG:
            serveCatalog(track);
            break;
          case TRACK_CATALOG_MSF:
            serveMsfCatalog(track);
            break;
          case TRACK_VIDEO:
            if (!videoEnabled) {
              track.close(new Error("video not published"));
              break;
            }
            if (videoContainer === "loc") {
              videoLocProducer = new Loc.Producer(track);
              videoLocStarted = false;
              forceKeyframe = true;
              track.closed.then(() => {
                // The remote closed the track; don't call producer.close() here.
                if (videoLocProducer) videoLocProducer = null;
              });
              break;
            }
            videoOut = track;
            videoGroup = null;
            pendingGroupFrames = [];
            forceKeyframe = true;
            track.closed.then(() => {
              if (videoOut === track) {
                videoOut = null;
                videoGroup = null;
              }
            });
            break;
          case TRACK_AUDIO:
            if (!audioEnabled) {
              track.close(new Error("audio not published"));
              break;
            }
            if (audioContainer === "loc") {
              audioLocProducer = new Loc.Producer(track);
              track.closed.then(() => {
                if (audioLocProducer) audioLocProducer = null;
              });
              break;
            }
            audioOut = track;
            audioGroup = null;
            audioGroupFrames = 0;
            pendingAudioGroupFrames = [];
            track.closed.then(() => {
              if (audioOut === track) {
                audioOut = null;
                audioGroup = null;
              }
            });
            break;
          default:
            track.close(new Error(`unknown track: ${track.name}`));
            break;
        }
      }
    } catch (e) {
      if (!stopped) fail(e);
    }
  })();

  // ---- 7. fps reporting ---------------------------------------------------
  let lastCount = 0;
  const fpsTimer = setInterval(() => {
    if (stopped) return;
    if (!videoEnabled) {
      // Audio-only: no frame counter to report.
      status({ state: "publishing" });
      return;
    }
    const fps = framesEncoded - lastCount;
    lastCount = framesEncoded;
    status({ state: "publishing", fps });
  }, 1000);

  // ---- 8. Handle / cleanup ------------------------------------------------
  const handle: PublishHandle = {
    stream: previewStream,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(fpsTimer);

      for (const r of readers) {
        try {
          await r.cancel();
        } catch {
          // reader may already be closed
        }
      }

      if (videoEncoder) closeEncoder(videoEncoder);
      if (audioEncoder) closeEncoder(audioEncoder);

      try {
        videoGroup?.close();
        audioGroup?.close();
      } catch {
        /* ignore */
      }
      try {
        videoLocProducer?.close();
        audioLocProducer?.close();
      } catch {
        /* ignore */
      }
      videoLocProducer = null;
      audioLocProducer = null;

      previewStream.getTracks().forEach((t) => t.stop());

      try {
        broadcast.close();
      } catch {
        /* ignore */
      }
      try {
        conn.close();
      } catch {
        /* ignore */
      }

      if (!fatal) status({ state: "stopped" });
    },
  };

  return handle;
}

// "OpusHead" magic signature: the 8 leading bytes of the Ogg-style Opus
// identification header that WebCodecs reports as the decoder description.
const OPUS_HEAD_MAGIC = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64];

/**
 * Adapt the WebCodecs audio decoder description into what the CMAF builder's
 * dOps box expects for Opus, leaving AAC untouched.
 *
 * WebCodecs hands Opus back an Ogg-style OpusHead: an 8-byte "OpusHead" magic,
 * then a body that begins with OpusHead version `1` and stores PreSkip /
 * InputSampleRate / OutputGain little-endian. The ISO-BMFF dOps box instead
 * wants Version `0` and those fields big-endian (and no magic). `createDOpsBox`
 * embeds whatever bytes we pass verbatim, so we convert here; otherwise the
 * parser trips on "unknown version: 1". If the description isn't a recognizable
 * OpusHead we return undefined and let the builder synthesize a valid dOps.
 */
function audioDescriptionForCmaf(
  desc: Uint8Array,
  codec: AudioCodec | undefined,
): Uint8Array | undefined {
  if (codec !== "opus") return desc;
  const HEAD = OPUS_HEAD_MAGIC.length;
  // magic + version + channels + preSkip(2) + sampleRate(4) + gain(2) + family(1)
  if (desc.length < HEAD + 11) return undefined;
  if (!OPUS_HEAD_MAGIC.every((b, i) => desc[i] === b)) return undefined;
  const body = desc.subarray(HEAD);
  const out = new Uint8Array(body); // copy; channelMappingFamily + table copied as-is
  out[0] = 0; // dOps Version (OpusHead's is 1)
  out[2] = body[3]; // PreSkip: LE -> BE
  out[3] = body[2];
  out[4] = body[7]; // InputSampleRate: LE -> BE
  out[5] = body[6];
  out[6] = body[5];
  out[7] = body[4];
  out[8] = body[9]; // OutputGain: LE -> BE
  out[9] = body[8];
  return out;
}

/**
 * Deterministic encoded-frame duration (µs) per audio codec, used to size audio
 * groups when the encoder omits `chunk.duration` (Chrome frequently reports it
 * as null for encoded audio). Opus emits fixed 20 ms frames; AAC-LC emits 1024
 * samples per frame, so its duration depends on the sample rate.
 */
function audioFrameDurationUs(codec: AudioCodec | undefined, sampleRate: number): number {
  if (codec === "opus") return 20_000;
  // AAC-LC (aac-raw / aac-adts): 1024 samples per frame.
  return sampleRate > 0 ? Math.round((1024 / sampleRate) * 1_000_000) : 0;
}

function closeEncoder(encoder: VideoEncoder | AudioEncoder) {
  try {
    if (encoder.state !== "closed") encoder.close();
  } catch {
    /* ignore */
  }
}

/**
 * Flattens an error (including the `AggregateError` that `Promise.any` throws)
 * into the list of every contributing Error, so callers can inspect the real
 * underlying causes rather than the wrapper's generic message.
 */
function flattenErrors(err: Error): Error[] {
  const out: Error[] = [err];
  // `AggregateError.errors` (set by Promise.any); typed structurally since the
  // configured TS lib may not declare AggregateError.
  const nested = (err as { errors?: unknown }).errors;
  if (Array.isArray(nested)) {
    for (const e of nested) {
      if (e instanceof Error) out.push(...flattenErrors(e));
    }
  }
  return out;
}

/**
 * Builds a human-readable detail string from a (possibly aggregate) connection
 * error, preferring the underlying cause messages over the wrapper's useless
 * "All promises were rejected".
 */
function errorDetail(err: Error): string {
  const messages = flattenErrors(err)
    .map((e) => e.message)
    .filter((m) => m && m !== "All promises were rejected");
  return messages.length ? [...new Set(messages)].join("; ") : err.message;
}

/**
 * Heuristic: does this connection failure look like a certificate / TLS failure
 * rather than a generic network error? WebTransport rejects a bad cert (or a
 * mismatched `serverCertificateHashes` pin) with a `WebTransportError` whose
 * message mentions the QUIC TLS handshake (e.g. `ERR_QUIC_PROTOCOL_ERROR.
 * QUIC_TLS_CERTIFICATE_UNKNOWN ... CERTIFICATE_VERIFY_FAILED`). We unwrap
 * `Promise.any`'s AggregateError and match on the error type or that text.
 */
function isCertHashError(err: Error): boolean {
  const errors = flattenErrors(err);
  if (typeof WebTransportError !== "undefined" && errors.some((e) => e instanceof WebTransportError)) {
    return true;
  }
  return errors.some((e) => /cert|certificate|hash|fingerprint|handshake|tls/i.test(e.message));
}

/**
 * TESTING ONLY. Parses the relay's self-signed cert sha-256 fingerprint from a
 * raw hex string and returns it as a `serverCertificateHashes` entry. Pinning
 * the hash makes WebTransport skip CA-chain verification for that cert. Returns
 * undefined if the hex is invalid (so connect falls back to normal verification
 * rather than silently failing).
 */
function parseCertHashes(hash: string): Net.Connection.CertificateHash[] | undefined {
  const hex = hash.trim().replace(/[:\s]/g, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return undefined;
  const value = new Uint8Array(new ArrayBuffer(32));
  for (let i = 0; i < 32; i++) {
    value[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return [{ algorithm: "sha-256", value }];
}
