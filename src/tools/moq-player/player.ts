// Player graph composed from `@moq/watch` primitives only, the consume-side counterpart to
// the MoQ Publish tool's publisher.ts. It mirrors what the package's `<moq-watch>` element wires up internally, minus the
// DOM attribute plumbing, so the React form can drive it through signals.
//
// The pipeline lives as long as the tool page; only the relay connection is created per Start,
// because `Reload`'s transport options are not reactive and giving up rejects a one-shot promise.
import * as Watch from "@moq/watch";
import { Effect, Signal } from "@moq/signals";

const Net = Watch.Net;

export type Latency = Watch.Latency;

export interface ConnectOptions {
  /** Relay URL. `http://` is the package's dev shorthand that fetches and pins the relay cert. */
  url: string;
  /** Auth token, appended as the `jwt` query param when non-empty. */
  token?: string;
  /** Relay cert SHA-256 fingerprint as hex, pinned via `serverCertificateHashes`. */
  certHash?: string;
  /** Allow the WebSocket fallback when WebTransport is unavailable. */
  wsFallback: boolean;
}

export class Player {
  readonly #signals = new Effect();

  // ---- Controls -----------------------------------------------------------
  readonly name = new Signal<Watch.Net.Path.Valid>(Net.Path.empty());
  /** Wait for the relay to (re)announce the broadcast before subscribing. */
  readonly reload = new Signal(true);
  readonly catalogFormat = new Signal<Watch.CatalogFormat | undefined>(undefined);
  readonly paused = new Signal(false);
  readonly muted = new Signal(false);
  readonly volume = new Signal(0.5);
  readonly latency = new Signal<Latency>("real-time");
  /** Rendition preference; the source picks the closest match. */
  readonly target = new Signal<Watch.Video.Target | undefined>(undefined);
  readonly canvas = new Signal<HTMLCanvasElement | undefined>(undefined);

  // ---- Pipeline -----------------------------------------------------------
  readonly broadcast: Watch.Broadcast;
  readonly sync: Watch.Sync;
  readonly video: Watch.Video.Decoder;
  readonly audio: Watch.Audio.Decoder;
  readonly renderer: Watch.Video.Renderer;
  readonly emitter: Watch.Audio.Emitter;

  // ---- Connection ---------------------------------------------------------
  readonly running = new Signal(false);
  readonly status = new Signal<Watch.Net.Connection.ReloadStatus>("disconnected");
  readonly error = new Signal<string | undefined>(undefined);
  /** The peer's PROBE estimates for the live connection, if the relay sends them. */
  readonly probe = new Signal<Watch.Net.Connection.Probe | undefined>(undefined);

  readonly #established = new Signal<Watch.Net.Connection.Established | undefined>(undefined);
  #session?: { reload: Watch.Net.Connection.Reload; dispose: () => void };

  constructor() {
    const signals = this.#signals;

    this.broadcast = new Watch.Broadcast({
      connection: this.#established,
      enabled: this.running,
      name: this.name,
      reload: this.reload,
      catalogFormat: this.catalogFormat,
    });

    const videoSource = new Watch.Video.Source({
      broadcast: this.broadcast,
      target: this.target,
      supported: Watch.Video.Decoder.supported,
    });
    const audioSource = new Watch.Audio.Source({
      broadcast: this.broadcast,
      supported: Watch.Audio.Decoder.supported,
    });
    signals.cleanup(() => {
      videoSource.close();
      audioSource.close();
    });

    // `Sync` cannot pace "instant" on its own: it gets a zero buffer, video is unpaced and audio
    // is disabled below, exactly like the element does.
    const paced = new Signal<Watch.Paced>("real-time");
    const isPaced = new Signal(true);
    signals.run((e) => {
      const latency = e.get(this.latency);
      paced.set(latency === "instant" ? Net.Time.Milli.zero : latency);
      isPaced.set(latency !== "instant");
    });

    this.sync = new Watch.Sync({
      latency: paced,
      connection: this.#established,
      video: videoSource.out.jitter,
      audio: audioSource.out.jitter,
    });

    const videoEnabled = new Signal(false);
    const audioEnabled = new Signal(false);
    this.video = new Watch.Video.Decoder(videoSource, this.sync, {
      enabled: videoEnabled,
      paced: isPaced,
    });
    this.audio = new Watch.Audio.Decoder(audioSource, this.sync, { enabled: audioEnabled });

    this.emitter = new Watch.Audio.Emitter(this.audio, {
      volume: this.volume,
      muted: this.muted,
      paused: this.paused,
    });
    // Always download while the page is up: the canvas is the whole tool, so the element's
    // viewport-distance heuristic would only add a way to stall.
    this.renderer = new Watch.Video.Renderer(this.video, {
      canvas: this.canvas,
      visible: "always",
    });

    signals.run((e) => {
      audioEnabled.set(e.get(this.emitter.out.enabled) && e.get(isPaced));
    });
    signals.run((e) => {
      if (e.get(this.latency) === "instant") this.audio.reset();
    });
    // Paused keeps the last frame on screen: download only until the first frame lands.
    signals.run((e) => {
      const visible = e.get(this.renderer.out.visible);
      if (!e.get(this.paused)) {
        videoEnabled.set(visible);
        return;
      }
      videoEnabled.set(visible && !e.get(this.renderer.out.frame));
    });

    signals.run((e) => {
      const connection = e.get(this.#established);
      this.probe.set(connection && e.get(connection.probe));
    });
  }

  /** Connect to the relay and subscribe. Throws synchronously on an invalid URL. */
  start(opts: ConnectOptions) {
    if (this.#session) return;

    let url: URL;
    try {
      url = new URL(opts.url);
    } catch {
      throw new Error(`Invalid relay URL: ${opts.url || "(empty)"}`);
    }
    if (opts.token) url.searchParams.set("jwt", opts.token);

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

  /** Disconnect from the relay. The last frame stays on the canvas. */
  stop() {
    const session = this.#session;
    if (!session) return;
    this.#session = undefined;
    session.dispose();
    this.#established.set(undefined);
    this.status.set("disconnected");
    this.running.set(false);
  }

  /** Re-anchor playback in buffered mode: reset the clock and flush the audio buffer. */
  reset() {
    this.sync.reset();
    this.audio.reset();
  }

  /** Stop everything and tear the pipeline down. */
  close() {
    this.stop();
    this.emitter.close();
    this.renderer.close();
    this.video.close();
    this.audio.close();
    this.sync.close();
    this.broadcast.close();
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
