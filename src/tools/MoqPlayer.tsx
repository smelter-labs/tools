import { useState, useRef, useEffect } from "react";
import { useSessionInput } from "../useSessionInput.ts";
import SuggestInput, { saveToHistory } from "../SuggestInput.tsx";
import { startPlaying, type PlayHandle, type PlayStatus } from "../moq/player.ts";

// Path the broadcast is consumed from when the field is left empty. Matches the
// streamer's default.
const DEFAULT_BROADCAST_PATH = "test";

export default function MoqPlayer({ params }: { params: URLSearchParams }) {
  // The relay, path and cert fields share their storage keys with the MoQ
  // streamer, so a publish-in-one-tab / play-in-another loop only needs them
  // typed once. The JWT is a different credential from the streamer's bearer
  // token, so it gets its own key.
  const [serverUrl, setServerUrl] = useSessionInput("moq:url", params, "url");
  const [broadcastPath, setBroadcastPath] = useSessionInput("moq:path", params, "path");
  const [jwt, setJwt] = useSessionInput("moq:jwt", params, "jwt");
  // TESTING ONLY: the relay's self-signed cert sha-256 fingerprint as raw hex.
  // Empty or invalid -> standard TLS verification.
  const [certHash, setCertHash] = useSessionInput("moq:cert", params, "cert");

  const [status, setStatus] = useState<PlayStatus>({ state: "stopped" });
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const handleRef = useRef<PlayHandle | null>(null);

  // Stop everything on unmount.
  useEffect(() => {
    return () => {
      void handleRef.current?.stop();
      handleRef.current = null;
    };
  }, []);

  const stop = async () => {
    const handle = handleRef.current;
    handleRef.current = null;
    setRunning(false);
    if (videoRef.current) videoRef.current.srcObject = null;
    await handle?.stop();
  };

  const start = async () => {
    if (busy || handleRef.current) return;
    const trimmedPath = broadcastPath.trim();
    setBusy(true);
    setStatus({ state: "connecting" });
    saveToHistory("moq:url", serverUrl);
    if (jwt) saveToHistory("moq:jwt", jwt);
    if (certHash) saveToHistory("moq:cert", certHash);
    if (trimmedPath) saveToHistory("moq:path", trimmedPath);
    try {
      const handle = await startPlaying({
        serverUrl,
        broadcastPath: trimmedPath || DEFAULT_BROADCAST_PATH,
        token: jwt,
        certHash,
        onStatus: setStatus,
      });
      handleRef.current = handle;
      setRunning(true);
      if (videoRef.current) {
        videoRef.current.srcObject = handle.stream;
        videoRef.current.play().catch(() => {});
      }
    } catch (err) {
      setStatus({ state: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div
        style={{
          display: "flex",
          gap: "1rem",
          marginBottom: "1rem",
          flexWrap: "wrap",
          flexShrink: 0,
        }}
      >
        <SuggestInput
          historyKey="moq:url"
          value={serverUrl}
          onChange={setServerUrl}
          placeholder="https://localhost:4443/"
          label="Server URL"
        />
        <SuggestInput
          historyKey="moq:path"
          value={broadcastPath}
          onChange={setBroadcastPath}
          placeholder={DEFAULT_BROADCAST_PATH}
          label="Broadcast path (optional)"
        />
        <SuggestInput
          historyKey="moq:jwt"
          value={jwt}
          onChange={setJwt}
          placeholder="jwt"
          label="JWT (optional)"
        />
        <SuggestInput
          historyKey="moq:cert"
          value={certHash}
          onChange={setCertHash}
          placeholder="a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"
          label="Self-signed cert SHA-256 fingerprint (optional)"
        />
      </div>

      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          alignItems: "center",
          marginBottom: "1rem",
          flexShrink: 0,
        }}
      >
        {!running ? (
          <button
            onClick={start}
            disabled={busy}
            style={{ padding: "0.5rem 1.5rem", fontSize: "1rem", cursor: "pointer" }}
          >
            {busy ? "Starting…" : "Start"}
          </button>
        ) : (
          <button
            onClick={stop}
            style={{ padding: "0.5rem 1.5rem", fontSize: "1rem", cursor: "pointer" }}
          >
            Stop
          </button>
        )}
        <StatusLine status={status} />
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* Not muted: Start is a user gesture, so autoplay with audio is allowed. */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          controls
          style={{ maxWidth: "100%", maxHeight: "100%", width: "100%", height: "100%" }}
        />
      </div>
    </>
  );
}

function StatusLine({ status }: { status: PlayStatus }) {
  const color =
    status.state === "error"
      ? "var(--error)"
      : status.state === "playing"
        ? "var(--accent)"
        : "var(--text-muted)";

  let text: string;
  switch (status.state) {
    case "connecting":
      text = "Connecting…";
      break;
    case "playing": {
      const tracks = [status.video, status.audio].filter(Boolean);
      text = tracks.length ? `Playing — ${tracks.join(" · ")}` : "Playing";
      break;
    }
    case "error":
      text = `Error: ${status.message ?? "unknown"}`;
      break;
    default:
      text = "Stopped";
  }

  return <span style={{ fontSize: "0.9rem", fontWeight: 500, color }}>{text}</span>;
}
