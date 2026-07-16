// Hand-rolled MoQ player: the consume-side counterpart to publisher.ts.
//
// @moq/hang 0.2.7 ships everything from wire bytes up to
// `{data, timestamp, keyframe}` (Container.Consumer + a decode-side Format for
// each of the three containers), but no player — the WebCodecs decode and the
// render sink are ours. We feed decoded frames into MediaStreamTrackGenerators
// and hand back a MediaStream, so a `<video srcObject>` does the A/V sync and
// clocking for us, exactly like the WHEP player.
import * as Net from "@moq/net";
import * as Catalog from "@moq/hang/catalog";
import { Cmaf, Consumer, Legacy, Loc, type Format } from "@moq/hang/container";
import { Hex } from "@moq/hang/util";
import type { Time } from "@moq/net";
import { connectRelay } from "./connect";

/** Track name the streamer publishes its catalog under (publisher.ts TRACK_CATALOG). */
const TRACK_CATALOG = "catalog.json";

/** Path consumed when the field is left empty. Matches the streamer's default. */
const DEFAULT_BROADCAST_PATH = "test";

/**
 * How far the Consumer lets the buffer run before it drops the oldest group to
 * catch up. This is a live player, so keep it tight.
 */
const LATENCY_MS = 100 as Time.Milli;

export interface PlayOptions {
  serverUrl: string;
  broadcastPath: string;
  /** JWT appended to the server URL as a `?jwt=` query param. Omitted when empty. */
  token?: string;
  /**
   * TESTING ONLY. The relay's self-signed cert sha-256 fingerprint as raw hex.
   * See connectRelay. Empty/invalid falls back to standard TLS verification.
   */
  certHash?: string;
  onStatus?: (status: PlayStatus) => void;
}

export interface PlayStatus {
  state: "connecting" | "playing" | "stopped" | "error";
  message?: string;
  /** Human-readable summary of the rendition being played, for the status line. */
  video?: string;
  audio?: string;
}

export interface PlayHandle {
  /** The decoded MediaStream, for `<video srcObject>`. */
  stream: MediaStream;
  stop: () => Promise<void>;
}

/** A decoded track: its generator-backed output plus everything to tear down. */
interface Pipeline {
  track: MediaStreamTrack;
  label: string;
  stop: () => Promise<void>;
}

