// Player built on `@moq/watch`'s headless `Player`, the consume-side counterpart to the MoQ
// Publish tool's publisher.ts. `Watch.Player` is the pipeline the package's `<moq-watch>` element
// drives, minus the DOM attribute plumbing, so the React form can drive it through signals.
//
// The pipeline lives as long as the tool page; only the relay connection is created per Start,
// because a `Connection`'s transport options (WebSocket fallback, pinned cert) are not reactive.
import * as Watch from "@moq/watch";
import { Effect, Signal } from "@moq/signals";

const Net = Watch.Net;

export type Delay = Watch.Delay;

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
  readonly announced = new Signal(true);
  readonly catalogFormat = new Signal<Watch.CatalogFormat | undefined>(undefined);
  readonly paused = new Signal(false);
  readonly muted = new Signal(false);
  readonly volume = new Signal(0.5);
  /** How far playback trails the live edge. `"instant"` also turns audio off. */
  readonly delay = new Signal<Delay>("auto");
  /** Future-dated media held beyond the live edge before skipping ahead; above zero is buffered playback. */
  readonly buffer = new Signal<Watch.Net.Time.Milli>(Net.Time.Milli.zero);
  /** Rendition preference; the source picks the closest match. */
  readonly target = new Signal<Watch.Video.Target | undefined>(undefined);
  readonly canvas = new Signal<HTMLCanvasElement | undefined>(undefined);

  // ---- Pipeline -----------------------------------------------------------
  readonly #pipeline: Watch.Player;
  readonly broadcast: Watch.Broadcast;
  readonly sync: Watch.Sync;
  readonly video: Watch.Video.Decoder;
  readonly audio: Watch.Audio.Decoder;

  // ---- Connection ---------------------------------------------------------
  readonly running = new Signal(false);
  readonly status = new Signal<Watch.Net.Connection.Status>("disconnected");
  readonly error = new Signal<string | undefined>(undefined);
  /** The peer's PROBE estimates for the live connection, if the relay sends them. */
  readonly probe = new Signal<Watch.Net.Connection.Probe | undefined>(undefined);

  readonly #origin = new Signal<Watch.Net.Origin.Table | undefined>(undefined);
  readonly #connection = new Signal<Watch.Net.Connection | undefined>(undefined);
  #session?: { connection: Watch.Net.Connection; dispose: () => void };

  constructor() {
    this.#pipeline = new Watch.Player({
      origin: this.#origin,
      probe: this.probe,
      enabled: this.running,
      name: this.name,
      announced: this.announced,
      catalogFormat: this.catalogFormat,
      canvas: this.canvas,
      paused: this.paused,
      muted: this.muted,
      volume: this.volume,
      delay: this.delay,
      buffer: this.buffer,
      target: this.target,
      // Always download while the page is up: the canvas is the whole tool, so the element's
      // viewport-distance heuristic would only add a way to stall.
      visible: "always",
    });
    this.broadcast = this.#pipeline.broadcast;
    this.sync = this.#pipeline.sync;
    this.video = this.#pipeline.video;
    this.audio = this.#pipeline.audio;

    // Mirror the live connection's origin, probe and status; each resets once it is dropped.
    this.#signals.run((e) => {
      const connection = e.get(this.#connection);
      if (!connection) return;
      e.run((inner) => inner.set(this.#origin, inner.get(connection.origin), undefined));
      e.run((inner) => inner.set(this.probe, inner.get(connection.probe), undefined));
      e.run((inner) => inner.set(this.status, inner.get(connection.status), "disconnected"));
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

    // Transport options give this handle its own reconnect loop instead of the page-wide pool.
    // It gives up, via `error`, on an auth rejection or once its retry window (10 s by default)
    // passes without a connection.
    const certHash = opts.certHash?.replace(/[:\s]/g, "");
    const connection = new Net.Connection({
      url,
      websocket: { enabled: opts.wsFallback },
      webtransport: certHash ? { serverCertificateHashes: [{ value: certHash }] } : undefined,
    });

    const unsubscribe = connection.error.subscribe((err) => {
      if (!err || this.#session?.connection !== connection) return;
      this.error.set(errorMessage(err));
      this.stop();
    });
    this.#session = {
      connection,
      dispose: () => {
        unsubscribe();
        connection.close();
      },
    };
    this.#connection.set(connection);
    this.error.set(undefined);
    this.running.set(true);
  }

  /** Disconnect from the relay. The last frame stays on the canvas. */
  stop() {
    const session = this.#session;
    if (!session) return;
    this.#session = undefined;
    session.dispose();
    this.#connection.set(undefined);
    this.running.set(false);
  }

  /** Re-anchor playback in buffered mode: reset the clock and flush the audio buffer. */
  reset() {
    this.#pipeline.reset();
  }

  /** Stop everything and tear the pipeline down. */
  close() {
    this.stop();
    this.#pipeline.close();
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
