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
  type VideoCodec,
  type ContainerKind,
} from "../moq/publisher.ts";

const NONE = "none";
const SCREEN = "screen";
const MICROPHONE = "microphone";

// Path the broadcast is published under when the field is left empty.
const DEFAULT_BROADCAST_PATH = "test";

// Seconds added to / removed from a track's PTS per button click.
const PTS_OFFSET_STEP_S = 10;

const SOURCE_OPTIONS: { value: SourceKind; label: string }[] = [
  { value: "screen", label: "Screen" },
  { value: "camera", label: "Camera" },
  { value: "none", label: "None (audio only)" },
];

const AUDIO_CODECS: { value: AudioCodec; label: string }[] = [
  { value: "opus", label: "Opus" },
  { value: "aac-raw", label: "AAC/raw" },
  { value: "aac-adts", label: "AAC/ADTS" },
];

const VIDEO_CODECS: { value: VideoCodec; label: string }[] = [
  { value: "avc1", label: "H264/avc1" },
  { value: "annexb", label: "H264/annexB" },
  { value: "vp8", label: "VP8" },
  { value: "vp9", label: "VP9" },
];

const CONTAINERS: { value: ContainerKind; label: string }[] = [
  { value: "cmaf", label: "CMAF" },
  { value: "legacy", label: "Legacy" },
  { value: "loc", label: "LOC" },
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
  const [token, setToken] = useSessionInput("moq:token", params, "token");
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
  const [reanchorTimestamps, setReanchorTimestamps] = useState(false);
  const [burstGroups, setBurstGroups] = useState(false);
  const [resolution, setResolution] = useState<string>("auto");
  const [framerate, setFramerate] = useState<string>("auto");
  const [videoBitrate, setVideoBitrate] = useState<string>("auto");
  const [keyframeInterval, setKeyframeInterval] = useState<string>("");
  const [audioBitrate, setAudioBitrate] = useState<string>("auto");
  const [audioGroupSize, setAudioGroupSize] = useState<string>("");
  const [burstAudioGroups, setBurstAudioGroups] = useState(false);
  const [audioCodec, setAudioCodec] = useState<AudioCodec>("opus");
  const [opusDtx, setOpusDtx] = useState(false);
  const [videoCodec, setVideoCodec] = useState<VideoCodec>("avc1");
  const [includeDescription, setIncludeDescription] = useState(true);
  const [audioIncludeDescription, setAudioIncludeDescription] = useState(true);
  const [videoContainer, setVideoContainer] = useState<ContainerKind>("cmaf");
  const [audioContainer, setAudioContainer] = useState<ContainerKind>("cmaf");
  const [contentHint, setContentHint] = useState<string>("auto");
  // Requested PTS offsets (what the buttons move) and the offsets the publisher
  // has actually put on the wire. Video's lags behind by up to a keyframe.
  const [videoPtsOffset, setVideoPtsOffset] = useState(0);
  const [audioPtsOffset, setAudioPtsOffset] = useState(0);
  const [videoPtsOffsetApplied, setVideoPtsOffsetApplied] = useState(0);
  const [audioPtsOffsetApplied, setAudioPtsOffsetApplied] = useState(0);

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

  // Push the PTS offsets at the running publisher, so a click mid-stream shifts
  // the live timeline instead of only taking effect on the next Start. The
  // publisher reports back through onPtsOffsetApplied once the change lands.
  // With nothing publishing there is nothing to wait for: the offset is whatever
  // the next Start will begin with.
  useEffect(() => {
    const handle = handleRef.current;
    if (handle) handle.setPtsOffsetUs("video", videoPtsOffset * 1_000_000);
    else setVideoPtsOffsetApplied(videoPtsOffset);
  }, [videoPtsOffset]);
  useEffect(() => {
    const handle = handleRef.current;
    if (handle) handle.setPtsOffsetUs("audio", audioPtsOffset * 1_000_000);
    else setAudioPtsOffsetApplied(audioPtsOffset);
  }, [audioPtsOffset]);

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
    // Stopping clears the offsets, so the next Start streams an unshifted
    // timeline. Applied is reset alongside requested rather than left to the
    // sync effects: a video offset still waiting on a keyframe when we stopped
    // would otherwise stay stuck showing as pending forever.
    setVideoPtsOffset(0);
    setAudioPtsOffset(0);
    setVideoPtsOffsetApplied(0);
    setAudioPtsOffsetApplied(0);
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
    if (source === NONE && audioSource === NONE) {
      setStatus({
        state: "error",
        message: "Select an audio source to publish an audio-only stream.",
      });
      return;
    }
    if (source !== NONE && videoContainer === "cmaf" && videoCodec === "annexb") {
      setStatus({
        state: "error",
        message: "Annex B bitstream requires the Legacy container (CMAF uses avc1).",
      });
      return;
    }
    if (audioContainer === "cmaf" && audioCodec === "aac-adts") {
      setStatus({
        state: "error",
        message: "ADTS bitstream requires the Legacy container (CMAF uses raw AAC).",
      });
      return;
    }
    const trimmedKeyframe = keyframeInterval.trim();
    let keyframeIntervalUs: number | undefined;
    if (trimmedKeyframe !== "") {
      const ms = Number(trimmedKeyframe);
      if (!Number.isFinite(ms) || ms <= 0) {
        setStatus({
          state: "error",
          message: "Keyframe interval must be a positive number of milliseconds (or empty for default).",
        });
        return;
      }
      keyframeIntervalUs = Math.round(ms * 1000);
    }
    const trimmedAudioGroup = audioGroupSize.trim();
    let audioGroupSizeMs: number | undefined;
    if (trimmedAudioGroup !== "") {
      const ms = Number(trimmedAudioGroup);
      if (!Number.isFinite(ms) || ms <= 0) {
        setStatus({
          state: "error",
          message: "Audio group size must be a positive number of milliseconds (or empty for default).",
        });
        return;
      }
      audioGroupSizeMs = ms;
    }
    const trimmedPath = broadcastPath.trim();
    setBusy(true);
    setStatus({ state: "connecting" });
    saveToHistory("moq:url", serverUrl);
    if (token) saveToHistory("moq:token", token);
    if (certHash) saveToHistory("moq:cert", certHash);
    if (trimmedPath) saveToHistory("moq:path", trimmedPath);
    try {
      const handle = await startPublishing({
        serverUrl,
        broadcastPath: trimmedPath || DEFAULT_BROADCAST_PATH,
        token,
        source,
        audioSource,
        audioProcessing,
        audioCodec,
        opusDtx,
        videoCodec,
        includeDescription,
        audioIncludeDescription,
        videoContainer,
        audioContainer,
        wsFallback,
        reanchorTimestamps,
        videoPtsOffsetUs: videoPtsOffset * 1_000_000,
        audioPtsOffsetUs: audioPtsOffset * 1_000_000,
        burstGroups,
        audioGroupSizeMs,
        burstAudioGroups,
        videoBitrate: VIDEO_BITRATES[videoBitrate]?.bps,
        audioBitrate: AUDIO_BITRATES[audioBitrate]?.bps,
        framerate: FRAMERATES[framerate]?.fps,
        width: RESOLUTIONS[resolution]?.width,
        height: RESOLUTIONS[resolution]?.height,
        keyframeIntervalUs,
        contentHint: CONTENT_HINTS[contentHint]?.value,
        certHash,
        onStatus: setStatus,
        onPtsOffsetApplied: (kind, offsetUs) => {
          const seconds = offsetUs / 1_000_000;
          if (kind === "video") setVideoPtsOffsetApplied(seconds);
          else setAudioPtsOffsetApplied(seconds);
        },
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
  // Audio-only stream: the video encoder options are irrelevant.
  const videoDisabled = disabled || source === NONE;

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
          placeholder={DEFAULT_BROADCAST_PATH}
          label="Broadcast path (optional)"
        />
        <SuggestInput
          historyKey="moq:token"
          value={token}
          onChange={setToken}
          placeholder="bearer token"
          label="Bearer token"
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
            disabled={videoDisabled}
          />
          <SourceSelect
            label="Framerate"
            value={framerate}
            options={selectOptions(FRAMERATES)}
            onChange={setFramerate}
            disabled={videoDisabled}
          />
          <SourceSelect
            label="Max bitrate"
            value={videoBitrate}
            options={selectOptions(VIDEO_BITRATES)}
            onChange={setVideoBitrate}
            disabled={videoDisabled}
          />
          <TextField
            label="Keyframe interval (ms)"
            value={keyframeInterval}
            onChange={setKeyframeInterval}
            placeholder="Default"
            disabled={videoDisabled}
          />
          <SourceSelect
            label="Content hint"
            value={contentHint}
            options={selectOptions(CONTENT_HINTS)}
            onChange={setContentHint}
            disabled={videoDisabled}
          />
          <SourceSelect
            label="Codec"
            value={videoCodec}
            options={VIDEO_CODECS}
            onChange={setVideoCodec}
            disabled={videoDisabled}
          />
          <SourceSelect
            label="Container"
            value={videoContainer}
            options={CONTAINERS}
            onChange={setVideoContainer}
            disabled={videoDisabled}
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
            <span style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>Catalog</span>
            <Checkbox
              label="Include description"
              checked={includeDescription}
              onChange={setIncludeDescription}
              disabled={videoDisabled || videoCodec !== "avc1"}
            />
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              flex: 1,
              minWidth: 200,
            }}
          >
            <span style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>Delivery</span>
            <Checkbox
              label="Burst each group (buffer whole GOP, then send at once)"
              checked={burstGroups}
              onChange={setBurstGroups}
              disabled={videoDisabled}
            />
          </div>
          <PtsOffsetField
            offset={videoPtsOffset}
            applied={videoPtsOffsetApplied}
            onAdjust={(delta) => setVideoPtsOffset((o) => o + delta)}
            disabled={busy || source === NONE}
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
          <SourceSelect
            label="Container"
            value={audioContainer}
            options={CONTAINERS}
            onChange={setAudioContainer}
            disabled={disabled}
          />
          <TextField
            label="Group size (ms)"
            value={audioGroupSize}
            onChange={setAudioGroupSize}
            placeholder="Default (per frame)"
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
            <span style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>Encoder</span>
            <Checkbox
              label="DTX (drop frames during silence)"
              checked={opusDtx}
              onChange={setOpusDtx}
              disabled={disabled || audioCodec !== "opus"}
            />
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              flex: 1,
              minWidth: 200,
            }}
          >
            <span style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>Catalog</span>
            <Checkbox
              label="Include description"
              checked={audioIncludeDescription}
              onChange={setAudioIncludeDescription}
              disabled={disabled || audioCodec !== "aac-raw"}
            />
          </div>
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
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              flex: 1,
              minWidth: 200,
            }}
          >
            <span style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>Delivery</span>
            <Checkbox
              label="Burst each audio group (buffer whole group, then send at once)"
              checked={burstAudioGroups}
              onChange={setBurstAudioGroups}
              disabled={disabled}
            />
          </div>
          <PtsOffsetField
            offset={audioPtsOffset}
            applied={audioPtsOffsetApplied}
            onAdjust={(delta) => setAudioPtsOffset((o) => o + delta)}
            disabled={busy || audioSource === NONE}
          />
        </OptionGroup>
      </div>

      <div style={{ marginBottom: "1rem", flexShrink: 0 }}>
        <Checkbox
          label="Enable WebSocket fallback"
          checked={wsFallback}
          onChange={setWsFallback}
          disabled={disabled}
        />
        <Checkbox
          label="Reanchor each track to zero"
          checked={reanchorTimestamps}
          onChange={setReanchorTimestamps}
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