export async function startPlaying(opts: PlayOptions): Promise<PlayHandle> {
  const status = (s: PlayStatus) => opts.onStatus?.(s);
  status({ state: "connecting" });

  const conn = await connectRelay({
    serverUrl: opts.serverUrl,
    token: opts.token,
    tokenParam: "jwt",
    certHash: opts.certHash,
    // WebTransport only: the WS fallback would silently paper over a relay that
    // isn't reachable the way we intend to test it.
    wsFallback: false,
  });

  let broadcast: Net.Broadcast;
  let root: Catalog.Root | undefined;
  try {
    broadcast = conn.consume(Net.Path.from(opts.broadcastPath || DEFAULT_BROADCAST_PATH));
    // Fetched once. A live catalog re-read (renditions appearing mid-stream) is
    // out of scope; the streamer publishes its catalog before any media.
    root = await Catalog.fetch(broadcast.subscribe(TRACK_CATALOG, Catalog.PRIORITY.catalog));
  } catch (e) {
    conn.close();
    throw new Error(`Failed to fetch the catalog: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    });
  }
  if (!root) {
    conn.close();
    throw new Error(`No broadcast found at "${opts.broadcastPath || DEFAULT_BROADCAST_PATH}".`);
  }

  let stopped = false;
  let fatal: Error | null = null;
  const pipelines: Pipeline[] = [];

  const fail = (err: unknown) => {
    if (fatal || stopped) return;
    fatal = err instanceof Error ? err : new Error(String(err));
    status({ state: "error", message: fatal.message });
    void handle.stop();
  };

  try {
    // The streamer can publish video-only or audio-only, so build the stream
    // from whatever the catalog actually declares rather than assuming both.
    const video = firstRendition(root.video?.renditions);
    if (video) pipelines.push(startVideo(broadcast, video.key, video.config, fail));

    const audio = firstRendition(root.audio?.renditions);
    if (audio) pipelines.push(startAudio(broadcast, audio.key, audio.config, fail));
  } catch (e) {
    await Promise.all(pipelines.map((p) => p.stop()));
    broadcast.close();
    conn.close();
    throw e;
  }

  if (pipelines.length === 0) {
    broadcast.close();
    conn.close();
    throw new Error("The catalog declares neither a video nor an audio rendition.");
  }

  const stream = new MediaStream(pipelines.map((p) => p.track));

  const handle: PlayHandle = {
    stream,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await Promise.all(pipelines.map((p) => p.stop()));
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

  status({
    state: "playing",
    video: pipelines.find((p) => p.track.kind === "video")?.label,
    audio: pipelines.find((p) => p.track.kind === "audio")?.label,
  });

  return handle;
}

/**
 * The first rendition in the catalog. The streamer only ever publishes one per
 * kind; picking the first is all the selection this player needs.
 */
function firstRendition<T>(renditions: Record<string, T> | undefined): { key: string; config: T } | undefined {
  const first = Object.entries(renditions ?? {})[0];
  return first ? { key: first[0], config: first[1] } : undefined;
}

/**
 * Builds the decode-side container Format for a rendition, along with the
 * decoder `description` when the container carries one.
 *
 * CMAF's init segment is authoritative: it holds the same avcC/dOps the catalog
 * may also advertise out-of-band, so prefer it and fall back to the catalog's
 * hex `description` for legacy/LOC.
 */
function formatFor(config: {
  container: Catalog.Container;
  description?: string;
}): { format: Format; description?: Uint8Array } {
  switch (config.container.kind) {
    case "cmaf": {
      const init = Cmaf.decodeInitSegment(base64ToBytes(config.container.init));
      return { format: new Cmaf.Format(init), description: init.description };
    }
    case "legacy":
      return { format: new Legacy.Format(), description: descriptionFor(config.description) };
    case "loc":
      return { format: new Loc.Format(), description: descriptionFor(config.description) };
  }
}

function descriptionFor(hex: string | undefined): Uint8Array | undefined {
  return hex ? Hex.toBytes(hex) : undefined;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function startVideo(
  broadcast: Net.Broadcast,
  key: string,
  config: NonNullable<Catalog.Root["video"]>["renditions"][string],
  fail: (err: unknown) => void,
): Pipeline {
  const { format, description } = formatFor(config);
  const consumer = new Consumer(broadcast.subscribe(key, Catalog.PRIORITY.video), {
    format,
    latency: LATENCY_MS,
  });

  const generator = new MediaStreamTrackGenerator<VideoFrame>({ kind: "video" });
  const writer = generator.writable.getWriter();

  const decoder = new VideoDecoder({
    // The generator's writable takes ownership of the frame, so we only close it
    // ourselves when the write is rejected (i.e. after teardown).
    output: (frame) => void writer.write(frame).catch(() => frame.close()),
    error: fail,
  });
  decoder.configure({
    codec: config.codec,
    codedWidth: config.codedWidth,
    codedHeight: config.codedHeight,
    description,
    optimizeForLatency: true,
  });

  const pump = pumpFrames(consumer, decoder, "video", fail);
  return pipeline(generator, writer, decoder, consumer, pump, videoLabel(config));
}

function startAudio(
  broadcast: Net.Broadcast,
  key: string,
  config: NonNullable<Catalog.Root["audio"]>["renditions"][string],
  fail: (err: unknown) => void,
): Pipeline {
  const { format, description } = formatFor(config);
  const consumer = new Consumer(broadcast.subscribe(key, Catalog.PRIORITY.audio), {
    format,
    latency: LATENCY_MS,
  });

  const generator = new MediaStreamTrackGenerator<AudioData>({ kind: "audio" });
  const writer = generator.writable.getWriter();

  const decoder = new AudioDecoder({
    output: (data) => void writer.write(data).catch(() => data.close()),
    error: fail,
  });
  decoder.configure({
    codec: config.codec,
    sampleRate: config.sampleRate,
    numberOfChannels: config.numberOfChannels,
    description,
  });

  const pump = pumpFrames(consumer, decoder, "audio", fail);
  return pipeline(generator, writer, decoder, consumer, pump, audioLabel(config));
}

/**
 * Drains the container Consumer into the decoder until the track ends or we
 * tear down.
 *
 * The Consumer hands back `{frame: undefined}` at a group boundary, which we
 * skip, and `undefined` once it is closed, which ends the loop. Video is gated
 * on a keyframe: a VideoDecoder throws if its first chunk is a delta, and while
 * the Consumer marks each group's first frame as a keyframe by protocol
 * invariant, a truncated group can still leave us mid-GOP.
 */
async function pumpFrames(
  consumer: Consumer,
  decoder: VideoDecoder | AudioDecoder,
  kind: "video" | "audio",
  fail: (err: unknown) => void,
): Promise<void> {
  let started = kind === "audio"; // every encoded audio frame is independently decodable
  try {
    for (;;) {
      const next = await consumer.next();
      if (!next) break;
      const frame = next.frame;
      if (!frame) continue;
      if (decoder.state !== "configured") break;
      if (!frame.keyframe && !started) continue;
      started = true;

      const init = {
        type: frame.keyframe ? ("key" as const) : ("delta" as const),
        timestamp: frame.timestamp,
        data: frame.data,
      };
      if (kind === "video") {
        (decoder as VideoDecoder).decode(new EncodedVideoChunk(init));
      } else {
        (decoder as AudioDecoder).decode(new EncodedAudioChunk(init));
      }
    }
  } catch (e) {
    if (decoder.state !== "closed") fail(e);
  }
}

function pipeline<T extends VideoFrame | AudioData>(
  generator: MediaStreamTrackGenerator<T>,
  writer: WritableStreamDefaultWriter<T>,
  decoder: VideoDecoder | AudioDecoder,
  consumer: Consumer,
  pump: Promise<void>,
  label: string,
): Pipeline {
  return {
    track: generator,
    label,
    stop: async () => {
      // Close the consumer first: it ends the pump loop (and the underlying MoQ
      // track), so nothing new reaches a decoder we are about to close.
      try {
        consumer.close();
      } catch {
        /* ignore */
      }
      await pump;
      try {
        if (decoder.state !== "closed") decoder.close();
      } catch {
        /* ignore */
      }
      // Abort rather than close: in-flight writes from the decoder's output
      // callback would otherwise keep a graceful close pending.
      try {
        await writer.abort();
      } catch {
        /* ignore */
      }
      generator.stop();
    },
  };
}

function videoLabel(config: { codec: string; codedWidth?: number; codedHeight?: number }): string {
  const size = config.codedWidth && config.codedHeight ? ` ${config.codedWidth}×${config.codedHeight}` : "";
  return `${config.codec}${size}`;
}

function audioLabel(config: { codec: string; sampleRate: number; numberOfChannels: number }): string {
  const channels = config.numberOfChannels === 1 ? "mono" : config.numberOfChannels === 2 ? "stereo" : `${config.numberOfChannels}ch`;
  return `${config.codec} ${config.sampleRate / 1000} kHz ${channels}`;
}
