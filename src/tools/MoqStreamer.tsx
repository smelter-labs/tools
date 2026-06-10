import { useState, useRef, useCallback, useEffect, type ReactNode } from "react";
import { useSessionInput } from "../useSessionInput.ts";
import SuggestInput, { saveToHistory } from "../SuggestInput.tsx";
import {
  startPublishing,
  type PublishHandle,
  type PublishStatus,
  type SourceKind,
  type AudioProcessing,
  type AudioCodec,
} from "../moq/publisher.ts";

const NONE = "none";
const SCREEN = "screen";
const MICROPHONE = "microphone";

const SOURCE_OPTIONS: { value: SourceKind; label: string }[] = [
  { value: "screen", label: "Screen" },
  { value: "camera", label: "Camera" },
];

const AUDIO_CODECS: { value: AudioCodec; label: string }[] = [
  { value: "opus", label: "Opus" },
  { value: "aac", label: "AAC" },
];

const RESOLUTIONS: Record<string, { label: string; width?: number; height?: number }> = {
  auto: { label: "Auto" },
  "2160p": { label: "2160p (4K)", width: 3840, height: 2160 },
  "1440p": { label: "1440p", width: 2560, height: 1440 },
  "1080p": { label: "1080p", width: 1920, height: 1080 },
  "720p": { label: "720p", width: 1280, height: 720 },
  "480p": { label: "480p", width: 854, height: 480 },
  "360p": { label: "360p", width: 640, height: 360 },
};

const FRAMERATES: Record<string, { label: string; fps?: number }> = {
  auto: { label: "Auto" },
  "60": { label: "60 fps", fps: 60 },
  "30": { label: "30 fps", fps: 30 },
  "24": { label: "24 fps", fps: 24 },
  "15": { label: "15 fps", fps: 15 },
};

const CONTENT_HINTS: Record<string, { label: string; value?: MediaStreamTrack["contentHint"] }> = {
  auto: { label: "Auto" },
  motion: { label: "Motion (favor framerate)", value: "motion" },
  detail: { label: "Detail (favor resolution)", value: "detail" },
  text: { label: "Text (favor resolution)", value: "text" },
};

const VIDEO_BITRATES: Record<string, { label: string; bps?: number }> = {
  auto: { label: "Auto" },
  "25000": { label: "25 Mbps", bps: 25_000_000 },
  "15000": { label: "15 Mbps", bps: 15_000_000 },
  "8000": { label: "8 Mbps", bps: 8_000_000 },
  "5000": { label: "5 Mbps", bps: 5_000_000 },
  "2500": { label: "2.5 Mbps", bps: 2_500_000 },
  "1000": { label: "1 Mbps", bps: 1_000_000 },
  "500": { label: "500 kbps", bps: 500_000 },
};

const AUDIO_BITRATES: Record<string, { label: string; bps?: number }> = {
  auto: { label: "Auto" },
  "256": { label: "256 kbps", bps: 256_000 },
  "192": { label: "192 kbps", bps: 192_000 },
  "128": { label: "128 kbps", bps: 128_000 },
  "96": { label: "96 kbps", bps: 96_000 },
  "64": { label: "64 kbps", bps: 64_000 },
  "32": { label: "32 kbps", bps: 32_000 },
};

function selectOptions<T extends { label: string }>(
  rec: Record<string, T>,
): { value: string; label: string }[] {
  return Object.entries(rec).map(([value, { label }]) => ({ value, label }));
}

