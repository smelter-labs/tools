import { useState, useRef, useEffect, type ReactNode } from "react";
import { useSessionInput } from "../useSessionInput.ts";
import SuggestInput, { saveToHistory } from "../SuggestInput.tsx";
import {
  startPublishing,
  type PublishHandle,
  type PublishStatus,
  type SourceKind,
} from "../moq/publisher.ts";

const SOURCE_OPTIONS: { value: SourceKind; label: string }[] = [
  { value: "screen", label: "Screen" },
  { value: "camera", label: "Camera" },
];

export default function MoqStreamer({ params }: { params: URLSearchParams }) {
  const [serverUrl, setServerUrl] = useSessionInput("moq:url", params, "url");
  const [broadcastPath, setBroadcastPath] = useSessionInput("moq:path", params, "path");
  const [source, setSource] = useState<SourceKind>("screen");
  const [audio, setAudio] = useState(true);
  const [wsFallback, setWsFallback] = useState(false);
  // TESTING ONLY: pin self-signed relay cert, skip CA verification.
  const [insecure, setInsecure] = useState(true);

  const [status, setStatus] = useState<PublishStatus>({ state: "stopped" });
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const handleRef = useRef<PublishHandle | null>(null);

  const stop = async () => {
    const handle = handleRef.current;
    handleRef.current = null;
    setRunning(false);
    if (videoRef.current) videoRef.current.srcObject = null;
    await handle?.stop();
  };

  // Stop everything on unmount.
  useEffect(() => {
    return () => {
      void handleRef.current?.stop();
      handleRef.current = null;
    };
  }, []);

  const start = async () => {
    if (busy || handleRef.current) return;
    setBusy(true);
    setStatus({ state: "connecting" });
    saveToHistory("moq:url", serverUrl);
    saveToHistory("moq:path", broadcastPath);
    try {
      const handle = await startPublishing({
        serverUrl,
        broadcastPath,
        source,
        audio,
        wsFallback,
        insecure,
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

  const disabled = running || busy;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "auto",
      }}
    >
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
          placeholder="test"
          label="Broadcast path"
        />
      </div>

      <div
        style={{
          display: "flex",
          gap: "1rem",
          flexWrap: "wrap",
          alignItems: "flex-start",
          marginBottom: "1rem",
          flexShrink: 0,
        }}
      >
        <SourceSelect
          label="Source"
          value={source}
          options={SOURCE_OPTIONS}
          onChange={setSource}
          disabled={disabled}
        />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            flex: 1,
            minWidth: 200,
          }}
        >
          <span style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>Options</span>
          <Checkbox label="Include audio" checked={audio} onChange={setAudio} disabled={disabled} />
          <Checkbox
            label="Enable WebSocket fallback"
            checked={wsFallback}
            onChange={setWsFallback}
            disabled={disabled}
          />
          <Checkbox
            label="Skip TLS cert verification (testing only)"
            checked={insecure}
            onChange={setInsecure}
            disabled={disabled}
          />
        </div>
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
          minHeight: 240,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          controls
          muted
          style={{ maxWidth: "100%", maxHeight: "100%", width: "100%", height: "100%" }}
        />
      </div>
    </div>
  );
}

function StatusLine({ status }: { status: PublishStatus }) {
  const color =
    status.state === "error"
      ? "var(--error)"
      : status.state === "publishing"
        ? "var(--accent)"
        : "var(--text-muted)";

  let text: string;
  switch (status.state) {
    case "connecting":
      text = "Connecting…";
      break;
    case "publishing":
      text = status.fps !== undefined ? `Publishing — ${status.fps} fps` : "Publishing";
      break;
    case "error":
      text = `Error: ${status.message ?? "unknown"}`;
      break;
    default:
      text = "Stopped";
  }

  return <span style={{ fontSize: "0.9rem", fontWeight: 500, color }}>{text}</span>;
}

function Checkbox({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: "0.9rem",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

function SourceSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}): ReactNode {
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 200 }}>
      <label
        style={{
          marginBottom: 4,
          fontSize: "0.85rem",
          color: "var(--text-muted)",
        }}
      >
        {label}
      </label>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
        style={{ width: "100%", padding: "0.5rem", fontSize: "1rem", boxSizing: "border-box" }}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
