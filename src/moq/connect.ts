// Shared relay connect logic for the MoQ publisher and player. Both tools hit
// the same relay with the same self-signed-cert and error-reporting concerns;
// they differ only in the query param the auth token rides on and whether the
// WebSocket fallback is allowed.
import * as Net from "@moq/net";

export interface RelayConnectOptions {
  /** Relay URL. Must be `https:` or `http:` — anything else is rejected. */
  serverUrl: string;
  /** Auth token. Appended as a query param only when non-empty. */
  token?: string;
  /** Query param the token rides on: "token" for publish, "jwt" for play. */
  tokenParam?: string;
  /**
   * TESTING ONLY. The relay's self-signed cert sha-256 fingerprint as a raw hex
   * string. When set and valid, the fingerprint is pinned via
   * `serverCertificateHashes`, making WebTransport skip CA-chain verification
   * for that cert. If empty/unset, or the hex is invalid, connect falls back to
   * standard TLS verification. NEVER use in production.
   */
  certHash?: string;
  /** Allow falling back to WebSocket when WebTransport is unavailable. */
  wsFallback?: boolean;
}

/**
 * Connects to a MoQ relay.
 *
 * An `http://` URL is a dev-only shorthand handled inside `@moq/net`: it fetches
 * `/certificate.sha256` from the relay, pins it, and upgrades the URL to
 * `https:`. We pass it through untouched.
 */
export async function connectRelay(opts: RelayConnectOptions): Promise<Net.Connection.Established> {
  const serverUrl = parseServerUrl(opts.serverUrl);
  if (opts.token) serverUrl.searchParams.set(opts.tokenParam ?? "token", opts.token);

  const props: Net.Connection.ConnectProps = {};
  if (!opts.wsFallback) props.websocket = { enabled: false };

  let certHashPinned = false;
  if (opts.certHash) {
    // TESTING ONLY: bypass CA verification by pinning the relay's cert hash.
    // On invalid hex we leave props untouched -> standard TLS verification.
    const certHashes = parseCertHashes(opts.certHash);
    if (certHashes) {
      props.webtransport = { serverCertificateHashes: certHashes };
      certHashPinned = true;
    }
  }

  try {
    return await Net.Connection.connect(serverUrl, Object.keys(props).length ? props : undefined);
  } catch (e) {
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
}

/**
 * Parses the relay URL and rejects any scheme `Net.Connection.connect` can't
 * serve, so a typo surfaces as a clear message here instead of an opaque
 * transport failure later.
 */
function parseServerUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid server URL: ${raw || "(empty)"}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `Unsupported server URL scheme "${url.protocol}". Use https:// (or http:// against a local relay).`,
    );
  }
  return url;
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
