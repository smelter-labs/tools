// Hand-rolled MoQ publisher: capture -> WebCodecs encode -> CMAF fragment ->
// @moq/net track publish. We avoid the high-level @moq/publish API because it
// hardcodes a "legacy" container; we require H264 + CMAF. Audio codec is
// selectable (AAC or Opus); the container is always CMAF.
//
// Publish model (confirmed in @moq/net broadcast.js + the @moq/publish serve
// loop in screen-CAGDqnB8.js:1576): it is PULL-based. We create a Broadcast,
// call conn.publish(path, broadcast), then loop broadcast.requested() and serve
// the track matching each subscription by name.
import * as Net from "@moq/net";
import * as Catalog from "@moq/hang/catalog";
import * as Cmaf from "./cmaf";

export type SourceKind = "camera" | "screen";

export type AudioCodec = "aac" | "opus";

// Maps each selectable audio codec to the single codec string that drives both
// WebCodecs (AudioEncoder.configure / isConfigSupported) and the CMAF init
// segment + catalog rendition.
const AUDIO_CODECS: Record<AudioCodec, string> = {
  aac: "mp4a.40.2", // AAC-LC
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
interface CmafContainer {
  kind: "cmaf";
  init: string;
  timescale: number;
  trackId: number;
}
interface CatalogRoot {
  video: {
    renditions: Record<
      string,
      {
        codec: string;
        container: CmafContainer;
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
        container: CmafContainer;
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
  source: SourceKind;
  /** Audio source: NONE / SCREEN / MICROPHONE sentinel, or a concrete device id. */
  audioSource: string;
  audioProcessing: AudioProcessing;
  /** Audio codec to encode/publish. Defaults to `"aac"` when unset. */
  audioCodec?: AudioCodec;
  wsFallback: boolean;
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
  const audioCodec = AUDIO_CODECS[opts.audioCodec ?? "aac"];

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
  if (opts.source === "screen" && opts.audioSource === SCREEN) {
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

  if (!videoTrackIn) {
    audioTrackIn?.stop();
    throw new Error("No video track captured.");
  }
  if (opts.contentHint) videoTrackIn.contentHint = opts.contentHint;
  // Naturally false when audioSource === NONE (getAudioTrack returns null), or
  // when the chosen source yielded no audio track.
  const audioEnabled = !!audioTrackIn;

  // Held tracks, used for preview and cleanup (they may come from separate
  // source streams).
  const previewStream = new MediaStream();
  previewStream.addTrack(videoTrackIn);
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

  let videoSeq = 0;
  let audioSeq = 0;
  let framesEncoded = 0;

  // Init-segment + dimension/format info, filled in from the first chunks.
  let videoInitB64: string | null = null;
  let audioInitB64: string | null = null;
  let videoDescHex: string | null = null;
  let audioDescHex: string | null = null;
  let videoW = 0;
  let videoH = 0;
  let videoCodec = VIDEO_CODEC;
  let audioSampleRate = 48000;
  let audioChannels = 2;

  let catalog: CatalogRoot | null = null;
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
    if (!videoInitB64) return;
    if (audioEnabled && !audioInitB64) return;

    const root: CatalogRoot = {
      video: {
        renditions: {
          [TRACK_VIDEO]: {
            codec: videoCodec,
            container: { kind: "cmaf", init: videoInitB64, timescale: Cmaf.TIMESCALE, trackId: Cmaf.TRACK_ID },
            codedWidth: videoW,
            codedHeight: videoH,
            framerate: FRAMERATE,
            bitrate: VIDEO_BITRATE,
            description: videoDescHex ?? undefined,
          },
        },
      },
    };

    if (audioEnabled && audioInitB64) {
      root.audio = {
        renditions: {
          [TRACK_AUDIO]: {
            codec: audioCodec,
            container: { kind: "cmaf", init: audioInitB64, timescale: Cmaf.TIMESCALE, trackId: Cmaf.TRACK_ID },
            sampleRate: audioSampleRate,
            numberOfChannels: audioChannels,
            bitrate: AUDIO_BITRATE,
            description: audioDescHex ?? undefined,
          },
        },
      };
    }

    catalog = root;
    resolveCatalogReady();
  };

  // ---- 3. Encoders --------------------------------------------------------
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      try {
        const desc = meta?.decoderConfig?.description;
        if (desc && !videoInitB64) {
          const avcC = Cmaf.toUint8(desc);
          videoDescHex = Cmaf.bytesToHex(avcC);
          videoW = meta?.decoderConfig?.codedWidth ?? videoW;
          videoH = meta?.decoderConfig?.codedHeight ?? videoH;
          videoInitB64 = Cmaf.videoInitBase64({ codedWidth: videoW, codedHeight: videoH, avcC });
          maybeBuildCatalog();
        }
        writeVideoChunk(chunk);
      } catch (e) {
        fail(e);
      }
    },
    error: fail,
  });

  const audioEncoder = audioEnabled
    ? new AudioEncoder({
      output: (chunk, meta) => {
        try {
          if (!audioInitB64) {
            const desc = meta?.decoderConfig?.description;
            // Opus needs the WebCodecs OpusHead converted to dOps layout; AAC's
            // AudioSpecificConfig passes through unchanged (see helper).
            const asc = desc ? audioDescriptionForCmaf(Cmaf.toUint8(desc), opts.audioCodec) : undefined;
            if (asc) audioDescHex = Cmaf.bytesToHex(asc);
            audioInitB64 = Cmaf.audioInitBase64({
              codec: audioCodec,
              sampleRate: audioSampleRate,
              numberOfChannels: audioChannels,
              asc,
            });
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
    const out = videoOut;
    if (!out || out.state.closed.peek()) return;

    const isKey = chunk.type === "key";
    if (isKey) {
      // GOP == group. Close the previous group and open a new one.
      videoGroup?.close();
      videoGroup = out.appendGroup();
    }
    // A group must start with a keyframe; until we've seen one, drop frames.
    if (!videoGroup) return;

    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const seg = Cmaf.dataSegment({
      data,
      timestampUs: chunk.timestamp,
      durationUs: chunk.duration ?? 1_000_000 / FRAMERATE,
      keyframe: isKey,
      sequence: videoSeq++,
    });
    videoGroup.writeFrame(seg);
  }

  function writeAudioChunk(chunk: EncodedAudioChunk) {
    const out = audioOut;
    if (!out || out.state.closed.peek()) return;

    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const seg = Cmaf.dataSegment({
      data,
      timestampUs: chunk.timestamp,
      durationUs: chunk.duration ?? 0,
      keyframe: true, // every AAC frame is independently decodable
      sequence: audioSeq++,
    });
    // One group per audio frame keeps latency low and the consumer happy.
    out.writeFrame(seg);
  }

  // ---- 4. Capture -> encode loops ----------------------------------------
  const videoReader = new MediaStreamTrackProcessor<VideoFrame>({ track: videoTrackIn }).readable.getReader();
  const readers: ReadableStreamDefaultReader<VideoFrame | AudioData>[] = [videoReader];

  void (async () => {
    try {
      for (; ;) {
        const { done, value } = await videoReader.read();
        if (done || stopped) {
          value?.close();
          break;
        }
        const frame = value;
        try {
          if (videoEncoder.state === "unconfigured") {
            const fps = opts.framerate ?? FRAMERATE;
            videoW = frame.codedWidth;
            videoH = frame.codedHeight;
            videoCodec = avcCodecString(videoW, videoH, fps);
            videoEncoder.configure({
              codec: videoCodec,
              width: frame.codedWidth,
              height: frame.codedHeight,
              bitrate: opts.videoBitrate ?? VIDEO_BITRATE,
              framerate: fps,
              latencyMode: "realtime",
              avc: { format: "avc" },
            });
          }
          const ts = frame.timestamp;
          const key = forceKeyframe || lastKeyframeUs < 0 || ts - lastKeyframeUs >= KEYFRAME_INTERVAL_US;
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
    closeEncoder(videoEncoder);
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
        );
      }
      // No hash pinned: standard TLS verification failed. Most often the relay
      // uses a self-signed certificate the browser won't trust.
      throw new Error(
        `Connection failed: TLS verification failed. If the relay uses a self-signed certificate, ` +
        `paste its SHA-256 fingerprint into the cert field. (${detail})`,
      );
    }
    throw new Error(`Connection failed: ${detail}`);
  }

  const broadcast = new Net.Broadcast();
  conn.publish(Net.Path.from(opts.broadcastPath), broadcast);
  status({ state: "publishing" });

  // ---- 6. Serve loop (pull-based) ----------------------------------------
  const serveCatalog = (track: Net.Track) => {
    void (async () => {
      try {
        await catalogReady;
        if (stopped || track.state.closed.peek() || !catalog) return;
        track.writeFrame(Catalog.encode(catalog as unknown as Catalog.Root));
      } catch (e) {
        if (!stopped) fail(e);
      }
    })();
  };

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
          case TRACK_VIDEO:
            videoOut = track;
            videoGroup = null;
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
            audioOut = track;
            track.closed.then(() => {
              if (audioOut === track) audioOut = null;
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

      closeEncoder(videoEncoder);
      if (audioEncoder) closeEncoder(audioEncoder);

      try {
        videoGroup?.close();
      } catch {
        /* ignore */
      }

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
function parseCertHashes(hash: string): WebTransportHash[] | undefined {
  const hex = hash.trim().replace(/[:\s]/g, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return undefined;
  const value = new Uint8Array(new ArrayBuffer(32));
  for (let i = 0; i < 32; i++) {
    value[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return [{ algorithm: "sha-256", value }];
}