export default function MoqStreamer({ params }: { params: URLSearchParams }) {
  const [serverUrl, setServerUrl] = useSessionInput("moq:url", params, "url");
  const [broadcastPath, setBroadcastPath] = useSessionInput("moq:path", params, "path");
  // TESTING ONLY: the relay's self-signed cert sha-256 fingerprint as raw hex.
  // Empty or invalid -> standard TLS verification.
  const [certHash, setCertHash] = useSessionInput("moq:cert", params, "cert");
  const [source, setSource] = useState<SourceKind>("screen");
  const [audioSource, setAudioSource] = useState<string>(NONE);
  const [audioProcessing, setAudioProcessing] = useState<AudioProcessing>({
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  });
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [wsFallback, setWsFallback] = useState(false);
  const [resolution, setResolution] = useState<string>("auto");
  const [framerate, setFramerate] = useState<string>("auto");
  const [videoBitrate, setVideoBitrate] = useState<string>("auto");
  const [audioBitrate, setAudioBitrate] = useState<string>("auto");
  const [audioCodec, setAudioCodec] = useState<AudioCodec>("opus");
  const [contentHint, setContentHint] = useState<string>("auto");

  const [status, setStatus] = useState<PublishStatus>({ state: "stopped" });
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const handleRef = useRef<PublishHandle | null>(null);

  const refreshDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setAudioDevices(devices.filter((d) => d.kind === "audioinput"));
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    refreshDevices();
    navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refreshDevices);
  }, [refreshDevices]);

  const namedAudioDevices = audioDevices.filter((d) => d.deviceId && d.label);
  const audioOptions = [
    { value: NONE, label: "None" },
    { value: SCREEN, label: "Screen audio" },
    ...(namedAudioDevices.length > 0
      ? namedAudioDevices.map((d) => ({ value: d.deviceId, label: d.label }))
      : [{ value: MICROPHONE, label: "Microphone" }]),
  ];

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
    if (certHash) saveToHistory("moq:cert", certHash);
    try {
      const handle = await startPublishing({
        serverUrl,
        broadcastPath,
        source,
        audioSource,
        audioProcessing,
        audioCodec,
        wsFallback,
        videoBitrate: VIDEO_BITRATES[videoBitrate]?.bps,
        audioBitrate: AUDIO_BITRATES[audioBitrate]?.bps,
        framerate: FRAMERATES[framerate]?.fps,
        width: RESOLUTIONS[resolution]?.width,
        height: RESOLUTIONS[resolution]?.height,
        contentHint: CONTENT_HINTS[contentHint]?.value,
        certHash,
        onStatus: setStatus,
      });
      handleRef.current = handle;
      setRunning(true);
      // Populate device labels for the next run now that we hold a permission grant.
      refreshDevices();
      if (videoRef.current) {
        videoRef.current.srcObject = handle.stream;
        videoRef.current.play().catch(() => { });
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
          gap: "1rem",
          flexWrap: "wrap",
          alignItems: "flex-start",
          marginBottom: "1rem",
          flexShrink: 0,
        }}
      >
        <OptionGroup label="Video">
          <SourceSelect
            label="Source"
            value={source}
            options={SOURCE_OPTIONS}
            onChange={setSource}
            disabled={disabled}
          />
          <SourceSelect
            label="Resolution"
            value={resolution}
            options={selectOptions(RESOLUTIONS)}
            onChange={setResolution}
            disabled={disabled}
          />
          <SourceSelect
            label="Framerate"
            value={framerate}
            options={selectOptions(FRAMERATES)}
            onChange={setFramerate}
            disabled={disabled}
          />
          <SourceSelect
            label="Max bitrate"
            value={videoBitrate}
            options={selectOptions(VIDEO_BITRATES)}
            onChange={setVideoBitrate}
            disabled={disabled}
          />
          <SourceSelect
            label="Content hint"
            value={contentHint}
            options={selectOptions(CONTENT_HINTS)}
            onChange={setContentHint}
            disabled={disabled}
          />
        </OptionGroup>
        <OptionGroup label="Audio">
          <SourceSelect
            label="Source"
            value={audioSource}
            options={audioOptions}
            onChange={setAudioSource}
            disabled={disabled}
          />
          <SourceSelect
            label="Codec"
            value={audioCodec}
            options={AUDIO_CODECS}
            onChange={setAudioCodec}
            disabled={disabled}
          />
          <SourceSelect
            label="Max bitrate"
            value={audioBitrate}
            options={selectOptions(AUDIO_BITRATES)}
            onChange={setAudioBitrate}
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
            <span style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>Processing</span>
            <Checkbox
              label="Echo cancellation"
              checked={audioProcessing.echoCancellation}
              onChange={(v) => setAudioProcessing((p) => ({ ...p, echoCancellation: v }))}
              disabled={disabled}
            />
            <Checkbox
              label="Noise suppression"
              checked={audioProcessing.noiseSuppression}
              onChange={(v) => setAudioProcessing((p) => ({ ...p, noiseSuppression: v }))}
              disabled={disabled}
            />
            <Checkbox
              label="Auto gain control"
              checked={audioProcessing.autoGainControl}
              onChange={(v) => setAudioProcessing((p) => ({ ...p, autoGainControl: v }))}
              disabled={disabled}
            />
          </div>
        </OptionGroup>
      </div>

      <div style={{ marginBottom: "1rem", flexShrink: 0 }}>
        <Checkbox
          label="Enable WebSocket fallback"
          checked={wsFallback}
          onChange={setWsFallback}
          disabled={disabled}
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

function OptionGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset
      style={{
        flex: 1,
        minWidth: 280,
        border: "1px solid var(--border, #444)",
        borderRadius: 6,
        padding: "0.5rem 1rem 1rem",
        margin: 0,
        display: "flex",
        flexWrap: "wrap",
        gap: "1rem",
        alignItems: "flex-start",
      }}
    >
      <legend
        style={{
          padding: "0 0.5rem",
          fontSize: "0.85rem",
          color: "var(--text-muted)",
        }}
      >
        {label}
      </legend>
      {children}
    </fieldset>
  );
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
