// Hand-rolled MoQ publisher: capture -> WebCodecs encode -> CMAF fragment ->
// @moq/net track publish. We avoid the high-level @moq/publish API because it
// hardcodes Opus audio and a "legacy" container; we require H264 + AAC + CMAF.
//
// Publish model (confirmed in @moq/net broadcast.js + the @moq/publish serve
// loop in screen-CAGDqnB8.js:1576): it is PULL-based. We create a Broadcast,
// call conn.publish(path, broadcast), then loop broadcast.requested() and serve
// the track matching each subscription by name.
import * as Net from "@moq/net";
import * as Catalog from "@moq/hang/catalog";
import * as Cmaf from "./cmaf";

export type SourceKind = "camera" | "screen";

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
  audio: boolean;
  wsFallback: boolean;
  /**
   * TESTING ONLY. Disables TLS CA verification by pinning the relay's
   * self-signed cert via `serverCertificateHashes`. Fetches the sha-256
   * fingerprint from the relay's `/certificate.sha256` endpoint. Browser
   * WebTransport has no global "reject unauthorized = false" — this is the
   * only supported way to accept an untrusted cert. NEVER use in production.
   */
  insecure?: boolean;
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
const AUDIO_CODEC = "mp4a.40.2"; // AAC-LC
const VIDEO_BITRATE = 5_000_000;
const AUDIO_BITRATE = 128_000;
const FRAMERATE = 30;
const KEYFRAME_INTERVAL_US = 2_000_000; // keyframe every ~2s

export async function startPublishing(opts: PublishOptions): Promise<PublishHandle> {
  const status = (s: PublishStatus) => opts.onStatus?.(s);

  // ---- 1. Capture ---------------------------------------------------------
  const constraints: MediaStreamConstraints = { video: true, audio: opts.audio };
  const stream =
    opts.source === "screen"
      ? await navigator.mediaDevices.getDisplayMedia(constraints)
      : await navigator.mediaDevices.getUserMedia(constraints);

  const videoTrackIn = stream.getVideoTracks()[0];
  const audioTrackIn = opts.audio ? stream.getAudioTracks()[0] : undefined;
  // If the user asked for audio but the source has none (e.g. screenshare
  // without audio), treat audio as disabled so the catalog stays consistent.
  const audioEnabled = !!audioTrackIn;

  if (audioEnabled) {
    const support = await AudioEncoder.isConfigSupported({
      codec: AUDIO_CODEC,
      sampleRate: 48000,
      numberOfChannels: 2,
      bitrate: AUDIO_BITRATE,
    });
    if (!support.supported) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error(
        "AAC encoding (mp4a.40.2) is not supported in this browser. Use Chrome, or disable audio.",
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
            codec: AUDIO_CODEC,
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
            const asc = desc ? Cmaf.toUint8(desc) : undefined;
            if (asc) audioDescHex = Cmaf.bytesToHex(asc);
            audioInitB64 = Cmaf.audioInitBase64({
              codec: AUDIO_CODEC,
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
            videoW = frame.codedWidth;
            videoH = frame.codedHeight;
            videoCodec = avcCodecString(videoW, videoH, FRAMERATE);
            videoEncoder.configure({
              codec: videoCodec,
              width: frame.codedWidth,
              height: frame.codedHeight,
              bitrate: VIDEO_BITRATE,
              framerate: FRAMERATE,
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
                codec: AUDIO_CODEC,
                sampleRate: audioSampleRate,
                numberOfChannels: audioChannels,
                bitrate: AUDIO_BITRATE,
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
  try {
    const serverUrl = new URL(opts.serverUrl);
    const props: Net.Connection.ConnectProps = {};
    if (opts.wsFallback) props.websocket = { enabled: true };
    if (opts.insecure) {
      // TESTING ONLY: bypass CA verification by pinning the relay's cert hash.
      const certHashes = await fetchCertHashes(serverUrl);
      if (certHashes) props.webtransport = { serverCertificateHashes: certHashes };
    }
    conn = await Net.Connection.connect(
      serverUrl,
      Object.keys(props).length ? props : undefined,
    );
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    closeEncoder(videoEncoder);
    if (audioEncoder) closeEncoder(audioEncoder);
    throw e instanceof Error ? e : new Error(String(e));
  }

  const broadcast = new Net.Broadcast();
  conn.publish(Net.Path.from(opts.broadcastPath), broadcast);
  status({ state: "publishing" });

  // ---- 6. Serve loop (pull-based) ----------------------------------------
  const serveCatalog = (track: Net.Track) => {
    void (async () => {
      await catalogReady;
      if (stopped || track.state.closed.peek() || !catalog) return;
      track.writeFrame(Catalog.encode(catalog as unknown as Catalog.Root));
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
    stream,
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

      stream.getTracks().forEach((t) => t.stop());

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

function closeEncoder(encoder: VideoEncoder | AudioEncoder) {
  try {
    if (encoder.state !== "closed") encoder.close();
  } catch {
    /* ignore */
  }
}

/**
 * TESTING ONLY. Fetches the relay's self-signed cert sha-256 fingerprint from
 * `/certificate.sha256` and returns it as a `serverCertificateHashes` entry.
 * Pinning the hash makes WebTransport skip CA-chain verification for that cert.
 * Returns undefined if the fingerprint can't be fetched/parsed (so connect
 * falls back to normal verification rather than silently failing).
 */
async function fetchCertHashes(
  serverUrl: URL,
): Promise<WebTransportHash[] | undefined> {
  try {
    const fpUrl = new URL(serverUrl);
    fpUrl.protocol = "http:";
    fpUrl.pathname = "/certificate.sha256";
    fpUrl.search = "";
    const res = await fetch(fpUrl);
    if (!res.ok) return undefined;
    const hex = (await res.text()).trim().replace(/[:\s]/g, "");
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) return undefined;
    const value = new Uint8Array(new ArrayBuffer(32));
    for (let i = 0; i < 32; i++) {
      value[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return [{ algorithm: "sha-256", value }];
  } catch {
    return undefined;
  }
}
