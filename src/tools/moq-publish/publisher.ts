// Publisher graph composed from `@moq/publish` primitives only. Every knob the form
// exposes is a signal the package itself declares live-editable, so changing a
// source, a device, or an encoder setting mid-stream is handled by the package.
//
// The capture sources, encoders, and preview live as long as the tool page: a source
// can be previewed before connecting and survives Start/Stop. Only the relay
// connection is created per Start, because `Reload`'s transport options are not
// reactive and giving up rejects a one-shot promise.
import * as Publish from "@moq/publish";
import { Effect, Signal, type Getter } from "@moq/signals";

const Net = Publish.Net;

export type SourceKind = "camera" | "screen" | "file";

/**
 * When to announce the broadcast. `always` and `source` mirror the `<moq-publish>` element's
 * `announce` attribute. `catalog` additionally waits until every captured track has its
 * rendition in the catalog: the package adds a rendition only once its encoder has seen a
 * first frame and resolved a codec, and a receiver that reads the catalog once (Smelter's MoQ
 * input does) would otherwise miss a track whose first frame comes late, which is the normal
 * case for screen capture since the browser only delivers frames when the screen changes.
 */
export type AnnounceMode = "always" | "source" | "catalog";

export interface ConnectOptions {
  /** Relay URL. `http://` is the package's dev shorthand that fetches and pins the relay cert. */
  url: string;
  /** Auth token, appended as the `token` query param when non-empty. */
  token?: string;
  /** Relay cert SHA-256 fingerprint as hex, pinned via `serverCertificateHashes`. */
  certHash?: string;
  /** Allow the WebSocket fallback when WebTransport is unavailable. */
  wsFallback: boolean;
}

export class Publisher {
  readonly #signals = new Effect();

  // ---- Controls -----------------------------------------------------------
  readonly source = new Signal<SourceKind | undefined>(undefined);
  readonly videoEnabled = new Signal(true);
  readonly audioEnabled = new Signal(true);
  readonly announce = new Signal<AnnounceMode>("source");
  readonly name = new Signal<Publish.Net.Path.Valid>(Net.Path.empty());
  readonly flip = new Signal(false);
  readonly latencyMax = new Signal<number | undefined>(undefined);
  readonly preview = new Signal<Publish.Preview.Mode>("source");
  readonly canvas = new Signal<HTMLCanvasElement | undefined>(undefined);

  // ---- Sources ------------------------------------------------------------
  readonly camera: Publish.Source.Camera;
  readonly microphone: Publish.Source.Microphone;
  readonly screen: Publish.Source.Screen;
  readonly file: Publish.Source.File;

  /** The video track feeding the capture, from whichever source is selected. */
  readonly videoSource: Getter<Publish.Video.Source | undefined>;
  /** The audio track feeding the audio encoder, from whichever source is selected. */
  readonly audioSource: Getter<Publish.Audio.Source | undefined>;

  // ---- Pipeline -----------------------------------------------------------
  readonly capture: Publish.Video.Capture;
  readonly broadcast: Publish.Broadcast;
  readonly video: Publish.Video.Encoder;
  readonly audio: Publish.Audio.Encoder;
  readonly renderer: Publish.Preview.Renderer;

  // ---- Connection ---------------------------------------------------------
  readonly running = new Signal(false);
  readonly status = new Signal<Publish.Net.Connection.ReloadStatus>("disconnected");
  readonly error = new Signal<string | undefined>(undefined);
  /** The peer's PROBE estimates for the live connection, if the relay sends them. */
  readonly probe = new Signal<Publish.Net.Connection.Probe | undefined>(undefined);

  readonly #established = new Signal<Publish.Net.Connection.Established | undefined>(undefined);
  readonly #bandwidth = new Signal<number | undefined>(undefined);
  #session?: { reload: Publish.Net.Connection.Reload; dispose: () => void };