function TextField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
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
      <input
        type="number"
        inputMode="numeric"
        min={1}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: "100%", padding: "0.5rem", fontSize: "1rem", boxSizing: "border-box" }}
      />
    </div>
  );
}

const formatOffset = (seconds: number) => `${seconds > 0 ? "+" : ""}${seconds} s`;

/**
 * Live PTS offset control: shifts this track's published timestamps by whole
 * seconds. Stays enabled while publishing — clicking mid-stream jumps the live
 * timeline, which is how a player's epoch-discontinuity handling gets tested.
 *
 * `offset` is what the buttons have asked for; `applied` is what the publisher
 * has actually put on the wire. Video only jumps at a keyframe, so the two
 * disagree until then and the note below spells out what is still going out.
 */
function PtsOffsetField({
  offset,
  applied,
  onAdjust,
  disabled,
}: {
  offset: number;
  applied: number;
  onAdjust: (deltaSeconds: number) => void;
  disabled?: boolean;
}): ReactNode {
  const button = {
    padding: "0.5rem 0.75rem",
    fontSize: "1rem",
    cursor: disabled ? "default" : "pointer",
  };
  const pending = applied !== offset;
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 200 }}>
      <label
        style={{
          marginBottom: 4,
          fontSize: "0.85rem",
          color: "var(--text-muted)",
        }}
      >
        PTS offset
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <button onClick={() => onAdjust(-PTS_OFFSET_STEP_S)} disabled={disabled} style={button}>
          −{PTS_OFFSET_STEP_S}
        </button>
        <span
          style={{
            flex: 1,
            textAlign: "center",
            fontSize: "1rem",
            fontVariantNumeric: "tabular-nums",
            color: offset === 0 ? "var(--text-muted)" : "var(--accent)",
          }}
        >
          {formatOffset(offset)}
        </span>
        <button onClick={() => onAdjust(PTS_OFFSET_STEP_S)} disabled={disabled} style={button}>
          +{PTS_OFFSET_STEP_S}
        </button>
      </div>
      {/* Always rendered so appearing/disappearing text can't jog the layout. */}
      <span style={{ marginTop: 4, minHeight: "1rem", fontSize: "0.75rem", color: "var(--text-muted)" }}>
        {pending ? `sending ${formatOffset(applied)} until the next keyframe` : ""}
      </span>
    </div>
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