  constructor() {
    const signals = this.#signals;

    // Each source captures only while it is the selected one and its media kind is enabled.
    const cameraEnabled = new Signal(false);
    const microphoneEnabled = new Signal(false);
    const screenEnabled = new Signal(false);
    const fileEnabled = new Signal(false);
    signals.run((e) => {
      const source = e.get(this.source);
      const video = e.get(this.videoEnabled);
      const audio = e.get(this.audioEnabled);
      cameraEnabled.set(source === "camera" && video);
      microphoneEnabled.set(source === "camera" && audio);
      screenEnabled.set(source === "screen" && (video || audio));
      fileEnabled.set(source === "file" && (video || audio));
    });

    this.camera = new Publish.Source.Camera({ enabled: cameraEnabled });
    this.microphone = new Publish.Source.Microphone({ enabled: microphoneEnabled });
    // Ask for both tracks up front: `getDisplayMedia` treats an unset `audio` as false, and
    // editing these constraints later re-prompts the picker, so the Video/Audio toggles gate
    // the encoders instead.
    this.screen = new Publish.Source.Screen({ enabled: screenEnabled, video: true, audio: true });
    this.file = new Publish.Source.File({ enabled: fileEnabled });

    const videoSource = new Signal<Publish.Video.Source | undefined>(undefined);
    const audioSource = new Signal<Publish.Audio.Source | undefined>(undefined);
    this.videoSource = videoSource;
    this.audioSource = audioSource;
    signals.run((e) => {
      switch (e.get(this.source)) {
        case "camera":
          videoSource.set(e.get(this.camera.out.source));
          audioSource.set(e.get(this.microphone.out.source));
          break;
        case "screen": {
          const screen = e.get(this.screen.out.source);
          videoSource.set(screen?.video);
          audioSource.set(screen?.audio);
          break;
        }
        case "file": {
          const file = e.get(this.file.out.source);
          videoSource.set(file.video);
          audioSource.set(file.audio);
          break;
        }
        default:
          videoSource.set(undefined);
          audioSource.set(undefined);
      }
    });

    this.capture = new Publish.Video.Capture({ source: videoSource });

    // Announce once connected: always, once some media is captured, or once the catalog lists
    // every captured track. The `catalog` gate latches for the rest of the session, so a
    // rendition briefly leaving the catalog (the encoder re-resolves when the capture size
    // changes) does not retract the announcement.
    const broadcastEnabled = new Signal(false);
    const catalogLatched = new Signal(false);
    signals.run((e) => {
      const running = e.get(this.running);
      if (!running) {
        catalogLatched.set(false);
        broadcastEnabled.set(false);
        return;
      }
      const announce = e.get(this.announce);
      const hasVideo = e.get(videoSource) !== undefined;
      const hasAudio = e.get(audioSource) !== undefined;
      const hasSource = hasVideo || hasAudio;
      if (announce === "always") {
        broadcastEnabled.set(true);
        return;
      }
      if (announce === "source" || e.get(catalogLatched)) {
        broadcastEnabled.set(hasSource);
        return;
      }
      const videoReady =
        !hasVideo || !e.get(this.videoEnabled) || e.get(this.video.out.catalog) !== undefined;
      const audioReady =
        !hasAudio || !e.get(this.audioEnabled) || e.get(this.audio.out.catalog) !== undefined;
      const ready = hasSource && videoReady && audioReady;
      if (ready) catalogLatched.set(true);
      broadcastEnabled.set(ready);
    });

    this.broadcast = new Publish.Broadcast({
      connection: this.#established,
      enabled: broadcastEnabled,
      name: this.name,
      display: this.capture.out.display,
      flip: this.flip,
      latencyMax: this.latencyMax,
    });

    this.video = new Publish.Video.Encoder("video", {
      broadcast: this.broadcast,
      capture: this.capture,
      enabled: this.videoEnabled,
      bandwidth: this.#bandwidth,
    });

    this.audio = new Publish.Audio.Encoder("audio", {
      broadcast: this.broadcast,
      enabled: this.audioEnabled,
      source: audioSource,
    });

    this.renderer = new Publish.Preview.Renderer({
      canvas: this.canvas,
      frame: this.capture.out.frame,
      display: this.capture.out.display,
      flip: this.flip,
      encoder: this.video,
      mode: this.preview,
      enabled: this.videoEnabled,
    });

    // Feed the congestion controller's send estimate to the video encoder as its bandwidth cap.
    signals.run((e) => {
      const connection = e.get(this.#established);
      this.#bandwidth.set(undefined);
      if (!connection) return;
      let inflight = false;
      const poll = async () => {
        if (inflight) return;
        inflight = true;
        try {
          const stats = await Promise.race([e.cancel, connection.stats()]);
          if (stats) this.#bandwidth.set(stats.estimatedSendRate);
        } finally {
          inflight = false;
        }
      };
      void poll();
      e.interval(poll, 500);
    });

    signals.run((e) => {
      const connection = e.get(this.#established);
      this.probe.set(connection && e.get(connection.probe));
    });
  }

  /** Connect to the relay and publish. Throws synchronously on an invalid URL. */
  start(opts: ConnectOptions) {
    if (this.#session) return;

    let url: URL;
    try {
      url = new URL(opts.url);
    } catch {
      throw new Error(`Invalid relay URL: ${opts.url || "(empty)"}`);
    }
    if (opts.token) url.searchParams.set("token", opts.token);

    const certHash = opts.certHash?.replace(/[:\s]/g, "");
    const reload = new Net.Connection.Reload({
      url,
      enabled: true,
      websocket: { enabled: opts.wsFallback },
      webtransport: certHash ? { serverCertificateHashes: [{ value: certHash }] } : undefined,
    });

    const unsubscribe = [
      reload.established.watch((connection) => this.#established.set(connection)),
      reload.status.watch((status) => this.status.set(status)),
    ];
    const session = {
      reload,
      dispose: () => {
        for (const dispose of unsubscribe) dispose();
        reload.close();
      },
    };
    this.#session = session;
    this.error.set(undefined);
    this.running.set(true);

    // `closed` rejects when the reconnect loop gives up.
    reload.closed.catch((err: unknown) => {
      if (this.#session !== session) return;
      this.error.set(errorMessage(err));
      this.stop();
    });
  }

  /** Disconnect from the relay. Sources keep capturing so the preview stays up. */
  stop() {
    const session = this.#session;
    if (!session) return;
    this.#session = undefined;
    session.dispose();
    this.#established.set(undefined);
    this.status.set("disconnected");
    this.running.set(false);
  }

  /** Stop everything and release the devices. */
  close() {
    this.stop();
    this.renderer.close();
    this.video.close();
    this.audio.close();
    this.broadcast.close();
    this.capture.close();
    this.camera.close();
    this.microphone.close();
    this.screen.close();
    this.file.close();
    this.#signals.close();
  }
}

/**
 * The connect race rejects with an `AggregateError` whose own message is just "All promises
 * were rejected"; the transport errors underneath carry the actual cause.
 */
function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const nested = (err as { errors?: unknown }).errors;
  if (Array.isArray(nested) && nested.length > 0) {
    const messages = [...new Set(nested.map(errorMessage).filter(Boolean))];
    if (messages.length > 0) return messages.join("; ");
  }
  return err.message;
}
